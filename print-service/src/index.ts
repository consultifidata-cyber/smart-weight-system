import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import logger from './utils/logger.js';
import { createDriver } from './drivers/index.js';
import { createServer } from './api/server.js';
import { startProbe, stopProbe } from './hardware/printerHealthCache.js';

// ── Build version (read once at startup) ─────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
let VERSION = '2.1.5';
try {
  const pkg = JSON.parse(readFileSync(join(__dir, '../package.json'), 'utf8'));
  VERSION = (pkg as { version?: string }).version ?? VERSION;
} catch { /* use hardcoded fallback */ }

async function main(): Promise<void> {
  // This is the startup line the acceptance test grep's for:
  // {"msg":"Service started","version":"2.1.5","printMode":"WINDOWS"}
  logger.info(
    { version: VERSION, stationId: config.stationId, printMode: config.printMode, driver: config.driver },
    'Service started',
  );

  try {
    // Create printer driver (resolves adapter type, logs effective config)
    const driver = await createDriver(config);

    // Start background health probe — replaces the old 10s heartbeat.
    // Probe runs every 30 s with 10 s timeout and 3-failure hysteresis.
    // HTTP handlers (system/status, print/health) read the cached boolean
    // instead of calling driver.healthCheck() on every request.
    startProbe(driver);

    // Create and start Express server
    const app = createServer(driver, config);

    const server = app.listen(config.apiPort, () => {
      logger.info({ port: config.apiPort, version: VERSION }, 'Print service listening');
    });

    // Graceful shutdown: drain in-flight print requests before exit.
    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'Shutting down print service');
      stopProbe();
      server.close(() => {
        logger.info('Print service stopped');
        process.exit(0);
      });
      setTimeout(() => {
        logger.warn('Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, 8000);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Fatal error');
    process.exit(1);
  }
}

main();
