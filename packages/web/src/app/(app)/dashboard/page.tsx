import Link from 'next/link';

import { loadDashboard, getSession } from '@/lib/session';
import { formatCpm, formatDuration, formatEta } from '@/lib/api';
import {
  Banner,
  Card,
  EmptyState,
  Lane,
  LoadBadge,
  Money,
  PageHeader,
  Sparkbars,
  Spinner,
  Stat,
  Tag,
} from '@/components/ui';

/**
 * Dashboard.
 *
 * Rendered on the server from one `/dashboard` call, so it paints with real
 * numbers on first byte. The tiles are ordered by what a dispatcher asks first:
 * how much money came in, what is rolling, what needs chasing.
 */

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  const { data, error } = await loadDashboard(session);

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Banner tone="bad" title="Could not reach the API">
          {error}. Start it with <span className="font-mono">pnpm dev:api</span>, then reload.
        </Banner>
      </>
    );
  }

  if (!data) return <Spinner />;

  const { summary, formatted, utilisation, health, trend, attention, hos, mode } = data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Week of ${trend[trend.length - 1]?.label ?? 'this week'}`}
        actions={
          <>
            <Link
              href="/dispatch"
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-black hover:brightness-110"
            >
              Open dispatch
            </Link>
            {mode === 'memory' ? <Tag tone="warn">in-memory demo data</Tag> : <Tag tone="good">postgres</Tag>}
          </>
        }
      />

      {/* ------------------------------------------------------------ money */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Revenue this week"
          value={formatted.revenueThisWeek}
          detail={`${summary.loadsDeliveredThisWeek} delivered`}
          tone="good"
        />
        <Stat
          label="Trucks available"
          value={`${summary.trucksAvailable} / ${summary.trucksTotal}`}
          detail={`${utilisation.loaded} loaded, ${utilisation.empty} empty, ${utilisation.maintenance} in shop`}
        />
        <Stat
          label="In transit"
          value={String(summary.loadsInTransit)}
          detail={`Deadhead ${formatted.deadheadRatioPercent} · on time ${formatted.onTimeRatePercent}`}
        />
        <Stat
          label="Unpaid receivables"
          value={formatted.unpaidReceivables}
          detail={`Avg ${formatted.averageRevenuePerMile} per mile`}
          tone={summary.unpaidReceivablesCents > 0 ? 'warn' : 'good'}
        />
      </div>

      {/* ---------------------------------------------------------- trends */}
      <div className="mt-4 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Revenue by week">
          <Sparkbars points={trend} formatValue={(cents) => `$${Math.round(cents / 100)}`} />
        </Card>

        <Card title="Fleet utilisation">
          <div className="space-y-2 p-4">
            <UtilBar label="Loaded" value={utilisation.loaded} total={summary.trucksTotal} color="var(--color-loaded)" />
            <UtilBar label="Empty (to pickup)" value={utilisation.empty} total={summary.trucksTotal} color="var(--color-empty)" />
            <UtilBar label="Available" value={utilisation.available} total={summary.trucksTotal} color="var(--color-available)" />
            <UtilBar label="Maintenance" value={utilisation.maintenance} total={summary.trucksTotal} color="var(--color-maintenance)" />
            <div className="mt-3 text-xs text-[var(--color-ink-faint)]">
              {Math.round(utilisation.utilisation * 100)}% of the fleet is deployed. A healthy small
              carrier runs 75-85%.
            </div>
          </div>
        </Card>
      </div>

      {/* ------------------------------------------------------ needs work */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card title={`Needs attention (${attention.length})`}>
          {attention.length === 0 ? (
            <EmptyState title="Nothing on fire" detail="No unassigned loads, no missing PODs, nothing past due." />
          ) : (
            <div className="divide-y divide-[var(--color-edge)]">
              {attention.slice(0, 8).map((item) => (
                <div key={item.load.id} className="px-4 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Lane origin={item.load.origin} destination={item.load.destination} />
                      <div className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">
                        {item.load.broker}
                      </div>
                    </div>
                    <LoadBadge status={item.load.status} />
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {item.reasons.map((reason) => (
                      <li key={reason} className="text-[11px] text-[var(--color-empty)]">
                        {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Board health">
          <div className="grid grid-cols-2 gap-3 p-4">
            <HealthTile
              label="Unassigned"
              value={health.unassigned}
              tone={health.unassigned > 0 ? 'warn' : 'good'}
              detail={health.staleUnassigned > 0 ? `${health.staleUnassigned} stale` : undefined}
            />
            <HealthTile
              label="Missing POD"
              value={health.missingPod}
              tone={health.missingPod > 0 ? 'bad' : 'good'}
              detail="blocks payment"
            />
            <HealthTile
              label="At risk on time"
              value={health.atRiskOnTime}
              tone={health.atRiskOnTime > 0 ? 'warn' : 'good'}
              detail="due within 24h"
            />
            <HealthTile
              label="Avg wait"
              value={`${health.averageDaysUnassigned}h`}
              tone="neutral"
              detail="to get assigned"
            />
          </div>

          {hos.length > 0 ? (
            <div className="border-t border-[var(--color-edge)] p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
                Hours of service
              </div>
              <div className="space-y-1.5">
                {hos.slice(0, 6).map((entry) => (
                  <div key={entry.driverId} className="flex items-center justify-between text-xs">
                    <span className="truncate text-[var(--color-ink-dim)]">
                      {entry.driverName ?? entry.unit}
                    </span>
                    <span className="money shrink-0">
                      <span
                        className={
                          entry.driveMinutesRemaining < 120
                            ? 'text-[var(--color-alert)]'
                            : entry.driveMinutesRemaining < 300
                              ? 'text-[var(--color-empty)]'
                              : 'text-[var(--color-ink-dim)]'
                        }
                      >
                        {formatDuration(entry.driveMinutesRemaining)}
                      </span>
                      <span className="ml-1 text-[var(--color-ink-faint)]">drive</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      {/* -------------------------------------------------------- in transit */}
      <Card title="In transit" className="mt-4">
        {data.board.columns
          .find((column) => column.status === 'in-transit')
          ?.loads.length === 0 ? (
          <EmptyState title="Nothing rolling" detail="Dispatch a load to see it here." />
        ) : (
          <div className="divide-y divide-[var(--color-edge)]">
            {data.board.columns
              .find((column) => column.status === 'in-transit')
              ?.loads.map((load) => {
                const progress = data.attention.find((row) => row.load.id === load.id);
                void progress;
                return (
                  <div key={load.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Lane origin={load.origin} destination={load.destination} />
                      <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                        {load.broker} · {load.miles} mi
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <Money cents={load.rate} className="text-sm font-medium" />
                      {load.deliveryDate ? (
                        <div className="text-[11px] text-[var(--color-ink-faint)]">
                          due {formatEta(load.deliveryDate)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </Card>
    </>
  );
}

function UtilBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-[var(--color-ink-dim)]">{label}</span>
        <span className="money text-[var(--color-ink-faint)]">
          {value} · {pct}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--color-board)]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function HealthTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number | string;
  detail?: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const toneClass = {
    good: 'text-[var(--color-available)]',
    warn: 'text-[var(--color-empty)]',
    bad: 'text-[var(--color-alert)]',
    neutral: 'text-[var(--color-ink)]',
  }[tone];

  return (
    <div className="rounded-md border border-[var(--color-edge)] bg-[var(--color-board)] p-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-faint)]">{label}</div>
      <div className={`money mt-0.5 text-xl font-semibold ${toneClass}`}>{value}</div>
      {detail ? <div className="text-[10px] text-[var(--color-ink-faint)]">{detail}</div> : null}
    </div>
  );
}

export { formatCpm };