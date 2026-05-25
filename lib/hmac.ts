/**
 * HMAC SHA-256 signing for webhooks + internal service calls.
 *
 * Webhook envelope:
 *   POST /merchant-endpoint
 *   X-Ledger-Signature: t=<unix>,v1=<hex(hmac_sha256(secret, t + "." + body))>
 *
 * Verification rejects timestamps older than 5 minutes (replay window).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret: string, body: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const signed = `${ts}.${body}`;
  const mac = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${ts},v1=${mac}`;
}

export interface VerifyResult { ok: boolean; reason?: string; }

export function verifySignature(secret: string, body: string, header: string | undefined | null, toleranceSec = 300): VerifyResult {
  if (!header) return { ok: false, reason: 'no signature' };
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('='))) as { t?: string; v1?: string };
  if (!parts.t || !parts.v1) return { ok: false, reason: 'malformed header' };
  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return { ok: false, reason: 'expired' };
  const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest();
  let received: Buffer;
  try { received = Buffer.from(parts.v1, 'hex'); } catch { return { ok: false, reason: 'bad hex' }; }
  if (received.length !== expected.length) return { ok: false, reason: 'length mismatch' };
  return timingSafeEqual(received, expected) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}
