/**
 * Webhook Service (port 5116).
 *
 * Subscribes to the broker, finds every endpoint registered for the
 * relevant merchant, and POSTs each event as an HMAC-signed payload.
 * Failures are queued for exponential-backoff retry; after the max
 * attempt count is reached they drop into the dead-letter table where
 * an operator can replay them.
 *
 * Header on every delivery:
 *
 *   X-Ledger-Signature: t=<unix>,v1=<hex(hmac_sha256(secret, t + "." + body))>
 *   X-Ledger-Event:     <topic>
 *   X-Ledger-Delivery:  <delivery_id>
 *   X-Ledger-Attempt:   <n>
 *
 * Endpoints can verify with the matching helper in lib/hmac.ts.
 */

import { bootService, start, bad } from '../../lib/service-base';
import { openDb, publicId, uuid } from '../../lib/db';
import { publish, subscribe } from '../../lib/broker';
import { signPayload } from '../../lib/hmac';
import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { EventTopic } from '../../lib/types';

const { app, log, port } = bootService({
  name: 'webhook',
  port: Number(process.env.LEDGER_WEBHOOK_PORT ?? 5116),
});

const db = openDb('webhook');

db.exec(`
  CREATE TABLE IF NOT EXISTS endpoints (
    id            TEXT PRIMARY KEY,
    public_id     TEXT UNIQUE NOT NULL,
    merchant_id   TEXT NOT NULL,
    url           TEXT NOT NULL,
    secret        TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    topics_json   TEXT NOT NULL DEFAULT '[]',   -- empty = all
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_endpoints_merchant ON endpoints(merchant_id);

  CREATE TABLE IF NOT EXISTS deliveries (
    id                TEXT PRIMARY KEY,
    endpoint_id       TEXT NOT NULL REFERENCES endpoints(id),
    event_id          INTEGER NOT NULL,
    event_topic       TEXT NOT NULL,
    payload_json      TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    attempts          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   TEXT,
    last_status_code  INTEGER,
    last_error        TEXT,
    last_attempt_at   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_status   ON deliveries(status);
  CREATE INDEX IF NOT EXISTS idx_deliveries_next     ON deliveries(next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_deliveries_endpoint ON deliveries(endpoint_id);
`);

const MAX_ATTEMPTS = Math.max(1, Number(process.env.LEDGER_WEBHOOK_MAX_ATTEMPTS ?? 8));

/* ── Endpoints CRUD ──────────────────────────────────────────────── */

