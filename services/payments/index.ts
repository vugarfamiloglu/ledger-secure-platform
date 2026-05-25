/**
 * Payments Service (port 5112).
 *
 * The user-facing orchestration layer.  A "payment" is a typed state
 * machine — initiated → authorized → pending → processing → settled,
 * with side branches for failed / reversed / refunded / expired.
 *
 * The payments service owns:
 *   • intent persistence + state machine validation
 *   • a thin risk-check hook (calls /fraud when present, allows otherwise)
 *   • idempotent capture + cancel + refund actions
 *   • posting to the ledger at each transition that moves money
 *   • emitting payment.* events for the webhook service to deliver
 *
 * Money never moves outside the ledger.  This service is purely the
 * coordinator that knows WHICH ledger entries to post WHEN.
 *
 *   capture     → debit customer.available, credit merchant.pending, credit fee.available
 *   settle      → debit merchant.pending,   credit merchant.available
 *   refund      → reversal-style JE that mirrors the capture
 *   cancel auth → no-op on ledger if we never captured; otherwise reverses
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, publicId, uuid } from '../../lib/db';
import { withIdempotency, IdempotencyConflictError } from '../../lib/idempotency';
import { publish, subscribe } from '../../lib/broker';
import { call } from '../../lib/http';
import { m } from '../../lib/money';
import type { Currency, PaymentKind, PaymentStatus, RiskLevel } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'payments',
  port: Number(process.env.LEDGER_PAYMENTS_PORT ?? 5112),
});

const db = openDb('payments');

/* ── Schema ───────────────────────────────────────────────────────── */

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id                 TEXT PRIMARY KEY,
    public_id          TEXT UNIQUE NOT NULL,
    merchant_id        TEXT NOT NULL,
    kind               TEXT NOT NULL,
    status             TEXT NOT NULL,
    amount_minor       TEXT NOT NULL,
    currency           TEXT NOT NULL,
    from_account_id    TEXT,
    to_account_id      TEXT,
    fee_account_id     TEXT,
    fee_amount_minor   TEXT NOT NULL DEFAULT '0',
    capture_je_id      TEXT,
    settle_je_id       TEXT,
    refund_je_id       TEXT,
    reverse_je_id      TEXT,
    fx_quote_id        TEXT,
    risk_score         REAL,
    risk_level         TEXT,
    risk_signals_json  TEXT,
    description        TEXT NOT NULL DEFAULT '',
    metadata_json      TEXT NOT NULL DEFAULT '{}',
    failure_reason     TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    captured_at        TEXT,
    settled_at         TEXT,
    refunded_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_payments_created  ON payments(created_at);

  CREATE TABLE IF NOT EXISTS payment_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id   TEXT NOT NULL REFERENCES payments(id),
    event        TEXT NOT NULL,
    from_status  TEXT,
    to_status    TEXT,
    detail_json  TEXT NOT NULL DEFAULT '{}',
    actor        TEXT NOT NULL DEFAULT 'system',
    occurred_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payment_events_pid ON payment_events(payment_id);
`);

/* ── State machine ────────────────────────────────────────────────── */

const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  initiated:  ['authorized', 'failed', 'expired'],
  authorized: ['pending', 'processing', 'failed', 'expired'],
  pending:    ['processing', 'settled', 'failed'],
  processing: ['settled', 'failed'],
  settled:    ['refunded', 'reversed'],
  failed:     [],
  reversed:   [],
  refunded:   [],
  expired:    [],
};

function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
    bad(409, `invalid state transition: ${from} → ${to}`);
  }
}

interface PaymentRow {
  id: string;
  public_id: string;
  merchant_id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount_minor: string;
  currency: Currency;
  from_account_id: string | null;
  to_account_id: string | null;
  fee_account_id: string | null;
  fee_amount_minor: string;
  capture_je_id: string | null;
  settle_je_id: string | null;
  refund_je_id: string | null;
  reverse_je_id: string | null;
  fx_quote_id: string | null;
  risk_score: number | null;
  risk_level: RiskLevel | null;
  risk_signals_json: string | null;
  description: string;
  metadata_json: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  captured_at: string | null;
  settled_at: string | null;
  refunded_at: string | null;
}

function getPayment(idOrPid: string): PaymentRow | undefined {
  return db.prepare<[string, string], PaymentRow>(
    `SELECT * FROM payments WHERE id = ? OR public_id = ?`,
  ).get(idOrPid, idOrPid);
}

function recordEvent(paymentId: string, event: string, from: PaymentStatus | null, to: PaymentStatus | null, detail: Record<string, any> = {}, actor = 'system'): void {
  db.prepare(
    `INSERT INTO payment_events (payment_id, event, from_status, to_status, detail_json, actor) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(paymentId, event, from, to, JSON.stringify(detail), actor);
}

