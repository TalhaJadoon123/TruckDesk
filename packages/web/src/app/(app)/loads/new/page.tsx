import { EmailParser } from '@/components/EmailParser';
import { getSession } from '@/lib/session';
import { EmptyState, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function LoadsNewPage() {
  const session = await getSession();
  if (!session) return <EmptyState title="Not signed in" />;

  return (
    <>
      <PageHeader
        title="Add a load"
        subtitle="Paste the broker email. The parser reads the lane, rate, miles, weight and dates, and tells you what it is not sure about."
      />
      <EmailParser token={session.token} />
    </>
  );
}