import type { Cents, Money } from './types.js';

export const USD: Money['currency'] = 'USD';

/**
 * Money is integer cents everywhere. `parseMoneyToCents` is the only place a
 * human- or LLM-written dollar string becomes a number.
 */
export function parseMoneyToCents(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    // Treat a bare number as dollars, but snap obvious cent values defensively.
    return Math.round(input * 100);
  }

  let text = String(input).trim();
  if (!text) return null;

  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  if (negative) text = text.replace(/^\(|\)$/g, '').replace(/^-/, '');

  // Strip currency symbols, ISO codes, commas and any trailing qualifier.
  text = text.replace(/[$\u20ac\u00a3]/g, '').replace(/\b(usd|usdollars|dollars?)\b/gi, '');
  text = text.replace(/,/g, '').replace(/\s+/g, '');
  text = text.replace(/(?:c|cent|cts)\b/gi, '');

  const match = /^(\d+(?:\.\d+)?)$/.exec(text);
  if (!match || match[1] === undefined) return null;

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;

  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

/** Parses either "$2.85/mi" or "2.85 per mile" style per-mile rates. */
export function parseRateToCents(input: string | number | null | undefined): Cents | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  if (!input) return null;

  const text = String(input);
  // Both "2.85/mi" and "2.85 per mile" mean the same thing to a dispatcher.
  const perMile = /(\/\s*(mi|miles?|cpm)\b)|(\bper\s*(mi|mile|miles)\b)/i.test(text);

  const cleaned = text
    .replace(/(\/\s*(mi|miles?|cpm)\b).*$/i, '')
    .replace(/\bper\s*(mi|mile|miles)\b.*$/i, '')
    .replace(/\s*(cpm)\b.*$/i, '')
    .trim();

  return parseMoneyToCents(cleaned);
}

export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) total += Math.round(value);
  }
  return total;
}

export function addCents(a: Cents, b: Cents): Cents {
  return Math.round(a) + Math.round(b);
}

export function subtractCents(a: Cents, b: Cents): Cents {
  return Math.round(a) - Math.round(b);
}

/** Basis-point share, rounded half-up. 2500 bps of $1000 = $250.00. */
export function applyBasisPoints(cents: Cents, bps: number): Cents {
  if (!Number.isFinite(bps)) return 0;
  return Math.round((cents * bps) / 10_000);
}

/** Per-unit rate that keeps 2 decimals. Guarded against divide-by-zero. */
export function perMileCents(totalCents: Cents, miles: number): number {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  return Math.round(totalCents / miles);
}

export function money(cents: Cents): Money {
  return { cents: Math.round(cents), currency: USD };
}

export function formatUsd(
  cents: Cents,
  options: { showCents?: boolean; sign?: boolean } = {},
): string {
  const { showCents = true, sign = false } = options;
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;

  const grouped = dollars.toLocaleString('en-US');
  const body = showCents
    ? `${grouped}.${remainder.toString().padStart(2, '0')}`
    : grouped;

  const prefix = negative ? '-' : sign ? '+' : '';
  return `${prefix}$${body}`;
}

/** "$2,450" / "$2,450.5" -> compact form for dense tables. */
export function formatUsdCompact(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents)) / 100;
  const sign = negative ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}k`;
  return formatUsd(cents, { showCents: false });
}

export function formatCpm(centsPerMile: number): string {
  const dollars = centsPerMile / 100;
  return `$${dollars.toFixed(2)}`;
}

export function toCents(value: unknown): Cents {
  const parsed = parseMoneyToCents(value as string | number | null);
  if (parsed === null) {
    throw new TypeError(`Cannot convert ${String(value)} to cents`);
  }
  return parsed;
}