app.post('/endpoints', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { merchant_id, url, description, secret, topics } = req.body ?? {};
    if (!merchant_id) bad(422, 'merchant_id required');
    if (!url)         bad(422, 'url required');
    try { new URL(url); } catch { bad(422, 'url must be a valid URL'); }
    const id = uuid();
    const pid = publicId('WHE');
    const sec = secret ?? `whsec_${randomBytes(24).toString('hex')}`;
    db.prepare(
      `INSERT INTO endpoints (id, public_id, merchant_id, url, secret, description, topics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, pid, merchant_id, url, sec, description ?? '', JSON.stringify(topics ?? []));
    log.info(`endpoint ${pid} registered for ${merchant_id} → ${url}`);
    res.status(201).json({ endpoint: db.prepare(`SELECT * FROM endpoints WHERE id = ?`).get(id) });
  } catch (e) { next(e); }
});

app.get('/endpoints', (req: Request, res: Response, next: NextFunction) => {
  try {
    const merchant = req.query.merchant_id as string | undefined;
    const rows = merchant
      ? db.prepare(`SELECT * FROM endpoints WHERE merchant_id = ? ORDER BY created_at DESC`).all(merchant)
      : db.prepare(`SELECT * FROM endpoints ORDER BY created_at DESC`).all();
    res.json({ endpoints: rows, total: rows.length });
  } catch (e) { next(e); }
});

app.delete('/endpoints/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = db.prepare(`UPDATE endpoints SET is_active = 0 WHERE id = ? OR public_id = ?`).run(req.params.id, req.params.id);
    if (r.changes === 0) bad(404, 'endpoint not found');
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

/* ── Delivery queue ──────────────────────────────────────────────── */

interface DeliveryRow {
  id: string; endpoint_id: string; event_id: number; event_topic: string; payload_json: string;
  status: 'pending' | 'succeeded' | 'failed' | 'dead'; attempts: number;
  next_attempt_at: string | null; last_status_code: number | null; last_error: string | null;
}

interface EndpointRow {
  id: string; public_id: string; merchant_id: string; url: string; secret: string;
  description: string; topics_json: string; is_active: number; created_at: string;
}

function endpointsForEvent(topic: string, merchantId: string | null): EndpointRow[] {
  const all = db.prepare<[string], EndpointRow>(`SELECT * FROM endpoints WHERE merchant_id = ? AND is_active = 1`).all(merchantId ?? '__none__');
  return all.filter((e) => {
    try {
      const subs = JSON.parse(e.topics_json) as string[];
      return subs.length === 0 || subs.includes(topic);
    } catch { return true; }
  });
}

function extractMerchantId(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return (payload.merchant_id ?? payload.payment?.merchant_id ?? payload.case?.merchant_id ?? payload.quote?.merchant_id ?? null) as string | null;
}

function enqueueDelivery(endpointId: string, eventId: number, topic: string, payload: any): void {
  const id = uuid();
  db.prepare(
    `INSERT INTO deliveries (id, endpoint_id, event_id, event_topic, payload_json, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, datetime('now'))`,
  ).run(id, endpointId, eventId, topic, JSON.stringify(payload));
}

async function attemptDelivery(d: DeliveryRow): Promise<void> {
  const ep = db.prepare<[string], EndpointRow>(`SELECT * FROM endpoints WHERE id = ?`).get(d.endpoint_id);
  if (!ep || !ep.is_active) {
    db.prepare(`UPDATE deliveries SET status = 'dead', last_error = 'endpoint missing or inactive', completed_at = datetime('now') WHERE id = ?`).run(d.id);
    return;
  }
  const body = d.payload_json;
  const ts = Math.floor(Date.now() / 1000);
  const sig = signPayload(ep.secret, body, ts);
  const nextAttempt = d.attempts + 1;
  let statusCode = 0;
  let errMsg: string | null = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Ledger-Signature': sig,
        'X-Ledger-Event':    d.event_topic,
        'X-Ledger-Delivery': d.id,
        'X-Ledger-Attempt':  String(nextAttempt),
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    statusCode = res.status;
    if (res.ok) {
      db.prepare(`UPDATE deliveries SET status = 'succeeded', attempts = ?, last_status_code = ?, last_attempt_at = datetime('now'), completed_at = datetime('now'), next_attempt_at = NULL WHERE id = ?`)
        .run(nextAttempt, statusCode, d.id);
      publish('webhook.delivered', { delivery_id: d.id, endpoint_public_id: ep.public_id, status_code: statusCode, attempts: nextAttempt }, 'webhook');
      log.info(`${ep.public_id} ${d.event_topic} → ${statusCode} (attempt ${nextAttempt})`);
      return;
    }
    errMsg = `HTTP ${statusCode}`;
  } catch (e: any) {
    errMsg = e?.name === 'AbortError' ? 'timeout (10s)' : String(e?.message ?? e);
  }
  /* Failure path: bump attempt, schedule next or dead-letter. */
  if (nextAttempt >= MAX_ATTEMPTS) {
    db.prepare(`UPDATE deliveries SET status = 'dead', attempts = ?, last_status_code = ?, last_error = ?, last_attempt_at = datetime('now'), completed_at = datetime('now'), next_attempt_at = NULL WHERE id = ?`)
      .run(nextAttempt, statusCode, errMsg, d.id);
    publish('webhook.failed', { delivery_id: d.id, endpoint_public_id: ep.public_id, attempts: nextAttempt, status_code: statusCode, error: errMsg, dead: true }, 'webhook');
    log.warn(`${ep.public_id} ${d.event_topic} DEAD after ${nextAttempt} attempts (${errMsg})`);
    return;
  }
  /* Exponential backoff with full jitter: base * 2^(n-1) ± 50%, capped at 1h. */
  const baseSec = 30;
  const expBase = baseSec * Math.pow(2, nextAttempt - 1);
  const jitter  = expBase * (Math.random() * 0.5 - 0.25);
  const delaySec = Math.min(Math.floor(expBase + jitter), 3600);
  db.prepare(`UPDATE deliveries SET status = 'pending', attempts = ?, last_status_code = ?, last_error = ?, last_attempt_at = datetime('now'), next_attempt_at = datetime('now', ?) WHERE id = ?`)
    .run(nextAttempt, statusCode, errMsg, `+${delaySec} seconds`, d.id);
  publish('webhook.failed', { delivery_id: d.id, endpoint_public_id: ep.public_id, attempts: nextAttempt, status_code: statusCode, error: errMsg, retry_in_sec: delaySec, dead: false }, 'webhook');
}

async function drainQueue(): Promise<void> {
  const due = db.prepare<[], DeliveryRow>(
    `SELECT * FROM deliveries WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')) ORDER BY next_attempt_at ASC LIMIT 50`,
  ).all();
  for (const d of due) {
    await attemptDelivery(d).catch((e) => log.error(`delivery ${d.id} crashed`, e));
  }
}

