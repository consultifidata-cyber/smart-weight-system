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
    const connected = await driver.healthCheckWin();
    if (!connected) {
      logger.warn({ device: config.device }, 'Printer not reachable on startup');
    } else {
      logger.info('Printer connected');
    }

    // Create and start Express server
    const app = createServer(driver, config);

    app.listen(config.apiPort, () => {
      logger.info({ port: config.apiPort }, 'Print service listening');
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down');
      process.exit(0);
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Fatal error');
    process.exit(1);
  }
}

main();
