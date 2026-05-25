/** Service-to-service HTTP client. */

const PORTS: Record<string, number> = {
  ledger:         Number(process.env.LEDGER_LEDGER_PORT         ?? 5111),
  payments:       Number(process.env.LEDGER_PAYMENTS_PORT       ?? 5112),
  fx:             Number(process.env.LEDGER_FX_PORT             ?? 5113),
  reconciliation: Number(process.env.LEDGER_RECONCILIATION_PORT ?? 5114),
  fraud:          Number(process.env.LEDGER_FRAUD_PORT          ?? 5115),
  webhook:        Number(process.env.LEDGER_WEBHOOK_PORT        ?? 5116),
};
export function baseUrl(service: keyof typeof PORTS): string { return `http://localhost:${PORTS[service]}`; }

export async function call<T>(service: keyof typeof PORTS, path: string, init: RequestInit & { retries?: number } = {}): Promise<T> {
  const url = `${baseUrl(service)}${path.startsWith('/') ? '' : '/'}${path}`;
  const retries = init.retries ?? 1;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
      const text = await res.text();
      const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
      if (!res.ok) throw Object.assign(new Error((data && data.error) || `${service} ${path} → ${res.status}`), { __http: res.status });
      return data as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  throw lastErr;
}
