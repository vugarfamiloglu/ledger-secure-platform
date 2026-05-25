/**
 * Ledger Service (port 5111).
 *
 * The double-entry engine that every other service ultimately writes
 * through.  Three concerns live here:
 *
 *   1. Accounts                — typed account registry per merchant
 *   2. Journal entries (JEs)   — append-only, immutable, multi-leg
 *   3. Postings                — the individual debit/credit legs
 *
 * Invariants enforced inside the same SQLite transaction as the write:
 *
 *   • SUM(debits) == SUM(credits) for every JE, per currency
 *   • Every posting references an existing, currency-matched account
 *   • Reversals create NEW journal entries (the original stays untouched)
 *   • Journal entries / postings cannot be updated or deleted (triggers)
 *
 * Background invariant scanner re-checks the ledger every 30s and logs
 * a screaming warning if anything has drifted.  In production this
 * would page on-call.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, publicId, uuid } from '../../lib/db';
import { withIdempotency, IdempotencyConflictError } from '../../lib/idempotency';
import { publish } from '../../lib/broker';
import { m } from '../../lib/money';
import type { AccountType, Currency } from '../../lib/types';
import type { Request, Response, NextFunction } from 'express';

const { app, log, port } = bootService({
  name: 'ledger',
  port: Number(process.env.LEDGER_LEDGER_PORT ?? 5111),
});

const db = openDb('ledger');

/* ── Schema ───────────────────────────────────────────────────────── */

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id                TEXT PRIMARY KEY,
    public_id         TEXT UNIQUE NOT NULL,
    merchant_id       TEXT,
    type              TEXT NOT NULL,
    currency          TEXT NOT NULL,
    name              TEXT NOT NULL,
    balance_available TEXT NOT NULL DEFAULT '0',
    balance_pending   TEXT NOT NULL DEFAULT '0',
    balance_reserved  TEXT NOT NULL DEFAULT '0',
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_merchant ON accounts(merchant_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_type     ON accounts(type);

  CREATE TABLE IF NOT EXISTS journal_entries (
    id            TEXT PRIMARY KEY,
    public_id     TEXT UNIQUE NOT NULL,
    description   TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    posted_at     TEXT NOT NULL DEFAULT (datetime('now')),
    reversal_of   TEXT REFERENCES journal_entries(id)
  );
  CREATE INDEX IF NOT EXISTS idx_je_posted_at ON journal_entries(posted_at);
  CREATE INDEX IF NOT EXISTS idx_je_reversal  ON journal_entries(reversal_of);

  CREATE TABLE IF NOT EXISTS postings (
    id               TEXT PRIMARY KEY,
    journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
    account_id       TEXT NOT NULL REFERENCES accounts(id),
    amount_minor     TEXT NOT NULL,
    currency         TEXT NOT NULL,
    side             TEXT NOT NULL CHECK(side IN ('debit','credit')),
    effect           TEXT NOT NULL DEFAULT 'available' CHECK(effect IN ('available','pending','reserved')),
    position         INTEGER NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id);
  CREATE INDEX IF NOT EXISTS idx_postings_je      ON postings(journal_entry_id);
`);

/* Immutability — append-only journal & postings.  SQLite triggers fire
 * inside the transaction, so any rogue UPDATE/DELETE aborts the txn. */
const triggerExists = (name: string) =>
  !!db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`).get(name);

if (!triggerExists('je_no_update')) {
  db.exec(`CREATE TRIGGER je_no_update BEFORE UPDATE ON journal_entries
           BEGIN SELECT RAISE(ABORT, 'journal entries are append-only'); END;`);
}
if (!triggerExists('je_no_delete')) {
  db.exec(`CREATE TRIGGER je_no_delete BEFORE DELETE ON journal_entries
           BEGIN SELECT RAISE(ABORT, 'journal entries cannot be deleted'); END;`);
}
if (!triggerExists('postings_no_update')) {
  db.exec(`CREATE TRIGGER postings_no_update BEFORE UPDATE ON postings
           BEGIN SELECT RAISE(ABORT, 'postings are append-only'); END;`);
}
if (!triggerExists('postings_no_delete')) {
  db.exec(`CREATE TRIGGER postings_no_delete BEFORE DELETE ON postings
           BEGIN SELECT RAISE(ABORT, 'postings cannot be deleted'); END;`);
}

