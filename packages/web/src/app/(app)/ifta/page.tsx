import { IftaCalculator } from '@/components/IftaCalculator';
import { getSession } from '@/lib/session';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * In-app IFTA.
 *
 * The same calculator as the marketing site, plus the quarter selector and the
 * note that a filing-grade report needs per-state stop mileage. That caveat is
 * stated in the UI rather than buried in docs, because a carrier who files from
 * a 50/50 origin/destination split will get a wrong number eventually.
 */
export default async function IftaPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  return (
    <>
      <PageHeader
        title="IFTA"
        subtitle="Quarterly apportioned fuel tax. Free tier gets the calculator; Starter adds the filed report."
      />

      <div className="mb-4 rounded-lg border border-[var(--color-empty)] bg-[color-mix(in_oklch,var(--color-empty)_8%,transparent)] px-4 py-3 text-sm">
        <span className="font-medium">How this estimates your number.</span>{' '}
        <span className="text-[var(--color-ink-dim)]">
          Gallons are derived from miles and MPG using the IRP standard when you do not enter them.
          Enter gallons per state for exact fuel credits. In the paid app, fuel-card entries supply
          real gallons per jurisdiction automatically.
        </span>
      </div>

      <IftaCalculator />

      <Card title="Quarterly filing" className="mt-4">
        <div className="px-4 py-3 text-sm text-[var(--color-ink-dim)]">
          IFTA periods run 1 January - 30 June and 1 July - 31 December. The filed report includes
          per-vehicle apportionment, the owner-operator deduction and every fixed fee, and is
          reproducible from the data you logged, which is the part an auditor actually asks about.
        </div>
      </Card>
    </>
  );
}