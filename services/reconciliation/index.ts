/**
 * Reconciliation Service (port 5114).
 *
 * Compares external statement feeds (bank, processor, ACH) against
 * internal payment records and labels each statement row:
 *
 *   matched      — exact reference + amount + currency hit
 *   partial      — fuzzy match within tolerance (date/amount)
 *   unmatched    — no candidate found
 *   duplicate    — same external_ref ingested twice
 *   suspicious   — found a candidate but amounts/dates disagree wildly
 *
 * Matches publish reconciliation.matched; everything left over after
 * each run publishes reconciliation.orphan so the operator dashboard
 * can highlight breaks.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, uuid } from '../../lib/db';
import { publish } from '../../lib/broker';
import { call } from '../../lib/http';
import { m } from '../../lib/money';
import type { Currency, ReconciliationState } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'reconciliation',
  port: Number(process.env.LEDGER_RECONCILIATION_PORT ?? 5114),
});

const db = openDb('reconciliation');

db.exec(`
  CREATE TABLE IF NOT EXISTS statements (
    id                 TEXT PRIMARY KEY,
    source             TEXT NOT NULL,         -- bank-acme / card-visa / ach-sepa …
    external_ref       TEXT NOT NULL,
    amount_minor       TEXT NOT NULL,
    currency           TEXT NOT NULL,
    posted_at          TEXT NOT NULL,
    raw_json           TEXT NOT NULL DEFAULT '{}',
    state              TEXT NOT NULL DEFAULT 'unmatched',
    matched_payment_id TEXT,
    matched_score      REAL,
    notes              TEXT,
    ingested_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_stmt_source ON statements(source);
  CREATE INDEX IF NOT EXISTS idx_stmt_state  ON statements(state);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_stmt_source_ref ON statements(source, external_ref);

  CREATE TABLE IF NOT EXISTS heal_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id TEXT NOT NULL REFERENCES statements(id),
    action       TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    applied      INTEGER NOT NULL DEFAULT 0,
    applied_at   TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

interface StatementRow {
  id: string; source: string; external_ref: string;
  amount_minor: string; currency: Currency; posted_at: string;
  raw_json: string; state: ReconciliationState;
  matched_payment_id: string | null; matched_score: number | null; notes: string | null; ingested_at: string;
}

interface PaymentLite {
  id: string; public_id: string; amount_minor: string; currency: Currency;
  status: string; created_at: string; description: string; metadata_json: string;
}

/* ── Routes ───────────────────────────────────────────────────────── */

/** POST /statements — ingest a batch of external statement rows. */
app.post('/statements', (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = Array.isArray(req.body) ? req.body : (req.body?.statements ?? []);
    if (!Array.isArray(items) || items.length === 0) bad(422, 'statements (array) required');
    let inserted = 0, duplicates = 0;
    const insert = db.prepare(
      `INSERT INTO statements (id, source, external_ref, amount_minor, currency, posted_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      if (!it.source || !it.external_ref || it.amount_minor == null || !it.currency || !it.posted_at) {
        bad(422, 'each statement requires source, external_ref, amount_minor, currency, posted_at');
      }
      try {
        insert.run(uuid(), it.source, it.external_ref, String(it.amount_minor), it.currency, it.posted_at, JSON.stringify(it.raw ?? {}));
        inserted++;
      } catch (e: any) {
        if (String(e?.message ?? '').includes('UNIQUE')) {
          duplicates++;
          db.prepare(`UPDATE statements SET state = 'duplicate' WHERE source = ? AND external_ref = ?`).run(it.source, it.external_ref);
        } else throw e;
      }
    }
    log.info(`ingested ${inserted} statement(s), ${duplicates} duplicate(s)`);
    res.status(201).json({ inserted, duplicates });
  } catch (e) { next(e); }
});

app.get('/statements', (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: string[] = [];
    const params: any[] = [];
    const q = req.query as Record<string, string | undefined>;
    if (q.state)    { where.push('state = ?');    params.push(q.state); }
    if (q.source)   { where.push('source = ?');   params.push(q.source); }
    if (q.currency) { where.push('currency = ?'); params.push(q.currency); }
    const limit  = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const sql = `SELECT * FROM statements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY posted_at DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, limit, offset);
    const totalSql = `SELECT COUNT(*) as c FROM statements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = (db.prepare(totalSql).get(...params) as { c: number }).c;
    res.json({ statements: rows, total });
  } catch (e) { next(e); }
});

app.get('/unmatched', (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM statements WHERE state IN ('unmatched','suspicious','partial') ORDER BY posted_at DESC LIMIT 200`).all();
  res.json({ statements: rows, total: rows.length });
});