/* ── Account-type orientation ─────────────────────────────────────────
 * Whether an account "naturally" carries a debit or credit balance.
 * Used purely for presentation — the invariant scanner doesn't care. */
const NORMAL_SIDE: Record<AccountType, 'debit' | 'credit'> = {
  treasury:   'debit',   // platform's own cash → asset
  fx_pool:    'debit',
  settlement: 'debit',
  escrow:     'debit',
  external:   'debit',
  merchant:   'credit',  // platform owes the merchant → liability
  customer:   'credit',
  reserve:    'credit',
  dispute:    'credit',
  fee:        'credit',  // platform's earned revenue
};

/* ── Helpers ─────────────────────────────────────────────────────── */

interface PostingInput {
  account_id: string;
  amount_minor: string | number;
  side: 'debit' | 'credit';
  effect?: 'available' | 'pending' | 'reserved';
}

interface PostingRow {
  id: string;
  journal_entry_id: string;
  account_id: string;
  amount_minor: string;
  currency: Currency;
  side: 'debit' | 'credit';
  effect: 'available' | 'pending' | 'reserved';
  position: number;
}

interface AccountRow {
  id: string;
  public_id: string;
  merchant_id: string | null;
  type: AccountType;
  currency: Currency;
  name: string;
  balance_available: string;
  balance_pending: string;
  balance_reserved: string;
  is_active: number;
  created_at: string;
}

function getAccount(id: string): AccountRow | undefined {
  return db.prepare<[string], AccountRow>(`SELECT * FROM accounts WHERE id = ?`).get(id);
}

function decorateAccount(a: AccountRow) {
  const sign = NORMAL_SIDE[a.type] === 'credit' ? -1n : 1n;
  const adj = (raw: string) => (m.fromDb(raw) * sign).toString();
  return {
    ...a,
    is_active: Boolean(a.is_active),
    normal_side: NORMAL_SIDE[a.type],
    /** Same fields, oriented so a "positive" number is what humans expect for the account type. */
    balance_available_oriented: adj(a.balance_available),
    balance_pending_oriented:   adj(a.balance_pending),
    balance_reserved_oriented:  adj(a.balance_reserved),
    balance_total_oriented:     (
      (m.fromDb(a.balance_available) + m.fromDb(a.balance_pending) + m.fromDb(a.balance_reserved)) * sign
    ).toString(),
  };
}

/**
 * Stage-1 validation: shape, account existence, currency match, balance
 * equation per currency.  Throws via `bad(...)` on failure.
 */
function validatePostings(rawPostings: PostingInput[]): {
  prepared: Array<PostingRow & { delta: bigint }>;
  currencies: Set<Currency>;
} {
  if (!Array.isArray(rawPostings) || rawPostings.length < 2) {
    bad(422, 'journal entry must have at least two postings');
  }
  const prepared: Array<PostingRow & { delta: bigint }> = [];
  const currencies = new Set<Currency>();
  const sumsByCurrency = new Map<Currency, bigint>();

  rawPostings.forEach((p, i) => {
    if (!p.account_id) bad(422, `posting #${i + 1}: account_id required`);
    if (p.side !== 'debit' && p.side !== 'credit') bad(422, `posting #${i + 1}: side must be debit|credit`);
    const acct = getAccount(p.account_id);
    if (!acct) bad(404, `posting #${i + 1}: account ${p.account_id} not found`);
    if (!acct.is_active) bad(409, `posting #${i + 1}: account ${acct.public_id} is inactive`);

    let amt: bigint;
    try { amt = BigInt(String(p.amount_minor).trim()); }
    catch { bad(422, `posting #${i + 1}: amount_minor must be an integer string`); }
    if (amt <= 0n) bad(422, `posting #${i + 1}: amount_minor must be strictly positive`);

    /* The stored amount carries the SIGN of the operation; balance math
     * then becomes a single SUM().  Debit = +, credit = -. */
    const signed = p.side === 'debit' ? amt : -amt;
    const effect = p.effect ?? 'available';
    if (effect !== 'available' && effect !== 'pending' && effect !== 'reserved') {
      bad(422, `posting #${i + 1}: effect must be available|pending|reserved`);
    }

    prepared.push({
      id: uuid(),
      journal_entry_id: '',         // filled by caller after JE row is created
      account_id: acct.id,
      amount_minor: signed.toString(),
      currency: acct.currency,
      side: p.side,
      effect,
      position: i + 1,
      delta: signed,
    });
    currencies.add(acct.currency);
    sumsByCurrency.set(acct.currency, (sumsByCurrency.get(acct.currency) ?? 0n) + signed);
  });

  /* Invariant: debits and credits net to zero PER currency.  Cross-
   * currency entries are valid (an FX execution will have a non-zero
   * USD leg AND a non-zero EUR leg), but each must self-balance. */
  for (const [cur, sum] of sumsByCurrency.entries()) {
    if (sum !== 0n) {
      bad(422, `unbalanced ${cur} legs: net = ${sum.toString()} minor units (debits must equal credits)`);
    }
  }
  return { prepared, currencies };
}

