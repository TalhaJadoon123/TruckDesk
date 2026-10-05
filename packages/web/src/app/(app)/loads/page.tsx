import Link from 'next/link';

import { endpoints } from '@/lib/api';
import { getSession } from '@/lib/session';
import { Banner, Card, EmptyState, Lane, LoadBadge, Money, PageHeader, Spinner, Tag } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function LoadsPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  let loads: Awaited<ReturnType<typeof endpoints.loads>>['loads'] = [];
  let error: string | null = null;

  try {
    loads = (await endpoints.loads(session.token, '?limit=100&sort=pickup')).loads;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load';
  }

  const byStatus = {
    booked: loads.filter((load) => load.status === 'booked'),
    rolling: loads.filter((load) => load.status === 'dispatched' || load.status === 'in-transit'),
    closed: loads.filter((load) => load.status === 'delivered' || load.status === 'paid'),
  };

  return (
    <>
      <PageHeader
        title="Loads"
        subtitle={`${loads.length} loads`}
        actions={
          <Link
            href="/dispatch"
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-black hover:brightness-110"
          >
            Dispatch
          </Link>
        }
      />

      {error ? (
        <Banner tone="bad" title="Could not load the load list">
          {error}
        </Banner>
      ) : null}

      {!error && loads.length === 0 ? (
        <Card>
          <EmptyState
            title="No loads yet"
            detail="Run `pnpm seed` for the demo company, or add a load from the dispatch board."
          />
        </Card>
      ) : null}

      {(['booked', 'rolling', 'closed'] as const).map((group) => (
        <Card
          key={group}
          title={`${group === 'rolling' ? 'Rolling' : group === 'closed' ? 'Closed' : 'Booked'} (${byStatus[group].length})`}
          className="mb-4"
        >
          {byStatus[group].length === 0 ? (
            <EmptyState title="Nothing here" />
          ) : (
            <div className="divide-y divide-[var(--color-edge)]">
              {byStatus[group].map((load) => {
                const rpm = load.miles > 0 ? load.rate / load.miles : 0;
                return (
                  <div key={load.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Lane origin={load.origin} destination={load.destination} />
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-faint)]">
                        <span>{load.broker}</span>
                        {load.reference ? <span>· {load.reference}</span> : null}
                        {load.commodity ? <span>· {load.commodity}</span> : null}
                        {load.proofOfDeliveryMissing ? (
                          <Tag tone="bad">no POD</Tag>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="money text-xs text-[var(--color-ink-dim)]">
                          {load.miles} mi · ${(rpm / 100).toFixed(2)}/mi
                        </div>
                      </div>
                      <Money cents={load.rate} className="w-24 text-right text-sm font-medium" />
                      <LoadBadge status={load.status} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ))}

      <Spinner label="" />
    </>
  );
}