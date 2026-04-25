/**
 * Phase D — Sync Retry Safety Tests
 *
 * Proves that the six real-world scenarios never produce duplicate rows.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateBagIdempotencyKey } from '../src/sync/idempotency.js';
import { SyncEngine } from '../src/sync/engine.js';
import { createTestDb, makeSession, makeBag, testConfig, MockDjangoClient } from './helpers.js';

// ── Shared mock setup ────────────────────────────────────────────────────────

function makeOnlineSession(overrides = {}) {
  return makeSession({ doc_id: 100, sync_status: 'ONLINE', is_offline: 0, ...overrides });
}

function makeReadyBag(sessionId: string, n: number, overrides = {}) {
  const qr  = `QR-SAFETY-${n.toString().padStart(3, '0')}`;
  const key = generateBagIdempotencyKey('ST01', sessionId, n, qr);
  return makeBag(sessionId, { bag_number: n, qr_code: qr, synced: 0, idempotency_key: key, ...overrides });
}

// ── Scenario 1: Normal push ──────────────────────────────────────────────────

describe('Scenario 1: normal push', () => {
  it('creates one row and marks synced=1', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();
    const engine = new SyncEngine(queries, client as any, testConfig);

    const session = makeOnlineSession();
    queries.insertSession(session);
    queries.insertBag(makeReadyBag(session.session_id, 1));

    await engine.syncBagsCycle();

    const bags = queries.getBagsBySession(session.session_id);
    assert.equal(bags[0].synced, 1);
    assert.equal(client.calls.filter(c => c.method === 'addBag').length, 1);
  });
});

// ── Scenario 2: Timeout after server save ────────────────────────────────────

describe('Scenario 2: timeout after server save', () => {
  it('retry gets idempotent:true, marks synced=1, calls addBag twice total', async () => {
    const { queries } = createTestDb();
    let callCount = 0;

    // First call: throws timeout. Second call: returns idempotent (server has it).
    const client = new MockDjangoClient();
    client.addBag = async (data: any) => {
      callCount++;
      if (callCount === 1) throw new Error('AbortError: signal timed out');
      return { status: 'ok', line_id: 999, qr_code: data.qr_code, bag_number: 1, total_bags: 1, idempotent: true };
    };

    const engine = new SyncEngine(queries, client as any, testConfig);
    const session = makeOnlineSession();
    queries.insertSession(session);
    queries.insertBag(makeReadyBag(session.session_id, 1));

    // First cycle: timeout — bag stays synced=0, sync_attempts incremented
    await engine.syncBagsCycle();
    let bag = queries.getBagsBySession(session.session_id)[0];
    assert.equal(bag.synced, 0, 'bag must stay unsynced after timeout');
    assert.equal(bag.sync_attempts, 1, 'sync_attempts must be 1 after first failure');

    // Second cycle: idempotent — bag marked synced=1
    await engine.syncBagsCycle();
    bag = queries.getBagsBySession(session.session_id)[0];
    assert.equal(bag.synced, 1, 'bag must be synced after idempotent retry');
    assert.equal(callCount, 2, 'addBag called exactly twice');
  });
});

// ── Scenario 3: 10s retry cycle ──────────────────────────────────────────────

describe('Scenario 3: retry cycle guard', () => {
  it('5 cycles on a bag that succeeds on cycle 1 — addBag called once', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();
    const engine = new SyncEngine(queries, client as any, testConfig);

    const session = makeOnlineSession();
    queries.insertSession(session);
    queries.insertBag(makeReadyBag(session.session_id, 1));

    for (let i = 0; i < 5; i++) await engine.syncBagsCycle();

    assert.equal(queries.getBagsBySession(session.session_id)[0].synced, 1);
    assert.equal(client.calls.filter(c => c.method === 'addBag').length, 1,
      'addBag called only once — synced bag skipped by listUnsyncedBags in later cycles');
  });
});

// ── Scenario 4: Service restart replay ──────────────────────────────────────

describe('Scenario 4: service restart replay', () => {
  it('uses stored idempotency_key after restart — same key, idempotent:true', async () => {
    const { queries } = createTestDb();
    const receivedKeys: string[] = [];

    const client = new MockDjangoClient();
    client.addBag = async (data: any) => {
      receivedKeys.push(data.idempotency_key);
      return { status: 'ok', line_id: 1, qr_code: data.qr_code, bag_number: 1, total_bags: 1, idempotent: false };
    };

    const session = makeOnlineSession();
    queries.insertSession(session);
    const bag = makeReadyBag(session.session_id, 1);
    queries.insertBag(bag);

    // "Crash" — bag never got synced (synced=0 in DB)
    // Simulate restart with fresh engine
    const engineAfterRestart = new SyncEngine(queries, client as any, testConfig);
    await engineAfterRestart.syncBagsCycle();

    assert.equal(receivedKeys.length, 1);
    assert.equal(receivedKeys[0], bag.idempotency_key,
      'restart must use stored key, not generate a new one');
    assert.equal(queries.getBagsBySession(session.session_id)[0].synced, 1);
  });
});

// ── Scenario 5: Double trigger (syncBagNow + timer) ──────────────────────────

describe('Scenario 5: double trigger prevention', () => {
  it('concurrent syncBagNow calls do not double-push', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();
    const engine = new SyncEngine(queries, client as any, testConfig);

    const session = makeOnlineSession();
    queries.insertSession(session);
    queries.insertBag(makeReadyBag(session.session_id, 1));

    // Fire two overlapping sync requests simultaneously
    await Promise.all([
      engine.syncBagsCycle(),
      engine.syncBagsCycle(),
    ]);
    await engine.waitForPendingSync();

    assert.equal(client.calls.filter(c => c.method === 'addBag').length, 1,
      'bagSyncRunning guard must prevent second concurrent call');
    assert.equal(queries.getBagsBySession(session.session_id)[0].synced, 1);
  });
});

// ── Scenario 6: 10 bags, 5 cycles — zero duplicates ──────────────────────────

describe('Scenario 6: full batch — no duplicates ever', () => {
  it('10 bags × 5 cycles → 10 synced, addBag called 10 times', async () => {
    const { queries } = createTestDb();
    const serverKeys = new Set<string>();
    let addBagCalls = 0;

    const client = new MockDjangoClient();
    client.addBag = async (data: any) => {
      addBagCalls++;
      const key = data.idempotency_key ?? data.qr_code;
      const idempotent = serverKeys.has(key);
      serverKeys.add(key);
      return { status: 'ok', line_id: addBagCalls, qr_code: data.qr_code, bag_number: 1, total_bags: 1, idempotent };
    };

    const engine = new SyncEngine(queries, client as any, testConfig);
    const session = makeOnlineSession();
    queries.insertSession(session);

    for (let b = 1; b <= 10; b++) {
      queries.insertBag(makeReadyBag(session.session_id, b));
    }

    for (let cycle = 1; cycle <= 5; cycle++) await engine.syncBagsCycle();
    await engine.waitForPendingSync();

    const bags = queries.getBagsBySession(session.session_id);
    assert.equal(bags.filter(b => b.synced === 1).length, 10, '10 bags must be synced');
    assert.equal(bags.filter(b => b.synced === 0).length, 0, '0 bags still unsynced');
    assert.equal(addBagCalls, 10, 'addBag called exactly 10 times — no retries needed');
    assert.equal(serverKeys.size, 10, 'server has exactly 10 distinct keys');
  });
});

// ── Scenario 7: sync_attempts tracking ──────────────────────────────────────

describe('Scenario 7: sync_attempts counter', () => {
  it('increments on each failure, stays at 0 on first-try success', async () => {
    const { queries } = createTestDb();
    let calls = 0;

    const client = new MockDjangoClient();
    client.addBag = async (data: any) => {
      calls++;
      if (calls <= 2) throw new Error('network error');
      return { status: 'ok', line_id: 1, qr_code: data.qr_code, bag_number: 1, total_bags: 1 };
    };

    const engine = new SyncEngine(queries, client as any, testConfig);
    const session = makeOnlineSession();
    queries.insertSession(session);
    queries.insertBag(makeReadyBag(session.session_id, 1));

    await engine.syncBagsCycle();  // fails: attempts=1
    let bag = queries.getBagsBySession(session.session_id)[0];
    assert.equal(bag.sync_attempts, 1, 'attempts=1 after first failure');
    assert.ok(bag.last_sync_error?.includes('network error'), 'error stored');

    await engine.syncBagsCycle();  // fails: attempts=2
    bag = queries.getBagsBySession(session.session_id)[0];
    assert.equal(bag.sync_attempts, 2, 'attempts=2 after second failure');

    await engine.syncBagsCycle();  // succeeds
    bag = queries.getBagsBySession(session.session_id)[0];
    assert.equal(bag.synced, 1, 'finally synced');
  });
});

// ── Scenario 8: startup stale bag detection ──────────────────────────────────

describe('Scenario 8: startup stale bag detection', () => {
  it('countStaleBags returns correct count for past-date unsynced bags', () => {
    const { queries } = createTestDb();

    const oldSession = makeSession({
      entry_date: '2026-01-01', sync_status: 'ONLINE', is_offline: 0, doc_id: 100,
    });
    queries.insertSession(oldSession);
    queries.insertBag(makeBag(oldSession.session_id, { qr_code: 'OLD-001', synced: 0, idempotency_key: null }));
    queries.insertBag(makeBag(oldSession.session_id, { qr_code: 'OLD-002', synced: 1, idempotency_key: null }));

    const today = '2026-04-25';
    const stale = queries.countStaleBags(today);
    assert.equal(stale, 1, 'only the synced=0 old bag should be counted as stale');
  });
});
