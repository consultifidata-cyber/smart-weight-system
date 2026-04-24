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
    // Create printer driver
    const driver = createDriver(config);

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

    // Background health polling — log state transitions (connected ↔ disconnected)
    const healthPollId = setInterval(async () => {
      try {
        const nowConnected = await driver.healthCheck();
        if (nowConnected !== printerConnected) {
          if (nowConnected) {
            logger.info('Printer reconnected');
          } else {
            logger.warn('Printer disconnected');
          }
          printerConnected = nowConnected;
        }
      } catch { /* healthCheck returns boolean, shouldn't throw */ }
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
      }, 4000);
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
