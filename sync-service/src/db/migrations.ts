import type Database from 'better-sqlite3';
import logger from '../utils/logger.js';

const LATEST_VERSION = 4;

const migrations: Record<number, (db: Database.Database) => void> = {
  // Version 0 → 1: Core entry tables
  1: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fg_entry (
        local_entry_id    TEXT PRIMARY KEY,
        station_id        TEXT NOT NULL,
        plant_id          INTEGER NOT NULL,
        entry_date        TEXT NOT NULL,
        shift             TEXT,
        production_run_id INTEGER,
        created_by        TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL UNIQUE,
        sync_status       TEXT NOT NULL DEFAULT 'PENDING',
        sync_attempts     INTEGER NOT NULL DEFAULT 0,
        last_sync_error   TEXT,
        last_sync_at      TEXT,
        server_prod_no    TEXT,
        server_doc_id     INTEGER
      );

      CREATE TABLE IF NOT EXISTS fg_entry_line (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        local_entry_id   TEXT NOT NULL REFERENCES fg_entry(local_entry_id) ON DELETE CASCADE,
        item_id          INTEGER NOT NULL,
        pack_config_id   INTEGER NOT NULL,
        offer_id         INTEGER,
        num_bags         INTEGER NOT NULL DEFAULT 1,
        base_uom         TEXT NOT NULL DEFAULT 'PCS',
        batch_no         TEXT,
        note             TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_fg_entry_sync ON fg_entry(sync_status);
      CREATE INDEX IF NOT EXISTS idx_fg_entry_date ON fg_entry(entry_date);
      CREATE INDEX IF NOT EXISTS idx_fg_entry_line_entry ON fg_entry_line(local_entry_id);
    `);
  },

  // Version 1 → 2: Master data cache tables
  2: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fg_pack_config (
        pack_id       INTEGER PRIMARY KEY,
        item_id       INTEGER NOT NULL,
        pack_name     TEXT NOT NULL,
        net_weight_gm REAL,
        pcs_per_bag   INTEGER,
        bag_type      TEXT,
        mrp           REAL,
        ptr           REAL,
        ptd           REAL,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS item_master (
        item_id    INTEGER PRIMARY KEY,
        item_name  TEXT NOT NULL,
        item_code  TEXT,
        uom        TEXT,
        category   TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sync_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },

  // Version 2 → 3: Session-based bag-by-bag flow
  3: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fg_session (
        session_id      TEXT PRIMARY KEY,
        doc_id          INTEGER,
        prod_no         TEXT,
        day_seq         INTEGER NOT NULL,
        station_id      TEXT NOT NULL,
        plant_id        TEXT NOT NULL,
        entry_date      TEXT NOT NULL,
        shift           TEXT,
        item_id         INTEGER NOT NULL,
        pack_config_id  INTEGER NOT NULL,
        pack_name       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'OPEN',
        is_offline      INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT UNIQUE,
        created_at      TEXT NOT NULL,
        closed_at       TEXT,
        sync_status     TEXT NOT NULL DEFAULT 'SYNCED',
        sync_attempts   INTEGER NOT NULL DEFAULT 0,
        sync_error      TEXT,
        last_sync_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS fg_bag (
        bag_id          TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES fg_session(session_id) ON DELETE CASCADE,
        bag_number      INTEGER NOT NULL,
        item_id         INTEGER NOT NULL,
        pack_config_id  INTEGER NOT NULL,
        offer_id        INTEGER,
        actual_weight_gm REAL,
        qr_code         TEXT NOT NULL UNIQUE,
        batch_no        TEXT,
        note            TEXT,
        line_id         INTEGER,
        synced          INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fg_session_status ON fg_session(status);
      CREATE INDEX IF NOT EXISTS idx_fg_session_sync ON fg_session(sync_status);
      CREATE INDEX IF NOT EXISTS idx_fg_session_date ON fg_session(entry_date);
      CREATE INDEX IF NOT EXISTS idx_fg_bag_session ON fg_bag(session_id);
      CREATE INDEX IF NOT EXISTS idx_fg_bag_qr ON fg_bag(qr_code);
    `);
  },

  // Version 3 → 4: Auto-session support (multi-product bag-first flow)
  4: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS day_seq_counter (
        station_id  TEXT NOT NULL,
        entry_date  TEXT NOT NULL,
        next_seq    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (station_id, entry_date)
      );

      CREATE INDEX IF NOT EXISTS idx_fg_session_auto
        ON fg_session(station_id, pack_config_id, entry_date, status);
    `);
  },
};

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion >= LATEST_VERSION) {
    logger.info({ currentVersion }, 'Database schema is up to date');
    return;
  }

  logger.info({ currentVersion, targetVersion: LATEST_VERSION }, 'Running database migrations');

  for (let version = currentVersion + 1; version <= LATEST_VERSION; version++) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new Error(`Missing migration for version ${version}`);
    }

    db.transaction(() => {
      logger.info({ version }, 'Applying migration');
      migrate(db);
      db.pragma(`user_version = ${version}`);
    })();
  }

  logger.info({ version: LATEST_VERSION }, 'All migrations applied');
}