app.get('/stats', (_req: Request, res: Response) => {
  const total      = (db.prepare(`SELECT COUNT(*) as c FROM statements`).get() as { c: number }).c;
  const byState    = db.prepare(`SELECT state, COUNT(*) as c FROM statements GROUP BY state`).all();
  const bySource   = db.prepare(`SELECT source, COUNT(*) as c FROM statements GROUP BY source`).all();
  const matchedAmt = db.prepare(`SELECT SUM(CAST(amount_minor AS INTEGER)) as v FROM statements WHERE state = 'matched'`).get();
  const healPending = (db.prepare(`SELECT COUNT(*) as c FROM heal_actions WHERE applied = 0`).get() as { c: number }).c;
  res.json({ total, by_state: byState, by_source: bySource, matched_amount: matchedAmt, heal_pending: healPending });
});

/** POST /run — run the matching engine across pending statements. */
app.post('/run', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pending = db.prepare(`SELECT * FROM statements WHERE state IN ('unmatched','partial','suspicious') LIMIT 1000`).all() as StatementRow[];
    const summary = { processed: 0, matched: 0, partial: 0, suspicious: 0, still_unmatched: 0, heals_queued: 0 };

    /* Pull a window of recent payments per currency.  In a real system
     * this would be paginated / streamed; for the demo a 30-day window
     * across all payments is plenty. */
    const candidatesByCurrency = new Map<Currency, PaymentLite[]>();
    for (const stmt of pending) {
      if (!candidatesByCurrency.has(stmt.currency)) {
        try {
          const r = await call<{ payments: PaymentLite[] }>('payments', `/payments?currency=${stmt.currency}&limit=500`, { method: 'GET', retries: 1 });
          candidatesByCurrency.set(stmt.currency, r.payments);
        } catch (_e) { candidatesByCurrency.set(stmt.currency, []); }
      }
    }

    for (const s of pending) {
      summary.processed++;
      const candidates = candidatesByCurrency.get(s.currency) ?? [];
      const decision = matchStatement(s, candidates);
      db.prepare(
        `UPDATE statements SET state = ?, matched_payment_id = ?, matched_score = ?, notes = ? WHERE id = ?`,
      ).run(decision.state, decision.payment_id, decision.score, decision.note, s.id);

      if (decision.state === 'matched') {
        summary.matched++;
        publish('reconciliation.matched', { statement_id: s.id, payment_id: decision.payment_id, score: decision.score }, 'reconciliation');
      } else if (decision.state === 'partial') {
        summary.partial++;
        /* Queue an auto-heal action for small rounding gaps that the
         * operator dashboard can apply with one click. */
        if (decision.heal) {
          db.prepare(
            `INSERT INTO heal_actions (statement_id, action, payload_json, note) VALUES (?, ?, ?, ?)`,
          ).run(s.id, decision.heal.action, JSON.stringify(decision.heal.payload), decision.heal.note);
          summary.heals_queued++;
        }
      } else if (decision.state === 'suspicious') {
        summary.suspicious++;
        publish('reconciliation.orphan', { statement_id: s.id, reason: 'suspicious', note: decision.note }, 'reconciliation');
      } else {
        summary.still_unmatched++;
        publish('reconciliation.orphan', { statement_id: s.id, reason: 'unmatched' }, 'reconciliation');
      }
    }
    log.info(`run: processed ${summary.processed}, matched ${summary.matched}, partial ${summary.partial}, suspicious ${summary.suspicious}, unmatched ${summary.still_unmatched}, heals ${summary.heals_queued}`);
    res.json(summary);
  } catch (e) { next(e); }
});

interface MatchDecision {
  state: ReconciliationState;
  payment_id: string | null;
  score: number;
  note: string;
  heal?: { action: string; payload: any; note: string };
}

