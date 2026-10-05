import { buildServer } from './server.js';
import { describeCapabilities } from './env.js';

/**
 * Process entry point for Node (Docker, a VPS, Railway, Fly).
 *
 * Boots, prints exactly what is and is not wired up, and shuts down cleanly on
 * SIGTERM so a rolling deploy does not cut pings in flight.
 */

const started = Date.now();

async function main(): Promise<void> {
  const app = await buildServer();

  const config = app.tdServices.env;
  const host = config.HOST;
  const port = config.PORT;

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error({ err: error }, 'Failed to listen');
    process.exit(1);
  }

  const capabilities = describeCapabilities(config);

  app.log.info(
    { port, host, elapsedMs: Date.now() - started },
    `TruckDesk API ready on http://${host}:${port}`,
  );

  // A capability banner at boot is the difference between "the AI parser is
  // broken" and "GROQ_API_KEY was never set".
  for (const capability of capabilities) {
    const mark = capability.enabled ? 'on ' : 'off';
    app.log.info(`  [${mark}] ${capability.name}: ${capability.detail}`);
  }

  if (app.tdServices.memory) {
    app.log.warn(
      'Running on the in-memory store. Set DATABASE_URL to persist data (Neon or Supabase, both free tier).',
    );
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      await app.tdServices.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection in a dispatch loop must not take the process down
  // mid-push; log it and keep serving.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled promise rejection');
  });
}

main().catch((error) => {
  console.error('Fatal error starting TruckDesk API:', error);
  process.exit(1);
});