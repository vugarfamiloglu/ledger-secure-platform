/**
 * Fraud Service (port 5115).
 *
 * Real-time risk scoring + case management.  The payments service
 * calls POST /score before authorizing each intent; this service
 * combines a deterministic rule layer with a tiny anomaly-detector
 * (running mean + standard deviation per merchant) to produce:
 *
 *   { score, level, action, signals[] }
 *
 * Anything above the "high" threshold also spawns a RiskCase that an
 * operator can resolve from the dashboard.  Decisions feed back into
 * the baseline so the model gets sharper over time.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, publicId, uuid } from '../../lib/db';
import { publish, subscribe } from '../../lib/broker';
import { m } from '../../lib/money';
import type { Currency, RiskLevel } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'fraud',
  port: Number(process.env.LEDGER_FRAUD_PORT ?? 5115),
});

const db = openDb('fraud');

db.exec(`
  CREATE TABLE IF NOT EXISTS risk_scores (
    id              TEXT PRIMARY KEY,
    payment_id      TEXT,
    merchant_id     TEXT NOT NULL,
    score           REAL NOT NULL,
    level           TEXT NOT NULL,
    action          TEXT NOT NULL,
    signals_json    TEXT NOT NULL DEFAULT '[]',
    amount_minor    TEXT NOT NULL,
    currency        TEXT NOT NULL,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scores_merchant ON risk_scores(merchant_id);
  CREATE INDEX IF NOT EXISTS idx_scores_level    ON risk_scores(level);

  CREATE TABLE IF NOT EXISTS risk_cases (
    id           TEXT PRIMARY KEY,
    public_id    TEXT UNIQUE NOT NULL,
    payment_id   TEXT,
    merchant_id  TEXT NOT NULL,
    score        REAL NOT NULL,
    level        TEXT NOT NULL,
    signals_json TEXT NOT NULL DEFAULT '[]',
    action       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    decided_by   TEXT,
    decision     TEXT,
    decided_at   TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cases_status ON risk_cases(status);
  CREATE INDEX IF NOT EXISTS idx_cases_level  ON risk_cases(level);

  /* Per-merchant baseline.  Welford's online algorithm: store n, mean
   * and M2 → variance = M2 / (n-1).  Tiny, exact, no batch retrain. */
  CREATE TABLE IF NOT EXISTS baselines (
    merchant_id TEXT NOT NULL,
    currency    TEXT NOT NULL,
    n           INTEGER NOT NULL DEFAULT 0,
    mean        REAL NOT NULL DEFAULT 0,
    m2          REAL NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (merchant_id, currency)
  );
