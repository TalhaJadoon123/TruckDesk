import { notFound } from 'next/navigation';

import { DOC_GROUPS, listDocs, readDoc } from '@/lib/content';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return listDocs().map((page) => ({ slug: page.slug }));
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = readDoc(slug);
  if (!found) notFound();

  const pages = listDocs();
  const current = pages.find((page) => page.slug === slug)!;

  const grouped = DOC_GROUPS.map((group) => ({
    group,
    pages: pages.filter((page) => page.group === group),
  })).filter((entry) => entry.pages.length > 0);

  return (
    <div className="td-layout">
      <nav className="td-nav">
        {grouped.map((section) => (
          <div key={section.group} className="td-nav-group">
            <h2>{section.group}</h2>
            {section.pages.map((page) => (
              <a
                key={page.slug}
                href={`/docs/${page.slug}`}
                className={page.slug === slug ? 'td-active' : undefined}
              >
                {page.title}
              </a>
            ))}
          </div>
        ))}
      </nav>

      <article className="td-content" dangerouslySetInnerHTML={{ __html: found.html }} />
    </div>
  );
}