/**
 * Idempotency engine.
 *
 *   const r = withIdempotency(db, key, requestBody, () => doWork());
 *
 * On first call for `key` we:
 *   1. Insert a row (key, request_hash) in state='in_flight'.  If two
 *      requests race the unique constraint loses one → we throw 409.
 *   2. Run the worker; capture its (status, body) response.
 *   3. UPDATE the row to state='completed' + cache the response.
 *
 * Subsequent calls with the same key:
 *   • same payload                  → return the cached response (idempotent)
 *   • different payload             → throw 409 (replay protection)
 *   • TTL expired                   → behave as a fresh call
 *
 * Keys live for 24 hours by default.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface IdempotentResponse<T> { status: number; body: T; }

const DEFAULT_TTL_HOURS = 24;

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      status TEXT NOT NULL DEFAULT 'in_flight' CHECK(status IN ('in_flight','completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);
  `);
}

function hashRequest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export class IdempotencyConflictError extends Error {
  constructor(public reason: string) { super(reason); this.name = 'IdempotencyConflictError'; }
}

/**
 * Wrap a worker so that calling it twice with the same key returns the
 * same response without re-executing.  THROWS:
 *   - IdempotencyConflictError when the same key arrives with a
 *     different payload (409 territory).
 */
export async function withIdempotency<T>(
  db: Database.Database,
  key: string,
  payload: unknown,
  worker: () => Promise<IdempotentResponse<T>> | IdempotentResponse<T>,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<IdempotentResponse<T>> {
  ensureSchema(db);
  const hash = hashRequest(payload);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

  // Prune obvious-expired rows opportunistically.
  db.prepare(`DELETE FROM idempotency_keys WHERE expires_at < datetime('now')`).run();

  // Step 1 — try to reserve the slot.  If insert fails because a row
  // already exists, fall through to step 2 (lookup).
  let reserved = false;
  try {
    db.prepare(
      `INSERT INTO idempotency_keys (key, request_hash, status, expires_at) VALUES (?, ?, 'in_flight', ?)`,
    ).run(key, hash, expiresAt);
    reserved = true;
  } catch (e: any) {
    if (!String(e?.message ?? '').includes('UNIQUE')) throw e;
  }

  if (reserved) {
    // We own this key; do the work.
    try {
      const res = await worker();
      db.prepare(
        `UPDATE idempotency_keys SET response_status = ?, response_body = ?, status = 'completed', completed_at = datetime('now') WHERE key = ?`,
      ).run(res.status, JSON.stringify(res.body ?? null), key);
      return res;
    } catch (workerErr) {
      // Roll the key back so the client can retry without 409.
      db.prepare(`DELETE FROM idempotency_keys WHERE key = ? AND status = 'in_flight'`).run(key);
      throw workerErr;
    }
  }

  // Step 2 — someone already reserved it.  Inspect and decide.
  const existing = db.prepare<[string], any>(`SELECT * FROM idempotency_keys WHERE key = ?`).get(key);
  if (!existing) {
    // Race: row got deleted between our insert + select.  Retry once.
    return withIdempotency(db, key, payload, worker, ttlHours);
  }
  if (existing.request_hash !== hash) {
    throw new IdempotencyConflictError(`idempotency key reused with a different payload`);
  }
  if (existing.status === 'in_flight') {
    // Another worker is processing the same request.  Spin-wait briefly.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const fresh = db.prepare<[string], any>(`SELECT * FROM idempotency_keys WHERE key = ?`).get(key);
      if (fresh?.status === 'completed') {
        return { status: fresh.response_status, body: JSON.parse(fresh.response_body || 'null') as T };
      }
    }
    throw new IdempotencyConflictError('in-flight idempotent request did not settle in time');
  }
  // Already completed → return the cached response.
  return { status: existing.response_status, body: JSON.parse(existing.response_body || 'null') as T };
}
