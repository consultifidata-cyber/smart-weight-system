import type Database from 'better-sqlite3';
import logger from '../utils/logger.js';
import { generateBagIdempotencyKey } from '../sync/idempotency.js';

const LATEST_VERSION = 8;

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

  // Version 4 → 5: Worker master cache + per-bag worker codes
  5: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_master (
        worker_id    INTEGER PRIMARY KEY,
        worker_code  TEXT NOT NULL UNIQUE,
        worker_name  TEXT NOT NULL,
        shift        TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      ALTER TABLE fg_bag ADD COLUMN worker_code_1 TEXT;
      ALTER TABLE fg_bag ADD COLUMN worker_code_2 TEXT;
    `);
  },
  // Version 5 → 6: Bag-level idempotency key (Phase B — duplicate-sync fix)
  6: (db) => {
    // Step 1: Add column (nullable so existing rows are valid until backfill)
    db.exec(`ALTER TABLE fg_bag ADD COLUMN idempotency_key TEXT`);

    // Step 2: Backfill all existing rows.
    // SQLite has no built-in SHA-256, so we compute keys in TypeScript.
    const existing = db.prepare(`
      SELECT b.bag_id, b.session_id, b.bag_number, b.qr_code, s.station_id
      FROM   fg_bag     b
      JOIN   fg_session s ON b.session_id = s.session_id
      WHERE  b.idempotency_key IS NULL
    `).all() as Array<{
      bag_id:     string;
      session_id: string;
      bag_number: number;
      qr_code:    string;
      station_id: string;
    }>;

    const update = db.prepare(
      `UPDATE fg_bag SET idempotency_key = ? WHERE bag_id = ?`,
    );

    db.transaction(() => {
      for (const row of existing) {
        const key = generateBagIdempotencyKey(
          row.station_id, row.session_id, row.bag_number, row.qr_code,
        );
        update.run(key, row.bag_id);
      }
    })();

    // Step 3: Unique index on idempotency_key (partial — guards non-null rows only).
    // A full NOT NULL constraint cannot be added via ALTER TABLE in SQLite; the
    // application enforces NOT NULL at insert time (bags.ts / sessions.ts).
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fg_bag_idempotency_key
        ON fg_bag(idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    logger.info(
      { backfilled: existing.length },
      'Migration 6: fg_bag.idempotency_key added and backfilled',
    );
  },

  // Version 6 → 7: Sync attempt tracking on fg_bag (Phase D)
  7: (db) => {
    db.exec(`
      ALTER TABLE fg_bag ADD COLUMN sync_attempts  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE fg_bag ADD COLUMN last_sync_error TEXT;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fg_bag_sync_attempts
        ON fg_bag(sync_attempts)
        WHERE synced = 0
    `);
    logger.info('Migration 7: fg_bag.sync_attempts and last_sync_error added');
  },

  // ── Version 7 → 8: Dispatch module (Phase DA) ──────────────────────────────
  // Adds three new tables for offline truck-load dispatch.
  // ZERO impact on existing tables — purely additive.
  // dispatch_doc  : one row per truck loading event
  // dispatch_line : one row per scanned bag in a dispatch
  // party_master  : cache of Django PartyMaster (customers) for dispatch entry
  8: (db) => {
    db.exec(`
      -- ── Party master cache (pulled from Django like workers/pack configs) ──
      CREATE TABLE IF NOT EXISTS party_master (
        party_id    INTEGER PRIMARY KEY,
        party_name  TEXT NOT NULL,
        party_code  TEXT,
        gst_no      TEXT,
        city        TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ── Dispatch document (one per truck loading) ─────────────────────────
      CREATE TABLE IF NOT EXISTS dispatch_doc (
        doc_id          TEXT PRIMARY KEY,                      -- UUID generated locally
        doc_no          TEXT NOT NULL UNIQUE,                  -- DSP-260426-001
        entry_date      TEXT NOT NULL,                         -- YYYY-MM-DD
        truck_no        TEXT NOT NULL,                         -- MH-12-AB-1234
        customer_id     INTEGER,                               -- PartyMaster.pk (set after sync)
        customer_name   TEXT NOT NULL,                         -- display name from party cache
        location        TEXT,                                  -- source warehouse / location
        plant_id        TEXT NOT NULL,                         -- local plant code
        shift_id        TEXT,                                  -- A / B / C
        delay_reason    TEXT,
        status          TEXT NOT NULL DEFAULT 'DRAFT',         -- DRAFT | CLOSED | DECLINED
        sync_status     TEXT NOT NULL DEFAULT 'LOCAL',         -- LOCAL | PENDING | SYNCING | SYNCED | FAILED
        idempotency_key TEXT UNIQUE,                           -- sha256 for safe retry push to Django
        total_bags      INTEGER NOT NULL DEFAULT 0,            -- incremented on each scan
        total_weight_gm REAL    NOT NULL DEFAULT 0,            -- summed from dispatch_line
        created_at      TEXT NOT NULL,
        closed_at       TEXT,
        django_doc_id   INTEGER,                               -- Django TruckLoad.pk after sync
        django_doc_no   TEXT,                                  -- Django TruckLoad.doc_no after sync
        sync_error      TEXT,
        last_sync_at    TEXT
      );

      -- ── Dispatch line (one row per scanned bag) ────────────────────────────
      CREATE TABLE IF NOT EXISTS dispatch_line (
        line_id          TEXT PRIMARY KEY,                     -- UUID generated locally
        doc_id           TEXT NOT NULL
                           REFERENCES dispatch_doc(doc_id)
                           ON DELETE CASCADE,
        qr_code          TEXT NOT NULL,                        -- scanned from label
        bag_id           TEXT,                                 -- fg_bag.bag_id (null = external scan)
        pack_name        TEXT,                                 -- from fg_bag JOIN fg_pack_config
        pack_config_id   INTEGER,
        item_id          INTEGER,
        actual_weight_gm REAL,                                 -- from fg_bag (for weight totals)
        source           TEXT NOT NULL DEFAULT 'LOCAL',        -- LOCAL | EXTERNAL (not in fg_bag)
        scanned_at       TEXT NOT NULL,
        synced           INTEGER NOT NULL DEFAULT 0,           -- 0 | 1
        django_line_id   INTEGER,                              -- Django scan line PK after sync
        UNIQUE(doc_id, qr_code)                                -- same QR cannot appear twice in same dispatch
      );
    `);

    // Indexes (separate exec so SQLite runs them one at a time)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_doc_status
        ON dispatch_doc(status, sync_status);

      CREATE INDEX IF NOT EXISTS idx_dispatch_doc_date
        ON dispatch_doc(entry_date);

      CREATE INDEX IF NOT EXISTS idx_dispatch_doc_plant
        ON dispatch_doc(plant_id, entry_date);

      CREATE INDEX IF NOT EXISTS idx_dispatch_line_doc
        ON dispatch_line(doc_id);

      CREATE INDEX IF NOT EXISTS idx_dispatch_line_qr
        ON dispatch_line(qr_code);

      CREATE INDEX IF NOT EXISTS idx_dispatch_line_unsynced
        ON dispatch_line(synced)
        WHERE synced = 0;

      CREATE INDEX IF NOT EXISTS idx_party_master_name
        ON party_master(party_name);
    `);

    logger.info('Migration 8: dispatch_doc, dispatch_line, party_master tables created (Phase DA)');
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
