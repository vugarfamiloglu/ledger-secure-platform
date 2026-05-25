/* API gateway — proxies every request under /api/<service>/<...path>
 * to the matching microservice on its private port.  Keeps the backend
 * topology hidden from the browser. */

import { NextRequest } from 'next/server';
import { serviceUrl, type ServiceName } from '@/lib/server';

const ALLOWED: ServiceName[] = ['ledger', 'payments', 'fx', 'reconciliation', 'fraud', 'webhook'];

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
    return new Response(JSON.stringify({ error: `gateway ${service}: ${e?.message ?? 'unreachable'}` }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const GET    = proxy;
export const POST   = proxy;
export const PUT    = proxy;
export const PATCH  = proxy;
export const DELETE = proxy;
