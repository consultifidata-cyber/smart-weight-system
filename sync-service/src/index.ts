import config from './config.js';
import logger from './utils/logger.js';
import { initDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { Queries } from './db/queries.js';
import { createServer } from './api/server.js';
import { DjangoClient } from './sync/client.js';
import { SyncEngine } from './sync/engine.js';

async function main(): Promise<void> {
  logger.info(
    { stationId: config.stationId, plantId: config.plantId },
    'Starting sync service',
  );

  try {
    // Initialize SQLite database and run migrations
    const db = initDb(config.dbPath);
    runMigrations(db);

    // Initialize query layer
    const queries = new Queries(db);

    // Initialize sync engine
    const client = new DjangoClient(config.djangoServerUrl, config.djangoApiToken, config.syncPushTimeoutMs);
    const syncEngine = new SyncEngine(queries, client, config);
    const pullMasterData = () => syncEngine.pullMasterData();

    // Create and start Express server
    // Pass client so session routes can proxy to Django
    const app = createServer(queries, config, undefined, pullMasterData, client, syncEngine);

    app.listen(config.apiPort, () => {
      logger.info({ port: config.apiPort }, 'Sync service listening');
    });

    // Start sync engine (offline session retry loop + master data timer)
    syncEngine.start();

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Shutting down sync service');
      syncEngine.stop();
      closeDb();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Fatal error');
    closeDb();
    process.exit(1);
  }
}

main();
