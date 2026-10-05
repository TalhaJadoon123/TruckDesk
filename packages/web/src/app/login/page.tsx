import Link from 'next/link';

import { LoginForm } from '@/components/LoginForm';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-5">
      <Link href="/" className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded bg-[var(--color-accent)] text-sm font-bold text-black">
          TD
        </span>
        <span className="font-semibold tracking-tight">TruckDesk</span>
      </Link>

      <LoginForm mode="login" />

      <p className="text-sm text-[var(--color-ink-dim)]">
        No account yet?{' '}
        <Link href="/register" className="underline hover:text-[var(--color-ink)]">
          Start free with 2 trucks
        </Link>
      </p>
    </div>
  );
}