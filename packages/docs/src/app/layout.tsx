import Link from 'next/link';

import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'TruckDesk Docs', template: '%s | TruckDesk Docs' },
  description: 'Setup, operations and API reference for TruckDesk.',
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="td-docs-header">
          <Link href="/" className="td-brand">
            <span className="td-mark">TD</span>
            <span>TruckDesk Docs</span>
          </Link>
          <Link href="/" className="td-header-link">
            Product
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}