/** Apply the signed delta to the right balance bucket on an account row. */
function applyDelta(accountId: string, effect: 'available' | 'pending' | 'reserved', delta: bigint): void {
  const col = effect === 'available' ? 'balance_available'
            : effect === 'pending'   ? 'balance_pending'
            : 'balance_reserved';
  const row = db.prepare<[string], { v: string }>(`SELECT ${col} as v FROM accounts WHERE id = ?`).get(accountId);
  const next = m.fromDb(row?.v ?? '0') + delta;
  db.prepare(`UPDATE accounts SET ${col} = ? WHERE id = ?`).run(m.toDb(next), accountId);
}

/* ── Routes ───────────────────────────────────────────────────────── */

app.post('/accounts', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { merchant_id, type, currency, name } = req.body ?? {};
    if (!type)     bad(422, 'type is required');
    if (!currency) bad(422, 'currency is required');
    if (!name)     bad(422, 'name is required');
    if (!(type in NORMAL_SIDE)) bad(422, `unknown account type "${type}"`);

    const id = uuid();
    const pid = publicId('ACC');
    db.prepare(
      `INSERT INTO accounts (id, public_id, merchant_id, type, currency, name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, pid, merchant_id ?? null, type, currency, name);
    const row = getAccount(id)!;
    log.info(`account ${pid} created (${type}/${currency})`);
    res.status(201).json({ account: decorateAccount(row) });
  } catch (e) { next(e); }
});

app.get('/accounts', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { merchant_id, type, currency } = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const params: any[] = [];
    if (merchant_id) { where.push('merchant_id = ?'); params.push(merchant_id); }
    if (type)        { where.push('type = ?');        params.push(type); }
    if (currency)    { where.push('currency = ?');    params.push(currency); }
    const sql = `SELECT * FROM accounts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    const rows = db.prepare(sql).all(...params) as AccountRow[];
    res.json({ accounts: rows.map(decorateAccount), total: rows.length });
  } catch (e) { next(e); }
});

app.get('/accounts/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = getAccount(req.params.id) ?? db.prepare<[string], AccountRow>(`SELECT * FROM accounts WHERE public_id = ?`).get(req.params.id);
    if (!a) bad(404, 'account not found');
    res.json({ account: decorateAccount(a) });
  } catch (e) { next(e); }
});

app.get('/accounts/:id/postings', (req: Request, res: Response, next: NextFunction) => {
  try {
    const a = getAccount(req.params.id) ?? db.prepare<[string], AccountRow>(`SELECT * FROM accounts WHERE public_id = ?`).get(req.params.id);
    if (!a) bad(404, 'account not found');
    const limit  = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const rows = db.prepare<[string, number, number], PostingRow & { posted_at: string; je_public_id: string; description: string }>(
      `SELECT p.*, je.posted_at as posted_at, je.public_id as je_public_id, je.description as description
       FROM postings p
       JOIN journal_entries je ON je.id = p.journal_entry_id
       WHERE p.account_id = ?
       ORDER BY je.posted_at DESC, p.position ASC
       LIMIT ? OFFSET ?`,
    ).all(a.id, limit, offset);
    res.json({ account: decorateAccount(a), postings: rows, total: rows.length });
  } catch (e) { next(e); }
});

