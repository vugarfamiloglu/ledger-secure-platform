/**
 * FX Service (port 5113).
 *
 * Multi-currency conversion with rate-locking.  Two phase contract:
 *
 *   1. POST /quote        → reserves a price for N seconds.  Caller
 *                            gets a public quote_id back.
 *   2. POST /quote/:id/execute → posts the cross-currency journal
 *                            entry to the ledger, debiting the source
 *                            account and crediting the destination at
 *                            the locked rate.
 *
 * Rates live in a small in-memory cache keyed by `${base}/${quote}`,
 * seeded from /rates writes and bumped every minute by a tiny
 * "market simulator" (random walk ±25bp).  In production this would
 * read from a real provider feed (Reuters / OANDA / etc.).
 *
 * The cross-currency JE has two non-zero legs PER currency, but each
 * currency self-balances — the ledger invariant accepts that.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, publicId, uuid } from '../../lib/db';
import { withIdempotency, IdempotencyConflictError } from '../../lib/idempotency';
import { publish } from '../../lib/broker';
import { call } from '../../lib/http';
import { applyRate, m } from '../../lib/money';
import type { Currency } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'fx',
  port: Number(process.env.LEDGER_FX_PORT ?? 5113),
});

const db = openDb('fx');

/* ── Schema ───────────────────────────────────────────────────────── */

db.exec(`
  CREATE TABLE IF NOT EXISTS fx_rates (
    base_currency  TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    rate_scaled    TEXT NOT NULL,     -- bigint × 10^rate_scale
    rate_scale     INTEGER NOT NULL,
    source         TEXT NOT NULL DEFAULT 'manual',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (base_currency, quote_currency)
  );
  CREATE TABLE IF NOT EXISTS fx_quotes (
    id                 TEXT PRIMARY KEY,
    public_id          TEXT UNIQUE NOT NULL,
    base_currency      TEXT NOT NULL,
    quote_currency     TEXT NOT NULL,
    rate_scaled        TEXT NOT NULL,
    rate_scale         INTEGER NOT NULL,
    spread_bp          INTEGER NOT NULL DEFAULT 0,
    amount_minor       TEXT NOT NULL,        -- input amount in base
    amount_quote_minor TEXT NOT NULL,        -- pre-computed output in quote
    spread_minor       TEXT NOT NULL DEFAULT '0',
    from_account_id    TEXT,
    to_account_id      TEXT,
    spread_account_id  TEXT,
    status             TEXT NOT NULL DEFAULT 'open',
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at         TEXT NOT NULL,
    executed_at        TEXT,
    journal_entry_id   TEXT,
    metadata_json      TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_fx_quotes_status  ON fx_quotes(status);
  CREATE INDEX IF NOT EXISTS idx_fx_quotes_expires ON fx_quotes(expires_at);
`);

/* ── Seed rates (fall-back when no provider has pushed any yet) ───── */
const DEFAULT_RATE_SCALE = 8;
const SEED_RATES: Array<[Currency, Currency, number]> = [
  ['USD', 'EUR', 0.92], ['EUR', 'USD', 1.087],
  ['USD', 'GBP', 0.79], ['GBP', 'USD', 1.266],
  ['USD', 'AZN', 1.70], ['AZN', 'USD', 0.588],
  ['USD', 'TRY', 32.20], ['TRY', 'USD', 0.031],
  ['USD', 'AED', 3.67], ['AED', 'USD', 0.272],
  ['USD', 'JPY', 154.80], ['JPY', 'USD', 0.00646],
  ['EUR', 'GBP', 0.86], ['GBP', 'EUR', 1.163],
  ['EUR', 'TRY', 35.0], ['TRY', 'EUR', 0.0286],
  ['EUR', 'AZN', 1.85], ['AZN', 'EUR', 0.541],
];
function setRate(base: Currency, quote: Currency, rate: number, source: string): void {
  const scaled = BigInt(Math.round(rate * 10 ** DEFAULT_RATE_SCALE));
  db.prepare(
    `INSERT INTO fx_rates (base_currency, quote_currency, rate_scaled, rate_scale, source, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (base_currency, quote_currency)
     DO UPDATE SET rate_scaled = excluded.rate_scaled, rate_scale = excluded.rate_scale, source = excluded.source, updated_at = datetime('now')`,
  ).run(base, quote, scaled.toString(), DEFAULT_RATE_SCALE, source);
}
for (const [b, q, r] of SEED_RATES) {
  const existing = db.prepare<[string, string], any>(`SELECT 1 FROM fx_rates WHERE base_currency = ? AND quote_currency = ?`).get(b, q);
  if (!existing) setRate(b, q, r, 'seed');
}

