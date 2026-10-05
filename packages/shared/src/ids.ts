/**
 * ID generation. Uses `crypto.getRandomValues`, which exists in Node 20+, in
 * Cloudflare Workers and in Hermes, so no dependency is required.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  // Fallback for exotic runtimes. Never reached on a supported target.
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** RFC 4122 version 4 UUID. */
export function uuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  }

  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

export function randomToken(length = 32): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

/**
 * Prefixed id: `ld_9f3a2b1c4d5`. The prefix makes log lines and support tickets
 * readable, which matters more here than raw entropy.
 */
export function prefixedId(prefix: string, length = 12): string {
  const bytes = randomBytes(length);
  let suffix = '';
  for (let i = 0; i < length; i += 1) {
    suffix += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

export const id = {
  load: () => prefixedId('ld'),
  truck: () => prefixedId('tr'),
  driver: () => prefixedId('dr'),
  user: () => prefixedId('us'),
  company: () => prefixedId('co'),
  stop: () => prefixedId('st'),
  document: () => prefixedId('dc'),
  event: () => prefixedId('ev'),
  invoice: () => prefixedId('in'),
  settlement: () => prefixedId('se'),
  iftaReport: () => prefixedId('if'),
  notification: () => prefixedId('nt'),
  session: () => prefixedId('ss'),
  token: () => prefixedId('tk'),
} as const;

/**
 * Device-scoped id for records created on a phone while offline. The client
 * sends this as the primary key and the server accepts it verbatim, which is
 * what makes replaying the offline queue safe: the row already exists, so the
 * replay is a no-op instead of a duplicate.
 */
export function offlineId(prefix: string): string {
  return prefixedId(prefix, 16);
}

/** Monotonic, sortable, human-readable key for invoices and settlements. */
export function sequenceKey(prefix: string, date: Date, sequence: number): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const seq = String(sequence).padStart(4, '0');
  return `${prefix}-${yyyy}${mm}${dd}-${seq}`;
}