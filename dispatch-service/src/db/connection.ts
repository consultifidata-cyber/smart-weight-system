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

  // Verify dispatch tables exist (migration v8 must have run)
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dispatch_doc','dispatch_line','party_master')"
  ).all() as { name: string }[]).map(r => r.name);

  if (tables.length < 3) {
    throw new Error(
      `Dispatch tables missing (found: ${tables.join(',')}). ` +
      'Ensure sync-service has run migration v8 (Phase DA) at least once.'
    );
  }

  logger.info('SQLite ready — dispatch tables confirmed');
  return db;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}
