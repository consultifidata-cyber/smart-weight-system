import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import logger from '../utils/logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath: string): Database.Database {
  // Ensure the data directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  logger.info({ dbPath }, 'Opening SQLite database');

  db = new Database(dbPath);

  // Enable WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');

  // Enable foreign key enforcement
  db.pragma('foreign_keys = ON');

  logger.info('SQLite database ready (WAL mode, FK enabled)');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}
