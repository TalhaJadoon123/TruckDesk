'use client';

import { useState } from 'react';

import { Card, Button, Banner, Field, Input } from '@/components/ui';
import { API_URL } from '@/lib/api';

/**
 * Sign in.
 *
 * Two paths, deliberately:
 *   - credentials, validated against the users table (scrypt hashes, no third
 *     party identity provider required);
 *   - the API's `/signup`, which creates the company and the owner in one call.
 *
 * Either way the browser ends up holding a signed session cookie whose payload
 * is already an API token, so there is no second round trip on the next request.
 */

export function LoginForm({ mode }: { mode: 'login' | 'register' }) {
  const [form, setForm] = useState({ companyName: '', name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === 'register') {
        const response = await fetch(`${API_URL}/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            companyName: form.companyName,
            name: form.name,
            email: form.email,
            password: form.password,
          }),
        });

        const payload = (await response.json()) as {
          companyId?: string;
          userId?: string;
          token?: string | null;
          note?: string;
          error?: { message?: string };
        };

        if (!response.ok) {
          setError(payload.error?.message ?? `Signup failed (${response.status})`);
          return;
        }

        if (!payload.token) {
          setNotice(payload.note ?? 'Account created. Set API_TOKEN_SECRET to receive a session.');
          return;
        }

        const claims = {
          userId: payload.userId ?? 'unknown',
          companyId: payload.companyId ?? 'unknown',
          role: 'owner' as const,
          email: form.email,
          name: form.name,
          token: payload.token,
        };

        await setSessionCookie(claims);
        window.location.href = '/dashboard';
        return;
      }

      // Sign in: verify credentials against the API's dev login.
      const response = await fetch(`${API_URL}/public/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, password: form.password }),
      });

      const payload = (await response.json()) as {
        token?: string;
        companyId?: string;
        userId?: string;
        role?: 'driver' | 'dispatcher' | 'owner' | 'admin';
        name?: string;
        error?: { message?: string };
      };

      if (!response.ok || !payload.token) {
        setError(payload.error?.message ?? 'Those credentials did not work');
        return;
      }

      await setSessionCookie({
        userId: payload.userId ?? 'unknown',
        companyId: payload.companyId ?? 'unknown',
        role: payload.role ?? 'dispatcher',
        email: form.email,
        name: payload.name ?? form.email,
        token: payload.token,
      });
      window.location.href = '/dashboard';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm p-6">
      <form onSubmit={submit} className="space-y-3">
        {mode === 'register' ? (
          <>
            <Field label="Company">
              <Input required value={form.companyName} onChange={set('companyName')} placeholder="Ridgeway Freight LLC" />
            </Field>
            <Field label="Your name">
              <Input required value={form.name} onChange={set('name')} placeholder="Dana Reyes" />
            </Field>
          </>
        ) : null}

        <Field label="Email">
          <Input required type="email" value={form.email} onChange={set('email')} placeholder="you@carrier.com" />
        </Field>

        <Field label="Password" hint={mode === 'register' ? 'At least 8 characters' : undefined}>
          <Input required type="password" value={form.password} onChange={set('password')} placeholder="..." />
        </Field>

        {error ? <Banner tone="bad" title="Cannot continue">{error}</Banner> : null}
        {notice ? <Banner tone="info" title="Heads up">{notice}</Banner> : null}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Working...' : mode === 'register' ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      {mode === 'login' ? (
        <div className="mt-4 rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] p-3 text-xs text-[var(--color-ink-dim)]">
          <div className="font-medium text-[var(--color-ink)]">Demo account</div>
          <div className="mt-1 font-mono">
            dispatcher@ridgewayfreight.com
            <br />
            truckdesk-demo
          </div>
          <div className="mt-1.5 text-[var(--color-ink-faint)]">
            Run <span className="font-mono">pnpm seed</span> first.
          </div>
        </div>
      ) : null}
    </Card>
  );
}

async function setSessionCookie(claims: {
  userId: string;
  companyId: string;
  role: 'driver' | 'dispatcher' | 'owner' | 'admin';
  email: string;
  name: string;
  token: string;
}): Promise<void> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claims),
  });

  if (!response.ok) {
    throw new Error('Could not start a session');
  }
}