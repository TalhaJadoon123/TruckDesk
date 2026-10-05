import Link from 'next/link';

import { getSession } from '@/lib/session';
import { Banner, Button } from '@/components/ui';

/**
 * The signed-in shell: a fixed left rail on desktop, a bottom bar on mobile.
 *
 * The nav is deliberately short. A dispatcher opens this six times a day; every
 * extra destination is friction. Loads, Dispatch, Map, Money, Drivers.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="w-full max-w-md text-center">
          <Banner tone="info" title="Sign in to open the dispatch board">
            The seeded demo company is available with no configuration. If you are running this
            locally, `pnpm seed` and then <span className="font-mono">pnpm dev</span> is enough.
          </Banner>
          <Link
            href="/login"
            className="mt-4 inline-block rounded-md bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-black hover:brightness-110"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const nav = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/dispatch', label: 'Dispatch' },
    { href: '/loads', label: 'Loads' },
    { href: '/ifta', label: 'IFTA' },
    { href: '/money', label: 'Money' },
    { href: '/drivers', label: 'Drivers' },
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-[var(--color-edge)] bg-[var(--color-panel)]/50 md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="flex h-7 w-7 items-center justify-center rounded bg-[var(--color-accent)] text-xs font-bold text-black">
            TD
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">TruckDesk</div>
            <div className="truncate text-[11px] text-[var(--color-ink-faint)]">{session.email}</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-2">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-2 text-sm text-[var(--color-ink-dim)] transition hover:bg-[var(--color-panel-raised)] hover:text-[var(--color-ink)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="space-y-2 border-t border-[var(--color-edge)] p-3">
          <Link
            href="/"
            className="block text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          >
            Marketing site
          </Link>
          <Link href="/login" className="block">
            <Button variant="subtle" size="sm" className="w-full justify-start">
              Sign out
            </Button>
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-4 py-6 pb-24 md:px-6 md:pb-6">{children}</main>

        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--color-edge)] bg-[var(--color-board)] md:hidden">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex-1 px-1 py-2.5 text-center text-[11px] text-[var(--color-ink-dim)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}