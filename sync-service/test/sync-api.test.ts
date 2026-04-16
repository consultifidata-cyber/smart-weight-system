import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, makePackConfig } from './helpers.js';
import type { Queries } from '../src/db/queries.js';
import type express from 'express';

let app: express.Express;
let queries: Queries;

beforeEach(() => {
  ({ app, queries } = createTestApp());
  // Seed products for tests that add bags
  queries.replacePackConfigs([
    makePackConfig({ pack_id: 10, item_id: 1, pack_name: 'Test Pack 500g', net_weight_gm: 500 }),
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /sync/status
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /sync/status', () => {
  it('returns status counts with 0 when no data', async () => {
    const res = await request(app).get('/sync/status');

    assert.equal(res.status, 200);
    assert.equal(res.body.pending_entries, 0);
    assert.equal(res.body.failed_entries, 0);
    assert.equal(res.body.synced_today, 0);
    assert.equal(res.body.pending_sessions, 0);
    assert.equal(res.body.closed_sessions_today, 0);
    assert.equal(res.body.total_bags_today, 0);
  });

  it('includes last_sync_at and last_master_sync_at', async () => {
    const res = await request(app).get('/sync/status');

    assert.equal(res.status, 200);
    assert.ok('last_sync_at' in res.body);
    assert.ok('last_master_sync_at' in res.body);
  });

  it('includes server_reachable flag', async () => {
    const res = await request(app).get('/sync/status');

    assert.equal(res.status, 200);
    assert.equal(typeof res.body.server_reachable, 'boolean');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /sync/master-refresh
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /sync/master-refresh', () => {
  it('returns products_count and items_count on success', async () => {
    const res = await request(app).post('/sync/master-refresh');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.products_count, 0);
    assert.equal(res.body.items_count, 0);
    assert.ok(res.body.synced_at);
  });

  it('returns 503 when pullMasterData not configured', async () => {
    const { createTestDb, testConfig } = await import('./helpers.js');
    const { createServer } = await import('../src/api/server.js');
    const { queries } = createTestDb();
    const bareApp = createServer(queries, testConfig, undefined, undefined, undefined);

    const res = await request(bareApp).post('/sync/master-refresh');
    assert.equal(res.status, 503);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /health
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// POST /sync/push-pending
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /sync/push-pending', () => {
  it('returns ok with pushed=0 when no pending sessions', async () => {
    const res = await request(app).post('/sync/push-pending');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.pushed, 0);
  });

  it('pushes pending sessions and returns counts', async () => {
    const { createTestApp, createTestDb, makeSession, makeBag, MockDjangoClient, testConfig } = await import('./helpers.js');
    const { queries: q, db } = createTestDb();
    const c = new MockDjangoClient();
    c.pushEntryResult = {
      success: true,
      server_prod_no: 'FGP-150426-01',
      server_doc_id: 100,
      retryable: undefined,
      error: undefined,
    };
    const { app: testApp } = createTestApp({ queries: q, client: c });

    // Insert a PENDING session with a bag
    q.insertSession(makeSession({
      session_id: 'push-test',
      status: 'CLOSED',
      sync_status: 'PENDING',
      is_offline: 1,
      sync_attempts: 0,
    }));
    q.insertBag(makeBag('push-test', { bag_id: 'pb1', qr_code: 'QR-PUSHPEND-1' }));

    const res = await request(testApp).post('/sync/push-pending');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.pending_before, 1);
    assert.equal(res.body.pushed, 1);
    assert.equal(res.body.pending_after, 0);
  });

  it('returns 503 when sync engine not available', async () => {
    const { createTestDb, testConfig } = await import('./helpers.js');
    const { createServer } = await import('../src/api/server.js');
    const { queries } = createTestDb();
    const bareApp = createServer(queries, testConfig, undefined, undefined, undefined);

    const res = await request(bareApp).post('/sync/push-pending');
    assert.equal(res.status, 503);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /sync/flush (edge cases)
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /sync/flush (edge cases)', () => {
  it('returns 503 when sync engine not available', async () => {
    const { createTestDb, testConfig } = await import('./helpers.js');
    const { createServer } = await import('../src/api/server.js');
    const { queries } = createTestDb();
    const bareApp = createServer(queries, testConfig, undefined, undefined, undefined);

    const res = await request(bareApp).post('/sync/flush');
    assert.equal(res.status, 503);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /sync/status (with data)
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /sync/status (with data)', () => {
  it('reflects bag and session counts after activity', async () => {
    // Add some bags
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500 });
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 505 });

    const res = await request(app).get('/sync/status');

    assert.equal(res.status, 200);
    assert.equal(res.body.total_bags_today, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /health
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /health', () => {
  it('returns service name, stationId, status=ok', async () => {
    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'sync-service');
    assert.equal(res.body.stationId, 'ST01');
    assert.equal(res.body.status, 'ok');
  });

  it('includes uptime', async () => {
    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(typeof res.body.uptime, 'number');
    assert.ok(res.body.uptime >= 0);
  });
});
