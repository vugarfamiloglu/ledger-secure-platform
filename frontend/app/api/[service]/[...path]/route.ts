/* API gateway — proxies every request under /api/<service>/<...path>
 * to the matching microservice on its private port.  Keeps the backend
 * topology hidden from the browser. */

import { NextRequest } from 'next/server';
import { serviceUrl, type ServiceName } from '@/lib/server';

const ALLOWED: ServiceName[] = ['ledger', 'payments', 'fx', 'reconciliation', 'fraud', 'webhook'];

const PORT_FOR: Record<ServiceName, string> = {
  ledger:         process.env.LEDGER_LEDGER_PORT         ?? '5111',
  payments:       process.env.LEDGER_PAYMENTS_PORT       ?? '5112',
  fx:             process.env.LEDGER_FX_PORT             ?? '5113',
  reconciliation: process.env.LEDGER_RECONCILIATION_PORT ?? '5114',
  fraud:          process.env.LEDGER_FRAUD_PORT          ?? '5115',
  webhook:        process.env.LEDGER_WEBHOOK_PORT        ?? '5116',
};

/* Diagnose a fetch failure and produce an operator-actionable message.
 * Node's fetch wraps the OS-level error in `e.cause` — connect refusals
 * come back as { code: 'ECONNREFUSED' }, timeouts as { code: 'UND_ERR_…' }
 * etc.  We dig those out and explain what they mean. */
function describeFetchFailure(service: ServiceName, e: any): string {
  const port = PORT_FOR[service];
  const code = e?.cause?.code ?? e?.code;
  if (code === 'ECONNREFUSED') {
    return `${service} service is not reachable on port ${port} — start it with "npm run dev:${service}" (or "npm run dev" to boot everything).`;
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `${service} service on port ${port} timed out — it may be overloaded or stuck.`;
  }
  if (code === 'ECONNRESET') {
    return `${service} service on port ${port} dropped the connection mid-request — check its logs for a crash.`;
  }
  if (code === 'ENOTFOUND') {
    return `cannot resolve hostname for ${service} (${port}) — check LEDGER_${service.toUpperCase()}_PORT in .env.local.`;
  }
  return `gateway → ${service} (port ${port}): ${e?.message ?? 'unreachable'}${code ? ` [${code}]` : ''}`;
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ service: string; path: string[] }> }) {
  const { service, path } = await ctx.params;
  if (!ALLOWED.includes(service as ServiceName)) {
    return new Response(JSON.stringify({ error: `unknown service: ${service}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  const subPath = (path ?? []).join('/');
  const search = req.nextUrl.searchParams.toString();
  const url = serviceUrl(service as ServiceName, `/${subPath}${search ? '?' + search : ''}`);

  /* Forward body untouched.  Strip headers Next.js would otherwise
   * inject (host, accept-encoding) that confuse the upstream. */
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (['host', 'connection', 'accept-encoding', 'content-length'].includes(k.toLowerCase())) return;
    headers[k] = v;
  });

  const init: RequestInit = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = await req.text();
  }

  try {
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch (e: any) {
    const message = describeFetchFailure(service as ServiceName, e);
    console.warn(`[gateway] ${req.method} /${subPath} → ${service} failed:`, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const GET    = proxy;
export const POST   = proxy;
export const PUT    = proxy;
export const PATCH  = proxy;
export const DELETE = proxy;
