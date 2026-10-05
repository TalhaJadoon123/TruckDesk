import { DispatchBoard } from '@/components/DispatchBoard';
import { loadDashboard, getSession } from '@/lib/session';
import { Banner, EmptyState, PageHeader, Spinner } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function DispatchPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  const { data, error } = await loadDashboard(session);

  if (error) {
    return (
      <>
        <PageHeader title="Dispatch" />
        <Banner tone="bad" title="Could not reach the API">
          {error}
        </Banner>
      </>
    );
  }
  if (!data) return <Spinner />;

  return (
    <>
      <PageHeader
        title="Dispatch"
        subtitle="Pick a load, then drop it on a truck. Every assignment is checked against equipment, weight, deadhead and remaining hours."
      />
      <DispatchBoard
        sessionToken={session.token}
        initialBoard={data.board}
        initialDashboard={data}
      />
    </>
  );
}