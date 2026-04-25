import config from './config.js';
import logger from './utils/logger.js';
import { initDb, closeDb } from './db/connection.js';
import { DispatchQueries } from './db/queries.js';
import { createServer } from './api/server.js';

async function main(): Promise<void> {
  logger.info({ port: config.apiPort, station: config.stationId }, 'Starting dispatch-service');

  // Open the shared SQLite DB (same file as sync-service)
  const db      = initDb(config.dbPath);
  const queries = new DispatchQueries(db);

  const app    = createServer(queries);

  // Bind 0.0.0.0 so Laptop B (on the same WiFi) can reach port 4000
  const server = app.listen(config.apiPort, '0.0.0.0', () => {
    logger.info(
      `Dispatch API ready → http://0.0.0.0:${config.apiPort}/health` +
      `  (LAN: http://<THIS_LAPTOP_IP>:${config.apiPort})`,
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down dispatch-service');
    server.close(() => {
      closeDb();
      logger.info('Stopped');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 6000);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[DISPATCH-SERVICE] Fatal error:', err);
  process.exit(1);
});
