import Link from 'next/link';

import { LoginForm } from '@/components/LoginForm';

export const metadata = { title: 'Start free' };

export default function RegisterPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-5">
      <Link href="/" className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded bg-[var(--color-accent)] text-sm font-bold text-black">
          TD
        </span>
        <span className="font-semibold tracking-tight">TruckDesk</span>
      </Link>

      <div className="text-center">
        <h1 className="text-xl font-semibold">Start free</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-dim)]">
          Two trucks, forever free. No card, no contract.
        </p>
      </div>

      <LoginForm mode="register" />

      <p className="text-sm text-[var(--color-ink-dim)]">
        Already running one?{' '}
        <Link href="/login" className="underline hover:text-[var(--color-ink)]">
          Sign in
        </Link>
      </p>
    </div>
  );
}