interface RateRow { base_currency: Currency; quote_currency: Currency; rate_scaled: string; rate_scale: number; source: string; updated_at: string; }

function getRate(base: Currency, quote: Currency): RateRow {
  if (base === quote) {
    /* Identity — handy for symmetric APIs that don't want to special-case. */
    return { base_currency: base, quote_currency: quote, rate_scaled: (10n ** BigInt(DEFAULT_RATE_SCALE)).toString(), rate_scale: DEFAULT_RATE_SCALE, source: 'identity', updated_at: new Date().toISOString() };
  }
  const direct = db.prepare<[string, string], RateRow>(`SELECT * FROM fx_rates WHERE base_currency = ? AND quote_currency = ?`).get(base, quote);
  if (direct) return direct;
  /* Synthesise the cross via USD as the pivot if no direct rate exists. */
  const a = db.prepare<[string, string], RateRow>(`SELECT * FROM fx_rates WHERE base_currency = ? AND quote_currency = 'USD'`).get(base, 'USD');
  const b = db.prepare<[string, string], RateRow>(`SELECT * FROM fx_rates WHERE base_currency = 'USD' AND quote_currency = ?`).get('USD', quote);
  if (!a || !b) bad(404, `no rate available for ${base}/${quote}`);
  const cross = (m.fromDb(a.rate_scaled) * m.fromDb(b.rate_scaled)) / (10n ** BigInt(a.rate_scale));
  return { base_currency: base, quote_currency: quote, rate_scaled: cross.toString(), rate_scale: b.rate_scale, source: `synth:${a.base_currency}/USD * USD/${quote}`, updated_at: new Date().toISOString() };
}

/* ── Routes ───────────────────────────────────────────────────────── */

app.get('/rates', (_req: Request, res: Response) => {
  const rows = db.prepare(`SELECT * FROM fx_rates ORDER BY base_currency, quote_currency`).all() as RateRow[];
  const decorated = rows.map((r) => ({
    ...r,
    rate_human: Number(m.fromDb(r.rate_scaled)) / 10 ** r.rate_scale,
  }));
  res.json({ rates: decorated, total: decorated.length });
});

app.post('/rates', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { base_currency, quote_currency, rate, source } = req.body ?? {};
    if (!base_currency || !quote_currency || rate == null) bad(422, 'base_currency, quote_currency, rate required');
    if (Number(rate) <= 0) bad(422, 'rate must be > 0');
    setRate(base_currency, quote_currency, Number(rate), source ?? 'manual');
    log.info(`rate ${base_currency}/${quote_currency} = ${rate} (${source ?? 'manual'})`);
    res.status(201).json({ rate: getRate(base_currency, quote_currency) });
  } catch (e) { next(e); }
});

/**
 * POST /quote — lock a rate for ttl_seconds.
 *
 * Body: {
 *   base_currency, quote_currency, amount_minor (in base),
 *   spread_bp (basis points platform takes; default 25),
 *   ttl_seconds (default 90),
 *   from_account_id?, to_account_id?, spread_account_id?
 * }
 * Header: Idempotency-Key (optional but recommended)
 */
