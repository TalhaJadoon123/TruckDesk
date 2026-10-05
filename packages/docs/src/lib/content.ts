import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import { marked } from 'marked';

import type { DocPage } from './types';

const CONTENT_DIR = path.join(process.cwd(), 'content');

/**
 * Docs content.
 *
 * Pages are plain markdown in `content/`, read at build time. That means the
 * docs version with the code, and a page can be edited without touching React.
 */
export function listDocs(): DocPage[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  const files = fs
    .readdirSync(CONTENT_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort();

  return files.map((file) => {
    const slug = file.replace(/\.md$/, '');
    const raw = fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8');
    const { data } = matter(raw);

    const order = typeof data['order'] === 'number' ? data['order'] : 999;
    const group = typeof data['group'] === 'string' ? data['group'] : 'Guide';

    return {
      slug,
      title: typeof data['title'] === 'string' ? data['title'] : slug,
      description: typeof data['description'] === 'string' ? data['description'] : '',
      order,
      group,
    };
  });
}

export function readDoc(slug: string): { page: DocPage; html: string } | null {
  const file = path.join(CONTENT_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;

  const raw = fs.readFileSync(file, 'utf8');
  const { data } = matter(raw);
  const html = marked.parse(raw, { async: false }) as string;

  return {
    page: {
      slug,
      title: typeof data['title'] === 'string' ? data['title'] : slug,
      description: typeof data['description'] === 'string' ? data['description'] : '',
      order: typeof data['order'] === 'number' ? data['order'] : 999,
      group: typeof data['group'] === 'string' ? data['group'] : 'Guide',
    },
    html,
  };
}

export const DOC_GROUPS = ['Start here', 'Free tier setup', 'Operations', 'Reference'] as const;