function matchStatement(stmt: StatementRow, candidates: PaymentLite[]): MatchDecision {
  const stmtAmt = m.fromDb(stmt.amount_minor);
  /* 1. Exact match — external_ref appears anywhere in payment metadata
   * or description, AND amount matches exactly. */
  for (const p of candidates) {
    if (m.fromDb(p.amount_minor) !== stmtAmt) continue;
    const ref = stmt.external_ref.toLowerCase();
    const blob = (p.description + ' ' + p.metadata_json + ' ' + p.public_id).toLowerCase();
    if (blob.includes(ref) || ref.includes(p.public_id.toLowerCase())) {
      return { state: 'matched', payment_id: p.id, score: 1.0, note: 'exact ref + amount' };
    }
  }
  /* 2. Fuzzy match — amount within 1% AND posted within ±2 days. */
  const stmtTime = Date.parse(stmt.posted_at.replace(' ', 'T') + 'Z');
  let best: { p: PaymentLite; score: number; gap: bigint; daysApart: number } | null = null;
  for (const p of candidates) {
    const pAmt = m.fromDb(p.amount_minor);
    const gap = pAmt > stmtAmt ? pAmt - stmtAmt : stmtAmt - pAmt;
    if (stmtAmt === 0n) continue;
    const ratio = Number(gap * 10000n / (stmtAmt > 0n ? stmtAmt : 1n)) / 10000;
    if (ratio > 0.01) continue;
    const pTime = Date.parse(p.created_at.replace(' ', 'T') + 'Z');
    const daysApart = Math.abs(pTime - stmtTime) / (1000 * 60 * 60 * 24);
    if (daysApart > 2) continue;
    const score = (1 - ratio) * 0.7 + (1 - daysApart / 2) * 0.3;
    if (!best || score > best.score) best = { p, score, gap, daysApart };
  }
  if (best) {
    const isPartial = best.gap !== 0n;
    const note = isPartial
      ? `fuzzy: amount gap ${best.gap.toString()} minor (~${(Number(best.gap * 10000n / m.fromDb(stmt.amount_minor || '1')) / 100).toFixed(2)}%), ${best.daysApart.toFixed(1)}d apart`
      : `fuzzy: amount exact, ${best.daysApart.toFixed(1)}d apart`;
    const heal = isPartial && best.gap < 100n
      ? { action: 'apply_rounding_adjustment', payload: { payment_id: best.p.id, statement_id: stmt.id, gap_minor: best.gap.toString() }, note: 'sub-1.00 unit gap — eligible for auto-heal' }
      : undefined;
    return { state: 'partial', payment_id: best.p.id, score: Math.round(best.score * 1000) / 1000, note, heal };
  }
  /* 3. Suspicious — there's a payment with same amount but reference
   * doesn't line up at all.  Operator needs to look. */
  const sameAmt = candidates.find((p) => m.fromDb(p.amount_minor) === stmtAmt);
  if (sameAmt) return { state: 'suspicious', payment_id: sameAmt.id, score: 0.5, note: 'amount match but no ref overlap — possible duplicate or attribution error' };
  return { state: 'unmatched', payment_id: null, score: 0, note: 'no candidate within tolerance' };
}

/** POST /heal/:id — apply a queued auto-heal action. */
app.post('/heal/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = db.prepare<[string], any>(`SELECT * FROM heal_actions WHERE id = ?`).get(req.params.id);
    if (!row) bad(404, 'heal action not found');
    if (row.applied) bad(409, 'heal action already applied');
    const payload = JSON.parse(row.payload_json || '{}');
    /* For the demo we just log + mark applied.  In production this
     * would post a small rounding-adjustment JE to the ledger. */
    db.prepare(`UPDATE heal_actions SET applied = 1, applied_at = datetime('now') WHERE id = ?`).run(row.id);
    db.prepare(`UPDATE statements SET state = 'matched', notes = COALESCE(notes,'') || ' [healed]' WHERE id = ?`).run(row.statement_id);
    publish('reconciliation.matched', { statement_id: row.statement_id, healed: true, payload }, 'reconciliation');
    log.info(`heal ${row.id} applied (${row.action})`);
    res.json({ ok: true, action: row.action, payload });
  } catch (e) { next(e); }
});

app.get('/heals', (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM heal_actions ORDER BY created_at DESC LIMIT 200`).all();
  res.json({ heals: rows, total: rows.length });
});

start(app, port, 'reconciliation', () => {
  /* Schedule the matching engine every 5 min so newly ingested rows
   * get processed without an operator clicking "Run". */
  setInterval(async () => {
    try {
      const pending = (db.prepare(`SELECT COUNT(*) as c FROM statements WHERE state IN ('unmatched','partial','suspicious')`).get() as { c: number }).c;
      if (pending === 0) return;
      const r = await call<any>('reconciliation', '/run', { method: 'POST', body: '{}', retries: 0 });
      log.info(`auto-run swept ${pending} pending → matched ${r.matched}, partial ${r.partial}, unmatched ${r.still_unmatched}`);
    } catch (e) { /* swallow — manual /run still works */ }
  }, 5 * 60_000);
  log.info('auto-matcher armed (5min cadence)');
});