app.post('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? req.body?.idempotency_key ?? `quote:${uuid()}`).toString().trim();
    const result = await withIdempotency(db, idemKey, req.body, () => {
      const b = req.body ?? {};
      if (!b.base_currency || !b.quote_currency) bad(422, 'base_currency, quote_currency required');
      if (b.base_currency === b.quote_currency) bad(422, 'base_currency and quote_currency must differ');
      if (!b.amount_minor) bad(422, 'amount_minor required (in minor units of base)');
      let amount: bigint;
      try { amount = BigInt(String(b.amount_minor)); }
      catch { bad(422, 'amount_minor must be an integer string'); }
      if (amount <= 0n) bad(422, 'amount_minor must be > 0');

      const rate = getRate(b.base_currency, b.quote_currency);
      const spreadBp = Math.max(0, Math.min(500, Number(b.spread_bp ?? 25)));
      /* Apply spread by shaving the customer's effective rate.  Spread
       * lives in the quote currency so we can post it cleanly to a
       * single fee/spread account.                                    */
      const grossQuote   = applyRate(amount, m.fromDb(rate.rate_scaled), rate.rate_scale, 'bank');
      const spreadAmount = (grossQuote * BigInt(spreadBp)) / 10_000n;
      const netQuote     = grossQuote - spreadAmount;

      const ttl = Math.max(30, Math.min(600, Number(b.ttl_seconds ?? 90)));
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString().slice(0, 19).replace('T', ' ');

      const id = uuid();
      const pid = publicId('FXQ');
      db.prepare(
        `INSERT INTO fx_quotes (
          id, public_id, base_currency, quote_currency, rate_scaled, rate_scale, spread_bp,
          amount_minor, amount_quote_minor, spread_minor,
          from_account_id, to_account_id, spread_account_id, status, expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(
        id, pid, b.base_currency, b.quote_currency, rate.rate_scaled, rate.rate_scale, spreadBp,
        amount.toString(), netQuote.toString(), spreadAmount.toString(),
        b.from_account_id ?? null, b.to_account_id ?? null, b.spread_account_id ?? null,
        expiresAt, JSON.stringify(b.metadata ?? {}),
      );

      const quote = db.prepare(`SELECT * FROM fx_quotes WHERE id = ?`).get(id);
      publish('fx.quoted', { quote }, 'fx');
      log.info(`${pid} quoted ${b.base_currency}→${b.quote_currency} amt=${amount} → ${netQuote} (spread ${spreadAmount}, ttl ${ttl}s)`);
      return { status: 201, body: { quote } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

app.get('/quote/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = db.prepare(`SELECT * FROM fx_quotes WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!q) bad(404, 'quote not found');
    res.json({ quote: q });
  } catch (e) { next(e); }
});