function updateStatus(p: PaymentRow, to: PaymentStatus, extra: Partial<PaymentRow> = {}): PaymentRow {
  assertTransition(p.status, to);
  const cols: string[] = ['status = ?', 'updated_at = datetime(\'now\')'];
  const params: any[] = [to];
  for (const [k, v] of Object.entries(extra)) {
    cols.push(`${k} = ?`); params.push(v ?? null);
  }
  params.push(p.id);
  db.prepare(`UPDATE payments SET ${cols.join(', ')} WHERE id = ?`).run(...params);
  return getPayment(p.id)!;
}

/* ── Risk hook ───────────────────────────────────────────────────────
 * Calls /fraud/score if the fraud service is up; falls back to a local
 * rule-based check so the payments service stays usable in isolation. */
interface RiskResult { score: number; level: RiskLevel; action: 'allow' | 'manual_review' | 'soft_block' | 'hard_freeze'; signals: string[]; }

async function scoreRisk(input: { payment_id: string; merchant_id: string; amount_minor: string; currency: Currency; metadata: any; }): Promise<RiskResult> {
  try {
    return await call<RiskResult>('fraud', '/score', {
      method: 'POST',
      body: JSON.stringify(input),
      retries: 0,
    });
  } catch (_e) {
    /* Local fallback — tiny rule set so we can still demo end-to-end. */
    const amt = m.fromDb(input.amount_minor);
    const signals: string[] = [];
    let score = 0.05;
    if (amt > 1_000_000n) { score += 0.45; signals.push('amount_over_10k'); }
    if (amt > 5_000_000n) { score += 0.30; signals.push('amount_over_50k'); }
    if (input.metadata?.suspicious === true) { score += 0.5; signals.push('explicit_test_flag'); }
    const level: RiskLevel = score >= 0.85 ? 'critical' : score >= 0.6 ? 'high' : score >= 0.3 ? 'medium' : 'low';
    const action = level === 'critical' ? 'hard_freeze' : level === 'high' ? 'manual_review' : 'allow';
    return { score: Math.min(score, 1), level, action, signals };
  }
}

/* ── Ledger calls (helpers) ──────────────────────────────────────── */

interface LedgerEntryResult { journal_entry: { id: string; public_id: string }; postings: any[]; }

async function postLedgerEntry(
  idemKey: string,
  description: string,
  metadata: Record<string, any>,
  postings: Array<{ account_id: string; side: 'debit' | 'credit'; amount_minor: string; effect?: 'available' | 'pending' | 'reserved' }>,
): Promise<LedgerEntryResult> {
  return call<LedgerEntryResult>('ledger', '/entries', {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ description, metadata, postings }),
    retries: 1,
  });
}

async function postLedgerReversal(idemKey: string, journalEntryId: string, reason: string) {
  return call<{ reversal: { id: string; public_id: string }; postings: any[] }>('ledger', '/reversals', {
    method: 'POST',
    headers: { 'Idempotency-Key': idemKey },
    body: JSON.stringify({ journal_entry_id: journalEntryId, reason }),
    retries: 1,
  });
}

