import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdempotencyKey,
  generateSessionIdempotencyKey,
} from '../src/sync/idempotency.js';

// ── generateIdempotencyKey ─────────────────────────────────────────

describe('generateIdempotencyKey', () => {
  const baseFields = {
    station_id: 'ST01',
    plant_id: 'BNJRS10',
    entry_date: '2026-04-15',
    item_id: '1',
    pack_config_id: '10',
    num_bags: 5,
    created_at: '2026-04-15T10:00:00Z',
  };

  it('returns a SHA256 hex string (64 chars)', () => {
    const key = generateIdempotencyKey(baseFields);
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same key', () => {
    const key1 = generateIdempotencyKey(baseFields);
    const key2 = generateIdempotencyKey({ ...baseFields });
    assert.equal(key1, key2);
  });

  it('different inputs produce different keys', () => {
    const key1 = generateIdempotencyKey(baseFields);
    const key2 = generateIdempotencyKey({ ...baseFields, station_id: 'ST02' });
    assert.notEqual(key1, key2);
  });

  it('changes when num_bags differs', () => {
    const key1 = generateIdempotencyKey(baseFields);
    const key2 = generateIdempotencyKey({ ...baseFields, num_bags: 10 });
    assert.notEqual(key1, key2);
  });

  it('changes when entry_date differs', () => {
    const key1 = generateIdempotencyKey(baseFields);
    const key2 = generateIdempotencyKey({ ...baseFields, entry_date: '2026-04-16' });
    assert.notEqual(key1, key2);
  });
});

// ── generateSessionIdempotencyKey ──────────────────────────────────

describe('generateSessionIdempotencyKey', () => {
  it('returns a 64-char hex string', () => {
    const key = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-1');
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same key', () => {
    const key1 = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-1');
    const key2 = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-1');
    assert.equal(key1, key2);
  });

  it('different station produces different key', () => {
    const key1 = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-1');
    const key2 = generateSessionIdempotencyKey('ST02', '2026-04-15', 'sess-1');
    assert.notEqual(key1, key2);
  });

  it('different sessionId produces different key', () => {
    const key1 = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-1');
    const key2 = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-2');
    assert.notEqual(key1, key2);
  });

  it('different date produces different key', () => {
    const key1 = generateSessionIdempotencyKey('ST01', '2026-04-15', 'sess-1');
    const key2 = generateSessionIdempotencyKey('ST01', '2026-04-16', 'sess-1');
    assert.notEqual(key1, key2);
  });
});