`);

/* ── Rule engine ─────────────────────────────────────────────────── */

interface RuleHit { signal: string; weight: number; }

interface ScoreInput { payment_id?: string; merchant_id: string; amount_minor: string; currency: Currency; metadata?: Record<string, any>; }

function runRules(input: ScoreInput): RuleHit[] {
  const hits: RuleHit[] = [];
  const amt = m.fromDb(input.amount_minor);
  const meta = input.metadata ?? {};

  /* Amount-tier rules — minor units are currency-agnostic so we use
   * USD-equivalent thresholds (this is fine for a single-tenant demo;
   * a real system would normalize via FX). */
  if (amt > 1_000_000n)   hits.push({ signal: 'amount_over_10k',  weight: 0.20 });
  if (amt > 5_000_000n)   hits.push({ signal: 'amount_over_50k',  weight: 0.25 });
  if (amt > 20_000_000n)  hits.push({ signal: 'amount_over_200k', weight: 0.30 });

  /* Velocity — how many scores has this merchant generated in the
   * last 60 seconds.  Anything > 10/min is unusual outside payouts. */
  const velocity = (db.prepare<[string], { c: number }>(
    `SELECT COUNT(*) as c FROM risk_scores WHERE merchant_id = ? AND created_at > datetime('now','-60 seconds')`,
  ).get(input.merchant_id) ?? { c: 0 }).c;
  if (velocity > 10) hits.push({ signal: `velocity_${velocity}_per_min`, weight: 0.20 });
  if (velocity > 30) hits.push({ signal: 'velocity_extreme', weight: 0.30 });

  /* Metadata hints — proxy/VPN, mismatched country, explicit test flag. */
  if (meta.proxy === true)      hits.push({ signal: 'client_proxy_detected',     weight: 0.15 });
  if (meta.country_mismatch)    hits.push({ signal: 'bin_country_vs_ip_mismatch', weight: 0.20 });
  if (meta.suspicious === true) hits.push({ signal: 'explicit_test_flag',         weight: 0.50 });
  if (meta.email && /\+\d+@/.test(meta.email)) hits.push({ signal: 'aliased_email', weight: 0.10 });

  /* Anomaly — z-score against baseline. */
  const base = db.prepare<[string, string], { n: number; mean: number; m2: number }>(
    `SELECT n, mean, m2 FROM baselines WHERE merchant_id = ? AND currency = ?`,
  ).get(input.merchant_id, input.currency);
  if (base && base.n >= 5) {
    const variance = base.n > 1 ? base.m2 / (base.n - 1) : 0;
    const std = Math.sqrt(Math.max(variance, 1));
    const z = (Number(amt) - base.mean) / std;
    if (z > 3)  hits.push({ signal: `anomaly_z_${z.toFixed(1)}σ`,    weight: 0.25 });
    if (z > 5)  hits.push({ signal: 'anomaly_z_extreme',             weight: 0.30 });
  }

  return hits;
}

function decisionFromScore(score: number): { level: RiskLevel; action: 'allow' | 'manual_review' | 'soft_block' | 'hard_freeze' } {
  if (score >= 0.85) return { level: 'critical', action: 'hard_freeze' };
  if (score >= 0.60) return { level: 'high',     action: 'manual_review' };
  if (score >= 0.30) return { level: 'medium',   action: 'allow' };
  return { level: 'low', action: 'allow' };
}

/* Update Welford's running stats so the baseline tracks new traffic. */
function bumpBaseline(merchantId: string, currency: Currency, amount: bigint): void {
  const cur = db.prepare<[string, string], { n: number; mean: number; m2: number }>(
    `SELECT n, mean, m2 FROM baselines WHERE merchant_id = ? AND currency = ?`,
  ).get(merchantId, currency);
  const x = Number(amount);
  if (!cur) {
    db.prepare(`INSERT INTO baselines (merchant_id, currency, n, mean, m2) VALUES (?, ?, 1, ?, 0)`).run(merchantId, currency, x);
    return;
  }
  const n = cur.n + 1;
  const delta = x - cur.mean;
  const newMean = cur.mean + delta / n;
  const newM2 = cur.m2 + delta * (x - newMean);
  db.prepare(`UPDATE baselines SET n = ?, mean = ?, m2 = ?, updated_at = datetime('now') WHERE merchant_id = ? AND currency = ?`)
    .run(n, newMean, newM2, merchantId, currency);
}

/* ── Routes ───────────────────────────────────────────────────────── */

app.post('/score', (req: Request, res: Response, next: NextFunction) => {
  try {
    const b: ScoreInput = req.body ?? {};
    if (!b.merchant_id)  bad(422, 'merchant_id required');
    if (!b.amount_minor) bad(422, 'amount_minor required');
    if (!b.currency)     bad(422, 'currency required');

    const hits = runRules(b);
    const base = 0.05;
    const rawScore = hits.reduce((a, h) => a + h.weight, base);
    const score = Math.min(Math.max(rawScore, 0), 1);
    const { level, action } = decisionFromScore(score);
    const signals = hits.map((h) => h.signal);

    const id = uuid();
    db.prepare(
      `INSERT INTO risk_scores (id, payment_id, merchant_id, score, level, action, signals_json, amount_minor, currency, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.payment_id ?? null, b.merchant_id, score, level, action, JSON.stringify(signals), b.amount_minor, b.currency, JSON.stringify(b.metadata ?? {}));

    /* Baseline only learns from non-high-risk traffic — don't poison
     * the mean with attack samples. */
    if (level === 'low' || level === 'medium') bumpBaseline(b.merchant_id, b.currency, m.fromDb(b.amount_minor));

    if (level === 'high' || level === 'critical') {
      const caseId = uuid(); const casePid = publicId('CASE');
      db.prepare(
        `INSERT INTO risk_cases (id, public_id, payment_id, merchant_id, score, level, signals_json, action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(caseId, casePid, b.payment_id ?? null, b.merchant_id, score, level, JSON.stringify(signals), action);
      publish('fraud.escalated', { case_public_id: casePid, payment_id: b.payment_id, score, level, signals }, 'fraud');
      log.warn(`case ${casePid} opened (${level} ${score.toFixed(2)}): ${signals.join(',')}`);
    }
    publish('fraud.scored', { payment_id: b.payment_id, merchant_id: b.merchant_id, score, level, action, signals }, 'fraud');
    res.json({ score, level, action, signals });
  } catch (e) { next(e); }
});

app.get('/cases', (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: string[] = [];
    const params: any[] = [];
    const q = req.query as Record<string, string | undefined>;
    if (q.status)      { where.push('status = ?');      params.push(q.status); }
    if (q.level)       { where.push('level = ?');       params.push(q.level); }
    if (q.merchant_id) { where.push('merchant_id = ?'); params.push(q.merchant_id); }
    const limit  = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const rows = db.prepare(`SELECT * FROM risk_cases ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) as c FROM risk_cases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params) as { c: number }).c;
    res.json({ cases: rows, total });
  } catch (e) { next(e); }
});

