import { NextResponse } from 'next/server';

import { encodeSession, SESSION_COOKIE } from '@/lib/session';

/**
 * Session cookie writer.
 *
 * The cookie value is signed with `API_TOKEN_SECRET` and its payload is already
 * an API token, so a server component can pass it straight to the API with no
 * extra verification step. HttpOnly + SameSite=Lax means client JavaScript
 * cannot read it, which is the point of having a session at all.
 */

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.API_TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    return NextResponse.json(
      { error: { message: 'API_TOKEN_SECRET is not configured' } },
      { status: 500 },
    );
  }

  let body: {
    userId?: string;
    companyId?: string;
    role?: 'driver' | 'dispatcher' | 'owner' | 'admin';
    email?: string;
    name?: string;
    token?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }

  if (!body.userId || !body.companyId || !body.token) {
    return NextResponse.json(
      { error: { message: 'userId, companyId and token are required' } },
      { status: 400 },
    );
  }

  const cookie = encodeSession(
    {
      userId: body.userId,
      companyId: body.companyId,
      role: body.role ?? 'dispatcher',
      email: body.email ?? '',
      name: body.name ?? body.email ?? 'User',
      token: body.token,
    },
    secret,
  );

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: cookie,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  });

  return response;
}

export async function DELETE(): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: SESSION_COOKIE, value: '', path: '/', maxAge: 0 });
  return response;
}