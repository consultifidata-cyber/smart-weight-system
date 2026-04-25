/**
 * Phase B — Bag Idempotency Tests
 *
 * Covers:
 *   1. Key generation is deterministic
 *   2. Migration 6 adds column + unique index
 *   3. DB rejects duplicate idempotency_key
 *   4. Retry after HTTP timeout → bag marked synced once, addBag called once
 *   5. Service restart replay uses stored key (not regenerated)
 *   6. Server idempotent:true response → engine marks synced
 *   7. client.addBag sends Idempotency-Key header
 *   8. client.addBag omits header for legacy null keys
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateBagIdempotencyKey } from '../src/sync/idempotency.js';
import { SyncEngine } from '../src/sync/engine.js';
import { DjangoClient } from '../src/sync/client.js';
import { createTestDb, makeBag, makeSession, testConfig, MockDjangoClient } from './helpers.js';

// ── 1. Key generation ───────────────────────────────────────────────────────

describe('generateBagIdempotencyKey', () => {
  it('produces a 64-char lowercase hex string', () => {
    const k = generateBagIdempotencyKey('ST01', 'sess-1', 3, 'NAY0PCS-150426-03-003');
    assert.equal(k.length, 64);
    assert.match(k, /^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs always produce same key', () => {
    const a = ['ST01', 'sess-abc', 7, 'QR-007'] as const;
    assert.equal(generateBagIdempotencyKey(...a), generateBagIdempotencyKey(...a));
  });

  it('is unique per bag_number within same session', () => {
    const k1 = generateBagIdempotencyKey('ST01', 'sess-1', 1, 'QR-001');
    const k2 = generateBagIdempotencyKey('ST01', 'sess-1', 2, 'QR-002');
    assert.notEqual(k1, k2);
  });

  it('is unique across sessions with same bag_number', () => {
    const k1 = generateBagIdempotencyKey('ST01', 'sess-A', 1, 'QR-A001');
    const k2 = generateBagIdempotencyKey('ST01', 'sess-B', 1, 'QR-B001');
    assert.notEqual(k1, k2);
  });

  it('is unique across stations', () => {
    const k1 = generateBagIdempotencyKey('ST01', 'sess-1', 1, 'QR-001');
    const k2 = generateBagIdempotencyKey('ST02', 'sess-1', 1, 'QR-001');
    assert.notEqual(k1, k2);
  });
});

// ── 2. Migration 6 — column + index ────────────────────────────────────────

describe('migration 6 schema changes', () => {
  it('adds idempotency_key column to fg_bag', () => {
    const { db } = createTestDb();
    const cols = db.prepare("PRAGMA table_info(fg_bag)").all() as Array<{ name: string }>;
    assert.ok(
      cols.some(c => c.name === 'idempotency_key'),
      'idempotency_key column must exist after migration 6',
    );
    db.close();
  });

  it('creates unique index on idempotency_key (partial — not null)', () => {
    const { db } = createTestDb();
    const indexes = db.prepare(
      `SELECT name, "unique" FROM pragma_index_list('fg_bag')`
    ).all() as Array<{ name: string; unique: number }>;
    const idx = indexes.find(i => i.name === 'idx_fg_bag_idempotency_key');
    assert.ok(idx, 'index idx_fg_bag_idempotency_key must exist');
    assert.equal(idx.unique, 1, 'the index must be UNIQUE');
    db.close();
  });

  it('LATEST_VERSION is 6', async () => {
    // Confirm the migration file exports version 6 as latest
    const { runMigrations } = await import('../src/db/migrations.js');
    const db = (await import('better-sqlite3')).default(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const ver = db.pragma('user_version', { simple: true }) as number;
    assert.equal(ver, 6, 'database schema should be at version 6 after running all migrations');
    db.close();
  });
});

// ── 3. DB unique constraint ─────────────────────────────────────────────────

describe('database unique constraint on idempotency_key', () => {
  it('rejects second bag with same idempotency_key', () => {
    const { queries } = createTestDb();
    const session = makeSession();
    queries.insertSession(session);

    const key = generateBagIdempotencyKey('ST01', session.session_id, 1, 'QR-001');

    queries.insertBag(makeBag(session.session_id, {
      bag_number: 1, qr_code: 'QR-001', idempotency_key: key,
    }));

    assert.throws(
      () => queries.insertBag(makeBag(session.session_id, {
        bag_number: 99, qr_code: 'QR-DIFF', idempotency_key: key,  // same key, different bag
      })),
      /UNIQUE constraint failed/,
    );
  });

  it('allows multiple null idempotency_keys (legacy bags)', () => {
    const { queries } = createTestDb();
    const session = makeSession();
    queries.insertSession(session);

    // Two legacy bags with null key — both should insert fine
    queries.insertBag(makeBag(session.session_id, {
      bag_number: 1, qr_code: 'LEGACY-001', idempotency_key: null,
    }));
    queries.insertBag(makeBag(session.session_id, {
      bag_number: 2, qr_code: 'LEGACY-002', idempotency_key: null,
    }));

    assert.equal(queries.getBagsBySession(session.session_id).length, 2);
  });
});

// ── 4. Retry safety — bag pushed multiple times ─────────────────────────────

describe('syncUnsyncedBags — idempotent retry', () => {
  it('engine calls addBag only once even after 3 sync cycles', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();
    let callCount = 0;

    client.addBag = async (data: any) => {
      callCount++;
      return {
        status: 'ok', line_id: 999, qr_code: data.qr_code,
        bag_number: 1, total_bags: 1, idempotent: callCount > 1,
      };
    };

    const engine = new SyncEngine(queries, client as any, testConfig);

    const session = makeSession({ doc_id: 100, sync_status: 'ONLINE', is_offline: 0 });
    queries.insertSession(session);

    const key = generateBagIdempotencyKey('ST01', session.session_id, 1, 'QR-RETRY-001');
    queries.insertBag(makeBag(session.session_id, {
      bag_number: 1, qr_code: 'QR-RETRY-001', synced: 0, idempotency_key: key,
    }));

    // Run 3 sync cycles
    for (let i = 0; i < 3; i++) await engine.syncBagsCycle();
    await engine.waitForPendingSync();

    const bags = queries.getBagsBySession(session.session_id);
    assert.equal(bags[0].synced, 1, 'bag must be marked synced=1');
    // After first cycle the bag is synced=1 so cycles 2 and 3 skip it
    assert.equal(callCount, 1, 'addBag should be called exactly once');
  });

  it('forwards stored idempotency_key to client.addBag', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();
    let capturedKey: unknown = undefined;

    client.addBag = async (data: any) => {
      capturedKey = data.idempotency_key;
      return { status: 'ok', line_id: 1, qr_code: data.qr_code, bag_number: 1, total_bags: 1 };
    };

    const engine = new SyncEngine(queries, client as any, testConfig);
    const session = makeSession({ doc_id: 100, sync_status: 'ONLINE', is_offline: 0 });
    queries.insertSession(session);

    const key = generateBagIdempotencyKey('ST01', session.session_id, 5, 'QR-FORWARD');
    queries.insertBag(makeBag(session.session_id, {
      bag_number: 5, qr_code: 'QR-FORWARD', synced: 0, idempotency_key: key,
    }));

    await engine.syncBagsCycle();

    assert.equal(capturedKey, key, 'stored idempotency_key must be forwarded to addBag');
  });
});

// ── 5. Service restart replay ───────────────────────────────────────────────

describe('service restart safety', () => {
  it('uses key stored in SQLite — not regenerated on restart', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();
    const received: string[] = [];

    client.addBag = async (data: any) => {
      received.push(data.idempotency_key);
      return { status: 'ok', line_id: 1, qr_code: data.qr_code, bag_number: 1, total_bags: 1 };
    };

    const session = makeSession({ doc_id: 100, sync_status: 'ONLINE', is_offline: 0 });
    queries.insertSession(session);

    // Bag was created before the crash — key is already stored in DB
    const storedKey = 'a'.repeat(64);   // stable key that was written before crash
    queries.insertBag(makeBag(session.session_id, {
      bag_number: 1, qr_code: 'QR-RESTART', synced: 0, idempotency_key: storedKey,
    }));

    // Simulate restart: new SyncEngine instance, same DB
    const engineAfterRestart = new SyncEngine(queries, client as any, testConfig);
    await engineAfterRestart.syncBagsCycle();

    assert.equal(received.length, 1);
    assert.equal(received[0], storedKey, 'must use stored key, not generate a new one');
  });
});

// ── 6. idempotent:true response handling ────────────────────────────────────

describe('idempotent server response', () => {
  it('marks bag synced when server returns idempotent:true', async () => {
    const { queries } = createTestDb();
    const client = new MockDjangoClient();

    // Server (Phase C) says: already have this bag
    client.addBag = async (data: any) => ({
      status: 'ok', line_id: 777, qr_code: data.qr_code,
      bag_number: 1, total_bags: 1, idempotent: true,
    });

    const engine = new SyncEngine(queries, client as any, testConfig);
    const session = makeSession({ doc_id: 100, sync_status: 'ONLINE', is_offline: 0 });
    queries.insertSession(session);

    const key = generateBagIdempotencyKey('ST01', session.session_id, 1, 'QR-IDEM');
    queries.insertBag(makeBag(session.session_id, {
      bag_number: 1, qr_code: 'QR-IDEM', synced: 0, idempotency_key: key,
    }));

    await engine.syncBagsCycle();

    const bags = queries.getBagsBySession(session.session_id);
    assert.equal(bags[0].synced, 1, 'idempotent:true must mark bag as synced');
    assert.equal(bags[0].line_id, 777, 'line_id from idempotent response must be stored');
  });
});

// ── 7 & 8. client.addBag header behaviour ───────────────────────────────────

describe('DjangoClient.addBag — Idempotency-Key header', () => {
  it('sends Idempotency-Key header when key is present', async () => {
    const capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: any, opts: any) => {
      for (const [k, v] of Object.entries(opts?.headers ?? {})) {
        capturedHeaders[k as string] = v as string;
      }
      return {
        ok: true,
        json: async () => ({ status: 'ok', line_id: 1, qr_code: 'QR', bag_number: 1, total_bags: 1 }),
      };
    }) as typeof fetch;

    try {
      const client = new DjangoClient('http://mock', 'tok', 1000);
      await client.addBag({
        doc_id: 1, item_id: 1, pack_config_id: 1,
        qr_code: 'QR', actual_weight_gm: 500,
        idempotency_key: 'z'.repeat(64),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok('Idempotency-Key' in capturedHeaders, 'header must be present');
    assert.equal(capturedHeaders['Idempotency-Key'], 'z'.repeat(64));
  });

  it('omits Idempotency-Key header when key is null (legacy bags)', async () => {
    const capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_url: any, opts: any) => {
      for (const [k, v] of Object.entries(opts?.headers ?? {})) {
        capturedHeaders[k as string] = v as string;
      }
      return {
        ok: true,
        json: async () => ({ status: 'ok', line_id: 1, qr_code: 'QR', bag_number: 1, total_bags: 1 }),
      };
    }) as typeof fetch;

    try {
      const client = new DjangoClient('http://mock', 'tok', 1000);
      await client.addBag({
        doc_id: 1, item_id: 1, pack_config_id: 1,
        qr_code: 'QR', actual_weight_gm: 500,
        idempotency_key: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(!('Idempotency-Key' in capturedHeaders), 'header must NOT be sent for null key');
  });
});
