import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../src/sync/engine.js';
import { createTestDb, MockDjangoClient, makeSession, makeBag, makePackConfig } from './helpers.js';
import type { Queries } from '../src/db/queries.js';

let queries: Queries;
let client: MockDjangoClient;
let engine: SyncEngine;

beforeEach(() => {
  ({ queries } = createTestDb());
  client = new MockDjangoClient();
  engine = new SyncEngine(queries, client as any, {
    stationId: 'ST01',
    plantId: 'BNJRS10',
    apiPort: 0,
    logLevel: 'silent',
    dbPath: ':memory:',
    djangoServerUrl: 'http://localhost:8000',
    djangoApiToken: 'test-token',
    syncRetryIntervalMs: 60000,
    masterSyncIntervalMs: 3600000,
    syncPushTimeoutMs: 5000,
    offlineDaySeqStart: 90,
    offlineDaySeqEnd: 99,
  } as any);
});

// ══════════════════════════════════════════════════════════════════════════════
// pullMasterData
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncEngine.pullMasterData', () => {
  it('fetches pack configs + items and stores in DB', async () => {
    client.masterConfigs = [
      makePackConfig({ pack_id: 1, pack_name: 'Pack A' }),
      makePackConfig({ pack_id: 2, pack_name: 'Pack B' }),
    ];
    client.masterItems = [
      { item_id: 1, item_name: 'Item A', item_code: 'FG001', uom: 'PCS', category: 'FG' },
    ];

    const result = await engine.pullMasterData();

    assert.equal(result.products, 2);
    assert.equal(result.items, 1);

    // Verify stored in DB
    const products = queries.getProducts();
    assert.equal(products.length, 2);
  });

  it('updates last_master_sync_at meta', async () => {
    client.masterConfigs = [];
    client.masterItems = [];

    await engine.pullMasterData();

    const lastSync = queries.getMeta('last_master_sync_at');
    assert.ok(lastSync);
  });

  it('returns {products: 0, items: 0} when client not configured', async () => {
    client.isConfigured = false;

    const result = await engine.pullMasterData();

    assert.equal(result.products, 0);
    assert.equal(result.items, 0);
  });

  it('returns {products: 0, items: 0} on fetch error', async () => {
    client.shouldFail = true;

    const result = await engine.pullMasterData();

    assert.equal(result.products, 0);
    assert.equal(result.items, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// pushOfflineSession (tested via retryPendingSessions which is private,
// but we can trigger the flow by inserting a PENDING session and calling
// the engine's internal methods indirectly)
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncEngine offline push', () => {
  it('pushes session with bags to client.pushEntry and marks SYNCED on success', async () => {
    const session = makeSession({
      session_id: 'push-ok',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('push-ok', { bag_id: 'b1', qr_code: 'QR-PUSH-1' }));

    // Access private method via prototype
    await (engine as any).pushOfflineSession(session);

    const updated = queries.getSession('push-ok')!;
    assert.equal(updated.sync_status, 'SYNCED');
    assert.equal(updated.doc_id, 100);
    assert.equal(updated.prod_no, 'FGP-150426-03');

    // Verify client was called
    const pushCall = client.calls.find(c => c.method === 'pushEntry');
    assert.ok(pushCall);
  });

  it('marks session FAILED when non-retryable error', async () => {
    client.pushEntryResult = {
      success: false,
      retryable: false,
      error: '400: Invalid data',
      server_prod_no: undefined,
      server_doc_id: undefined,
    };

    const session = makeSession({
      session_id: 'push-fail',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('push-fail', { bag_id: 'bf1', qr_code: 'QR-FAIL-1' }));

    await (engine as any).pushOfflineSession(session);

    const updated = queries.getSession('push-fail')!;
    assert.equal(updated.sync_status, 'FAILED');
  });

  it('keeps session PENDING when retryable, increments attempts', async () => {
    client.pushEntryResult = {
      success: false,
      retryable: true,
      error: 'Server error 500',
      server_prod_no: undefined,
      server_doc_id: undefined,
    };

    const session = makeSession({
      session_id: 'push-retry',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
      sync_attempts: 0,
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('push-retry', { bag_id: 'br1', qr_code: 'QR-RETRY-1' }));

    await (engine as any).pushOfflineSession(session);

    const updated = queries.getSession('push-retry')!;
    // updateSessionSyncStatus increments attempts by 1 (called twice: SYNCING + PENDING)
    assert.ok(updated.sync_attempts >= 1);
    assert.equal(updated.sync_status, 'PENDING');
  });

  it('marks FAILED when no bags in session', async () => {
    const session = makeSession({
      session_id: 'push-empty',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
    });
    queries.insertSession(session);

    await (engine as any).pushOfflineSession(session);

    const updated = queries.getSession('push-empty')!;
    assert.equal(updated.sync_status, 'FAILED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// shouldRetrySession
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncEngine.shouldRetrySession', () => {
  it('returns true when sync_attempts=0', () => {
    const session = makeSession({ sync_attempts: 0 });
    assert.equal((engine as any).shouldRetrySession(session), true);
  });

  it('returns true when last_sync_at is null', () => {
    const session = makeSession({ sync_attempts: 3, last_sync_at: null });
    assert.equal((engine as any).shouldRetrySession(session), true);
  });

  it('returns false when backoff has not elapsed', () => {
    const session = makeSession({
      sync_attempts: 3,
      last_sync_at: new Date().toISOString(), // just now
    });
    // backoff for attempt 3 = min(60000 * 2^2, 300000) = 240000ms
    assert.equal((engine as any).shouldRetrySession(session), false);
  });

  it('returns true when enough time has passed', () => {
    const past = new Date(Date.now() - 400_000).toISOString(); // 400s ago
    const session = makeSession({
      sync_attempts: 1,
      last_sync_at: past,
    });
    // backoff for attempt 1 = min(60000 * 2^0, 300000) = 60000ms = 60s
    // 400s > 60s → should retry
    assert.equal((engine as any).shouldRetrySession(session), true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// closeAndQueueStaleSessions
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncEngine.closeAndQueueStaleSessions', () => {
  it('closes stale sessions with bags and marks them PENDING', () => {
    // Insert session from yesterday (stale)
    const yesterday = '2026-04-14';
    const session = makeSession({
      session_id: 'stale-with-bags',
      station_id: 'ST01',
      entry_date: yesterday,
      status: 'OPEN',
      sync_status: 'LOCAL',
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('stale-with-bags', { bag_id: 'sb1', qr_code: 'QR-STALE-1' }));

    engine.closeAndQueueStaleSessions();

    const updated = queries.getSession('stale-with-bags')!;
    assert.equal(updated.status, 'CLOSED');
    assert.equal(updated.sync_status, 'PENDING');
    assert.ok(updated.closed_at);
  });

  it('closes empty stale sessions and marks them SYNCED (no push needed)', () => {
    const yesterday = '2026-04-14';
    const session = makeSession({
      session_id: 'stale-empty',
      station_id: 'ST01',
      entry_date: yesterday,
      status: 'OPEN',
      sync_status: 'LOCAL',
    });
    queries.insertSession(session);
    // No bags inserted

    engine.closeAndQueueStaleSessions();

    const updated = queries.getSession('stale-empty')!;
    assert.equal(updated.status, 'CLOSED');
    assert.equal(updated.sync_status, 'SYNCED');
  });

  it('does not touch today\'s OPEN sessions', () => {
    const today = new Date().toISOString().substring(0, 10);
    const session = makeSession({
      session_id: 'today-open',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
    });
    queries.insertSession(session);

    engine.closeAndQueueStaleSessions();

    const updated = queries.getSession('today-open')!;
    assert.equal(updated.status, 'OPEN');
    assert.equal(updated.sync_status, 'LOCAL');
  });

  it('handles multiple stale sessions from different dates', () => {
    const session1 = makeSession({
      session_id: 'stale-d1',
      station_id: 'ST01',
      entry_date: '2026-04-12',
      status: 'OPEN',
      sync_status: 'LOCAL',
    });
    const session2 = makeSession({
      session_id: 'stale-d2',
      station_id: 'ST01',
      entry_date: '2026-04-13',
      status: 'OPEN',
      sync_status: 'LOCAL',
    });
    queries.insertSession(session1);
    queries.insertSession(session2);
    queries.insertBag(makeBag('stale-d1', { bag_id: 'sd1', qr_code: 'QR-SD1' }));
    queries.insertBag(makeBag('stale-d2', { bag_id: 'sd2', qr_code: 'QR-SD2' }));

    engine.closeAndQueueStaleSessions();

    assert.equal(queries.getSession('stale-d1')!.status, 'CLOSED');
    assert.equal(queries.getSession('stale-d1')!.sync_status, 'PENDING');
    assert.equal(queries.getSession('stale-d2')!.status, 'CLOSED');
    assert.equal(queries.getSession('stale-d2')!.sync_status, 'PENDING');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// flushAllOpenSessions (end-of-shift)
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncEngine.flushAllOpenSessions', () => {
  it('closes all OPEN sessions with bags, attempts push, returns counts', async () => {
    const today = new Date().toISOString().substring(0, 10);
    const s1 = makeSession({
      session_id: 'flush-s1',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
      is_offline: 1,
    });
    const s2 = makeSession({
      session_id: 'flush-s2',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
      is_offline: 1,
      pack_config_id: 20,
    });
    queries.insertSession(s1);
    queries.insertSession(s2);
    queries.insertBag(makeBag('flush-s1', { bag_id: 'fb1', qr_code: 'QR-FLUSH-1' }));
    queries.insertBag(makeBag('flush-s2', { bag_id: 'fb2', qr_code: 'QR-FLUSH-2' }));

    // Mock push succeeds
    client.pushEntryResult = {
      success: true,
      server_prod_no: 'FGP-150426-01',
      server_doc_id: 200,
      retryable: undefined,
      error: undefined,
    };

    const result = await engine.flushAllOpenSessions();

    assert.equal(result.closed, 2);
    assert.equal(result.pushed, 2);

    // Both sessions should be CLOSED + SYNCED
    assert.equal(queries.getSession('flush-s1')!.status, 'CLOSED');
    assert.equal(queries.getSession('flush-s1')!.sync_status, 'SYNCED');
    assert.equal(queries.getSession('flush-s2')!.status, 'CLOSED');
    assert.equal(queries.getSession('flush-s2')!.sync_status, 'SYNCED');
  });

  it('silently closes empty sessions (no bags) without counting them', async () => {
    const today = new Date().toISOString().substring(0, 10);
    const session = makeSession({
      session_id: 'flush-empty',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
    });
    queries.insertSession(session);
    // No bags

    const result = await engine.flushAllOpenSessions();

    assert.equal(result.closed, 0); // empty sessions don't count
    assert.equal(result.pushed, 0);
    assert.equal(queries.getSession('flush-empty')!.status, 'CLOSED');
    assert.equal(queries.getSession('flush-empty')!.sync_status, 'SYNCED');
  });

  it('returns pushed=0 when push fails (retryable)', async () => {
    const today = new Date().toISOString().substring(0, 10);
    const session = makeSession({
      session_id: 'flush-fail',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
      is_offline: 1,
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('flush-fail', { bag_id: 'ff1', qr_code: 'QR-FLUSHFAIL-1' }));

    client.pushEntryResult = {
      success: false,
      retryable: true,
      error: 'Server 500',
      server_prod_no: undefined,
      server_doc_id: undefined,
    };

    const result = await engine.flushAllOpenSessions();

    assert.equal(result.closed, 1);
    assert.equal(result.pushed, 0); // push failed

    // Session is CLOSED but stays PENDING (will retry later)
    const updated = queries.getSession('flush-fail')!;
    assert.equal(updated.status, 'CLOSED');
    assert.equal(updated.sync_status, 'PENDING');
  });

  it('returns {closed: 0, pushed: 0} when no open sessions', async () => {
    const result = await engine.flushAllOpenSessions();
    assert.deepEqual(result, { closed: 0, pushed: 0 });
  });

  it('handles mix of successful and failed pushes', async () => {
    const today = new Date().toISOString().substring(0, 10);
    const s1 = makeSession({
      session_id: 'flush-mix-ok',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
      is_offline: 1,
    });
    const s2 = makeSession({
      session_id: 'flush-mix-fail',
      station_id: 'ST01',
      entry_date: today,
      status: 'OPEN',
      sync_status: 'LOCAL',
      is_offline: 1,
      pack_config_id: 20,
    });
    queries.insertSession(s1);
    queries.insertSession(s2);
    queries.insertBag(makeBag('flush-mix-ok', { bag_id: 'fmok1', qr_code: 'QR-FMOK-1' }));
    queries.insertBag(makeBag('flush-mix-fail', { bag_id: 'fmfail1', qr_code: 'QR-FMFAIL-1' }));

    let callCount = 0;
    // Override pushEntry to succeed first, fail second
    client.pushEntry = async (_data: unknown) => {
      callCount++;
      if (callCount === 1) {
        return { success: true, server_prod_no: 'FGP-OK', server_doc_id: 300, retryable: undefined, error: undefined };
      }
      return { success: false, retryable: true, error: 'Timeout', server_prod_no: undefined, server_doc_id: undefined };
    };

    const result = await engine.flushAllOpenSessions();

    assert.equal(result.closed, 2);
    assert.equal(result.pushed, 1); // only first succeeded
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Max retry exhaustion
// ══════════════════════════════════════════════════════════════════════════════

describe('SyncEngine max retry exhaustion', () => {
  it('marks session FAILED after MAX_RETRIES (10) attempts', async () => {
    client.pushEntryResult = {
      success: false,
      retryable: true,
      error: 'Server 500',
      server_prod_no: undefined,
      server_doc_id: undefined,
    };

    // Session at attempt 9 — one more push should tip it to FAILED
    const session = makeSession({
      session_id: 'exhaust-retry',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
      sync_attempts: 9,
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('exhaust-retry', { bag_id: 'er1', qr_code: 'QR-EXHAUST-1' }));

    await (engine as any).pushOfflineSession(session);

    const updated = queries.getSession('exhaust-retry')!;
    assert.equal(updated.sync_status, 'FAILED');
    assert.ok(updated.sync_error?.includes('Max retries exceeded'));
  });

  it('keeps session PENDING at attempt 8 (under MAX_RETRIES)', async () => {
    client.pushEntryResult = {
      success: false,
      retryable: true,
      error: 'Server 500',
      server_prod_no: undefined,
      server_doc_id: undefined,
    };

    const session = makeSession({
      session_id: 'under-max',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
      sync_attempts: 8,
    });
    queries.insertSession(session);
    queries.insertBag(makeBag('under-max', { bag_id: 'um1', qr_code: 'QR-UNDER-1' }));

    await (engine as any).pushOfflineSession(session);

    const updated = queries.getSession('under-max')!;
    assert.equal(updated.sync_status, 'PENDING');
  });
});
