import type { NextConfig } from 'next';

/**
 * Next config.
 *
 * The workspace packages are transpiled rather than bundled from `dist`, so a
 * change to `@truckdesk/core` shows up on refresh without a rebuild. That costs
 * nothing in production, where Turbopack still tree-shakes the same code.
 *
 * `output: 'export'` is intentionally NOT set: the app uses Auth.js, which needs
 * a Node runtime for the session route, so it deploys to Cloudflare Pages via the
 * static export of `.next/static` plus Functions, or to any Node host.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@truckdesk/shared', '@truckdesk/core'],

  experimental: {
    optimizePackageImports: ['@truckdesk/shared', '@truckdesk/core'],
  },

  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;