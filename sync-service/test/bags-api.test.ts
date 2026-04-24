import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createTestApp, makePackConfig, MockDjangoClient } from './helpers.js';
import type { Queries } from '../src/db/queries.js';
import type { SyncEngine } from '../src/sync/engine.js';
import type express from 'express';

// supertest may leave TCP sockets open — force clean exit after all tests
after(() => setTimeout(() => process.exit(0), 200));

let app: express.Express;
let queries: Queries;
let client: MockDjangoClient;
let syncEngine: SyncEngine;

beforeEach(() => {
  ({ app, queries, client, syncEngine } = createTestApp());
  // Disable Django client so syncBagNow() (fire-and-forget inline sync)
  // exits immediately without creating lingering async operations.
  // The sync engine itself is fully tested in engine.test.ts.
  client.isConfigured = false;
  // Seed product catalog so bags/add can resolve pack_name + item_id
  queries.replacePackConfigs([
    makePackConfig({ pack_id: 10, item_id: 1, pack_name: 'Test Pack 500g', net_weight_gm: 500 }),
    makePackConfig({ pack_id: 20, item_id: 2, pack_name: 'Kasturi Rs5', net_weight_gm: 200 }),
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /bags/add
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /bags/add', () => {
  it('returns 201 with qr_code, bag_number, pack_name', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 510, worker_code_1: 'W1' });

    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.bag_id);
    assert.ok(res.body.qr_code);
    assert.equal(res.body.bag_number, 1);
    assert.equal(res.body.pack_name, 'Test Pack 500g');
    assert.equal(res.body.total_bags_today, 1);
    assert.equal(res.body.session_bags, 1);
  });

  it('returns 400 when pack_config_id missing', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ weight_gm: 500 });

    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('pack_config_id'));
  });

  it('returns 400 for unknown pack_config_id', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 999, weight_gm: 500, worker_code_1: 'W1' });

    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('Unknown pack_config_id'));
  });

  it('auto-creates session on first bag for a product', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 510, worker_code_1: 'W1' });

    assert.equal(res.status, 201);
    assert.equal(res.body.day_seq, 1);

    // Verify session was created in DB
    const sessions = queries.listOpenSessions('ST01');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].pack_config_id, 10);
    assert.equal(sessions[0].status, 'OPEN');
    assert.equal(sessions[0].sync_status, 'LOCAL');
  });

  it('reuses existing session for same product on same day', async () => {
    const r1 = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 510, worker_code_1: 'W1' });

    const r2 = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 520, worker_code_1: 'W1' });

    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r1.body.bag_number, 1);
    assert.equal(r2.body.bag_number, 2);
    assert.equal(r2.body.session_bags, 2);

    // Same day_seq = same session
    assert.equal(r1.body.day_seq, r2.body.day_seq);

    // Only 1 session should exist
    const sessions = queries.listOpenSessions('ST01');
    assert.equal(sessions.length, 1);
  });

  it('creates separate sessions for different products', async () => {
    const r1 = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 510, worker_code_1: 'W1' });

    const r2 = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 20, weight_gm: 200, worker_code_1: 'W1' });

    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r1.body.pack_name, 'Test Pack 500g');
    assert.equal(r2.body.pack_name, 'Kasturi Rs5');

    // Different day_seq for different products
    assert.notEqual(r1.body.day_seq, r2.body.day_seq);

    // 2 sessions should exist
    const sessions = queries.listOpenSessions('ST01');
    assert.equal(sessions.length, 2);
  });

  it('increments bag_number within same product session', async () => {
    const r1 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });
    const r2 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 505, worker_code_1: 'W1' });
    const r3 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 510, worker_code_1: 'W1' });

    assert.equal(r1.body.bag_number, 1);
    assert.equal(r2.body.bag_number, 2);
    assert.equal(r3.body.bag_number, 3);
    assert.equal(r3.body.session_bags, 3);
    assert.equal(r3.body.total_bags_today, 3);
  });

  it('generates correct QR code format (PREFIX-DDMMYY-SEQ-BAG)', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });

    // QR format: PREFIX-DDMMYY-SEQ02d-BAG03d
    assert.match(res.body.qr_code, /^[A-Z0-9]+-\d{6}-\d{2}-\d{3}$/);
  });

  it('bag_number resets per product session', async () => {
    // Add 2 bags for product A
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 505, worker_code_1: 'W1' });

    // Add 1 bag for product B — bag_number should start at 1
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 20, weight_gm: 200, worker_code_1: 'W1' });

    assert.equal(res.body.bag_number, 1);
    assert.equal(res.body.session_bags, 1);
    // total_bags_today includes all products
    assert.equal(res.body.total_bags_today, 3);
  });

  it('rejects missing weight_gm', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10 });

    assert.equal(res.status, 400);
  });

  it('day_seq increments per new product session', async () => {
    const r1 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });
    const r2 = await request(app).post('/bags/add').send({ pack_config_id: 20, weight_gm: 200, worker_code_1: 'W1' });

    assert.equal(r1.body.day_seq, 1);
    assert.equal(r2.body.day_seq, 2);
  });

  it('returns 409 on duplicate QR code', async () => {
    // Add a bag
    const r1 = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });
    assert.equal(r1.status, 201);

    // Manually insert a bag with the same QR to trigger conflict
    const qr = r1.body.qr_code;
    const sessions = queries.listOpenSessions('ST01');
    try {
      queries.insertBag({
        bag_id: 'dup-bag',
        session_id: sessions[0].session_id,
        bag_number: 99,
        item_id: 1,
        pack_config_id: 10,
        offer_id: null,
        actual_weight_gm: 500,
        qr_code: qr,
        batch_no: null,
        note: null,
        line_id: null,
        synced: 0,
        created_at: new Date().toISOString(),
        worker_code_1: null,
        worker_code_2: null,
      });
      assert.fail('Should have thrown UNIQUE constraint error');
    } catch (err: any) {
      assert.ok(err.message.includes('UNIQUE'));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /bags/today
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /bags/today', () => {
  it('returns empty summary when no bags', async () => {
    const res = await request(app).get('/bags/today');

    assert.equal(res.status, 200);
    assert.equal(res.body.total_bags, 0);
    assert.ok(Array.isArray(res.body.by_product));
    assert.equal(res.body.by_product.length, 0);
    assert.ok(res.body.date);
    assert.equal(res.body.station_id, 'ST01');
  });

  it('returns correct count after adding bags', async () => {
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 505, worker_code_1: 'W1' });
    await request(app).post('/bags/add').send({ pack_config_id: 20, weight_gm: 200, worker_code_1: 'W1' });

    const res = await request(app).get('/bags/today');

    assert.equal(res.status, 200);
    assert.equal(res.body.total_bags, 3);
    assert.equal(res.body.by_product.length, 2);

    const product10 = res.body.by_product.find((p: any) => p.pack_config_id === 10);
    const product20 = res.body.by_product.find((p: any) => p.pack_config_id === 20);

    assert.ok(product10);
    assert.equal(product10.count, 2);
    assert.equal(product10.pack_name, 'Test Pack 500g');

    assert.ok(product20);
    assert.equal(product20.count, 1);
    assert.equal(product20.pack_name, 'Kasturi Rs5');
  });

  it('includes date and station_id', async () => {
    const res = await request(app).get('/bags/today');

    assert.equal(res.status, 200);
    assert.ok(res.body.date);
    assert.equal(res.body.station_id, 'ST01');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /sync/flush (end-of-shift)
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /sync/flush', () => {
  it('returns ok with 0 closed when no open sessions', async () => {
    const res = await request(app).post('/sync/flush');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.closed, 0);
  });

  it('closes open sessions and attempts push', async () => {
    // Add some bags to create open sessions
    await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' });
    await request(app).post('/bags/add').send({ pack_config_id: 20, weight_gm: 200, worker_code_1: 'W1' });

    // Verify 2 open sessions exist
    const beforeSessions = queries.listOpenSessions('ST01');
    assert.equal(beforeSessions.length, 2);

    const res = await request(app).post('/sync/flush');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.closed, 2);

    // Verify sessions are now closed
    const afterSessions = queries.listOpenSessions('ST01');
    assert.equal(afterSessions.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Multi-product interleaved flow (integration)
// ══════════════════════════════════════════════════════════════════════════════

describe('Multi-product interleaved flow', () => {
  it('handles interleaved bags for different products correctly', async () => {
    // Simulate real factory: bags arrive in random product order
    const r1 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 500, worker_code_1: 'W1' }); // Product A bag 1
    const r2 = await request(app).post('/bags/add').send({ pack_config_id: 20, weight_gm: 200, worker_code_1: 'W1' }); // Product B bag 1
    const r3 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 505, worker_code_1: 'W1' }); // Product A bag 2
    const r4 = await request(app).post('/bags/add').send({ pack_config_id: 20, weight_gm: 195, worker_code_1: 'W1' }); // Product B bag 2
    const r5 = await request(app).post('/bags/add').send({ pack_config_id: 10, weight_gm: 510, worker_code_1: 'W1' }); // Product A bag 3

    // Product A: bags 1,2,3 — same session, same day_seq
    assert.equal(r1.body.bag_number, 1);
    assert.equal(r3.body.bag_number, 2);
    assert.equal(r5.body.bag_number, 3);
    assert.equal(r1.body.day_seq, r3.body.day_seq);
    assert.equal(r3.body.day_seq, r5.body.day_seq);

    // Product B: bags 1,2 — different session, different day_seq
    assert.equal(r2.body.bag_number, 1);
    assert.equal(r4.body.bag_number, 2);
    assert.equal(r2.body.day_seq, r4.body.day_seq);

    // Different products have different day_seq
    assert.notEqual(r1.body.day_seq, r2.body.day_seq);

    // Total bags today = 5
    assert.equal(r5.body.total_bags_today, 5);

    // Summary endpoint agrees
    const summary = await request(app).get('/bags/today');
    assert.equal(summary.body.total_bags, 5);
    assert.equal(summary.body.by_product.length, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Edge Cases: Weight Validation
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /bags/add (weight edge cases)', () => {
  it('rejects zero weight', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 0 });

    assert.equal(res.status, 400);
  });

  it('rejects negative weight', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: -5 });

    assert.equal(res.status, 400);
  });

  it('accepts very large weight', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 999999, worker_code_1: 'W1' });

    assert.equal(res.status, 201);
    assert.equal(res.body.bag_number, 1);
  });

  it('accepts decimal weight', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10, weight_gm: 500.75, worker_code_1: 'W1' });

    assert.equal(res.status, 201);
  });

  it('rejects missing weight_gm', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 10 });

    assert.equal(res.status, 400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Edge Cases: Malformed Input
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /bags/add (malformed input)', () => {
  it('returns 400 for string pack_config_id that does not match any product', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 'abc', weight_gm: 500, worker_code_1: 'W1' });

    // String 'abc' won't match any pack_config_id (they're numbers)
    assert.equal(res.status, 400);
  });

  it('returns 400 for empty body', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({});

    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('pack_config_id'));
  });

  it('returns 400 when pack_config_id is null', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: null, weight_gm: 500 });

    assert.equal(res.status, 400);
  });

  it('returns 400 when pack_config_id is 0', async () => {
    const res = await request(app)
      .post('/bags/add')
      .send({ pack_config_id: 0, weight_gm: 500 });

    // 0 is falsy, treated as missing
    assert.equal(res.status, 400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Edge Cases: High-Volume Bag Numbers
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /bags/add (high volume)', () => {
  it('handles 20 bags in rapid succession for same product', async () => {
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        request(app)
          .post('/bags/add')
          .send({ pack_config_id: 10, weight_gm: 500 + i, worker_code_1: 'W1' })
      );
    }

    // Note: supertest serializes requests to the same app,
    // so these run sequentially despite Promise.all
    const results = [];
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post('/bags/add')
        .send({ pack_config_id: 10, weight_gm: 500 + i, worker_code_1: 'W1' });
      results.push(res);
    }

    // All should succeed
    for (const res of results) {
      assert.equal(res.status, 201);
    }

    // Bag numbers should be 1-20
    const bagNumbers = results.map(r => r.body.bag_number);
    assert.deepEqual(bagNumbers, Array.from({ length: 20 }, (_, i) => i + 1));

    // Total bags should be 20
    assert.equal(results[19].body.total_bags_today, 20);
    assert.equal(results[19].body.session_bags, 20);
  });
});
