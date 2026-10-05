import { endpoints } from '@/lib/api';
import { getSession } from '@/lib/session';
import { formatDuration } from '@/lib/api';
import { Banner, Card, EmptyState, PageHeader, Spinner, Tag } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface DriverRow {
  id: string;
  name: string;
  phone?: string;
  status: string;
  payType: string;
  payRateBps?: number;
  payPerMileCents?: number;
  licenseState?: string;
  hazmatEndorsed?: boolean;
  preferredLanes?: Array<Record<string, unknown>>;
}

export default async function DriversPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  let drivers: DriverRow[] = [];
  let hos: Array<Record<string, unknown>> = [];
  let error: string | null = null;

  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    const [driversResponse, hosResponse] = await Promise.all([
      fetch(`${apiUrl}/drivers`, {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      }),
      fetch(`${apiUrl}/hos`, {
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
      }),
    ]);

    if (driversResponse.ok) {
      const body = (await driversResponse.json()) as { drivers?: DriverRow[] };
      drivers = body.drivers ?? [];
    }
    if (hosResponse.ok) {
      const body = (await hosResponse.json()) as { hos?: Array<Record<string, unknown>> };
      hos = body.hos ?? [];
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Could not load drivers';
  }

  void endpoints;

  return (
    <>
      <PageHeader
        title="Drivers"
        subtitle={`${drivers.length} drivers`}
      />

      {error ? (
        <Banner tone="bad" title="Could not load drivers">
          {error}
        </Banner>
      ) : null}

      {!error && drivers.length === 0 ? (
        <Card>
          <EmptyState title="No drivers" detail="Add drivers to start assigning loads and running settlements." />
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {drivers.map((driver) => {
          const hosEntry = hos.find((entry) => entry.driverId === driver.id);
          const driveMinutes = (hosEntry?.driveMinutesRemaining as number) ?? null;

          return (
            <Card key={driver.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{driver.name}</div>
                  <div className="truncate text-xs text-[var(--color-ink-faint)]">
                    {driver.phone ?? 'no phone'}
                  </div>
                </div>
                <Tag tone={driver.status === 'active' ? 'good' : 'warn'}>{driver.status}</Tag>
              </div>

              <div className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-faint)]">Pay</span>
                  <span className="money text-[var(--color-ink-dim)]">
                    {driver.payType === 'percentage'
                      ? `${((driver.payRateBps ?? 2500) / 100).toFixed(0)}% of linehaul`
                      : driver.payType === 'flat_per_mile'
                        ? `${((driver.payPerMileCents ?? 45) / 100).toFixed(2)}/mi`
                        : driver.payType.replace('_', ' ')}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-faint)]">CDL</span>
                  <span className="text-[var(--color-ink-dim)]">{driver.licenseState ?? 'not on file'}</span>
                </div>

                {driver.hazmatEndorsed ? (
                  <div className="flex justify-between">
                    <span className="text-[var(--color-ink-faint)]">Endorsements</span>
                    <Tag>Hazmat</Tag>
                  </div>
                ) : null}

                {driveMinutes !== null ? (
                  <div className="flex justify-between">
                    <span className="text-[var(--color-ink-faint)]">Drive left</span>
                    <span
                      className={`money ${
                        driveMinutes < 120
                          ? 'text-[var(--color-alert)]'
                          : driveMinutes < 300
                            ? 'text-[var(--color-empty)]'
                            : 'text-[var(--color-ink-dim)]'
                      }`}
                    >
                      {formatDuration(driveMinutes)}
                    </span>
                  </div>
                ) : null}
              </div>

              {Array.isArray(driver.preferredLanes) && driver.preferredLanes.length > 0 ? (
                <div className="mt-3 border-t border-[var(--color-edge)] pt-2">
                  <div className="text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
                    Runs
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {driver.preferredLanes.slice(0, 3).map((lane, index) => (
                      <Tag key={index}>
                        {String(lane.originState ?? '?')} &rarr; {String(lane.destinationState ?? '?')}
                      </Tag>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <Spinner label="" />
    </>
  );
}