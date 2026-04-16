import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createServer } from '../src/api/server.js';
import type { ServerContext } from '../src/types.js';
import type { StabilityState } from '../src/types.js';

interface MockOverrides {
  state?: Partial<StabilityState>;
  connected?: boolean;
  config?: Record<string, unknown>;
}

function createMockContext(overrides: MockOverrides = {}): ServerContext {
  return {
    stabilityDetector: {
      getState: () => ({
        weight: 25.45,
        stable: true,
        stableWeight: 25.45,
        lastReadingAt: Date.now(),
        ...overrides.state,
      }),
      update: () => ({ weight: null, stable: false, stableWeight: null }),
    },
    weightReader: {
      isConnected: overrides.connected ?? true,
    },
    config: {
      stationId: 'ST01',
      serial: { port: 'COM4', simulate: false, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
      api: { port: 5000 },
      stability: { thresholdMs: 1500, toleranceKg: 0.02 },
      logLevel: 'info',
      ...(overrides.config || {}),
    },
  } as unknown as ServerContext;
}

describe('GET /weight', () => {
  it('returns weight when connected and stable', async () => {
    const ctx = createMockContext();
    const app = createServer(ctx);

    const res = await request(app).get('/weight');
    assert.equal(res.status, 200);
    assert.equal(res.body.weight, 25.45);
    assert.equal(res.body.stable, true);
    assert.equal(res.body.stableWeight, 25.45);
    assert.equal(res.body.stationId, 'ST01');
    assert.equal(res.body.status, 'ok');
  });

  it('returns 503 when disconnected', async () => {
    const ctx = createMockContext({ connected: false });
    const app = createServer(ctx);

    const res = await request(app).get('/weight');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'disconnected');
  });

  it('returns 503 when no data', async () => {
    const ctx = createMockContext({ state: { weight: null, lastReadingAt: null } });
    const app = createServer(ctx);

    const res = await request(app).get('/weight');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'no_data');
  });

  it('returns 503 when data is stale (>5s old)', async () => {
    const ctx = createMockContext({ state: { lastReadingAt: Date.now() - 6000 } });
    const app = createServer(ctx);

    const res = await request(app).get('/weight');
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'no_data');
  });

  it('includes CORS headers', async () => {
    const ctx = createMockContext();
    const app = createServer(ctx);

    const res = await request(app).get('/weight');
    assert.ok(res.headers['access-control-allow-origin']);
  });
});

describe('GET /health', () => {
  it('returns 200 when connected', async () => {
    const ctx = createMockContext();
    const app = createServer(ctx);

    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'weight-service');
    assert.equal(res.body.stationId, 'ST01');
    assert.equal(res.body.serial.connected, true);
  });

  it('returns 503 when disconnected', async () => {
    const ctx = createMockContext({ connected: false });
    const app = createServer(ctx);

    const res = await request(app).get('/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.serial.connected, false);
  });
});
