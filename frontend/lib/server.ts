/* Server-only fetch helper for proxying to the internal microservices.
 * Lives outside `services/` because Next.js compiles the frontend
 * independently and we don't want to pull `lib/service-base` into the
 * Next bundle. */

import 'server-only';

const PORTS: Record<string, number> = {
  ledger:         Number(process.env.LEDGER_LEDGER_PORT         ?? 5111),
  payments:       Number(process.env.LEDGER_PAYMENTS_PORT       ?? 5112),
  fx:             Number(process.env.LEDGER_FX_PORT             ?? 5113),
  reconciliation: Number(process.env.LEDGER_RECONCILIATION_PORT ?? 5114),
  fraud:          Number(process.env.LEDGER_FRAUD_PORT          ?? 5115),
  webhook:        Number(process.env.LEDGER_WEBHOOK_PORT        ?? 5116),
};

export type ServiceName = keyof typeof PORTS;

export function serviceUrl(service: ServiceName, path: string): string {
  const base = `http://localhost:${PORTS[service]}`;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

export async function fetchService<T = any>(
  service: ServiceName,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(serviceUrl(service, path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data) ? data.error : `${service} ${path} → ${res.status}`;
    throw Object.assign(new Error(String(msg)), { status: res.status, body: data });
  }
  return data as T;
}

/** Try to fetch; on any error return null.  Useful for dashboards that
 *  should gracefully degrade if one service is offline. */
export async function tryFetch<T = any>(service: ServiceName, path: string, init?: RequestInit): Promise<T | null> {
  try { return await fetchService<T>(service, path, init); }
  catch { return null; }
}