/* POST /entries — atomically post a multi-leg journal entry.  The
 * Idempotency-Key header (preferred) or top-level `idempotency_key`
 * field makes this safe to retry under network loss.                  */
app.post('/entries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? req.body?.idempotency_key ?? '').toString().trim();
    if (!idemKey) bad(400, 'Idempotency-Key header is required');

    const { description, metadata, postings: rawPostings } = req.body ?? {};
    if (!description) bad(422, 'description is required');

    const result = await withIdempotency(db, idemKey, req.body, () => {
      const { prepared } = validatePostings(rawPostings);

      /* Wrap everything in a single SQLite transaction → all-or-nothing.
       * better-sqlite3's .transaction() bumps to an immediate-mode
       * write lock, giving us serial-equivalent isolation for the
       * duration of the entry. */
      const txn = db.transaction(() => {
        const jeId = uuid();
        const jePid = publicId('JE');
        db.prepare(
          `INSERT INTO journal_entries (id, public_id, description, metadata_json) VALUES (?, ?, ?, ?)`,
        ).run(jeId, jePid, description, JSON.stringify(metadata ?? {}));

        const insertPosting = db.prepare(
          `INSERT INTO postings (id, journal_entry_id, account_id, amount_minor, currency, side, effect, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const accountTouches = new Map<string, { account_id: string; deltas: bigint[] }>();
        for (const p of prepared) {
          insertPosting.run(p.id, jeId, p.account_id, p.amount_minor, p.currency, p.side, p.effect, p.position);
          applyDelta(p.account_id, p.effect, p.delta);
          if (!accountTouches.has(p.account_id)) accountTouches.set(p.account_id, { account_id: p.account_id, deltas: [] });
          accountTouches.get(p.account_id)!.deltas.push(p.delta);
        }
        return { jeId, jePid, accountTouches };
      });

      const { jeId, jePid, accountTouches } = txn();

      /* Event publication is OUTSIDE the txn — the broker has its own
       * DB connection.  This is fine because the broker delivers
       * at-least-once and consumers must be idempotent anyway. */
      const postingsForEvent = db.prepare<[string], PostingRow>(`SELECT * FROM postings WHERE journal_entry_id = ? ORDER BY position`).all(jeId);
      publish('ledger.posted', {
        journal_entry_id: jeId,
        journal_entry_public_id: jePid,
        description,
        postings: postingsForEvent,
      }, 'ledger');

      for (const t of accountTouches.values()) {
        const a = getAccount(t.account_id)!;
        publish('balance.updated', {
          account_id: a.id,
          account_public_id: a.public_id,
          currency: a.currency,
          balance_available: a.balance_available,
          balance_pending:   a.balance_pending,
          balance_reserved:  a.balance_reserved,
        }, 'ledger');
      }

      const je = db.prepare(`SELECT * FROM journal_entries WHERE id = ?`).get(jeId);
      log.info(`JE ${jePid} posted: ${prepared.length} legs, ${postingsForEvent.length} touches`);
      return { status: 201, body: { journal_entry: je, postings: postingsForEvent } };
    });

    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) {
      res.status(409).json({ error: e.message });
      return;
    }
    next(e);
  }
});

app.get('/entries', (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit  = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const rows = db.prepare(`SELECT * FROM journal_entries ORDER BY posted_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) as c FROM journal_entries`).get() as { c: number }).c;
    res.json({ entries: rows, total });
  } catch (e) { next(e); }
});

app.get('/entries/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const je = db.prepare(`SELECT * FROM journal_entries WHERE id = ? OR public_id = ?`).get(req.params.id, req.params.id);
    if (!je) bad(404, 'journal entry not found');
    const postings = db.prepare(`SELECT * FROM postings WHERE journal_entry_id = ? ORDER BY position`).all((je as any).id);
    res.json({ entry: je, postings });
  } catch (e) { next(e); }
});

/* POST /reversals — mirror a JE with opposite signs into a NEW entry.
 * The original is never touched (immutability) and is linked via
 * reversal_of so the audit trail stays intact. */
app.post('/reversals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idemKey = (req.header('Idempotency-Key') ?? req.body?.idempotency_key ?? '').toString().trim();
    if (!idemKey) bad(400, 'Idempotency-Key header is required');
    const { journal_entry_id, reason } = req.body ?? {};
    if (!journal_entry_id) bad(422, 'journal_entry_id is required');

    const result = await withIdempotency(db, idemKey, req.body, () => {
      const orig = db.prepare(`SELECT * FROM journal_entries WHERE id = ? OR public_id = ?`).get(journal_entry_id, journal_entry_id) as any;
      if (!orig) bad(404, 'original journal entry not found');
      if (orig.reversal_of) bad(409, 'cannot reverse a reversal');
      const already = db.prepare(`SELECT id FROM journal_entries WHERE reversal_of = ?`).get(orig.id);
      if (already) bad(409, 'journal entry already reversed');

      const originals = db.prepare<[string], PostingRow>(`SELECT * FROM postings WHERE journal_entry_id = ? ORDER BY position`).all(orig.id);

      const txn = db.transaction(() => {
        const jeId = uuid();
        const jePid = publicId('JE');
        db.prepare(
          `INSERT INTO journal_entries (id, public_id, description, metadata_json, reversal_of) VALUES (?, ?, ?, ?, ?)`,
        ).run(jeId, jePid, `REVERSAL of ${orig.public_id}${reason ? ` — ${reason}` : ''}`, JSON.stringify({ reason }), orig.id);

        const insertPosting = db.prepare(
          `INSERT INTO postings (id, journal_entry_id, account_id, amount_minor, currency, side, effect, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const accountTouches = new Set<string>();
        for (const p of originals) {
          const flippedAmt = (-m.fromDb(p.amount_minor)).toString();
          const flippedSide = p.side === 'debit' ? 'credit' : 'debit';
          insertPosting.run(uuid(), jeId, p.account_id, flippedAmt, p.currency, flippedSide, p.effect, p.position);
          applyDelta(p.account_id, p.effect, -m.fromDb(p.amount_minor));
          accountTouches.add(p.account_id);
        }
        return { jeId, jePid, accountTouches };
      });

      const { jeId, jePid, accountTouches } = txn();
      const reversal   = db.prepare(`SELECT * FROM journal_entries WHERE id = ?`).get(jeId);
      const postings   = db.prepare<[string], PostingRow>(`SELECT * FROM postings WHERE journal_entry_id = ? ORDER BY position`).all(jeId);

      publish('ledger.reversed', {
        original_id: orig.id,
        original_public_id: orig.public_id,
        reversal_id: jeId,
        reversal_public_id: jePid,
        reason: reason ?? null,
      }, 'ledger');
      for (const accId of accountTouches) {
        const a = getAccount(accId)!;
        publish('balance.updated', {
          account_id: a.id,
          account_public_id: a.public_id,
          currency: a.currency,
          balance_available: a.balance_available,
          balance_pending:   a.balance_pending,
          balance_reserved:  a.balance_reserved,
        }, 'ledger');
      }
      log.info(`JE ${jePid} reversed ${orig.public_id}`);
      return { status: 201, body: { reversal, postings } };
    });

    res.status(result.status).json(result.body);
  } catch (e: any) {
    if (e instanceof IdempotencyConflictError) {
      res.status(409).json({ error: e.message });
      return;
    }
    next(e);
  }
});

