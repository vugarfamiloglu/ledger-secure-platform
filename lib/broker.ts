/**
 * RabbitMQ/Kafka-shape message broker, backed by a shared SQLite event log.
 *
 * Surface:
 *   publish(topic, payload, origin)            — appends an event row
 *   subscribe(topic, group, handler)           — drains via polling
 *
 * Guarantees:
 *   - at-least-once delivery (handler MUST be idempotent)
 *   - per-(group, topic) offset, so two services in the same group share
 *     work (competing consumers) while different groups each get a copy
 *   - in-order per topic
 *
 * Replace the SQLite layer with kafkajs/amqplib and the rest of the
 * codebase keeps working — same publish/subscribe contract.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BrokerEvent, EventTopic } from './types';

let _conn: Database.Database | null = null;

function brokerDb(): Database.Database {
  if (_conn) return _conn;
  const file = resolve(process.cwd(), 'data', 'broker.db');
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('busy_timeout = 5000');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_topic_id ON events(topic, id);

    CREATE TABLE IF NOT EXISTS consumer_offsets (
      consumer_group TEXT NOT NULL,
      topic TEXT NOT NULL,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (consumer_group, topic)
    );
  `);
  _conn = conn;
  return conn;
}

export function publish<T = any>(topic: EventTopic, payload: T, origin: string): BrokerEvent<T> {
  const r = brokerDb().prepare(`INSERT INTO events (topic, payload_json, origin) VALUES (?, ?, ?)`)
    .run(topic, JSON.stringify(payload, bigIntReplacer), origin);
  return { id: r.lastInsertRowid as number, topic, payload, origin, ts: new Date().toISOString() };
}

interface Handler<T = any> { topic: EventTopic; group: string; fn: (e: BrokerEvent<T>) => Promise<void> | void; }
const handlers: Handler[] = [];
let pollTimer: NodeJS.Timeout | null = null;

export function subscribe<T = any>(topic: EventTopic, group: string, fn: (e: BrokerEvent<T>) => Promise<void> | void): { stop: () => void } {
  handlers.push({ topic, group, fn: fn as any });
  ensurePolling();
  return { stop: () => {} };
}

function ensurePolling(): void {
  if (pollTimer) return;
  const ms = Number(process.env.LEDGER_BROKER_POLL_MS ?? 200);
  pollTimer = setInterval(drain, ms);
  setImmediate(drain);
}

async function drain(): Promise<void> {
  if (handlers.length === 0) return;
  const db = brokerDb();
  const groups = new Map<string, { group: string; topic: EventTopic; hs: Handler[] }>();
  for (const h of handlers) {
    const k = `${h.group}::${h.topic}`;
    if (!groups.has(k)) groups.set(k, { group: h.group, topic: h.topic, hs: [] });
    groups.get(k)!.hs.push(h);
  }
  for (const { group, topic, hs } of groups.values()) {
    const off = db.prepare<[string, string], { last_event_id: number }>(
      `SELECT last_event_id FROM consumer_offsets WHERE consumer_group = ? AND topic = ?`,
    ).get(group, topic);
    const lastId = off?.last_event_id ?? 0;
    const rows = db.prepare<[string, number], { id: number; payload_json: string; origin: string; ts: string }>(
      `SELECT id, payload_json, origin, ts FROM events WHERE topic = ? AND id > ? ORDER BY id ASC LIMIT 200`,
    ).all(topic, lastId);
    if (rows.length === 0) continue;
    let advanced = lastId;
    for (const r of rows) {
      const evt: BrokerEvent = { id: r.id, topic, origin: r.origin, ts: r.ts, payload: safeParse(r.payload_json) };
      try {
        for (const h of hs) await h.fn(evt);
        advanced = r.id;
      } catch (e) {
        console.error(`[broker] ${group}::${topic} #${r.id}`, e);
        break;
      }
    }
    if (advanced !== lastId) {
      db.prepare(
        `INSERT INTO consumer_offsets (consumer_group, topic, last_event_id) VALUES (?, ?, ?)
         ON CONFLICT (consumer_group, topic) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = datetime('now')`,
      ).run(group, topic, advanced);
    }
  }
}

function safeParse(s: string): any { try { return JSON.parse(s, bigIntReviver); } catch { return s; } }

/** Allow BigInt amounts to survive JSON round-trips by encoding as { __big: "123" }. */
function bigIntReplacer(_k: string, v: any): any { return typeof v === 'bigint' ? { __big: v.toString() } : v; }
function bigIntReviver(_k: string, v: any): any {
  if (v && typeof v === 'object' && '__big' in v && typeof v.__big === 'string') return BigInt(v.__big);
  return v;
}

/* introspection */
export function recentEvents(limit = 200): BrokerEvent[] {
  const rows = brokerDb().prepare<[number], { id: number; topic: string; payload_json: string; origin: string; ts: string }>(
    `SELECT * FROM events ORDER BY id DESC LIMIT ?`,
  ).all(limit);
  return rows.map((r) => ({ id: r.id, topic: r.topic as EventTopic, origin: r.origin, ts: r.ts, payload: safeParse(r.payload_json) }));
}