/* ── Routes ───────────────────────────────────────────────────────── */

/**
 * POST /payments — create a new payment intent.
 *
 * Body: {
 *   merchant_id, kind ('pay_in'|'pay_out'|'transfer'|'refund'),
 *   amount_minor, currency, fee_amount_minor?,
 *   from_account_id, to_account_id, fee_account_id?,
 *   description?, metadata?
 * }
 * Header: Idempotency-Key: <stable client-supplied key>
 */
app.post('/payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? req.body?.idempotency_key ?? '').toString().trim();
    if (!idemKey) bad(400, 'Idempotency-Key header is required');

    const result = await withIdempotency(db, idemKey, req.body, async () => {
      const b = req.body ?? {};
      if (!b.merchant_id)     bad(422, 'merchant_id required');
      if (!b.kind)            bad(422, 'kind required');
      if (!b.amount_minor)    bad(422, 'amount_minor required');
      if (!b.currency)        bad(422, 'currency required');
      if (!b.from_account_id) bad(422, 'from_account_id required');
      if (!b.to_account_id)   bad(422, 'to_account_id required');

      let amount: bigint;
      try { amount = BigInt(String(b.amount_minor)); }
      catch { bad(422, 'amount_minor must be an integer minor-unit string'); }
      if (amount <= 0n) bad(422, 'amount_minor must be > 0');
      const feeAmount = b.fee_amount_minor ? BigInt(String(b.fee_amount_minor)) : 0n;
      if (feeAmount < 0n) bad(422, 'fee_amount_minor must be >= 0');
      if (feeAmount > 0n && !b.fee_account_id) bad(422, 'fee_account_id required when fee_amount_minor > 0');
      if (feeAmount >= amount) bad(422, 'fee cannot equal or exceed gross amount');

      const id = uuid();
      const pid = publicId('PAY');
      db.prepare(
        `INSERT INTO payments (
          id, public_id, merchant_id, kind, status, amount_minor, currency,
          from_account_id, to_account_id, fee_account_id, fee_amount_minor,
          description, metadata_json
        ) VALUES (?, ?, ?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, pid, b.merchant_id, b.kind, amount.toString(), b.currency,
        b.from_account_id, b.to_account_id, b.fee_account_id ?? null, feeAmount.toString(),
        b.description ?? '', JSON.stringify(b.metadata ?? {}),
      );
      recordEvent(id, 'created', null, 'initiated', { kind: b.kind, amount_minor: amount.toString(), currency: b.currency });

      const created = getPayment(id)!;

      /* Risk decisioning happens BEFORE we tell anyone about the intent. */
      const risk = await scoreRisk({
        payment_id: pid,
        merchant_id: b.merchant_id,
        amount_minor: amount.toString(),
        currency: b.currency,
        metadata: b.metadata ?? {},
      });
      db.prepare(
        `UPDATE payments SET risk_score = ?, risk_level = ?, risk_signals_json = ? WHERE id = ?`,
      ).run(risk.score, risk.level, JSON.stringify(risk.signals), id);

      if (risk.action === 'hard_freeze') {
        const failed = updateStatus(created, 'failed', { failure_reason: `risk:${risk.level} (${risk.signals.join(',')})` });
        recordEvent(id, 'risk_blocked', 'initiated', 'failed', { score: risk.score, level: risk.level, signals: risk.signals });
        publish('payment.failed', { payment: failed, reason: 'risk_blocked' }, 'payments');
        publish('fraud.scored', { payment_id: pid, score: risk.score, level: risk.level, action: 'hard_freeze' }, 'payments');
        return { status: 201, body: { payment: failed, risk } };
      }

      /* Otherwise the intent is authorized and ready to be captured. */
      const authorized = updateStatus(created, 'authorized', {});
      recordEvent(id, 'authorized', 'initiated', 'authorized', { score: risk.score, level: risk.level });
      publish('payment.created', { payment: authorized, risk }, 'payments');
      publish('fraud.scored', { payment_id: pid, score: risk.score, level: risk.level, action: risk.action }, 'payments');
      log.info(`${pid} authorized (${b.kind} ${b.currency} ${amount.toString()}, risk=${risk.level})`);
      return { status: 201, body: { payment: authorized, risk } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

/** POST /payments/:id/capture — authorized → pending, posts the capture JE. */
app.post('/payments/:id/capture', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? `cap:${req.params.id}`).toString().trim();
    const p = getPayment(req.params.id);
    if (!p) bad(404, 'payment not found');

    const result = await withIdempotency(db, idemKey, { action: 'capture', payment: p.id, current: p.status }, async () => {
      if (p.status !== 'authorized') bad(409, `payment is ${p.status}, cannot capture`);

      const gross = m.fromDb(p.amount_minor);
      const fee   = m.fromDb(p.fee_amount_minor);
      const net   = gross - fee;

      /* Three-leg capture: pull from customer (available), credit merchant
       * (pending — settlement window), credit platform fee (immediate). */
      const postings: Array<{ account_id: string; side: 'debit' | 'credit'; amount_minor: string; effect?: 'available' | 'pending' | 'reserved' }> = [
        { account_id: p.from_account_id!, side: 'debit',  amount_minor: gross.toString(), effect: 'available' },
        { account_id: p.to_account_id!,   side: 'credit', amount_minor: net.toString(),   effect: 'pending' },
      ];
      if (fee > 0n && p.fee_account_id) {
        postings.push({ account_id: p.fee_account_id, side: 'credit', amount_minor: fee.toString(), effect: 'available' });
      }

      const ledgerRes = await postLedgerEntry(`cap:${p.public_id}`, `Capture for ${p.public_id}`, { payment_id: p.public_id, kind: p.kind }, postings);
      const updated = updateStatus(p, 'pending', { capture_je_id: ledgerRes.journal_entry.id, captured_at: new Date().toISOString() });
      recordEvent(p.id, 'captured', 'authorized', 'pending', { je_public_id: ledgerRes.journal_entry.public_id });
      publish('payment.captured', { payment: updated, journal_entry_id: ledgerRes.journal_entry.public_id }, 'payments');
      log.info(`${p.public_id} captured → ledger ${ledgerRes.journal_entry.public_id}`);
      return { status: 200, body: { payment: updated, journal_entry: ledgerRes.journal_entry } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

/** POST /payments/:id/settle — pending → settled, clears the pending bucket. */
app.post('/payments/:id/settle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? `set:${req.params.id}`).toString().trim();
    const p = getPayment(req.params.id);
    if (!p) bad(404, 'payment not found');

    const result = await withIdempotency(db, idemKey, { action: 'settle', payment: p.id, current: p.status }, async () => {
      if (p.status !== 'pending' && p.status !== 'processing') bad(409, `payment is ${p.status}, cannot settle`);

      const net = m.fromDb(p.amount_minor) - m.fromDb(p.fee_amount_minor);
      const ledgerRes = await postLedgerEntry(
        `set:${p.public_id}`,
        `Settlement for ${p.public_id}`,
        { payment_id: p.public_id, kind: p.kind },
        [
          { account_id: p.to_account_id!, side: 'debit',  amount_minor: net.toString(), effect: 'pending' },
          { account_id: p.to_account_id!, side: 'credit', amount_minor: net.toString(), effect: 'available' },
        ],
      );
      const updated = updateStatus(p, 'settled', { settle_je_id: ledgerRes.journal_entry.id, settled_at: new Date().toISOString() });
      recordEvent(p.id, 'settled', p.status, 'settled', { je_public_id: ledgerRes.journal_entry.public_id });
      publish('payment.settled', { payment: updated, journal_entry_id: ledgerRes.journal_entry.public_id }, 'payments');
      log.info(`${p.public_id} settled`);
      return { status: 200, body: { payment: updated, journal_entry: ledgerRes.journal_entry } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

/** POST /payments/:id/refund — settled → refunded (reverses capture + settle). */
app.post('/payments/:id/refund', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? `ref:${req.params.id}`).toString().trim();
    const p = getPayment(req.params.id);
    if (!p) bad(404, 'payment not found');
    const reason = (req.body?.reason ?? 'merchant_initiated').toString();

    const result = await withIdempotency(db, idemKey, { action: 'refund', payment: p.id, current: p.status, reason }, async () => {
      if (p.status !== 'settled') bad(409, `payment is ${p.status}, can only refund a settled payment`);
      if (!p.capture_je_id) bad(409, 'payment has no capture journal entry to reverse');

      /* Reverse the SETTLE JE first (so the merchant available balance
       * comes down before the capture reversal makes the customer whole). */
      if (p.settle_je_id) {
        await postLedgerReversal(`refset:${p.public_id}`, p.settle_je_id, reason);
      }
      const captureRev = await postLedgerReversal(`refcap:${p.public_id}`, p.capture_je_id, reason);
      const updated = updateStatus(p, 'refunded', { refund_je_id: captureRev.reversal.id, refunded_at: new Date().toISOString(), failure_reason: reason });
      recordEvent(p.id, 'refunded', 'settled', 'refunded', { reason, reversal_public_id: captureRev.reversal.public_id });
      publish('payment.refunded', { payment: updated, reversal_public_id: captureRev.reversal.public_id }, 'payments');
      log.info(`${p.public_id} refunded → reversal ${captureRev.reversal.public_id}`);
      return { status: 200, body: { payment: updated, reversal: captureRev.reversal } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

/** POST /payments/:id/cancel — authorized/pending → failed, reverses any posted ledger entries. */
app.post('/payments/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? `cnc:${req.params.id}`).toString().trim();
    const p = getPayment(req.params.id);
    if (!p) bad(404, 'payment not found');
    const reason = (req.body?.reason ?? 'merchant_cancelled').toString();

    const result = await withIdempotency(db, idemKey, { action: 'cancel', payment: p.id, current: p.status, reason }, async () => {
      if (p.status !== 'authorized' && p.status !== 'pending') bad(409, `payment is ${p.status}, cannot cancel`);
      let reverseRef: string | null = null;
      if (p.capture_je_id) {
        const rev = await postLedgerReversal(`cnc:${p.public_id}`, p.capture_je_id, reason);
        reverseRef = rev.reversal.public_id;
      }
      const updated = updateStatus(p, 'failed', { failure_reason: `cancelled:${reason}`, reverse_je_id: reverseRef ? reverseRef : null });
      recordEvent(p.id, 'cancelled', p.status, 'failed', { reason, reversal_public_id: reverseRef });
      publish('payment.failed', { payment: updated, reason: 'cancelled' }, 'payments');
      log.info(`${p.public_id} cancelled`);
      return { status: 200, body: { payment: updated, reversal_public_id: reverseRef } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

/** GET /payments — list with filters. */
app.get('/payments', (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: string[] = [];
    const params: any[] = [];
    const q = req.query as Record<string, string | undefined>;
    if (q.merchant_id) { where.push('merchant_id = ?'); params.push(q.merchant_id); }
    if (q.status)      { where.push('status = ?');      params.push(q.status); }
    if (q.kind)        { where.push('kind = ?');        params.push(q.kind); }
    if (q.currency)    { where.push('currency = ?');    params.push(q.currency); }
    if (q.risk_level)  { where.push('risk_level = ?');  params.push(q.risk_level); }
    if (q.search)      {
      where.push('(public_id LIKE ? OR description LIKE ? OR metadata_json LIKE ?)');
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }
    const limit  = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const sql = `SELECT * FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, limit, offset);
    const totalSql = `SELECT COUNT(*) as c FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = (db.prepare(totalSql).get(...params) as { c: number }).c;
    res.json({ payments: rows, total });
  } catch (e) { next(e); }
});

/** GET /payments/:id — single payment + its event timeline. */
app.get('/payments/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const p = getPayment(req.params.id);
    if (!p) bad(404, 'payment not found');
    const events = db.prepare<[string], any>(`SELECT * FROM payment_events WHERE payment_id = ? ORDER BY occurred_at ASC, id ASC`).all(p.id);
    res.json({ payment: p, events });
  } catch (e) { next(e); }
});

/** GET /stats — quick aggregates for dashboards. */
app.get('/stats', (_req: Request, res: Response) => {
  const total      = (db.prepare(`SELECT COUNT(*) as c FROM payments`).get() as { c: number }).c;
  const byStatus   = db.prepare(`SELECT status, COUNT(*) as c FROM payments GROUP BY status`).all();
  const byCurrency = db.prepare(`SELECT currency, COUNT(*) as c, SUM(CAST(amount_minor AS INTEGER)) as gross FROM payments GROUP BY currency`).all();
  const byKind     = db.prepare(`SELECT kind, COUNT(*) as c FROM payments GROUP BY kind`).all();
  const recentVol  = db.prepare(`SELECT COUNT(*) as c, SUM(CAST(amount_minor AS INTEGER)) as gross FROM payments WHERE created_at > datetime('now','-24 hours')`).get();
  res.json({ total, by_status: byStatus, by_currency: byCurrency, by_kind: byKind, last_24h: recentVol });
});

/* ── Background expirer ────────────────────────────────────────────
 * Payments that sit in 'initiated' or 'authorized' for too long
 * auto-expire.  In a real system the window would be configurable
 * per kind (cards: 7 days, ACH: 90 days).  Here we use a fixed 30
 * minutes for demo purposes. */
function runExpirer(): number {
  const stale = db.prepare<[], { id: string; public_id: string; status: PaymentStatus }>(
    `SELECT id, public_id, status FROM payments
     WHERE status IN ('initiated','authorized') AND created_at < datetime('now','-30 minutes')`,
  ).all();
  let count = 0;
  for (const s of stale) {
    try {
      const full = getPayment(s.id)!;
      const expired = updateStatus(full, 'expired', { failure_reason: 'auto_expired' });
      recordEvent(s.id, 'expired', s.status, 'expired', { policy: '30m' });
      publish('payment.failed', { payment: expired, reason: 'expired' }, 'payments');
      count++;
    } catch (e) { log.warn(`expirer failed on ${s.public_id}`, e); }
  }
  return count;
}

/* ── Boot ─────────────────────────────────────────────────────────── */

start(app, port, 'payments', () => {
  setInterval(() => {
    try { const n = runExpirer(); if (n > 0) log.info(`expirer swept ${n} stale intent(s)`); }
    catch (e) { log.error('expirer crashed', e); }
  }, 60_000);
  log.info('expirer armed (60s cadence, 30m policy)');

  /* Listen for ledger reversal events that pertain to one of our
   * payments — keeps the payment status in sync if the ledger is
   * manually reversed (e.g. via an operator using /reversals). */
  subscribe<{ original_id: string; reversal_public_id: string }>('ledger.reversed', 'payments-tracker', (evt) => {
    const linked = db.prepare<[string, string], PaymentRow>(
      `SELECT * FROM payments WHERE capture_je_id = ? OR settle_je_id = ?`,
    ).get(evt.payload.original_id, evt.payload.original_id);
    if (!linked) return;
    if (linked.status === 'settled' || linked.status === 'pending') {
      try {
        const updated = updateStatus(linked, 'reversed', { reverse_je_id: evt.payload.reversal_public_id });
        recordEvent(linked.id, 'auto_reversed', linked.status, 'reversed', { reversal_public_id: evt.payload.reversal_public_id });
        publish('payment.failed', { payment: updated, reason: 'ledger_reversal' }, 'payments');
      } catch (e) { log.warn(`auto-reverse on ${linked.public_id} skipped`, e); }
    }
  });
});