/* ── Invariant scanner ───────────────────────────────────────────────
 * Re-derives every account balance from postings and compares to the
 * cached row.  Also re-checks the per-JE per-currency net-zero rule.
 * In production this would page on-call if anything is off. */
function runInvariantScan(): { ok: boolean; balance_drift: number; unbalanced_entries: number; checked_at: string } {
  const drift = db.prepare(`
    SELECT a.id, a.public_id, a.balance_available, a.balance_pending, a.balance_reserved,
      COALESCE((SELECT SUM(CAST(amount_minor AS INTEGER)) FROM postings WHERE account_id = a.id AND effect = 'available'), 0) as derived_available,
      COALESCE((SELECT SUM(CAST(amount_minor AS INTEGER)) FROM postings WHERE account_id = a.id AND effect = 'pending'),   0) as derived_pending,
      COALESCE((SELECT SUM(CAST(amount_minor AS INTEGER)) FROM postings WHERE account_id = a.id AND effect = 'reserved'),  0) as derived_reserved
    FROM accounts a
  `).all() as Array<{
    id: string; public_id: string;
    balance_available: string; balance_pending: string; balance_reserved: string;
    derived_available: number | string; derived_pending: number | string; derived_reserved: number | string;
  }>;

  let driftCount = 0;
  for (const r of drift) {
    if (m.fromDb(r.balance_available) !== m.fromDb(r.derived_available)) {
      driftCount++; log.warn(`balance drift on ${r.public_id} available: cached=${r.balance_available} derived=${r.derived_available}`);
    }
    if (m.fromDb(r.balance_pending) !== m.fromDb(r.derived_pending)) {
      driftCount++; log.warn(`balance drift on ${r.public_id} pending: cached=${r.balance_pending} derived=${r.derived_pending}`);
    }
    if (m.fromDb(r.balance_reserved) !== m.fromDb(r.derived_reserved)) {
      driftCount++; log.warn(`balance drift on ${r.public_id} reserved: cached=${r.balance_reserved} derived=${r.derived_reserved}`);
    }
  }

  const unbalanced = db.prepare(`
    SELECT journal_entry_id, currency, SUM(CAST(amount_minor AS INTEGER)) as net
    FROM postings GROUP BY journal_entry_id, currency
    HAVING net != 0
  `).all() as Array<{ journal_entry_id: string; currency: string; net: number }>;
  for (const u of unbalanced) {
    log.warn(`unbalanced JE ${u.journal_entry_id} ${u.currency} net=${u.net}`);
  }

  return {
    ok: driftCount === 0 && unbalanced.length === 0,
    balance_drift: driftCount,
    unbalanced_entries: unbalanced.length,
    checked_at: new Date().toISOString(),
  };
}

