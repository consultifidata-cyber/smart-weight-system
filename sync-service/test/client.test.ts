import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DjangoClient } from '../src/sync/client.js';

let client: DjangoClient;

// We mock global fetch for each test
const originalFetch = globalThis.fetch;

beforeEach(() => {
  client = new DjangoClient('http://localhost:8000', 'test-token', 5000);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
});

function mockFetch(response: { ok: boolean; status: number; json?: unknown; text?: string }): void {
  globalThis.fetch = (async () => ({
    ok: response.ok,
    status: response.status,
    json: async () => response.json,
    text: async () => response.text || '',
  })) as any;
}

function mockFetchError(error: Error): void {
  globalThis.fetch = (async () => { throw error; }) as any;
}

// ══════════════════════════════════════════════════════════════════════════════
// isConfigured
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.isConfigured', () => {
  it('returns true when serverUrl is set', () => {
    assert.equal(client.isConfigured, true);
  });

  it('returns false when serverUrl is empty', () => {
    const emptyClient = new DjangoClient('', 'token');
    assert.equal(emptyClient.isConfigured, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// healthCheck
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.healthCheck', () => {
  it('returns true on 200', async () => {
    mockFetch({ ok: true, status: 200 });
    assert.equal(await client.healthCheck(), true);
  });

  it('returns false on network error', async () => {
    mockFetchError(new Error('ECONNREFUSED'));
    assert.equal(await client.healthCheck(), false);
  });

  it('returns false when not configured', async () => {
    const emptyClient = new DjangoClient('', 'token');
    assert.equal(await emptyClient.healthCheck(), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// fetchPackConfigs
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.fetchPackConfigs', () => {
  it('parses response.configs', async () => {
    const configs = [{ pack_id: 1, item_id: 1, pack_name: 'Test', net_weight_gm: 500 }];
    mockFetch({ ok: true, status: 200, json: { configs } });
    const result = await client.fetchPackConfigs();
    assert.equal(result.length, 1);
    assert.equal(result[0].pack_id, 1);
  });

  it('throws on non-ok response', async () => {
    mockFetch({ ok: false, status: 500 });
    await assert.rejects(() => client.fetchPackConfigs(), /Failed to fetch pack configs/);
  });

  it('returns empty array when not configured', async () => {
    const emptyClient = new DjangoClient('', 'token');
    const result = await emptyClient.fetchPackConfigs();
    assert.deepEqual(result, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// fetchItemMasters
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.fetchItemMasters', () => {
  it('parses response.items', async () => {
    const items = [{ item_id: 1, item_name: 'FG Item', item_code: 'FG001' }];
    mockFetch({ ok: true, status: 200, json: { items } });
    const result = await client.fetchItemMasters();
    assert.equal(result.length, 1);
    assert.equal(result[0].item_name, 'FG Item');
  });

  it('throws on non-ok response', async () => {
    mockFetch({ ok: false, status: 401 });
    await assert.rejects(() => client.fetchItemMasters(), /Failed to fetch item masters/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// openSession
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.openSession', () => {
  it('sends correct body and returns doc_id/prod_no/day_seq', async () => {
    const respData = { doc_id: 100, prod_no: 'FGP-150426-03', day_seq: 3, entry_date: '2026-04-15', pack_name: 'Test' };
    mockFetch({ ok: true, status: 201, json: respData });
    const result = await client.openSession({ item_id: 1, pack_config_id: 10 });
    assert.equal(result.doc_id, 100);
    assert.equal(result.prod_no, 'FGP-150426-03');
    assert.equal(result.day_seq, 3);
  });

  it('throws on non-ok response', async () => {
    mockFetch({ ok: false, status: 400, text: 'Bad Request' });
    await assert.rejects(() => client.openSession({ item_id: 1, pack_config_id: 10 }), /open-session failed/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// addBag
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.addBag', () => {
  it('returns line_id and bag_number', async () => {
    const respData = { line_id: 200, qr_code: 'QR-001', bag_number: 1, total_bags: 1 };
    mockFetch({ ok: true, status: 201, json: respData });
    const result = await client.addBag({
      doc_id: 100, item_id: 1, pack_config_id: 10, qr_code: 'QR-001', actual_weight_gm: 500,
    });
    assert.equal(result.line_id, 200);
    assert.equal(result.bag_number, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// closeSession
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.closeSession', () => {
  it('returns prod_no, total_bags, doc_status', async () => {
    const respData = { prod_no: 'FGP-150426-03', total_bags: 5, doc_status: 'POSTED', verification_status: 'VERIFIED' };
    mockFetch({ ok: true, status: 200, json: respData });
    const result = await client.closeSession(100);
    assert.equal(result.prod_no, 'FGP-150426-03');
    assert.equal(result.total_bags, 5);
    assert.equal(result.doc_status, 'POSTED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// pushEntry
// ══════════════════════════════════════════════════════════════════════════════

describe('DjangoClient.pushEntry', () => {
  const pushData = {
    idempotency_key: 'key-123',
    entry_date: '2026-04-15',
    bags: [{ item_id: 1, pack_config_id: 10, actual_weight_gm: 500, qr_code: 'QR-1' }],
  };

  it('returns success=true with server_prod_no on 200', async () => {
    mockFetch({
      ok: true, status: 200,
      json: { doc_id: 100, prod_no: 'FGP-150426-03', total_bags: 1 },
    });
    const result = await client.pushEntry(pushData);
    assert.equal(result.success, true);
    assert.equal(result.server_prod_no, 'FGP-150426-03');
    assert.equal(result.server_doc_id, 100);
  });

  it('returns retryable=false on 4xx', async () => {
    mockFetch({ ok: false, status: 400, text: 'Bad Request' });
    const result = await client.pushEntry(pushData);
    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
  });

  it('returns retryable=true on 5xx', async () => {
    mockFetch({ ok: false, status: 500, text: 'Internal Server Error' });
    const result = await client.pushEntry(pushData);
    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
  });

  it('returns retryable=true on network error', async () => {
    mockFetchError(new Error('ECONNREFUSED'));
    const result = await client.pushEntry(pushData);
    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
    assert.ok(result.error?.includes('ECONNREFUSED'));
  });

  it('returns retryable=true when not configured', async () => {
    const emptyClient = new DjangoClient('', 'token');
    const result = await emptyClient.pushEntry(pushData);
    assert.equal(result.success, false);
    assert.equal(result.retryable, true);
  });
});