app.get('/cases/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = db.prepare(`SELECT * FROM risk_cases WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!c) bad(404, 'case not found');
    res.json({ case: c });
  } catch (e) { next(e); }
});

app.post('/cases/:id/resolve', (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = db.prepare<[string, string], any>(`SELECT * FROM risk_cases WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!c) bad(404, 'case not found');
    if (c.status !== 'open') bad(409, `case is ${c.status}, cannot resolve`);
    const { decision, decided_by, note } = req.body ?? {};
    if (!decision || !['approved', 'rejected', 'escalated'].includes(decision)) bad(422, 'decision must be approved|rejected|escalated');
    const status = decision === 'escalated' ? 'escalated' : 'resolved';
    db.prepare(`UPDATE risk_cases SET status = ?, decision = ?, decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?`)
      .run(status, decision, decided_by ?? 'operator', note ?? null, c.id);
    publish('fraud.escalated', { case_public_id: c.public_id, decision, decided_by: decided_by ?? 'operator' }, 'fraud');
    log.info(`case ${c.public_id} ${status} (${decision})`);
    res.json({ case: db.prepare(`SELECT * FROM risk_cases WHERE id = ?`).get(c.id) });
  } catch (e) { next(e); }
});

app.get('/baselines', (req: Request, res: Response) => {
  const merchant = req.query.merchant_id as string | undefined;
  const rows = merchant
    ? db.prepare(`SELECT * FROM baselines WHERE merchant_id = ?`).all(merchant)
    : db.prepare(`SELECT * FROM baselines ORDER BY n DESC LIMIT 200`).all();
  res.json({ baselines: rows });
});

app.get('/stats', (_req: Request, res: Response) => {
  const totalScored = (db.prepare(`SELECT COUNT(*) as c FROM risk_scores`).get() as { c: number }).c;
  const byLevel    = db.prepare(`SELECT level, COUNT(*) as c FROM risk_scores GROUP BY level`).all();
  const byAction   = db.prepare(`SELECT action, COUNT(*) as c FROM risk_scores GROUP BY action`).all();
  const casesOpen  = (db.prepare(`SELECT COUNT(*) as c FROM risk_cases WHERE status = 'open'`).get() as { c: number }).c;
  const casesByLvl = db.prepare(`SELECT level, COUNT(*) as c FROM risk_cases GROUP BY level`).all();
  res.json({ scored_total: totalScored, by_level: byLevel, by_action: byAction, open_cases: casesOpen, cases_by_level: casesByLvl });
});

start(app, port, 'fraud', () => {
  /* Listen for ledger.posted as a secondary anomaly signal — if the
   * same account fires too many entries too fast, flag a velocity case. */
  subscribe<{ postings: Array<{ account_id: string; amount_minor: string; currency: Currency }> }>('ledger.posted', 'fraud-velocity', (evt) => {
    /* Lightweight: we just bump activity counts; full velocity logic
     * runs at /score time.  This subscription mainly demonstrates the
     * cross-service event flow. */
    for (const p of evt.payload.postings ?? []) {
      /* no-op for now — slot for ML-grade rules later. */
      void p;
    }
  });
  log.info('rule engine + Welford baseline online');
});
