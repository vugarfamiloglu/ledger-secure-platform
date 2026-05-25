/**
 * Money — BigInt minor-unit math, never floats.
 *
 * Every amount in the platform is a (BigInt, currency) pair stored in
 * the smallest unit the currency natively uses (cents for USD/EUR,
 * yen for JPY, etc.).  BigInt gives us arbitrary precision; the
 * currency table tells us how many minor digits each one has.
 *
 * Why this matters: financial systems lose money one rounded cent at a
 * time if you let JavaScript's floating-point math anywhere near
 * balances.  Even DECIMAL(38,18) in SQL only helps if the application
 * layer respects it.  Using BigInt end-to-end is the only way to make
 * "sum(debits) == sum(credits)" provably true.
 */

export type Currency = 'USD' | 'EUR' | 'GBP' | 'AZN' | 'TRY' | 'AED' | 'JPY';

interface CurrencyMeta {
  symbol: string;
  /** number of minor-unit digits (USD = 2 cents per dollar). */
  decimals: number;
  name: string;
}

export const CURRENCIES: Record<Currency, CurrencyMeta> = {
  USD: { symbol: '$',  decimals: 2, name: 'US Dollar' },
  EUR: { symbol: '€',  decimals: 2, name: 'Euro' },
  GBP: { symbol: '£',  decimals: 2, name: 'British Pound' },
  AZN: { symbol: '₼',  decimals: 2, name: 'Azerbaijani Manat' },
  TRY: { symbol: '₺',  decimals: 2, name: 'Turkish Lira' },
  AED: { symbol: 'د.إ', decimals: 2, name: 'UAE Dirham' },
  JPY: { symbol: '¥',  decimals: 0, name: 'Japanese Yen' },
};

export function decimalsOf(c: Currency): number { return CURRENCIES[c].decimals; }
export function symbolOf(c: Currency): string   { return CURRENCIES[c].symbol; }

/* ── Parsing ──────────────────────────────────────────── */

/** Parse "12.34" / "12,34" / "12" → minor units BigInt for the given currency. */
export function parseMinor(input: string | number, currency: Currency): bigint {
  if (typeof input === 'number') input = String(input);
  const s = String(input).trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Cannot parse "${input}" as money`);
  const negative = s.startsWith('-');
  const abs = negative ? s.slice(1) : s;
  const [whole, fracRaw = ''] = abs.split('.');
  const d = decimalsOf(currency);
  const frac = fracRaw.length > d ? fracRaw.slice(0, d) : fracRaw.padEnd(d, '0');
  const minor = BigInt(whole) * (10n ** BigInt(d)) + BigInt(frac || '0');
  return negative ? -minor : minor;
}

/** Format minor units as a localised major-unit string. */
export function fmtMoney(minor: bigint | number, currency: Currency, opts: { symbol?: boolean; grouping?: boolean } = {}): string {
  const m = typeof minor === 'bigint' ? minor : BigInt(minor);
  const d = decimalsOf(currency);
  const negative = m < 0n;
  const abs = negative ? -m : m;
  const scale = 10n ** BigInt(d);
  const whole = abs / scale;
  const frac = abs % scale;
  const wholeStr = (opts.grouping !== false)
    ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : whole.toString();
  const fracStr = d === 0 ? '' : '.' + frac.toString().padStart(d, '0');
  const sym = opts.symbol === false ? '' : symbolOf(currency);
  return `${negative ? '-' : ''}${sym}${wholeStr}${fracStr}`;
}

/** Same as fmtMoney but always prepends a +/- sign (used in ledger rows). */
export function fmtSigned(minor: bigint, currency: Currency): string {
  if (minor === 0n) return fmtMoney(0n, currency);
  return (minor > 0n ? '+' : '') + fmtMoney(minor, currency);
}

/* ── Math helpers (BigInt-safe) ───────────────────────── */

/** Multiply a money amount by a rate represented as bigint × 10^scale. */
export function applyRate(minor: bigint, rateScaled: bigint, rateScale: number, rounding: 'bank' | 'down' | 'up' = 'bank'): bigint {
  const product = minor * rateScaled;
  const divisor = 10n ** BigInt(rateScale);
  if (rounding === 'down') return product / divisor;
  if (rounding === 'up')   return (product + (product >= 0n ? divisor - 1n : -(divisor - 1n))) / divisor;
  // Banker's rounding (round half to even) — the financial-services default.
  const quotient = product / divisor;
  const remainder = product % divisor;
  const half = divisor / 2n;
  if (remainder === 0n) return quotient;
  const absRem = remainder < 0n ? -remainder : remainder;
  if (absRem < half) return quotient;
  if (absRem > half) return product >= 0n ? quotient + 1n : quotient - 1n;
  // Exactly half — round to even.
  if (quotient % 2n === 0n) return quotient;
  return product >= 0n ? quotient + 1n : quotient - 1n;
}

/** Encode/decode for storage. We store amounts as TEXT in SQLite to avoid
 *  any 64-bit integer truncation when values grow large (e.g. JPY totals). */
export const m = {
  toDb(v: bigint): string { return v.toString(); },
  fromDb(v: string | number | bigint | null | undefined): bigint {
    if (v == null) return 0n;
    if (typeof v === 'bigint') return v;
    return BigInt(String(v));
  },
};