app.get('/quotes', (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: string[] = [];
    const params: any[] = [];
    const q = req.query as Record<string, string | undefined>;
    if (q.status)         { where.push('status = ?');         params.push(q.status); }
    if (q.base_currency)  { where.push('base_currency = ?');  params.push(q.base_currency); }
    if (q.quote_currency) { where.push('quote_currency = ?'); params.push(q.quote_currency); }
    const limit  = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const sql = `SELECT * FROM fx_quotes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, limit, offset);
    res.json({ quotes: rows, total: rows.length });
  } catch (e) { next(e); }
});

/** POST /quote/:id/execute — post the cross-currency JE at the locked rate. */
app.post('/quote/:id/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? `exec:${req.params.id}`).toString().trim();
    const q = db.prepare<[string, string], any>(`SELECT * FROM fx_quotes WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!q) bad(404, 'quote not found');

    const result = await withIdempotency(db, idemKey, { action: 'execute', quote: q.id, status: q.status }, async () => {
      if (q.status === 'executed') bad(409, 'quote already executed');
      if (q.status === 'expired')  bad(409, 'quote expired');
      const expiresMs = new Date(q.expires_at.replace(' ', 'T') + 'Z').getTime();
      if (expiresMs < Date.now()) {
        db.prepare(`UPDATE fx_quotes SET status = 'expired' WHERE id = ?`).run(q.id);
        publish('fx.expired', { quote_id: q.id, public_id: q.public_id }, 'fx');
        bad(409, 'quote expired at execute-time');
      }
      const b = req.body ?? {};
      const fromId   = b.from_account_id   ?? q.from_account_id;
      const toId     = b.to_account_id     ?? q.to_account_id;
      const spreadId = b.spread_account_id ?? q.spread_account_id;
      if (!fromId || !toId) bad(422, 'from_account_id + to_account_id required (at quote or execute time)');

      const amountBase  = m.fromDb(q.amount_minor);
      const netQuote    = m.fromDb(q.amount_quote_minor);
      const spreadAmt   = m.fromDb(q.spread_minor);
      const grossQuote  = netQuote + spreadAmt;

      /* Four-leg cross-currency JE.  Each currency self-balances:
       *   base:  fromAccount (DEBIT amountBase) ↔ fxPoolBase (CREDIT amountBase)
       *   quote: fxPoolQuote (DEBIT grossQuote) ↔ toAccount (CREDIT netQuote)
       *                                          + spreadAccount (CREDIT spreadAmt)
       * (the platform's fxPool* accounts are auto-resolved by name) */
      const fxPoolBase  = await resolveOrCreateFxPool(q.base_currency);
      const fxPoolQuote = await resolveOrCreateFxPool(q.quote_currency);

      const postings: Array<{ account_id: string; side: 'debit' | 'credit'; amount_minor: string; effect?: 'available' | 'pending' | 'reserved' }> = [
        { account_id: fromId,       side: 'debit',  amount_minor: amountBase.toString() },
        { account_id: fxPoolBase,   side: 'credit', amount_minor: amountBase.toString() },
        { account_id: fxPoolQuote,  side: 'debit',  amount_minor: grossQuote.toString() },
        { account_id: toId,         side: 'credit', amount_minor: netQuote.toString() },
      ];
      if (spreadAmt > 0n && spreadId) {
        postings.push({ account_id: spreadId, side: 'credit', amount_minor: spreadAmt.toString() });
      } else if (spreadAmt > 0n) {
        /* No dedicated spread account → roll the spread back into the
         * fxPoolQuote (platform keeps the spread as treasury). */
        postings[2] = { account_id: fxPoolQuote, side: 'debit', amount_minor: netQuote.toString() };
      }

      const ledgerRes = await call<{ journal_entry: { id: string; public_id: string }; postings: any[] }>(
        'ledger', '/entries',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `fx:${q.public_id}` },
          body: JSON.stringify({
            description: `FX execute ${q.public_id} ${q.base_currency}→${q.quote_currency}`,
            metadata: { quote_public_id: q.public_id, base: q.base_currency, quote: q.quote_currency, rate_scaled: q.rate_scaled, rate_scale: q.rate_scale, spread_bp: q.spread_bp },
            postings,
          }),
          retries: 1,
        },
      );
      db.prepare(
        `UPDATE fx_quotes SET status = 'executed', executed_at = datetime('now'), journal_entry_id = ?,
         from_account_id = COALESCE(?, from_account_id), to_account_id = COALESCE(?, to_account_id), spread_account_id = COALESCE(?, spread_account_id)
         WHERE id = ?`,
      ).run(ledgerRes.journal_entry.id, fromId, toId, spreadId ?? null, q.id);
      const fresh = db.prepare(`SELECT * FROM fx_quotes WHERE id = ?`).get(q.id);
      publish('fx.executed', { quote: fresh, journal_entry_public_id: ledgerRes.journal_entry.public_id }, 'fx');
      log.info(`${q.public_id} executed → ledger ${ledgerRes.journal_entry.public_id}`);
      return { status: 200, body: { quote: fresh, journal_entry: ledgerRes.journal_entry } };
    });
    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) { res.status(409).json({ error: e.message }); return; }
    next(e);
  }
});

