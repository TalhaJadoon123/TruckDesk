import { randomUUID } from 'node:crypto';

let counter = 0;

/** Monotonic, human-sortable timestamp key: 20261003T142233-000123. */
export function stamp(date: Date = new Date()): string {
  counter = (counter + 1) % 1000;
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${iso}-${counter.toString().padStart(6, '0')}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function requestId(): string {
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Broker emails write dates every way imaginable. This handles the ones that
 * actually show up: ISO, US slash, "Mon Jan 5", "01/05/26 2:00 PM", and
 * relative day names. Anything ambiguous returns null rather than becoming
 * `Invalid Date`, so the caller can flag it for the dispatcher to confirm.
 */
/**
 * Parse a date out of the formats a broker email actually uses.
 *
 * Two things matter here and both were learned the hard way:
 *
 *   1. `new Date(text)` is only trusted for strings that carry an explicit
 *      timezone. `new Date('03/16/2026')` resolves to *local* midnight, which
 *      means the same email parses to a different instant depending on where the
 *      server runs. Date-only and US-slash forms are therefore handled explicitly
 *      and anchored to UTC.
 *   2. Relative day names ("tomorrow") need a reference point. Without the
 *      `reference` argument they resolve against the wall clock, which makes the
 *      parser non-deterministic and untestable.
 */
export function parseFlexibleDate(
  input: string | number | Date | null | undefined,
  reference: Date = new Date(),
): Date | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const fromNumber = new Date(input);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  const text = input.trim();
  if (!text) return null;

  // Trust the platform parser only for absolute, timezone-bearing strings.
  const isAbsolute = /T\d{2}:\d{2}/.test(text) || /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  if (isAbsolute) {
    const direct = new Date(text);
    if (!Number.isNaN(direct.getTime())) return direct;
  }

  const relative =
    /^(today|tonight|tomorrow|tmrw|yesterday)(\s*[-–]?\s*(morning|afternoon|noon|evening|night))?$/i.exec(
      text,
    );
  if (relative) {
    const base = new Date(reference.getTime());
    const word = (relative[1] ?? '').toLowerCase();
    if (word === 'tomorrow' || word === 'tmrw') base.setUTCDate(base.getUTCDate() + 1);
    if (word === 'yesterday') base.setUTCDate(base.getUTCDate() - 1);

    const part = (relative[3] ?? '').toLowerCase();
    if (part === 'morning') base.setUTCHours(8, 0, 0, 0);
    else if (part === 'afternoon') base.setUTCHours(13, 0, 0, 0);
    else if (part === 'noon') base.setUTCHours(12, 0, 0, 0);
    else if (part === 'evening') base.setUTCHours(18, 0, 0, 0);
    else if (part === 'night') base.setUTCHours(21, 0, 0, 0);
    else if (word === 'tonight') base.setUTCHours(23, 0, 0, 0);
    else base.setUTCHours(9, 0, 0, 0);
    return base;
  }

  const slash =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s*[,@]?\s*(\d{1,2}):(\d{2})\s*([ap]m)?)?$/i.exec(text);
  if (slash) {
    const month = Number.parseInt(slash[1] ?? '1', 10);
    const day = Number.parseInt(slash[2] ?? '1', 10);
    const rawYear = Number.parseInt(slash[3] ?? '0', 10);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;

    let hour = slash[4] ? Number.parseInt(slash[4], 10) : 0;
    const minute = slash[5] ? Number.parseInt(slash[5], 10) : 0;
    const meridiem = slash[6]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    // Anchored to UTC: a date with no timezone means the same moment for every
    // reader, which is what a dispatch board needs.
    const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    return Number.isNaN(candidate.getTime()) ? null : candidate;
  }

  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dashed) {
    const candidate = new Date(
      Date.UTC(
        Number.parseInt(dashed[1] ?? '0', 10),
        Number.parseInt(dashed[2] ?? '1', 10) - 1,
        Number.parseInt(dashed[3] ?? '1', 10),
      ),
    );
    return Number.isNaN(candidate.getTime()) ? null : candidate;
  }

  const dayFirst = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (dayFirst) {
    const base = new Date(reference.getTime());
    const month = Number.parseInt(dayFirst[1] ?? '1', 10);
    const day = Number.parseInt(dayFirst[2] ?? '1', 10);
    let candidate = new Date(Date.UTC(base.getUTCFullYear(), month - 1, day, 12, 0, 0));
    if (candidate.getTime() < base.getTime() - 86_400_000) {
      candidate = new Date(Date.UTC(base.getUTCFullYear() + 1, month - 1, day, 12, 0, 0));
    }
    return candidate;
  }

  // Last resort: let the platform try, but reject anything it cannot place.
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}
export function toIsoOrNull(input: string | number | Date | null | undefined): string | null {
  const parsed = parseFlexibleDate(input);
  return parsed ? parsed.toISOString() : null;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                    */
/* -------------------------------------------------------------------------- */

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : DATE_FMT.format(date);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : `${DATETIME_FMT.format(date)} UTC`;
}

