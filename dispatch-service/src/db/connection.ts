import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import logger from '../utils/logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialised — call initDb() first');
  return db;
}

export function initDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  logger.info({ dbPath }, 'Opening SQLite (same file as sync-service)');

  db = new Database(dbPath);

  // WAL mode — allows dispatch-service to read/write dispatch tables
  // while sync-service reads/writes fg_ tables concurrently
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/**
 * Poll until all three dispatch tables exist (created by sync-service migration v8).
 *
 * dispatch-service starts at the same time as sync-service; on first boot the
 * migrations may not have run yet.  We retry with a 2s interval for up to
 * maxWaitMs (default 30s) before giving up — enough time for sync-service to
 * open the DB, run migrations v1-v9, and close its transaction.
 */
export async function waitForDispatchTables(
  openedDb: Database.Database,
  maxWaitMs = 30_000,
): Promise<void> {
  const pollMs   = 2_000;
  const deadline = Date.now() + maxWaitMs;

  const check = () =>
    (openedDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dispatch_doc','dispatch_line','party_master')"
    ).all() as { name: string }[]).map(r => r.name);

  let found = check();

  while (found.length < 3) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Dispatch tables still missing after ${maxWaitMs / 1000}s ` +
        `(found: ${found.join(',') || 'none'}). ` +
        'Ensure sync-service has run migration v8 (Phase DA) at least once.',
      );
    }

    logger.warn(
      { found, remainingSec: Math.round(remaining / 1000) },
      '[dispatch] Tables not ready — waiting for sync-service migrations…',
    );

    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    found = check();
  }

  logger.info({ tables: found }, 'SQLite ready — dispatch tables confirmed');
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}
