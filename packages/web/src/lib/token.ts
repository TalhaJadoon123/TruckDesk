import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Token and password helpers for the web tier.
 *
 * These mirror `packages/api/src/auth.ts` exactly. The duplication is
 * deliberate and small: the web tier signs the API's token format so it does not
 * need an extra network round trip to obtain one, and a shared package would pull
 * `node:crypto` into the browser bundle.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/* -------------------------------------------------------------------------- */
/* API tokens (HMAC-SHA256, the format packages/api verifies)                    */
/* -------------------------------------------------------------------------- */

export interface ApiTokenClaims {
  sub: string;
  company: string;
  role: 'driver' | 'dispatcher' | 'owner' | 'admin';
  driverId?: string;
  iat: number;
  exp: number;
}

export function issueApiToken(
  claims: Omit<ApiTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 60 * 60 * 12,
  now: Date = new Date(),
): string {
  if (!secret || secret.length < 16) {
    throw new Error('API_TOKEN_SECRET must be at least 16 characters');
  }

  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: ApiTokenClaims = {
    ...claims,
    iat: issuedAt,
    exp: issuedAt + Math.max(60, ttlSeconds),
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signHmac(encoded, secret)}`;
}

export function verifyApiToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): ApiTokenClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = signHmac(encoded, secret);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ApiTokenClaims;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now.getTime() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function signHmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                     */
/* -------------------------------------------------------------------------- */

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }

  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}