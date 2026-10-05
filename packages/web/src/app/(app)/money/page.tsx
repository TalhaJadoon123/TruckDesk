import Link from 'next/link';

import { endpoints } from '@/lib/api';
import { getSession } from '@/lib/session';
import {
  Banner,
  Card,
  EmptyState,
  Money,
  PageHeader,
  Spinner,
  Stat,
  Tag,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Money: receivables aging plus the two weekly jobs (settle, bill).
 *
 * Aging is shown as buckets because that is how a broker's credit department and
 * every factoring company present it. The 60+ column is the one that matters.
 */
export default async function MoneyPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  let aging: Record<string, unknown> | null = null;
  let invoices: Array<Record<string, unknown>> = [];
  let error: string | null = null;

  try {
    aging = (await endpoints.aging(session.token)) as Record<string, unknown>;
    const response = await endpoints.bill(session.token);
    void response;
    const listed = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/invoice`,
      { headers: { Authorization: `Bearer ${session.token}` }, cache: 'no-store' },
    );
    if (listed.ok) {
      const body = (await listed.json()) as { invoices?: Array<Record<string, unknown>> };
      invoices = body.invoices ?? [];
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load';
  }

  const buckets = (aging?.buckets ?? {}) as Record<
    string,
    { count: number; balanceCents: number }
  >;
  const order = ['current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_90_plus'];
  const labels: Record<string, string> = {
    current: 'Current',
    days_1_30: '1-30 days',
    days_31_60: '31-60 days',
    days_61_90: '61-90 days',
    days_90_plus: '90+ days',
  };

  const topDelinquents = ((aging?.topDelinquents ?? []) as Array<Record<string, unknown>>).slice(0, 6);

  return (
    <>
      <PageHeader
        title="Money"
        subtitle="Invoices out, settlements owed, and who has not paid."
      />

      {error ? (
        <Banner tone="bad" title="Could not load receivables">
          {error}
        </Banner>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Outstanding"
          value={format((aging?.totalOutstandingCents as number) ?? 0)}
          detail={`${invoices.length} invoices`}
        />
        <Stat
          label="Overdue"
          value={format((aging?.totalOverdueCents as number) ?? 0)}
          detail={`${(aging?.overdueCount as number) ?? 0} invoices past due`}
          tone={((aging?.totalOverdueCents as number) ?? 0) > 0 ? 'warn' : 'good'}
        />
        <Stat
          label="Average days past due"
          value={String((aging?.averageDaysPastDue as number) ?? 0)}
          detail="across overdue invoices"
        />
        <Stat
          label="Over 60 days"
          value={`${Math.round(((aging?.staleShare as number) ?? 0) * 100)}%`}
          detail="of the book"
          tone={((aging?.staleShare as number) ?? 0) > 0.15 ? 'bad' : 'good'}
        />
      </div>

      <Card title="Aging" className="mt-4">
        <div className="grid gap-2 p-4 sm:grid-cols-5">
          {order.map((key) => {
            const bucket = buckets[key];
            return (
              <div
                key={key}
                className="rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] p-3"
              >
                <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                  {labels[key]}
                </div>
                <Money
                  cents={bucket?.balanceCents ?? 0}
                  className="mt-0.5 block text-lg font-semibold"
                />
                <div className="text-[10px] text-[var(--color-ink-faint)]">
                  {bucket?.count ?? 0} invoices
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {topDelinquents.length > 0 ? (
        <Card title="Chase these first" className="mt-4">
          <div className="divide-y divide-[var(--color-edge)]">
            {topDelinquents.map((row) => (
              <div key={String(row.invoiceId)} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm">{String(row.brokerName)}</div>
                  <div className="text-[11px] text-[var(--color-ink-faint)]">
                    {String(row.number)} · {String(row.loadCount)} loads
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Tag tone={(row.daysPastDue as number) > 60 ? 'bad' : 'warn'}>
                    {String(row.daysPastDue)}d past due
                  </Tag>
                  <Money cents={row.balanceCents as number} className="w-24 text-right text-sm" />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card title="Invoices" className="mt-4">
        {invoices.length === 0 ? (
          <EmptyState
            title="No invoices yet"
            detail="Run a billing pass from the API to raise one per broker from delivered loads."
          />
        ) : (
          <div className="divide-y divide-[var(--color-edge)]">
            {invoices.map((invoice) => (
              <div key={String(invoice.id)} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm">
                    {String(invoice.brokerName)}{' '}
                    <span className="text-[var(--color-ink-faint)]">{String(invoice.number)}</span>
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-faint)]">
                    due {String(invoice.dueAt).slice(0, 10)}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Tag tone={invoice.status === 'paid' ? 'good' : invoice.status === 'overdue' ? 'bad' : 'warn'}>
                    {String(invoice.status)}
                  </Tag>
                  <Money cents={invoice.balanceCents as number} className="w-24 text-right text-sm" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-4 text-xs text-[var(--color-ink-faint)]">
        Need to run a billing pass? <Link href="/docs" className="underline">See the API docs.</Link>
      </div>

      <Spinner label="" />
    </>
  );
}

function format(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}