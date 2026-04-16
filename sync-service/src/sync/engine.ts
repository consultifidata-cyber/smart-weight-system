import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { generateSessionIdempotencyKey } from './idempotency.js';
import type { Queries } from '../db/queries.js';
import type { DjangoClient } from './client.js';
import type { FGSession, FGBag } from '../types.js';
import type { SyncServiceConfig } from '../config.js';

const MAX_RETRIES = 10;

export class SyncEngine {
  private queries: Queries;
  private client: DjangoClient;
  private stationId: string;
  private plantId: string;
  private retryIntervalMs: number;
  private masterSyncIntervalMs: number;
  private bagSyncIntervalMs: number;
  private retryTimerId: ReturnType<typeof setInterval> | null = null;
  private masterTimerId: ReturnType<typeof setInterval> | null = null;
  private bagSyncTimerId: ReturnType<typeof setInterval> | null = null;
  private bagSyncRunning = false; // guard against overlapping cycles

  constructor(
    queries: Queries,
    client: DjangoClient,
    config: SyncServiceConfig,
  ) {
    this.queries = queries;
    this.client = client;
    this.stationId = config.stationId;
    this.plantId = config.plantId;
    this.retryIntervalMs = config.syncRetryIntervalMs;
    this.masterSyncIntervalMs = config.masterSyncIntervalMs;
    this.bagSyncIntervalMs = config.bagSyncIntervalMs;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    logger.info(
      {
        retryIntervalMs: this.retryIntervalMs,
        masterSyncIntervalMs: this.masterSyncIntervalMs,
        bagSyncIntervalMs: this.bagSyncIntervalMs,
      },
      'Sync engine started',
    );

    // Auto-close stale sessions from past dates on startup
    this.closeAndQueueStaleSessions();

    // Layer 2: Fast per-bag sync loop (default 10s)
    this.bagSyncTimerId = setInterval(() => this.syncBagsCycle(), this.bagSyncIntervalMs);

    // Retry loop: auto-close stale + push pending offline sessions (default 60s)
    this.retryTimerId = setInterval(() => {
      this.closeAndQueueStaleSessions();
      this.retryPendingSessions();
    }, this.retryIntervalMs);

    // Master data sync timer
    this.masterTimerId = setInterval(() => this.pullMasterData(), this.masterSyncIntervalMs);

    // Initial master data check
    this.checkInitialMasterSync();
  }

  stop(): void {
    if (this.bagSyncTimerId) {
      clearInterval(this.bagSyncTimerId);
      this.bagSyncTimerId = null;
    }
    if (this.retryTimerId) {
      clearInterval(this.retryTimerId);
      this.retryTimerId = null;
    }
    if (this.masterTimerId) {
      clearInterval(this.masterTimerId);
      this.masterTimerId = null;
    }
    logger.info('Sync engine stopped');
  }

  // ── Real-time per-bag sync (Layer 1 + Layer 2) ─────────────────────────

  private _pendingSync: Promise<void> = Promise.resolve();

