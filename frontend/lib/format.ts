/* Display formatters.  Kept independent of @lib/money so they can run
 * in client components without importing better-sqlite3. */

export type Currency = 'USD' | 'EUR' | 'GBP' | 'AZN' | 'TRY' | 'AED' | 'JPY';

const DEC: Record<Currency, number> = { USD: 2, EUR: 2, GBP: 2, AZN: 2, TRY: 2, AED: 2, JPY: 0 };
const SYM: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£', AZN: '₼', TRY: '₺', AED: 'د.إ', JPY: '¥' };

export function fmtMinor(minor: bigint | string | number, currency: Currency = 'USD', opts: { symbol?: boolean; sign?: boolean } = {}): string {
  const m = typeof minor === 'bigint' ? minor : BigInt(String(minor ?? '0'));
  const d = DEC[currency] ?? 2;
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const scale = 10n ** BigInt(d);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = d === 0 ? '' : '.' + (abs % scale).toString().padStart(d, '0');
  const sym = opts.symbol === false ? '' : (SYM[currency] ?? currency + ' ');
  const sign = neg ? '-' : (opts.sign ? '+' : '');
  return `${sign}${sym}${whole}${frac}`;
}

export function fmtDate(input: string | Date, opts: { time?: boolean } = { time: true }): string {
  const d = typeof input === 'string'
    ? new Date(input.includes('T') ? input : input.replace(' ', 'T') + 'Z')
    : input;
  if (isNaN(d.getTime())) return String(input);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!opts.time) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRelative(input: string | Date): string {
  const d = typeof input === 'string'
    ? new Date(input.includes('T') ? input : input.replace(' ', 'T') + 'Z')
    : input;
  if (isNaN(d.getTime())) return String(input);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 30)    return 'just now';
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 7 * 86400) return `${Math.floor(sec / 86400)}d ago`;
  return fmtDate(d, { time: false });
}

export function fmtNumber(n: number | string, decimals = 0): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtPercent(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

export function shortId(s: string | null | undefined, head = 8, tail = 4): string {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
