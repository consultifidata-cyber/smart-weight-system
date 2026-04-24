import config from './config.js';
import logger from './utils/logger.js';
import { initDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { Queries } from './db/queries.js';
import { createServer } from './api/server.js';
import { DjangoClient } from './sync/client.js';
import { SyncEngine } from './sync/engine.js';
import { backupDatabase } from './db/backup.js';

async function main(): Promise<void> {
  logger.info(
    { stationId: config.stationId, plantId: config.plantId },
    'Starting sync service',
  );

  // Validate: if Django URL is configured, token must also be set
  if (config.djangoServerUrl && !config.djangoApiToken) {
    logger.error(
      'DJANGO_API_TOKEN is required when DJANGO_SERVER_URL is set. '
      + 'Set the token in .env or remove DJANGO_SERVER_URL for offline-only mode.',
    );
    process.exit(1);
  }

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

    const server = app.listen(config.apiPort, () => {
      logger.info({ port: config.apiPort }, 'Sync service listening');
    });

    // Start sync engine (offline session retry loop + master data timer)
    syncEngine.start();

    // Daily database backup (initial + every 24h)
    await backupDatabase(db, config.dbPath).catch(err =>
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Initial database backup failed'),
    );
    const backupTimerId = setInterval(() => {
      backupDatabase(db, config.dbPath).catch(err =>
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Scheduled database backup failed'),
      );
    }, 24 * 60 * 60 * 1000);

    // Graceful shutdown: drain in-flight HTTP requests before closing DB
    const shutdown = (signal: string): void => {
      logger.info({ signal }, 'Shutting down sync service');
      clearInterval(backupTimerId);
      syncEngine.stop();
      let dbClosed = false;
      server.close(() => {
        if (!dbClosed) { dbClosed = true; closeDb(); }
        logger.info('Sync service stopped');
        process.exit(0);
      });
      // Force exit after 4s if drain stalls (launcher waits 5s total)
      setTimeout(() => {
        logger.warn('Graceful shutdown timed out, forcing exit');
        if (!dbClosed) { dbClosed = true; closeDb(); }
        process.exit(1);
      }, 4000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Fatal error');
    closeDb();
    process.exit(1);
  }
}

main();