export function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function hoursBetween(from: string | Date, to: string | Date): number {
  const a = from instanceof Date ? from.getTime() : Date.parse(from);
  const b = to instanceof Date ? to.getTime() : Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (b - a) / 3_600_000;
}

export function daysBetween(from: string | Date, to: string | Date): number {
  return hoursBetween(from, to) / 24;
}

export function hoursToHuman(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0h';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function minutesToHuman(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0m';
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Weeks - settlements and dashboards hang off these                            */
/* -------------------------------------------------------------------------- */

export interface WeekWindow {
  /** ISO date (YYYY-MM-DD) of the Monday that starts the week. */
  key: string;
  start: string;
  end: string;
  label: string;
}

/** Monday 00:00 UTC of the week containing `iso`. Weeks run Mon-Sun. */
export function startOfWeekIso(iso: string, now: Date = new Date()): WeekWindow {
  const base = Number.isNaN(Date.parse(iso)) ? now : new Date(iso);
  const day = base.getUTCDay();
  // getUTCDay: 0=Sun .. 6=Sat. Shift so Monday maps to 0.
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + diff),
  );
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  return {
    key: monday.toISOString().slice(0, 10),
    start: monday.toISOString(),
    end: sunday.toISOString(),
    label: `Week of ${monday.toISOString().slice(0, 10)}`,
  };
}

export function previousWeekIso(iso: string): WeekWindow {
  const current = startOfWeekIso(iso);
  return startOfWeekIso(new Date(Date.parse(current.start) - 7 * 86_400_000).toISOString());
}

export function nextWeekIso(iso: string): WeekWindow {
  const current = startOfWeekIso(iso);
  return startOfWeekIso(new Date(Date.parse(current.start) + 7 * 86_400_000).toISOString());
}

export function weekWindowsBack(iso: string, count: number): WeekWindow[] {
  const windows: WeekWindow[] = [];
  for (let i = 0; i < count; i += 1) {
    windows.push(startOfWeekIso(new Date(Date.parse(iso) - i * 7 * 86_400_000).toISOString()));
  }
  return windows;
}

export interface QuarterRef {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  label: string;
}

export function quarterOf(iso: string): QuarterRef {
  const date = new Date(iso);
  const month = date.getUTCMonth() + 1;
  const quarter = (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  const year = date.getUTCFullYear();
  return { year, quarter, label: `${year}-Q${quarter}` };
}

export function quarterWindow(
  year: number,
  quarter: 1 | 2 | 3 | 4,
): { start: string; end: string; label: string } {
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const endMonth = quarter === 4 ? 12 : quarter * 3;
  const end = new Date(Date.UTC(year, endMonth, 0, 23, 59, 59, 999));
  return { start: start.toISOString(), end: end.toISOString(), label: `${year}-Q${quarter}` };
}

/** IFTA quarters are calendar quarters; this resolves "current". */
export function currentQuarter(now: Date = new Date()): QuarterRef {
  const month = now.getUTCMonth() + 1;
  const quarter = (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4;
  return { year: now.getUTCFullYear(), quarter, label: `${now.getUTCFullYear()}-Q${quarter}` };
}

export function isWithin(iso: string, start: string, end: string): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(start) && t <= Date.parse(end);
}

export function ageInDays(iso: string, now: Date = new Date()): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}