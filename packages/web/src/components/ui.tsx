import type { ReactNode } from 'react';

import type { Load, Truck } from '@truckdesk/shared';

/**
 * Small, dependency-free UI primitives.
 *
 * No component library: every dependency in this app earns its place on the
 * free tier, and a design system the dispatcher can restyle without a build step
 * is worth more here than a vendor's defaults.
 */

/* -------------------------------------------------------------------------- */
/* Layout                                                                        */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = '',
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] ${className}`}
    >
      {title ? (
        <header className="flex items-center justify-between border-b border-[var(--color-edge)] px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-[var(--color-ink-dim)]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat tile                                                                      */
/* -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    neutral: 'text-[var(--color-ink)]',
    good: 'text-[var(--color-available)]',
    warn: 'text-[var(--color-empty)]',
    bad: 'text-[var(--color-alert)]',
  }[tone];

  return (
    <div className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
        {label}
      </div>
      <div className={`money mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-[var(--color-ink-dim)]">{detail}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                         */
/* -------------------------------------------------------------------------- */

const TRUCK_TONE: Record<Truck['status'], string> = {
  available: 'var(--color-available)',
  loaded: 'var(--color-loaded)',
  empty: 'var(--color-empty)',
  maintenance: 'var(--color-maintenance)',
};

const LOAD_TONE: Record<Load['status'], string> = {
  booked: 'var(--color-booked)',
  dispatched: 'var(--color-transit)',
  'in-transit': 'var(--color-transit)',
  delivered: 'var(--color-delivered)',
  paid: 'var(--color-paid)',
};

export function TruckBadge({ status }: { status: Truck['status'] }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize"
      style={{ background: `color-mix(in oklch, ${TRUCK_TONE[status]} 18%, transparent)`, color: TRUCK_TONE[status] }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TRUCK_TONE[status] }} />
      {status}
    </span>
  );
}

export function LoadBadge({ status }: { status: Load['status'] }) {
  return (
    <span
      className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium"
      style={{
        background: `color-mix(in oklch, ${LOAD_TONE[status]} 18%, transparent)`,
        color: LOAD_TONE[status],
      }}
    >
      {status === 'in-transit' ? 'in transit' : status}
    </span>
  );
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'bad' | 'good' }) {
  const toneClass = {
    neutral: 'text-[var(--color-ink-dim)] border-[var(--color-edge)]',
    good: 'text-[var(--color-available)] border-[var(--color-available)]',
    warn: 'text-[var(--color-empty)] border-[var(--color-empty)]',
    bad: 'text-[var(--color-alert)] border-[var(--color-alert)]',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] ${toneClass}`}>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                       */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md';
}) {
  const variants = {
    primary:
      'bg-[var(--color-accent)] text-black font-semibold hover:brightness-110 disabled:opacity-40',
    ghost:
      'border border-[var(--color-edge)] text-[var(--color-ink)] hover:bg-[var(--color-panel-raised)]',
    subtle: 'text-[var(--color-ink-dim)] hover:text-[var(--color-ink)] hover:bg-[var(--color-panel-raised)]',
    danger: 'bg-[var(--color-alert)] text-white font-semibold hover:brightness-110 disabled:opacity-40',
  }[variant];

  const sizes = { sm: 'px-2 py-1 text-xs', md: 'px-3 py-1.5 text-sm' }[size];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md transition disabled:cursor-not-allowed ${variants} ${sizes} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] px-3 py-1.5 text-sm text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)] ${props.className ?? ''}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] px-2 py-1.5 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)] ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-ink-dim)]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">{hint}</span> : null}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                       */
/* -------------------------------------------------------------------------- */

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-sm font-medium text-[var(--color-ink-dim)]">{title}</div>
      {detail ? <div className="max-w-sm text-xs text-[var(--color-ink-faint)]">{detail}</div> : null}
      {action}
    </div>
  );
}

export function Banner({
  tone = 'warn',
  title,
  children,
}: {
  tone?: 'warn' | 'bad' | 'good' | 'info';
  title: string;
  children?: ReactNode;
}) {
  const toneClass = {
    warn: 'border-[var(--color-empty)] bg-[color-mix(in_oklch,var(--color-empty)_10%,transparent)]',
    bad: 'border-[var(--color-alert)] bg-[color-mix(in_oklch,var(--color-alert)_10%,transparent)]',
    good: 'border-[var(--color-available)] bg-[color-mix(in_oklch,var(--color-available)_10%,transparent)]',
    info: 'border-[var(--color-booked)] bg-[color-mix(in_oklch,var(--color-booked)_10%,transparent)]',
  }[tone];

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <div className="font-medium">{title}</div>
      {children ? <div className="mt-0.5 text-xs opacity-90">{children}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-[var(--color-ink-dim)]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-edge)] border-t-[var(--color-accent)]" />
      {label}...
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                     */
/* -------------------------------------------------------------------------- */

export function Money({ cents, className = '' }: { cents: number; className?: string }) {
  const negative = cents < 0;
  const dollars = Math.abs(cents) / 100;
  return (
    <span className={`money ${className}`}>
      {negative ? '-' : ''}${dollars.toLocaleString('en-US', {
        minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      })}
    </span>
  );
}

export function Lane({ origin, destination }: { origin: string; destination: string }) {
  return (
    <div className="truncate text-sm">
      <span className="font-medium">{origin}</span>
      <span className="mx-1.5 text-[var(--color-ink-faint)]">&rarr;</span>
      <span className="text-[var(--color-ink-dim)]">{destination}</span>
    </div>
  );
}

/** Horizontal revenue bars for the weekly trend. */
export function Sparkbars({
  points,
  formatValue,
}: {
  points: Array<{ label: string; revenueCents: number }>;
  formatValue: (cents: number) => string;
}) {
  const max = Math.max(1, ...points.map((point) => point.revenueCents));

  return (
    <div className="flex items-end gap-1.5 px-4 py-3">
      {points.map((point) => {
        const height = Math.max(4, Math.round((point.revenueCents / max) * 88));
        return (
          <div key={point.label} className="group flex flex-1 flex-col items-center gap-1">
            <div className="text-[10px] opacity-0 transition group-hover:opacity-100">
              {formatValue(point.revenueCents)}
            </div>
            <div
              className="w-full rounded-t bg-[var(--color-accent)]/70 transition group-hover:bg-[var(--color-accent)]"
              style={{ height }}
              title={`${point.label}: ${formatValue(point.revenueCents)}`}
            />
            <div className="text-[9px] text-[var(--color-ink-faint)]">{point.label.slice(5)}</div>
          </div>
        );
      })}
    </div>
  );
}