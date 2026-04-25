import type Database from 'better-sqlite3';
import type {
  FGEntry,
  FGEntryLine,
  FGEntryWithLines,
  FGSession,
  FGBag,
  FGSessionWithBags,
  SyncStatus,
  FGPackConfig,
  ItemMaster,
  WorkerMaster,
  ProductForDropdown,
} from '../types.js';

export class Queries {
  private db: Database.Database;

  // ── Legacy entry statements ──
  private _insertEntry!: Database.Statement;
  private _insertLine!: Database.Statement;
  private _getEntry!: Database.Statement;
  private _getLinesByEntry!: Database.Statement;
  private _updateSyncStatus!: Database.Statement;
  private _updateSyncSuccess!: Database.Statement;
  private _listPending!: Database.Statement;
  private _countByStatus!: Database.Statement;
  private _countSyncedToday!: Database.Statement;

  // ── Master data statements ──
  private _getProducts!: Database.Statement;
  private _getWorkers!: Database.Statement;
  private _getMeta!: Database.Statement;
  private _upsertMeta!: Database.Statement;

  // ── Session statements ──
  private _insertSession!: Database.Statement;
  private _getSession!: Database.Statement;
  private _getOpenSession!: Database.Statement;
  private _updateSessionOnline!: Database.Statement;
  private _updateSessionStatus!: Database.Statement;
  private _updateSessionSyncStatus!: Database.Statement;
  private _updateSessionSynced!: Database.Statement;
  private _updateSessionClosed!: Database.Statement;
  private _listPendingSessions!: Database.Statement;
  private _requeueFailedSessions!: Database.Statement;
  private _resetStuckSyncingSessions!: Database.Statement;
  private _countSessionsByStatus!: Database.Statement;
  private _countClosedSessionsToday!: Database.Statement;

  // ── Auto-session statements ──
  private _findOpenSessionForPack!: Database.Statement;
  private _getNextDaySeq!: Database.Statement;
  private _incrementDaySeq!: Database.Statement;
  private _listOpenSessions!: Database.Statement;
  private _closeStaleSessionsForDate!: Database.Statement;
  private _listStaleOpenSessions!: Database.Statement;

  // ── Real-time sync statements ──
  private _listLocalSessions!: Database.Statement;
  private _listUnsyncedBags!: Database.Statement;
  private _moveBagsToSession!: Database.Statement;
  private _markSessionClosedExternally!: Database.Statement;

  // ── Bag statements ──
  private _insertBag!: Database.Statement;
  private _getBagsBySession!: Database.Statement;
  private _getNextBagNumber!: Database.Statement;
  private _updateBagSynced!: Database.Statement;
  private _countBagsToday!: Database.Statement;
  private _getBagByIdempotencyKey!: Database.Statement;     // Phase B
  private _incrementBagSyncAttempts!: Database.Statement;   // Phase D
  private _countStaleBags!: Database.Statement;             // Phase D

  constructor(db: Database.Database) {
    this.db = db;
    this.prepareStatements();
  }

