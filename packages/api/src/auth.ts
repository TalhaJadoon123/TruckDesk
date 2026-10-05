import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { DomainError, err, ok, type Result } from '@truckdesk/shared';

/**
 * Authentication.
 *
 * Two independent mechanisms, because the app has two very different clients:
 *
 *   1. Passwords - scrypt with a per-user salt. `scrypt` is in Node's standard
 *      library, so this is a real KDF with zero dependencies and zero cost.
 *   2. API tokens - HMAC-SHA256 over a short payload, issued by the web app
 *      after Auth.js verifies the session. The API is a separate origin with a
 *      separate budget, and it must be callable from a Cloudflare Worker and
 *      from a mobile app that has no cookie jar.
 *
 * Deliberately absent: JWT. A signed compact token with a server-side
 * revocation list is simpler to reason about, and revocation matters here
 * because a driver phones in that the phone was stolen.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/* -------------------------------------------------------------------------- */
/* Passwords                                                                     */
/* -------------------------------------------------------------------------- */

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new DomainError('INVALID_INPUT', 'Password must be at least 8 characters');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
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
  // Constant-time compare so a timing oracle cannot leak the hash.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A believable minimum work factor on a seeded demo account, without getting in
 * the way of the test suite.
 */
export async function burnPasswordCycles(rounds = 1): Promise<void> {
  await hashPassword('x'.repeat(16));
  if (rounds <= 1) return;
  await hashPassword('y'.repeat(16));
}

/* -------------------------------------------------------------------------- */
/* API tokens                                                                    */
/* -------------------------------------------------------------------------- */

export interface ApiTokenClaims {
  /** User id. */
  sub: string;
  /** Company id. Every query is scoped by this. */
  company: string;
  /** Role, checked by the route guard. */
  role: 'driver' | 'dispatcher' | 'owner' | 'admin';
  /** Optional: restricts the token to one driver's loads. */
  driverId?: string;
  /** Issued-at, seconds. */
  iat: number;
  /** Expiry, seconds. */
  exp: number;
}

export interface VerifiedToken extends ApiTokenClaims {
  /** `userId:companyId` for log correlation. */
  subject: string;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 12;

export function issueApiToken(
  claims: Omit<ApiTokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  now: Date = new Date(),
): string {
  if (!secret || secret.length < 16) {
    throw new DomainError('INTERNAL', 'API_TOKEN_SECRET must be at least 16 characters');
  }

  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload: ApiTokenClaims = {
    ...claims,
    iat: issuedAt,
    exp: issuedAt + Math.max(60, ttlSeconds),
  };

  const encoded = base64url(JSON.stringify(payload));
  const signature = sign(encoded, secret);
  return `${encoded}.${signature}`;
}

export function verifyApiToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Result<VerifiedToken> {
  const dot = token.indexOf('.');
  if (dot <= 0) return err(Errors.unauthorized('Malformed token'));

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, secret);

  const provided = Buffer.from(signature, 'base64url');
  const computed = Buffer.from(expected, 'base64url');
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return err(Errors.unauthorized('Token signature is invalid'));
  }

  let payload: ApiTokenClaims;
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    payload = JSON.parse(json) as ApiTokenClaims;
  } catch {
    return err(Errors.unauthorized('Token payload is not valid JSON'));
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    return err(Errors.unauthorized('Token has expired'));
  }
  if (!payload.sub || !payload.company || !payload.role) {
    return err(Errors.unauthorized('Token is missing required claims'));
  }

  return ok({ ...payload, subject: `${payload.sub}:${payload.company}` });
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}

/** Long-lived key a carrier's own TMS uses, revocable in the app. */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const secret = randomBytes(24).toString('base64url');
  const key = `tdk_${secret}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, 12),
  };
}

export function hashApiKey(key: string): string {
  return createHmac('sha256', 'truckdesk-api-key').update(key).digest('hex');
}

export function verifyApiKeyHash(key: string, hash: string): boolean {
  const a = Buffer.from(hashApiKey(key), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One-time token in a magic link. Short TTL, single purpose. */
export function generateSignInToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSignInToken(token) };
}

export function hashSignInToken(token: string): string {
  return createHmac('sha256', 'truckdesk-sign-in').update(token).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Dev fallback                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Development-only authentication.
 *
 * With no database and no Auth.js session, the API still needs to answer
 * `/dashboard` during local development. This produces a signed token for a
 * fixed demo identity. It refuses to run in production.
 */
export function devToken(
  secret: string,
  identity: { sub: string; company: string; role?: ApiTokenClaims['role']; driverId?: string },
  ttlSeconds = 60 * 60 * 24 * 7,
): string {
  return issueApiToken(
    {
      sub: identity.sub,
      company: identity.company,
      role: identity.role ?? 'dispatcher',
      ...(identity.driverId ? { driverId: identity.driverId } : {}),
    },
    secret,
    ttlSeconds,
  );
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

const Errors = {
  unauthorized(message: string): DomainError {
    return new DomainError('FORBIDDEN', message, { status: 401 });
  },
};

/* -------------------------------------------------------------------------- */
/* Roles                                                                         */
/* -------------------------------------------------------------------------- */

export type Role = ApiTokenClaims['role'];

const DISPATCHER_ROLES: readonly Role[] = ['dispatcher', 'owner', 'admin'];

/** Can this role assign loads, invoice brokers, run settlements? */
export function canDispatch(role: Role): boolean {
  return DISPATCHER_ROLES.includes(role);
}

export function canManageBilling(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}

export function isAdmin(role: Role): boolean {
  return role === 'admin';
}

/** A driver token may only touch its own driver's data. */
export function canAccessDriver(role: Role, tokenDriverId: string | undefined, targetDriverId: string): boolean {
  if (canDispatch(role)) return true;
  return Boolean(tokenDriverId) && tokenDriverId === targetDriverId;
}

export type { DomainError };
export { DomainError as AuthError };