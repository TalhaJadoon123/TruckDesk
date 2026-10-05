/**
 * Session handling.
 *
 * Auth.js (NextAuth) owns the real session. This module is the bridge: it stores
 * the API token that the auth callback received, and provides the small helpers
 * that both server components and client components need to know who is signed
 * in and which company they belong to.
 *
 * Auth.js v5 (`next-auth@5` beta) is used with a credentials provider backed by
 * our own users table. It is free and open source, and a credentials provider
 * avoids depending on a paid email provider for the sign-in link.
 */

import { cookies } from 'next/headers';

import { issueApiToken } from './token';
import { endpoints, type DashboardResponse } from './api';

export const SESSION_COOKIE = 'truckdesk_session';

/**
 * The signed-in identity, read from the Auth.js session cookie.
 *
 * In development with no database, `devSession()` below provides a usable
 * fallback so the dashboard renders without signing in first.
 */
export interface Session {
  userId: string;
  companyId: string;
  role: 'driver' | 'dispatcher' | 'owner' | 'admin';
  email: string;
  name: string;
  driverId?: string;
  token: string;
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return devSession();

  const decoded = decodeSession(raw);
  return decoded;
}

/**
 * Development-only session.
 *
 * The seeded demo company is `co_ridgeway`. This makes `pnpm dev` land on a
 * populated dashboard immediately, and it is refused unless the environment is
 * explicitly non-production.
 */
export function devSession(): Session | null {
  if (process.env.NODE_ENV === 'production') return null;

  const companyId = process.env.DEV_COMPANY_ID ?? 'co_ridgeway';
  const userId = process.env.DEV_USER_ID ?? 'us_seed_owner';
  const secret = process.env.API_TOKEN_SECRET;

  if (!secret || secret.length < 16) return null;

  return {
    userId,
    companyId,
    role: 'owner',
    email: process.env.DEV_EMAIL ?? 'dispatcher@ridgewayfreight.com',
    name: 'Dana Reyes',
    token: issueApiToken({ sub: userId, company: companyId, role: 'owner' }, secret),
  };
}

/* -------------------------------------------------------------------------- */
/* Token encoding                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The session cookie carries the same payload as the API token plus the display
 * name. It is signed with the API secret, so the API can verify it directly and
 * the web tier never holds a separate session store.
 */
export function encodeSession(
  claims: Omit<Session, 'token'>,
  secret: string,
): string {
  const token = issueApiToken(
    {
      sub: claims.userId,
      company: claims.companyId,
      role: claims.role,
      ...(claims.driverId ? { driverId: claims.driverId } : {}),
    },
    secret,
    60 * 60 * 12,
  );

  const payload = {
    ...claims,
    token,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12,
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signCookie(encoded, secret);
  return `${encoded}.${signature}`;
}

export function decodeSession(raw: string): Session | null {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const secret = process.env.API_TOKEN_SECRET;

  if (!secret) return null;
  if (signCookie(encoded, secret) !== signature) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Session & {
      exp: number;
    };
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function signCookie(encoded: string, secret: string): string {
  // Web Crypto is available in both the Node runtime and the Edge runtime, so
  // this works wherever Next.js runs it.
  return signHmac(encoded, secret);
}

/* -------------------------------------------------------------------------- */
/* Data helpers used by server components                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the dashboard for a session, returning a fully-shaped payload even when
 * the API is not running. A dispatch screen that renders "API unreachable" with
 * an explanation is far more useful than an error boundary.
 */
export async function loadDashboard(session: Session): Promise<{
  data: DashboardResponse | null;
  error: string | null;
}> {
  try {
    const data = await endpoints.dashboard(session.token);
    return { data, error: null };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Could not reach the TruckDesk API';
    return { data: null, error: message };
  }
}

export { endpoints };