  /**
   * Public trigger for inline sync — called by bags.ts right after insert.
   * Fire-and-forget: does not block the HTTP response.
   */
  syncBagNow(): void {
    this._pendingSync = this.syncBagsCycle().catch(err => {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ error }, 'Inline bag sync cycle failed');
    });
  }

  /** Await completion of any in-flight sync cycle (used by tests). */
  waitForPendingSync(): Promise<void> {
    return this._pendingSync;
  }

  /**
   * One full sync cycle: register LOCAL sessions → push unsynced bags.
   * Guarded so overlapping calls don't pile up.
   */
  async syncBagsCycle(): Promise<void> {
    if (this.bagSyncRunning) return;
    if (!this.client.isConfigured) return;

    this.bagSyncRunning = true;
    try {
      const today = new Date().toISOString().substring(0, 10);
      await this.syncLocalSessions(today);
      await this.syncUnsyncedBags(today);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ error }, 'Bag sync cycle error');
    } finally {
      this.bagSyncRunning = false;
    }
  }

  /**
   * Step A: Find LOCAL sessions (no doc_id) and register them with Django.
   * On success, session transitions LOCAL → ONLINE (doc_id set).
   */
  async syncLocalSessions(today: string): Promise<void> {
    const locals = this.queries.listLocalSessions(this.stationId, today);
    if (locals.length === 0) return;

    for (const session of locals) {
      try {
        const resp = await this.client.openSession({
          item_id: session.item_id,
          pack_config_id: session.pack_config_id,
          entry_date: session.entry_date,
          shift: session.shift,
        });

        this.queries.updateSessionOnline(
          session.session_id, resp.doc_id, resp.prod_no, resp.day_seq,
        );

        logger.info(
          { sessionId: session.session_id, docId: resp.doc_id, prodNo: resp.prod_no, daySeq: resp.day_seq },
          'Session registered with Django (LOCAL → ONLINE)',
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn(
          { sessionId: session.session_id, error },
          'Failed to register session with Django — will retry next cycle',
        );
        // Session stays LOCAL, retry next cycle
      }
    }
  }

  /**
   * Step B: Find bags with synced=0 whose session has a doc_id, push each
   * to Django via addBag(). On success, mark bag synced=1.
   *
   * Handles 409 (session closed externally by dispatch) via rollover.
   */
  async syncUnsyncedBags(today: string): Promise<void> {
    const bags = this.queries.listUnsyncedBags(this.stationId, today);
    if (bags.length === 0) return;

    for (const bag of bags) {
      const session = this.queries.getSession(bag.session_id);
      if (!session || !session.doc_id) continue;

      try {
        const resp = await this.client.addBag({
          doc_id: session.doc_id,
          item_id: bag.item_id,
          pack_config_id: bag.pack_config_id,
          qr_code: bag.qr_code,
          actual_weight_gm: bag.actual_weight_gm,
          offer_id: bag.offer_id,
          batch_no: bag.batch_no,
          note: bag.note,
        });

        this.queries.updateBagSynced(bag.bag_id, resp.line_id);
        logger.info(
          { bagId: bag.bag_id, qrCode: bag.qr_code, lineId: resp.line_id },
          'Bag synced to Django',
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);

        // 409 = session was closed externally (dispatch-triggered post+approve)
        if (error.includes('409')) {
          logger.warn(
            { sessionId: bag.session_id, bagId: bag.bag_id },
            'Session closed externally (409) — initiating rollover',
          );
          await this.handleSessionRollover(session, today);
          // Stop processing this batch — next cycle will pick up moved bags
          break;
        }

        logger.warn({ bagId: bag.bag_id, error }, 'Failed to sync bag — will retry next cycle');
      }
    }
  }

  /**
   * Handle external session close (409 from Django):
   * 1. Mark old session CLOSED + SYNCED locally
   * 2. Create new session with next day_seq
   * 3. Move unsynced bags from old → new session
   *
   * Next sync cycle will register the new session and push the moved bags.
   */
  async handleSessionRollover(closedSession: FGSession, today: string): Promise<void> {
    // Mark old session as closed by dispatch
    this.queries.markSessionClosedExternally(closedSession.session_id);

    // Check for unsynced bags to move
    const unsyncedBags = this.queries.getBagsBySession(closedSession.session_id)
      .filter((b: FGBag) => b.synced === 0);

    if (unsyncedBags.length === 0) {
      logger.info(
        { sessionId: closedSession.session_id },
        'Session closed externally, no unsynced bags to move',
      );
      return;
    }

    // Create new session for same pack_config with next day_seq
    const daySeq = this.queries.getNextDaySeq(this.stationId, today);
    const sessionId = randomUUID();
    const idempotencyKey = generateSessionIdempotencyKey(this.stationId, today, sessionId);
    const now = new Date().toISOString();

    const newSession: FGSession = {
      session_id: sessionId,
      doc_id: null,
      prod_no: null,
      day_seq: daySeq,
      station_id: this.stationId,
      plant_id: this.plantId,
      entry_date: today,
      shift: closedSession.shift,
      item_id: closedSession.item_id,
      pack_config_id: closedSession.pack_config_id,
      pack_name: closedSession.pack_name,
      status: 'OPEN',
      is_offline: 1,
      idempotency_key: idempotencyKey,
      created_at: now,
      closed_at: null,
      sync_status: 'LOCAL',
      sync_attempts: 0,
      sync_error: null,
      last_sync_at: null,
    };

    this.queries.insertSession(newSession);

    // Move unsynced bags to new session
    const moved = this.queries.moveBagsToSession(closedSession.session_id, sessionId);

    logger.info(
      {
        oldSession: closedSession.session_id,
        newSession: sessionId,
        daySeq,
        movedBags: moved,
      },
      'Session rollover complete — new session created, unsynced bags moved',
    );
  }

  // ── Offline session retry (push-entry bulk push) ───────────────────────

  async retryPendingSessions(): Promise<void> {
    const pending = this.queries.listPendingSessions(20);
    if (pending.length === 0) return;

    logger.info({ count: pending.length }, 'Retrying pending offline sessions');

    for (const session of pending) {
      if (!this.shouldRetrySession(session)) continue;
      await this.pushOfflineSession(session);
    }
  }

  async pushOfflineSession(session: FGSession): Promise<void> {
    const bags = this.queries.getBagsBySession(session.session_id);
    if (bags.length === 0) {
      // No bags — mark as failed
      this.queries.updateSessionSyncStatus(session.session_id, 'FAILED', 'No bags in session');
      return;
    }

    // Mark as SYNCING
    this.queries.updateSessionSyncStatus(session.session_id, 'SYNCING', null);

    const idempotencyKey = session.idempotency_key || session.session_id;

    const result = await this.client.pushEntry({
      idempotency_key: idempotencyKey,
      entry_date: session.entry_date,
      shift: session.shift,
      bags: bags.map((b: FGBag) => ({
        item_id: b.item_id,
        pack_config_id: b.pack_config_id,
        offer_id: b.offer_id,
        actual_weight_gm: b.actual_weight_gm,
        qr_code: b.qr_code,
        batch_no: b.batch_no,
        note: b.note,
      })),
    });

    if (result.success) {
      this.queries.updateSessionSynced(
        session.session_id,
        result.server_doc_id || 0,
        result.server_prod_no || '',
      );
      this.queries.setMeta('last_sync_at', new Date().toISOString());
      logger.info(
        { sessionId: session.session_id, prodNo: result.server_prod_no },
        'Offline session pushed to Django',
      );
    } else if (!result.retryable) {
      this.queries.updateSessionSyncStatus(session.session_id, 'FAILED', result.error || null);
      logger.error(
        { sessionId: session.session_id, error: result.error },
        'Offline session push permanently failed',
      );
    } else {
      const attempts = (session.sync_attempts || 0) + 1;
      if (attempts >= MAX_RETRIES) {
        this.queries.updateSessionSyncStatus(
          session.session_id, 'FAILED',
          `Max retries exceeded. Last error: ${result.error}`,
        );
        logger.error({ sessionId: session.session_id }, 'Offline session failed after max retries');
      } else {
        this.queries.updateSessionSyncStatus(session.session_id, 'PENDING', result.error || null);
      }
    }
  }

  private shouldRetrySession(session: FGSession): boolean {
    if (session.sync_attempts === 0) return true;

    const backoffMs = Math.min(
      60_000 * Math.pow(2, session.sync_attempts - 1),
      300_000,
    );

    if (!session.last_sync_at) return true;

    const elapsed = Date.now() - new Date(session.last_sync_at).getTime();
    return elapsed >= backoffMs;
  }

  // ── Auto-close stale sessions ───────────────────────────────────────

  /** Close any OPEN sessions from past dates, mark them PENDING for push */
  closeAndQueueStaleSessions(): void {
    const today = new Date().toISOString().substring(0, 10);
    const stale = this.queries.listStaleOpenSessions(this.stationId, today);

    if (stale.length === 0) return;

    for (const session of stale) {
      const bags = this.queries.getBagsBySession(session.session_id);
      if (bags.length === 0) {
        // Empty session — just close it, no need to push
        this.queries.updateSessionClosed(session.session_id);
        this.queries.updateSessionSyncStatus(session.session_id, 'SYNCED', null);
        logger.info({ sessionId: session.session_id }, 'Closed empty stale session');
      } else {
        this.queries.closeAndMarkPending(session.session_id);
        logger.info(
          { sessionId: session.session_id, bags: bags.length, date: session.entry_date },
          'Closed stale session, queued for push',
        );
      }
    }
  }

  /** Flush all OPEN sessions (end-of-shift): close + mark PENDING + push immediately */
  async flushAllOpenSessions(): Promise<{ closed: number; pushed: number }> {
    const openSessions = this.queries.listOpenSessions(this.stationId);
    let closed = 0;
    let pushed = 0;

    for (const session of openSessions) {
      const bags = this.queries.getBagsBySession(session.session_id);
      if (bags.length === 0) {
        this.queries.updateSessionClosed(session.session_id);
        this.queries.updateSessionSyncStatus(session.session_id, 'SYNCED', null);
        continue;
      }

      this.queries.closeAndMarkPending(session.session_id);
      closed++;

      // Attempt immediate push
      const refreshed = this.queries.getSession(session.session_id);
      if (refreshed) {
        await this.pushOfflineSession(refreshed);
        const after = this.queries.getSession(session.session_id);
        if (after?.sync_status === 'SYNCED') pushed++;
      }
    }

    return { closed, pushed };
  }

  // ── Master data ────────────────────────────────────────────────────────

  private async checkInitialMasterSync(): Promise<void> {
    const lastSync = this.queries.getMeta('last_master_sync_at');

    if (!lastSync) {
      logger.info('No master data found, triggering initial pull');
      await this.pullMasterData();
      return;
    }

    const elapsed = Date.now() - new Date(lastSync).getTime();
    const staleMs = 24 * 60 * 60 * 1000;
    if (elapsed > staleMs) {
      logger.info({ lastSync }, 'Master data stale, triggering refresh');
      await this.pullMasterData();
    }
  }

  async pullMasterData(): Promise<{ products: number; items: number }> {
    if (!this.client.isConfigured) {
      logger.debug('Django server not configured, skipping master data pull');
      return { products: 0, items: 0 };
    }

    try {
      logger.info('Pulling master data from Django');

      const [configs, items] = await Promise.all([
        this.client.fetchPackConfigs(),
        this.client.fetchItemMasters(),
      ]);

      this.queries.replacePackConfigs(configs);
      this.queries.replaceItemMasters(items);
      this.queries.setMeta('last_master_sync_at', new Date().toISOString());

      logger.info({ products: configs.length, items: items.length }, 'Master data updated');
      return { products: configs.length, items: items.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ error }, 'Master data pull failed');
      return { products: 0, items: 0 };
    }
  }
}
