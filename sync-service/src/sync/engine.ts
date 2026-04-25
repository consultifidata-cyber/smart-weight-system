import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { generateSessionIdempotencyKey } from './idempotency.js';
import type { Queries } from '../db/queries.js';
import type { DjangoClient } from './client.js';
import type { FGSession, FGBag, DispatchDoc } from '../types.js';
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
  private readonly dispatchSyncIntervalMs = 30_000;
  private retryTimerId: ReturnType<typeof setInterval> | null = null;
  private masterTimerId: ReturnType<typeof setInterval> | null = null;
  private bagSyncTimerId: ReturnType<typeof setInterval> | null = null;
  private dispatchSyncTimerId: ReturnType<typeof setInterval> | null = null;
  private bagSyncRunning = false;
  private dispatchSyncRunning = false;

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
    // Startup recovery: reset sessions stuck in SYNCING from a previous crash
    const resetCount = this.queries.resetStuckSyncingSessions();
    if (resetCount > 0) {
      logger.warn({ resetCount }, 'Reset stuck SYNCING sessions to PENDING on startup');
    }

    // Startup recovery: reset dispatch docs stuck in SYNCING (Phase DE)
    const dispatchReset = this.queries.resetStuckDispatchDocs();
    if (dispatchReset > 0) {
      logger.warn({ dispatchReset }, 'Reset stuck SYNCING dispatch docs to PENDING on startup');
    }

    // Phase D: warn about stale bags (synced=0 from past dates) on startup.
    // These will be retried automatically, but the log helps support diagnose issues.
    const today = new Date().toISOString().substring(0, 10);
    const staleBags = this.queries.countStaleBags(today);
    if (staleBags > 0) {
      logger.warn(
        { staleBagCount: staleBags, today },
        'Startup: unsynced bags found from previous dates — they will be retried. ' +
        'If this count is unexpectedly high, investigate sync failures in logs.',
      );
    }

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

    // Dispatch push timer — 30s (Phase DE)
    this.dispatchSyncTimerId = setInterval(() => this.pushDispatchesCycle(), this.dispatchSyncIntervalMs);

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
    if (this.dispatchSyncTimerId) {
      clearInterval(this.dispatchSyncTimerId);
      this.dispatchSyncTimerId = null;
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

      // Phase D: attempt number for logging (sync_attempts = number of PAST failures)
      const attemptNum = (bag.sync_attempts ?? 0) + 1;

      // Warn early when a bag has been retried many times without success
      if (attemptNum > 5) {
        logger.warn(
          {
            bagId:    bag.bag_id,
            qrCode:   bag.qr_code,
            key:      bag.idempotency_key?.substring(0, 8),
            attempts: attemptNum,
          },
          '[bag-sync] High retry count — bag may be stuck. Check server logs.',
        );
      }

      try {
        logger.debug(
          {
            attempt:  attemptNum,
            bagId:    bag.bag_id,
            qrCode:   bag.qr_code,
            key:      bag.idempotency_key?.substring(0, 8) ?? 'null',
            docId:    session.doc_id,
          },
          '[bag-sync] Pushing bag to Django',
        );

        const resp = await this.client.addBag({
          doc_id: session.doc_id,
          item_id: bag.item_id,
          pack_config_id: bag.pack_config_id,
          qr_code: bag.qr_code,
          actual_weight_gm: bag.actual_weight_gm,
          offer_id: bag.offer_id,
          batch_no: bag.batch_no,
          note: bag.note,
          worker_code_1: bag.worker_code_1,
          worker_code_2: bag.worker_code_2,
          idempotency_key: bag.idempotency_key ?? undefined,
        });

        this.queries.updateBagSynced(bag.bag_id, resp.line_id);

        if (resp.idempotent) {
          // Server already had this bag (Phase B key or Phase C QR dedup).
          // One row exists on Django — no duplicate created.
          logger.info(
            {
              attempt:   attemptNum,
              bagId:     bag.bag_id,
              qrCode:    bag.qr_code,
              lineId:    resp.line_id,
              httpStatus: 200,
              result:    'idempotent',
            },
            '[bag-sync] Bag already on server — marked synced, no duplicate',
          );
        } else {
          logger.info(
            {
              attempt:    attemptNum,
              bagId:      bag.bag_id,
              qrCode:     bag.qr_code,
              lineId:     resp.line_id,
              httpStatus: 200,
              result:     'created',
            },
            '[bag-sync] Bag synced to Django',
          );
        }

      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const isTimeout = error.includes('AbortError') ||
                          error.includes('TimeoutError') ||
                          error.includes('signal timed out');

        // Persist the failure — increment attempts, record last error
        this.queries.incrementBagSyncAttempts(bag.bag_id, error);

        // 409 = session was closed externally (dispatch-triggered post+approve).
        // Note: a QR-duplicate 409 would be impossible here because Phase C returns
        // 200 + idempotent:true for duplicate QRs; 409 is strictly "doc not DRAFT".
        if (error.includes('409')) {
          logger.warn(
            {
              attempt:    attemptNum,
              sessionId:  bag.session_id,
              bagId:      bag.bag_id,
              httpStatus: 409,
              result:     'session_closed_externally',
            },
            '[bag-sync] Session closed externally — initiating rollover',
          );
          await this.handleSessionRollover(session, today);
          break;
        }

        // Timeout: the server may have saved the bag before the connection dropped.
        // The idempotency_key ensures the next attempt will return idempotent:true.
        if (isTimeout) {
          logger.warn(
            {
              attempt:    attemptNum,
              bagId:      bag.bag_id,
              qrCode:     bag.qr_code,
              key:        bag.idempotency_key?.substring(0, 8) ?? 'null',
              result:     'timeout',
              safeToRetry: true,
            },
            '[bag-sync] addBag timed out — server may have saved bag. ' +
            'Next retry will use same idempotency_key; duplicate is prevented.',
          );
        } else {
          logger.warn(
            {
              attempt:    attemptNum,
              bagId:      bag.bag_id,
              qrCode:     bag.qr_code,
              result:     'error',
              error,
            },
            '[bag-sync] Failed to sync bag — will retry next cycle',
          );
        }
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
    // Check for unsynced bags to move
    const unsyncedBags = this.queries.getBagsBySession(closedSession.session_id)
      .filter((b: FGBag) => b.synced === 0);

    if (unsyncedBags.length === 0) {
      // No bags to move — just mark old session closed
      this.queries.markSessionClosedExternally(closedSession.session_id);
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

    // Atomically: close old session + insert new session + move unsynced bags
    const moved = this.queries.rolloverSession(closedSession.session_id, newSession);

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
        worker_code_1: b.worker_code_1,
        worker_code_2: b.worker_code_2,
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

    let needsPull = false;
    if (!lastSync) {
      logger.info('No master data found, triggering initial pull');
      needsPull = true;
    } else {
      const elapsed = Date.now() - new Date(lastSync).getTime();
      const staleMs = 24 * 60 * 60 * 1000;
      if (elapsed > staleMs) {
        logger.info({ lastSync }, 'Master data stale, triggering refresh');
        needsPull = true;
      }
    }

    if (!needsPull) return;

    await this.pullMasterData();

    // If workers are still empty after first pull, retry with backoff
    const workers = this.queries.getWorkers();
    if (workers.length === 0) {
      this.retryMasterDataUntilWorkers();
    }
  }

  private retryMasterDataUntilWorkers(): void {
    const retryDelayMs = 30_000; // 30 seconds
    const maxRetries = 10;
    let attempt = 0;

    const retry = async () => {
      attempt++;
      logger.info({ attempt, maxRetries }, 'Retrying master data pull (workers empty)');

      await this.pullMasterData();
      const workers = this.queries.getWorkers();
      if (workers.length > 0) {
        logger.info({ workerCount: workers.length }, 'Workers populated after retry');
        return;
      }

      if (attempt < maxRetries) {
        setTimeout(retry, retryDelayMs);
      } else {
        logger.warn('Max master data retries reached, workers still empty — will rely on hourly sync');
      }
    };

    setTimeout(retry, retryDelayMs);
  }

  async pullMasterData(): Promise<{ products: number; items: number; workers: number; parties: number }> {
    if (!this.client.isConfigured) {
      logger.debug('Django server not configured, skipping master data pull');
      return { products: 0, items: 0, workers: 0, parties: 0 };
    }

    logger.info('Pulling master data from Django');

    const [configsResult, itemsResult, workersResult, partiesResult] = await Promise.allSettled([
      this.client.fetchPackConfigs(),
      this.client.fetchItemMasters(),
      this.client.fetchWorkerMasters(),
      this.client.fetchPartyMasters(),
    ]);

    let products = 0;
    let items    = 0;
    let workers  = 0;
    let parties  = 0;

    if (configsResult.status === 'fulfilled') {
      this.queries.replacePackConfigs(configsResult.value);
      products = configsResult.value.length;
    } else {
      logger.error({ error: configsResult.reason?.message || String(configsResult.reason) }, 'Failed to fetch pack configs');
    }

    if (itemsResult.status === 'fulfilled') {
      this.queries.replaceItemMasters(itemsResult.value);
      items = itemsResult.value.length;
    } else {
      logger.error({ error: itemsResult.reason?.message || String(itemsResult.reason) }, 'Failed to fetch item masters');
    }

    if (workersResult.status === 'fulfilled') {
      this.queries.replaceWorkerMasters(workersResult.value);
      workers = workersResult.value.length;
    } else {
      logger.error({ error: workersResult.reason?.message || String(workersResult.reason) }, 'Failed to fetch worker masters');
    }

    if (partiesResult.status === 'fulfilled') {
      this.queries.replacePartyMasters(partiesResult.value);
      parties = partiesResult.value.length;
      this.queries.setMeta('last_pull_party_at', new Date().toISOString());
      logger.info(`[sync-service][party-pull] received ${parties} parties`);
    } else {
      logger.error({ error: partiesResult.reason?.message || String(partiesResult.reason) }, 'Failed to fetch party masters');
    }

    if (configsResult.status === 'fulfilled' || itemsResult.status === 'fulfilled' || workersResult.status === 'fulfilled') {
      this.queries.setMeta('last_master_sync_at', new Date().toISOString());
    }

    logger.info({ products, items, workers, parties }, 'Master data pull complete');
    return { products, items, workers, parties };
  }

  // ── Dispatch push (Phase DE) ───────────────────────────────────────────

  async pushDispatchesCycle(): Promise<void> {
    if (this.dispatchSyncRunning) return;
    if (!this.client.isConfigured) return;

    this.dispatchSyncRunning = true;
    try {
      await this.pushPendingDispatches();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ error }, 'Dispatch push cycle error');
    } finally {
      this.dispatchSyncRunning = false;
    }
  }

  private async pushPendingDispatches(): Promise<void> {
    const docs = this.queries.listPendingDispatchDocs(5);
    if (docs.length === 0) return;

    logger.info({ count: docs.length }, '[dispatch-sync] Pushing pending dispatch docs to Django');

    for (const doc of docs) {
      await this.pushOneDispatch(doc);
    }
  }

  private async pushOneDispatch(doc: DispatchDoc): Promise<void> {
    this.queries.markDispatchDocSyncing(doc.doc_id);
    const lines = this.queries.getDispatchLinesByDoc(doc.doc_id);

    try {
      const resp = await this.client.pushDispatch({
        idempotency_key: doc.idempotency_key ?? doc.doc_id,
        entry_date:      doc.entry_date,
        truck_no:        doc.truck_no,
        customer_id:     doc.customer_id,
        customer_name:   doc.customer_name,
        location:        doc.location,
        shift:           doc.shift_id,
        delay_reason:    doc.delay_reason,
        lines:           lines.map(l => ({
          qr_code:          l.qr_code,
          bag_id:           l.bag_id,
          pack_name:        l.pack_name,
          pack_config_id:   l.pack_config_id,
          item_id:          l.item_id,
          actual_weight_gm: l.actual_weight_gm,
          source:           l.source,
          scanned_at:       l.scanned_at,
        })),
      });

      this.queries.markDispatchDocSynced(doc.doc_id, resp.doc_id, resp.doc_no);
      this.queries.setMeta('last_dispatch_sync_at', new Date().toISOString());

      logger.info(
        { docNo: doc.doc_no, djangoDocId: resp.doc_id, djangoDocNo: resp.doc_no },
        resp.idempotent
          ? '[dispatch-sync] Already on server — marked SYNCED (idempotent)'
          : '[dispatch-sync] Dispatch pushed to Django',
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // 4xx = bad data / rejected permanently; 5xx or network = transient, retry
      const is4xx = /push-dispatch failed: 4\d\d/.test(error);

      if (is4xx) {
        this.queries.markDispatchDocFailed(doc.doc_id, error);
        logger.error(
          { docNo: doc.doc_no, error },
          '[dispatch-sync] Dispatch permanently failed (4xx) — manual fix required',
        );
      } else {
        this.queries.revertDispatchDocToPending(doc.doc_id, error);
        logger.warn(
          { docNo: doc.doc_no, error },
          '[dispatch-sync] Dispatch push failed (transient) — will retry next cycle',
        );
      }
    }
  }

  // ── Party master pull (Phase DE — BLOCKED pending Django endpoint) ─────
  // GET /api/station/party-masters/ does NOT exist on Django yet.
  // Add that endpoint (Phase DD-bis), then call this from pullMasterData()
  // using Promise.allSettled alongside fetchPackConfigs / fetchWorkerMasters.
  async pullPartyMasters(): Promise<number> {
    if (!this.client.isConfigured) return 0;

    try {
      const parties = await this.client.fetchPartyMasters();
      this.queries.replacePartyMasters(parties);
      logger.info({ count: parties.length }, 'Party masters updated');
      return parties.length;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ error }, 'Failed to fetch party masters');
      return 0;
    }
  }
}
