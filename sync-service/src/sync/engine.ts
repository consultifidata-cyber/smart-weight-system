import logger from '../utils/logger.js';
import type { Queries } from '../db/queries.js';
import type { DjangoClient } from './client.js';
import type { FGSession, FGBag } from '../types.js';
import type { SyncServiceConfig } from '../config.js';

const MAX_RETRIES = 10;

export class SyncEngine {
  private queries: Queries;
  private client: DjangoClient;
  private stationId: string;
  private retryIntervalMs: number;
  private masterSyncIntervalMs: number;
  private retryTimerId: ReturnType<typeof setInterval> | null = null;
  private masterTimerId: ReturnType<typeof setInterval> | null = null;

  constructor(
    queries: Queries,
    client: DjangoClient,
    config: SyncServiceConfig,
  ) {
    this.queries = queries;
    this.client = client;
    this.stationId = config.stationId;
    this.retryIntervalMs = config.syncRetryIntervalMs;
    this.masterSyncIntervalMs = config.masterSyncIntervalMs;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  start(): void {
    logger.info(
      { retryIntervalMs: this.retryIntervalMs, masterSyncIntervalMs: this.masterSyncIntervalMs },
      'Sync engine started',
    );

    // Auto-close stale sessions from past dates on startup
    this.closeAndQueueStaleSessions();

    // Retry loop: auto-close stale + push pending
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
