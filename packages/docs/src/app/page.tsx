import Link from 'next/link';

import { DOC_GROUPS, listDocs } from '@/lib/content';

export const dynamic = 'force-static';

export default function DocsIndex() {
  const pages = listDocs();
  const grouped = DOC_GROUPS.map((group) => ({
    group,
    pages: pages.filter((page) => page.group === group),
  })).filter((entry) => entry.pages.length > 0);

  return (
    <div className="td-layout" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <div className="td-content">
        <h1>TruckDesk documentation</h1>
        <p className="td-lede">
          Everything needed to run a dispatch operation on TruckDesk without spending money.
          Start with the setup page; it is fifteen minutes and no card.
        </p>

        {grouped.map((section) => (
          <section key={section.group}>
            <h2>{section.group}</h2>
            <div className="td-cards">
              {section.pages.map((page) => (
                <Link key={page.slug} href={`/docs/${page.slug}`} className="td-card">
                  <div className="td-card-title">{page.title}</div>
                  {page.description ? (
                    <div className="td-card-desc">{page.description}</div>
                  ) : null}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}