/* Auto-create / cache an fx_pool account per currency.  Pools are
 * platform-owned (no merchant) and live for the lifetime of the
 * deployment.  We round-trip through the ledger so the ledger remains
 * the single source of truth for "does this account exist?". */
const poolCache = new Map<Currency, string>();
async function resolveOrCreateFxPool(currency: Currency): Promise<string> {
  if (poolCache.has(currency)) return poolCache.get(currency)!;
  try {
    const list = await call<{ accounts: Array<{ id: string; type: string; currency: Currency; name: string }> }>(
      'ledger', `/accounts?type=fx_pool&currency=${currency}`, { method: 'GET', retries: 1 },
    );
    if (list.accounts.length > 0) {
      poolCache.set(currency, list.accounts[0].id);
      return list.accounts[0].id;
    }
  } catch (_e) { /* fall through to create */ }
  const created = await call<{ account: { id: string } }>('ledger', '/accounts', {
    method: 'POST',
    body: JSON.stringify({ type: 'fx_pool', currency, name: `FX Pool ${currency}` }),
    retries: 1,
  });
  poolCache.set(currency, created.account.id);
  log.info(`created fx_pool/${currency} ${created.account.id}`);
  return created.account.id;
}

/* ── Background market simulator + expirer ──────────────────────────
 * Small random walks on the seeded rates so the dashboard ticks look
 * alive.  In production this would be a feed from a real provider. */
function runMarket(): void {
  const rows = db.prepare(`SELECT * FROM fx_rates WHERE source IN ('seed','market')`).all() as RateRow[];
  for (const r of rows) {
    const cur = Number(m.fromDb(r.rate_scaled)) / 10 ** r.rate_scale;
    const drift = cur * ((Math.random() - 0.5) * 0.0025); // ±25bp
    setRate(r.base_currency, r.quote_currency, Math.max(cur + drift, 0.000001), 'market');
  }
}
function runQuoteExpirer(): number {
  const expired = db.prepare(`SELECT id, public_id FROM fx_quotes WHERE status = 'open' AND expires_at < datetime('now')`).all() as Array<{ id: string; public_id: string }>;
  for (const e of expired) {
    db.prepare(`UPDATE fx_quotes SET status = 'expired' WHERE id = ?`).run(e.id);
    publish('fx.expired', { quote_id: e.id, public_id: e.public_id }, 'fx');
  }
  return expired.length;
}

app.get('/stats', (_req: Request, res: Response) => {
  const total      = (db.prepare(`SELECT COUNT(*) as c FROM fx_quotes`).get() as { c: number }).c;
  const byStatus   = db.prepare(`SELECT status, COUNT(*) as c FROM fx_quotes GROUP BY status`).all();
  const byPair     = db.prepare(`SELECT base_currency, quote_currency, COUNT(*) as c FROM fx_quotes GROUP BY base_currency, quote_currency`).all();
  const rateCount  = (db.prepare(`SELECT COUNT(*) as c FROM fx_rates`).get() as { c: number }).c;
  res.json({ quotes_total: total, by_status: byStatus, by_pair: byPair, rates_tracked: rateCount });
});

start(app, port, 'fx', () => {
  setInterval(() => { try { runMarket(); } catch (e) { log.error('market tick crashed', e); } }, 60_000);
  setInterval(() => {
    try { const n = runQuoteExpirer(); if (n > 0) log.info(`expired ${n} stale quote(s)`); }
    catch (e) { log.error('quote expirer crashed', e); }
  }, 15_000);
  log.info(`seeded ${SEED_RATES.length} base rates, market ticks every 60s, expirer every 15s`);
});