app.get('/invariant', (_req: Request, res: Response) => res.json(runInvariantScan()));

/* Stats endpoint for the dashboard. */
app.get('/stats', (_req: Request, res: Response) => {
  const accountCount = (db.prepare(`SELECT COUNT(*) as c FROM accounts`).get() as { c: number }).c;
  const jeCount      = (db.prepare(`SELECT COUNT(*) as c FROM journal_entries`).get() as { c: number }).c;
  const postingCount = (db.prepare(`SELECT COUNT(*) as c FROM postings`).get() as { c: number }).c;
  const reversalCount = (db.prepare(`SELECT COUNT(*) as c FROM journal_entries WHERE reversal_of IS NOT NULL`).get() as { c: number }).c;
  const byType = db.prepare(`SELECT type, COUNT(*) as c FROM accounts GROUP BY type`).all();
  const byCurrency = db.prepare(`SELECT currency, COUNT(*) as c FROM accounts GROUP BY currency`).all();
  res.json({
    accounts: accountCount,
    journal_entries: jeCount,
    postings: postingCount,
    reversals: reversalCount,
    accounts_by_type: byType,
    accounts_by_currency: byCurrency,
  });
});

/* ── Boot ─────────────────────────────────────────────────────────── */

start(app, port, 'ledger', () => {
  /* Schedule invariant scan every 30s.  In dev this lives in-process; in
   * prod you'd run it as a sidecar so a crashing ledger doesn't take
   * the alarm system with it. */
  setInterval(() => {
    try {
      const r = runInvariantScan();
      if (!r.ok) log.error(`INVARIANT FAILURE drift=${r.balance_drift} unbalanced=${r.unbalanced_entries}`);
    } catch (e) { log.error('invariant scan crashed', e); }
  }, 30_000);
  log.info('invariant scanner armed (30s cadence)');
});