/* ── Routes (read + manual replay) ───────────────────────────────── */

app.get('/deliveries', (req: Request, res: Response, next: NextFunction) => {
  try {
    const where: string[] = [];
    const params: any[] = [];
    const q = req.query as Record<string, string | undefined>;
    if (q.status)      { where.push('status = ?');      params.push(q.status); }
    if (q.event_topic) { where.push('event_topic = ?'); params.push(q.event_topic); }
    if (q.endpoint_id) { where.push('endpoint_id = ?'); params.push(q.endpoint_id); }
    const limit  = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const rows = db.prepare(`SELECT * FROM deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ deliveries: rows, total: rows.length });
  } catch (e) { next(e); }
});

app.get('/deliveries/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    if (!r) bad(404, 'delivery not found');
    res.json({ delivery: r });
  } catch (e) { next(e); }
});

/** POST /deliveries/:id/replay — reset a failed/dead delivery so it
 *  goes through the queue once more. */
app.post('/deliveries/:id/replay', (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = db.prepare<[string], DeliveryRow>(`SELECT * FROM deliveries WHERE id = ?`).get(req.params.id);
    if (!r) bad(404, 'delivery not found');
    db.prepare(`UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'), last_error = NULL, completed_at = NULL WHERE id = ?`).run(r.id);
    log.info(`delivery ${r.id} replayed (was ${r.status})`);
    res.json({ replayed: true });
  } catch (e) { next(e); }
});

app.get('/stats', (_req: Request, res: Response) => {
  const total      = (db.prepare(`SELECT COUNT(*) as c FROM deliveries`).get() as { c: number }).c;
  const endpoints  = (db.prepare(`SELECT COUNT(*) as c FROM endpoints WHERE is_active = 1`).get() as { c: number }).c;
  const byStatus   = db.prepare(`SELECT status, COUNT(*) as c FROM deliveries GROUP BY status`).all();
  const byTopic    = db.prepare(`SELECT event_topic, COUNT(*) as c FROM deliveries GROUP BY event_topic`).all();
  const lastFail   = db.prepare(`SELECT * FROM deliveries WHERE status IN ('failed','dead') ORDER BY last_attempt_at DESC LIMIT 5`).all();
  res.json({ total, endpoints, by_status: byStatus, by_topic: byTopic, recent_failures: lastFail });
});

/* ── Subscriptions: turn every interesting event into deliveries ── */

const FANOUT_TOPICS: EventTopic[] = [
  'payment.created', 'payment.captured', 'payment.settled', 'payment.failed', 'payment.refunded',
  'fx.executed', 'fx.expired',
  'fraud.scored', 'fraud.escalated',
  'reconciliation.matched', 'reconciliation.orphan',
  'balance.updated',
];

start(app, port, 'webhook', () => {
  for (const topic of FANOUT_TOPICS) {
    subscribe(topic, 'webhook-fanout', (evt) => {
      const merchantId = extractMerchantId(evt.payload);
      const endpoints = merchantId ? endpointsForEvent(topic, merchantId) : [];
      for (const ep of endpoints) {
        enqueueDelivery(ep.id, evt.id, topic, evt.payload);
      }
      if (endpoints.length > 0) {
        log.info(`fanned out ${topic} to ${endpoints.length} endpoint(s)`);
      }
    });
  }
  log.info(`fanout listening on ${FANOUT_TOPICS.length} topics`);

  /* Drain the queue every 2s.  Backoff times are minimum 30s so this
   * is plenty granular without spinning. */
  setInterval(() => { drainQueue().catch((e) => log.error('drain crashed', e)); }, 2_000);
  log.info(`delivery worker armed (2s tick, ${MAX_ATTEMPTS} max attempts, exp backoff capped at 1h)`);
});
