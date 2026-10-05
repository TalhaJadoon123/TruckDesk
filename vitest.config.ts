import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest at the repo root.
 *
 * One project per package under test. The domain projects import the built
 * `dist` of each workspace package, which means `turbo` builds them first
 * (`test` dependsOn `^build`). That is deliberate: testing the published
 * artifact is what actually ships.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],

    // The demo seeder replays GPS, so a bit of headroom avoids flakes on a
    // loaded CI box without making a hang look like a pass.
    testTimeout: 20_000,
    hookTimeout: 20_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'packages/shared/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/eld/src/**/*.ts',
        'packages/loads/src/**/*.ts',
        'packages/llm/src/**/*.ts',
        'packages/sms/src/**/*.ts',
      ],
      exclude: ['**/index.ts', '**/*.test.ts', '**/probe.ts', '**/smoke.ts'],
      thresholds: {
        lines: 55,
        functions: 50,
        branches: 40,
      },
    },

    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './coverage/junit.xml' },
  },

  resolve: {
    alias: {
      '@truckdesk/shared': fileURLToPath(new URL('./packages/shared/dist/index.js', import.meta.url)),
      '@truckdesk/core': fileURLToPath(new URL('./packages/core/dist/index.js', import.meta.url)),
      '@truckdesk/eld': fileURLToPath(new URL('./packages/eld/dist/index.js', import.meta.url)),
      '@truckdesk/loads': fileURLToPath(new URL('./packages/loads/dist/index.js', import.meta.url)),
      '@truckdesk/llm': fileURLToPath(new URL('./packages/llm/dist/index.js', import.meta.url)),
      '@truckdesk/sms': fileURLToPath(new URL('./packages/sms/dist/index.js', import.meta.url)),
      '@truckdesk/integrations': fileURLToPath(new URL('./packages/integrations/dist/index.js', import.meta.url)),
      '@fixtures': fileURLToPath(new URL('./tests/fixtures', import.meta.url)),
    },
  },
});