  private prepareStatements(): void {
    // ── Legacy entry statements ──────────────────────────────────────────
    this._insertEntry = this.db.prepare(`
      INSERT INTO fg_entry (
        local_entry_id, station_id, plant_id, entry_date, shift,
        production_run_id, created_by, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._insertLine = this.db.prepare(`
      INSERT INTO fg_entry_line (
        local_entry_id, item_id, pack_config_id, offer_id,
        num_bags, base_uom, batch_no, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getEntry = this.db.prepare(
      `SELECT * FROM fg_entry WHERE local_entry_id = ?`
    );

    this._getLinesByEntry = this.db.prepare(
      `SELECT * FROM fg_entry_line WHERE local_entry_id = ?`
    );

    this._updateSyncStatus = this.db.prepare(`
      UPDATE fg_entry
      SET sync_status = ?, sync_attempts = sync_attempts + 1,
          last_sync_error = ?, last_sync_at = datetime('now')
      WHERE local_entry_id = ?
    `);

    this._updateSyncSuccess = this.db.prepare(`
      UPDATE fg_entry
      SET sync_status = 'SYNCED', server_prod_no = ?, server_doc_id = ?,
          last_sync_error = NULL, last_sync_at = datetime('now')
      WHERE local_entry_id = ?
    `);

    this._listPending = this.db.prepare(`
      SELECT * FROM fg_entry
      WHERE sync_status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT ?
    `);

    this._countByStatus = this.db.prepare(
      `SELECT sync_status, COUNT(*) as count FROM fg_entry GROUP BY sync_status`
    );

    this._countSyncedToday = this.db.prepare(
      `SELECT COUNT(*) as count FROM fg_entry WHERE sync_status = 'SYNCED' AND entry_date = ?`
    );

    // ── Master data statements ───────────────────────────────────────────
    this._getProducts = this.db.prepare(`
      SELECT
        p.pack_id, p.item_id, p.pack_name AS name, p.pack_name,
        p.net_weight_gm, p.pcs_per_bag, p.bag_type, p.mrp
      FROM fg_pack_config p
      ORDER BY p.pack_name
    `);

    this._getWorkers = this.db.prepare(
      `SELECT worker_id, worker_code, worker_name, shift FROM worker_master ORDER BY worker_name`
    );

    this._getMeta = this.db.prepare(
      `SELECT value FROM sync_meta WHERE key = ?`
    );

    this._upsertMeta = this.db.prepare(`
      INSERT INTO sync_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    // ── Session statements ───────────────────────────────────────────────
    this._insertSession = this.db.prepare(`
      INSERT INTO fg_session (
        session_id, doc_id, prod_no, day_seq, station_id, plant_id,
        entry_date, shift, item_id, pack_config_id, pack_name,
        status, is_offline, idempotency_key, created_at, sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getSession = this.db.prepare(
      `SELECT * FROM fg_session WHERE session_id = ?`
    );

    this._getOpenSession = this.db.prepare(
      `SELECT * FROM fg_session WHERE station_id = ? AND status = 'OPEN' LIMIT 1`
    );

    this._updateSessionOnline = this.db.prepare(`
      UPDATE fg_session
      SET doc_id = ?, prod_no = ?, day_seq = ?, is_offline = 0, sync_status = 'ONLINE'
      WHERE session_id = ?
    `);

    this._updateSessionStatus = this.db.prepare(
      `UPDATE fg_session SET status = ? WHERE session_id = ?`
    );

    this._updateSessionSyncStatus = this.db.prepare(`
      UPDATE fg_session
      SET sync_status = ?, sync_attempts = sync_attempts + 1,
          sync_error = ?, last_sync_at = datetime('now')
      WHERE session_id = ?
    `);

    this._updateSessionSynced = this.db.prepare(`
      UPDATE fg_session
      SET sync_status = 'SYNCED', doc_id = ?, prod_no = ?,
          sync_error = NULL, last_sync_at = datetime('now')
      WHERE session_id = ?
    `);

    this._updateSessionClosed = this.db.prepare(`
      UPDATE fg_session
      SET status = 'CLOSED', closed_at = datetime('now')
      WHERE session_id = ?
    `);

    this._listPendingSessions = this.db.prepare(`
      SELECT * FROM fg_session
      WHERE sync_status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT ?
    `);

    this._requeueFailedSessions = this.db.prepare(`
      UPDATE fg_session
      SET sync_status = 'PENDING', sync_attempts = 0, sync_error = NULL, last_sync_at = NULL
      WHERE sync_status = 'FAILED'
    `);

    this._resetStuckSyncingSessions = this.db.prepare(`
      UPDATE fg_session
      SET sync_status = 'PENDING', sync_error = 'Reset from SYNCING on startup'
      WHERE sync_status = 'SYNCING'
    `);

    this._countSessionsByStatus = this.db.prepare(
      `SELECT status, COUNT(*) as count FROM fg_session GROUP BY status`
    );

    this._countClosedSessionsToday = this.db.prepare(
      `SELECT COUNT(*) as count FROM fg_session WHERE status = 'CLOSED' AND entry_date = ?`
    );

    // ── Auto-session statements ────────────────────────────────────────
    this._findOpenSessionForPack = this.db.prepare(`
      SELECT * FROM fg_session
      WHERE station_id = ? AND pack_config_id = ? AND entry_date = ? AND status = 'OPEN'
      LIMIT 1
    `);

    this._getNextDaySeq = this.db.prepare(`
      INSERT INTO day_seq_counter (station_id, entry_date, next_seq)
      VALUES (?, ?, 1)
      ON CONFLICT(station_id, entry_date) DO UPDATE SET next_seq = next_seq + 1
      RETURNING next_seq
    `);

    this._incrementDaySeq = this.db.prepare(`
      UPDATE day_seq_counter SET next_seq = next_seq + 1
      WHERE station_id = ? AND entry_date = ?
    `);

    this._listOpenSessions = this.db.prepare(
      `SELECT * FROM fg_session WHERE station_id = ? AND status = 'OPEN' ORDER BY created_at ASC`
    );

    this._closeStaleSessionsForDate = this.db.prepare(`
      UPDATE fg_session
      SET status = 'CLOSED', closed_at = datetime('now'), sync_status = 'PENDING'
      WHERE station_id = ? AND status = 'OPEN' AND entry_date < ?
    `);

    this._listStaleOpenSessions = this.db.prepare(`
      SELECT * FROM fg_session
      WHERE station_id = ? AND status = 'OPEN' AND entry_date < ?
      ORDER BY created_at ASC
    `);

    // ── Real-time sync statements ──────────────────────────────────────
    this._listLocalSessions = this.db.prepare(`
      SELECT * FROM fg_session
      WHERE station_id = ? AND entry_date = ? AND status = 'OPEN' AND doc_id IS NULL
      ORDER BY created_at ASC
    `);

    this._listUnsyncedBags = this.db.prepare(`
      SELECT b.* FROM fg_bag b
      JOIN fg_session s ON b.session_id = s.session_id
      WHERE s.station_id = ? AND s.entry_date = ? AND s.doc_id IS NOT NULL AND b.synced = 0
      ORDER BY b.created_at ASC
    `);

    this._moveBagsToSession = this.db.prepare(`
      UPDATE fg_bag SET session_id = ? WHERE session_id = ? AND synced = 0
    `);

    this._markSessionClosedExternally = this.db.prepare(`
      UPDATE fg_session
      SET status = 'CLOSED', sync_status = 'SYNCED', closed_at = datetime('now')
      WHERE session_id = ?
    `);

    // ── Bag statements ───────────────────────────────────────────────────
    // Phase B+D: idempotency_key (col 16), sync_attempts (col 17), last_sync_error (col 18).
    this._insertBag = this.db.prepare(`
      INSERT INTO fg_bag (
        bag_id, session_id, bag_number, item_id, pack_config_id,
        offer_id, actual_weight_gm, qr_code, batch_no, note,
        line_id, synced, created_at, worker_code_1, worker_code_2,
        idempotency_key, sync_attempts, last_sync_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getBagByIdempotencyKey = this.db.prepare(
      `SELECT * FROM fg_bag WHERE idempotency_key = ?`,
    );

    // Phase D: increment sync_attempts + record error on each failed addBag attempt
    this._incrementBagSyncAttempts = this.db.prepare(`
      UPDATE fg_bag
      SET sync_attempts  = sync_attempts + 1,
          last_sync_error = ?
      WHERE bag_id = ?
    `);

    // Phase D: count unsynced bags from dates before today (stale)
    this._countStaleBags = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM fg_bag b
      JOIN fg_session s ON b.session_id = s.session_id
      WHERE b.synced = 0
        AND s.entry_date < ?
    `);

    this._getBagsBySession = this.db.prepare(
      `SELECT * FROM fg_bag WHERE session_id = ? ORDER BY bag_number ASC`
    );

    this._getNextBagNumber = this.db.prepare(
      `SELECT COALESCE(MAX(bag_number), 0) + 1 AS next FROM fg_bag WHERE session_id = ?`
    );

    this._updateBagSynced = this.db.prepare(
      `UPDATE fg_bag SET synced = 1, line_id = ? WHERE bag_id = ?`
    );

    this._countBagsToday = this.db.prepare(
      `SELECT COUNT(*) as count FROM fg_bag b JOIN fg_session s ON b.session_id = s.session_id WHERE s.entry_date = ?`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Legacy entry operations (kept for backward compat)
  // ══════════════════════════════════════════════════════════════════════════

  insertEntry(entry: FGEntry, lines: FGEntryLine[]): void {
    this.db.transaction(() => {
      this._insertEntry.run(
        entry.local_entry_id, entry.station_id, entry.plant_id,
        entry.entry_date, entry.shift, entry.production_run_id,
        entry.created_by, entry.created_at, entry.idempotency_key,
      );
      for (const line of lines) {
        this._insertLine.run(
          line.local_entry_id, line.item_id, line.pack_config_id,
          line.offer_id, line.num_bags, line.base_uom, line.batch_no, line.note,
        );
      }
    })();
  }

  getEntry(localEntryId: string): FGEntry | undefined {
    return this._getEntry.get(localEntryId) as FGEntry | undefined;
  }

  getEntryWithLines(localEntryId: string): FGEntryWithLines | undefined {
    const entry = this.getEntry(localEntryId);
    if (!entry) return undefined;
    const lines = this._getLinesByEntry.all(localEntryId) as FGEntryLine[];
    return { ...entry, lines };
  }

  listEntries(options: {
    date?: string;
    status?: SyncStatus;
    limit?: number;
  } = {}): { entries: FGEntry[]; total: number; pending_count: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.date) {
      conditions.push('entry_date = ?');
      params.push(options.date);
    }
    if (options.status) {
      conditions.push('sync_status = ?');
      params.push(options.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit || 50;

    const entries = this.db.prepare(
      `SELECT * FROM fg_entry ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit) as FGEntry[];

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM fg_entry ${where}`
    ).get(...params) as { count: number };

    const pendingRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM fg_entry WHERE sync_status = 'PENDING'`
    ).get() as { count: number };

    return { entries, total: totalRow.count, pending_count: pendingRow.count };
  }

  listPending(limit: number = 50): FGEntry[] {
    return this._listPending.all(limit) as FGEntry[];
  }

  updateSyncStatus(localEntryId: string, status: SyncStatus, error: string | null): void {
    this._updateSyncStatus.run(status, error, localEntryId);
  }

  updateSyncSuccess(localEntryId: string, serverProdNo: string, serverDocId: number): void {
    this._updateSyncSuccess.run(serverProdNo, serverDocId, localEntryId);
  }

  getStatusCounts(): Record<string, number> {
    const rows = this._countByStatus.all() as { sync_status: string; count: number }[];
    const result: Record<string, number> = { PENDING: 0, SYNCING: 0, SYNCED: 0, FAILED: 0 };
    for (const row of rows) {
      result[row.sync_status] = row.count;
    }
    return result;
  }

  countSyncedToday(date: string): number {
    const row = this._countSyncedToday.get(date) as { count: number };
    return row.count;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Session operations (bag-by-bag)
  // ══════════════════════════════════════════════════════════════════════════

  insertSession(session: FGSession): void {
    this._insertSession.run(
      session.session_id, session.doc_id, session.prod_no, session.day_seq,
      session.station_id, session.plant_id, session.entry_date, session.shift,
      session.item_id, session.pack_config_id, session.pack_name,
      session.status, session.is_offline, session.idempotency_key,
      session.created_at, session.sync_status,
    );
  }

  getSession(sessionId: string): FGSession | undefined {
    return this._getSession.get(sessionId) as FGSession | undefined;
  }

  getSessionWithBags(sessionId: string): FGSessionWithBags | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const bags = this._getBagsBySession.all(sessionId) as FGBag[];
    return { ...session, bags };
  }

  getOpenSession(stationId: string): FGSession | undefined {
    return this._getOpenSession.get(stationId) as FGSession | undefined;
  }

  updateSessionOnline(sessionId: string, docId: number, prodNo: string, daySeq: number): void {
    this._updateSessionOnline.run(docId, prodNo, daySeq, sessionId);
  }

  updateSessionStatus(sessionId: string, status: string): void {
    this._updateSessionStatus.run(status, sessionId);
  }

  updateSessionSyncStatus(sessionId: string, syncStatus: SyncStatus, error: string | null): void {
    this._updateSessionSyncStatus.run(syncStatus, error, sessionId);
  }

  updateSessionSynced(sessionId: string, docId: number, prodNo: string): void {
    this._updateSessionSynced.run(docId, prodNo, sessionId);
  }

  updateSessionClosed(sessionId: string): void {
    this._updateSessionClosed.run(sessionId);
  }

  listPendingSessions(limit: number = 20): FGSession[] {
    return this._listPendingSessions.all(limit) as FGSession[];
  }

  /** Reset all FAILED sessions back to PENDING for retry. Returns count of requeued sessions. */
  requeueFailedSessions(): number {
    const result = this._requeueFailedSessions.run();
    return result.changes;
  }

  /** Reset any SYNCING sessions to PENDING (startup recovery after crash). Returns count reset. */
  resetStuckSyncingSessions(): number {
    const result = this._resetStuckSyncingSessions.run();
    return result.changes;
  }

  countClosedSessionsToday(date: string): number {
    const row = this._countClosedSessionsToday.get(date) as { count: number };
    return row.count;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Auto-session operations (bag-first multi-product flow)
  // ══════════════════════════════════════════════════════════════════════════

  /** Find an existing OPEN session for this station + pack_config + date */
  findOpenSessionForPack(stationId: string, packConfigId: number, entryDate: string): FGSession | undefined {
    return this._findOpenSessionForPack.get(stationId, packConfigId, entryDate) as FGSession | undefined;
  }

  /** Allocate the next day_seq for this station + date (auto-incrementing) */
  getNextDaySeq(stationId: string, entryDate: string): number {
    const row = this._getNextDaySeq.get(stationId, entryDate) as { next_seq: number };
    return row.next_seq;
  }

  /** List all OPEN sessions for a station */
  listOpenSessions(stationId: string): FGSession[] {
    return this._listOpenSessions.all(stationId) as FGSession[];
  }

  /** List stale OPEN sessions (entry_date < today) for closing */
  listStaleOpenSessions(stationId: string, today: string): FGSession[] {
    return this._listStaleOpenSessions.all(stationId, today) as FGSession[];
  }

  /** Close all OPEN sessions from dates before today, mark PENDING for sync */
  closeStaleSessionsForDate(stationId: string, today: string): number {
    const result = this._closeStaleSessionsForDate.run(stationId, today);
    return result.changes;
  }

  /** Close a single session and mark it PENDING for sync */
  closeAndMarkPending(sessionId: string): void {
    this.db.transaction(() => {
      this._updateSessionClosed.run(sessionId);
      this._updateSessionSyncStatus.run('PENDING', null, sessionId);
    })();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Real-time sync operations (per-bag Django sync)
  // ══════════════════════════════════════════════════════════════════════════

  /** OPEN sessions with no Django doc_id — need client.openSession() */
  listLocalSessions(stationId: string, today: string): FGSession[] {
    return this._listLocalSessions.all(stationId, today) as FGSession[];
  }

  /** Bags not yet pushed to Django, whose session already has a doc_id */
  listUnsyncedBags(stationId: string, today: string): FGBag[] {
    return this._listUnsyncedBags.all(stationId, today) as FGBag[];
  }

  /** Move unsynced bags (synced=0) from old session to new session (rollover) */
  moveBagsToSession(oldSessionId: string, newSessionId: string): number {
    const result = this._moveBagsToSession.run(newSessionId, oldSessionId);
    return result.changes;
  }

  /** Mark a session as closed by an external actor (e.g., dispatch-triggered close) */
  markSessionClosedExternally(sessionId: string): void {
    this._markSessionClosedExternally.run(sessionId);
  }

  /** Atomically close old session + insert new session + move unsynced bags */
  rolloverSession(oldSessionId: string, newSession: FGSession): number {
    let moved = 0;
    this.db.transaction(() => {
      this._markSessionClosedExternally.run(oldSessionId);
      this._insertSession.run(
        newSession.session_id, newSession.doc_id, newSession.prod_no, newSession.day_seq,
        newSession.station_id, newSession.plant_id, newSession.entry_date, newSession.shift,
        newSession.item_id, newSession.pack_config_id, newSession.pack_name,
        newSession.status, newSession.is_offline, newSession.idempotency_key,
        newSession.created_at, newSession.sync_status,
      );
      const result = this._moveBagsToSession.run(newSession.session_id, oldSessionId);
      moved = result.changes;
    })();
    return moved;
  }

  /** Get today's bag summary grouped by pack_config for display */
  getBagsSummaryToday(stationId: string, date: string): Array<{ pack_config_id: number; pack_name: string; count: number }> {
    const rows = this.db.prepare(`
      SELECT s.pack_config_id, s.pack_name, COUNT(b.bag_id) as count
      FROM fg_session s
      JOIN fg_bag b ON b.session_id = s.session_id
      WHERE s.station_id = ? AND s.entry_date = ?
      GROUP BY s.pack_config_id, s.pack_name
      ORDER BY s.pack_name
    `).all(stationId, date) as Array<{ pack_config_id: number; pack_name: string; count: number }>;
    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Bag operations
  // ══════════════════════════════════════════════════════════════════════════

  insertBag(bag: FGBag): void {
    this._insertBag.run(
      bag.bag_id, bag.session_id, bag.bag_number,
      bag.item_id, bag.pack_config_id, bag.offer_id,
      bag.actual_weight_gm, bag.qr_code, bag.batch_no, bag.note,
      bag.line_id, bag.synced, bag.created_at,
      bag.worker_code_1 ?? null, bag.worker_code_2 ?? null,
      bag.idempotency_key  ?? null,    // Phase B
      bag.sync_attempts    ?? 0,       // Phase D
      bag.last_sync_error  ?? null,    // Phase D
    );
  }

  /** Phase B: look up a bag by its idempotency key. */
  getBagByIdempotencyKey(key: string): FGBag | undefined {
    return this._getBagByIdempotencyKey.get(key) as FGBag | undefined;
  }

  /** Phase D: record a failed addBag attempt on a bag. */
  incrementBagSyncAttempts(bagId: string, error: string | null): void {
    this._incrementBagSyncAttempts.run(error, bagId);
  }

  /** Phase D: count bags with synced=0 from dates before today (stale). */
  countStaleBags(today: string): number {
    const row = this._countStaleBags.get(today) as { count: number };
    return row.count;
  }

  getBagsBySession(sessionId: string): FGBag[] {
    return this._getBagsBySession.all(sessionId) as FGBag[];
  }

  getNextBagNumber(sessionId: string): number {
    const row = this._getNextBagNumber.get(sessionId) as { next: number };
    return row.next;
  }

  updateBagSynced(bagId: string, lineId: number): void {
    this._updateBagSynced.run(lineId, bagId);
  }

  countBagsToday(date: string): number {
    const row = this._countBagsToday.get(date) as { count: number };
    return row.count;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Master data operations
  // ══════════════════════════════════════════════════════════════════════════

  getProducts(): ProductForDropdown[] {
    return this._getProducts.all() as ProductForDropdown[];
  }

  replacePackConfigs(configs: FGPackConfig[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM fg_pack_config').run();
      const insert = this.db.prepare(`
        INSERT INTO fg_pack_config (pack_id, item_id, pack_name, net_weight_gm, pcs_per_bag, bag_type, mrp, ptr, ptd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of configs) {
        insert.run(c.pack_id, c.item_id, c.pack_name, c.net_weight_gm, c.pcs_per_bag, c.bag_type, c.mrp, c.ptr, c.ptd);
      }
    })();
  }

  replaceItemMasters(items: ItemMaster[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM item_master').run();
      const insert = this.db.prepare(`
        INSERT INTO item_master (item_id, item_name, item_code, uom, category)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const i of items) {
        insert.run(i.item_id, i.item_name, i.item_code, i.uom, i.category);
      }
    })();
  }

  getWorkers(): WorkerMaster[] {
    return this._getWorkers.all() as WorkerMaster[];
  }

  replaceWorkerMasters(workers: WorkerMaster[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM worker_master').run();
      const insert = this.db.prepare(`
        INSERT INTO worker_master (worker_id, worker_code, worker_name, shift)
        VALUES (?, ?, ?, ?)
      `);
      for (const w of workers) {
        insert.run(w.worker_id, w.worker_code, w.worker_name, w.shift);
      }
    })();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Sync metadata
  // ══════════════════════════════════════════════════════════════════════════

  getMeta(key: string): string | null {
    const row = this._getMeta.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this._upsertMeta.run(key, value);
  }
}
