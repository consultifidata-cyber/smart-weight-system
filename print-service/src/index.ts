import config from './config.js';
import logger from './utils/logger.js';
import { createDriver } from './drivers/index.js';
import { createServer } from './api/server.js';

async function main(): Promise<void> {
  logger.info(
    { stationId: config.stationId, driver: config.driver, device: config.device },
    'Starting print service',
  );

  try {
    // Create printer driver (async in Phase 2 — may run USB auto-detection)
    const driver = await createDriver(config);

    // Health check on startup
    let printerConnected = await driver.healthCheck();
    if (!printerConnected) {
      logger.warn({ device: config.device }, 'Printer not reachable on startup');
    } else {
      logger.info('Printer connected');
    }

    // Create and start Express server
    const app = createServer(driver, config);

    const server = app.listen(config.apiPort, () => {
      logger.info({ port: config.apiPort }, 'Print service listening');
    });

    // Hardware heartbeat — every 10 s (PRINT_HEALTH_POLL_MS).
    // CascadingPrintAdapter.healthCheck() drives automatic recovery internally:
    // if the current adapter fails it probes USBPRIN → libusb → COM and switches.
    const healthPollId = setInterval(async () => {
      try {
        const nowConnected = await driver.healthCheck();
        if (nowConnected !== printerConnected) {
          const adapterInfo = (driver as any).adapter?.getInfo?.() ?? 'n/a';
          if (nowConnected) {
            logger.info({ adapter: adapterInfo }, 'Printer recovered');
          } else {
            logger.warn({ adapter: adapterInfo }, 'Printer unavailable — will retry next heartbeat');
          }
          printerConnected = nowConnected;
        }
      } catch { /* healthCheck must not throw */ }
    }, config.healthPollMs);

    // Graceful shutdown: drain in-flight print requests before exit.
    // Critical: aborting a TSPL buffer mid-stream can jam the printer.
    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'Shutting down print service');
      clearInterval(healthPollId);
      server.close(() => {
        logger.info('Print service stopped');
        process.exit(0);
      });
      setTimeout(() => {
        logger.warn('Graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, 8000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Fatal error');
    process.exit(1);
  }
}

main();
