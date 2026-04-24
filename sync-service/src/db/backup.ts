import type Database from 'better-sqlite3';
import { readdirSync, renameSync, unlinkSync, statSync } from 'fs';
import { dirname, join, basename } from 'path';
import logger from '../utils/logger.js';

const MAX_BACKUPS = 7;
const BACKUP_PATTERN = /^fg_production\.\d{8}\.bak$/;

/**
 * Backup the SQLite database using the online backup API.
 * Safe to call during active reads/writes (WAL mode).
 *
 * - Writes to a temp file first, then renames atomically
 * - Keeps last MAX_BACKUPS daily backups, deletes older ones
 */
export async function backupDatabase(db: Database.Database, dbPath: string): Promise<void> {
  const backupDir = dirname(dbPath);
  const dateStr = new Date().toISOString().substring(0, 10).replace(/-/g, '');
  const backupName = `fg_production.${dateStr}.bak`;
  const backupPath = join(backupDir, backupName);
  const tempPath = backupPath + '.tmp';

  try {
    // Step 1: Backup to temp file using SQLite online backup API
    await db.backup(tempPath);

    // Step 2: Atomic rename
    renameSync(tempPath, backupPath);

    // Step 3: Cleanup old backups (keep last MAX_BACKUPS)
    const files = readdirSync(backupDir)
      .filter(f => BACKUP_PATTERN.test(f))
      .sort()
      .reverse();

    for (const old of files.slice(MAX_BACKUPS)) {
      try {
        unlinkSync(join(backupDir, old));
        logger.debug({ file: old }, 'Deleted old backup');
      } catch { /* best effort */ }
    }

    const size = statSync(backupPath).size;
    logger.info(
      { backupPath: backupName, sizeBytes: size, keptBackups: Math.min(files.length, MAX_BACKUPS) },
      'Database backup complete',
    );
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tempPath); } catch { /* may not exist */ }
    throw err;
  }
}
