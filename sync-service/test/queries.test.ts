import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, makeSession, makeBag, makePackConfig } from './helpers.js';
import type { Queries } from '../src/db/queries.js';
import type { ItemMaster } from '../src/types.js';

let queries: Queries;

beforeEach(() => {
  ({ queries } = createTestDb());
});

// ══════════════════════════════════════════════════════════════════════════════
// Session queries
// ══════════════════════════════════════════════════════════════════════════════

describe('Session queries', () => {
  it('insertSession + getSession roundtrip', () => {
    const session = makeSession({ session_id: 'sess-rt' });
    queries.insertSession(session);
    const got = queries.getSession('sess-rt');
    assert.ok(got);
    assert.equal(got.session_id, 'sess-rt');
    assert.equal(got.station_id, session.station_id);
    assert.equal(got.pack_name, session.pack_name);
    assert.equal(got.status, 'OPEN');
  });

  it('getSession returns undefined for unknown id', () => {
    const got = queries.getSession('nonexistent');
    assert.equal(got, undefined);
  });

  it('getOpenSession returns OPEN session for station', () => {
    const session = makeSession({ station_id: 'ST01', status: 'OPEN' });
    queries.insertSession(session);
    const got = queries.getOpenSession('ST01');
    assert.ok(got);
    assert.equal(got.session_id, session.session_id);
  });

  it('getOpenSession returns undefined when none open', () => {
    const session = makeSession({ station_id: 'ST01', status: 'CLOSED' });
    queries.insertSession(session);
    const got = queries.getOpenSession('ST01');
    assert.equal(got, undefined);
  });

  it('getOpenSession ignores other stations', () => {
    const session = makeSession({ station_id: 'ST02', status: 'OPEN' });
    queries.insertSession(session);
    const got = queries.getOpenSession('ST01');
    assert.equal(got, undefined);
  });

  it('updateSessionClosed sets status=CLOSED and closed_at', () => {
    const session = makeSession({ session_id: 'sess-close' });
    queries.insertSession(session);
    queries.updateSessionClosed('sess-close');
    const got = queries.getSession('sess-close')!;
    assert.equal(got.status, 'CLOSED');
    assert.ok(got.closed_at);
  });

  it('updateSessionSyncStatus increments sync_attempts', () => {
    const session = makeSession({ session_id: 'sess-sync' });
    queries.insertSession(session);
    queries.updateSessionSyncStatus('sess-sync', 'PENDING', 'test error');
    const got = queries.getSession('sess-sync')!;
    assert.equal(got.sync_attempts, 1);
    assert.equal(got.sync_error, 'test error');
  });

  it('updateSessionSynced sets doc_id, prod_no, sync_status=SYNCED', () => {
    const session = makeSession({ session_id: 'sess-synced' });
    queries.insertSession(session);
    queries.updateSessionSynced('sess-synced', 200, 'FGP-150426-05');
    const got = queries.getSession('sess-synced')!;
    assert.equal(got.sync_status, 'SYNCED');
    assert.equal(got.doc_id, 200);
    assert.equal(got.prod_no, 'FGP-150426-05');
    assert.equal(got.sync_error, null);
  });

  it('updateSessionOnline sets doc_id, prod_no, day_seq and clears offline', () => {
    const session = makeSession({ session_id: 'sess-online', is_offline: 1 });
    queries.insertSession(session);
    queries.updateSessionOnline('sess-online', 300, 'FGP-150426-06', 6);
    const got = queries.getSession('sess-online')!;
    assert.equal(got.doc_id, 300);
    assert.equal(got.prod_no, 'FGP-150426-06');
    assert.equal(got.day_seq, 6);
    assert.equal(got.is_offline, 0);
    assert.equal(got.sync_status, 'SYNCED');
  });

  it('listPendingSessions returns only PENDING sync_status, ordered by created_at', () => {
    const s1 = makeSession({ session_id: 'pend-1', sync_status: 'PENDING', created_at: '2026-04-15T01:00:00Z' });
    const s2 = makeSession({ session_id: 'pend-2', sync_status: 'PENDING', created_at: '2026-04-15T02:00:00Z' });
    const s3 = makeSession({ session_id: 'synced-1', sync_status: 'SYNCED', created_at: '2026-04-15T00:00:00Z' });
    queries.insertSession(s1);
    queries.insertSession(s2);
    queries.insertSession(s3);
    const pending = queries.listPendingSessions(10);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].session_id, 'pend-1');
    assert.equal(pending[1].session_id, 'pend-2');
  });

  it('countClosedSessionsToday filters by entry_date', () => {
    const s1 = makeSession({ session_id: 'today-1', entry_date: '2026-04-15', status: 'CLOSED' });
    const s2 = makeSession({ session_id: 'today-2', entry_date: '2026-04-15', status: 'CLOSED' });
    const s3 = makeSession({ session_id: 'yesterday', entry_date: '2026-04-14', status: 'CLOSED' });
    const s4 = makeSession({ session_id: 'today-open', entry_date: '2026-04-15', status: 'OPEN' });
    queries.insertSession(s1);
    queries.insertSession(s2);
    queries.insertSession(s3);
    queries.insertSession(s4);
    // Note: countClosedSessionsToday checks status='CLOSED' AND entry_date
    assert.equal(queries.countClosedSessionsToday('2026-04-15'), 2);
    assert.equal(queries.countClosedSessionsToday('2026-04-14'), 1);
    assert.equal(queries.countClosedSessionsToday('2026-04-13'), 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Bag queries
// ══════════════════════════════════════════════════════════════════════════════

describe('Bag queries', () => {
  const SESSION_ID = 'bag-test-session';

  beforeEach(() => {
    queries.insertSession(makeSession({ session_id: SESSION_ID }));
  });

  it('insertBag + getBagsBySession roundtrip', () => {
    const bag = makeBag(SESSION_ID, { bag_id: 'b1', qr_code: 'QR-RT-1' });
    queries.insertBag(bag);
    const bags = queries.getBagsBySession(SESSION_ID);
    assert.equal(bags.length, 1);
    assert.equal(bags[0].bag_id, 'b1');
    assert.equal(bags[0].qr_code, 'QR-RT-1');
  });

  it('getNextBagNumber returns 1 for empty session', () => {
    assert.equal(queries.getNextBagNumber(SESSION_ID), 1);
  });

  it('getNextBagNumber increments after inserts', () => {
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'bn1', bag_number: 1, qr_code: 'QR-BN-1' }));
    assert.equal(queries.getNextBagNumber(SESSION_ID), 2);
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'bn2', bag_number: 2, qr_code: 'QR-BN-2' }));
    assert.equal(queries.getNextBagNumber(SESSION_ID), 3);
  });

  it('insertBag rejects duplicate qr_code (UNIQUE constraint)', () => {
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'dup1', qr_code: 'QR-DUP' }));
    assert.throws(() => {
      queries.insertBag(makeBag(SESSION_ID, { bag_id: 'dup2', qr_code: 'QR-DUP' }));
    });
  });

  it('updateBagSynced sets synced=1 and line_id', () => {
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'sync-b1', qr_code: 'QR-SYNC-1', synced: 0 }));
    queries.updateBagSynced('sync-b1', 999);
    const bags = queries.getBagsBySession(SESSION_ID);
    assert.equal(bags[0].synced, 1);
    assert.equal(bags[0].line_id, 999);
  });

  it('getBagsBySession returns bags ordered by bag_number ASC', () => {
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'ord3', bag_number: 3, qr_code: 'QR-ORD-3' }));
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'ord1', bag_number: 1, qr_code: 'QR-ORD-1' }));
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'ord2', bag_number: 2, qr_code: 'QR-ORD-2' }));
    const bags = queries.getBagsBySession(SESSION_ID);
    assert.equal(bags[0].bag_number, 1);
    assert.equal(bags[1].bag_number, 2);
    assert.equal(bags[2].bag_number, 3);
  });

  it('countBagsToday counts across sessions for date', () => {
    const s2Id = 'bag-test-session-2';
    queries.insertSession(makeSession({ session_id: s2Id, entry_date: '2026-04-15' }));
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'ct1', qr_code: 'QR-CT-1' }));
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'ct2', qr_code: 'QR-CT-2' }));
    queries.insertBag(makeBag(s2Id, { bag_id: 'ct3', qr_code: 'QR-CT-3' }));
    assert.equal(queries.countBagsToday('2026-04-15'), 3);
    assert.equal(queries.countBagsToday('2026-04-14'), 0);
  });

  it('getSessionWithBags returns session + nested bags array', () => {
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'swb1', bag_number: 1, qr_code: 'QR-SWB-1' }));
    queries.insertBag(makeBag(SESSION_ID, { bag_id: 'swb2', bag_number: 2, qr_code: 'QR-SWB-2' }));
    const result = queries.getSessionWithBags(SESSION_ID);
    assert.ok(result);
    assert.equal(result.session_id, SESSION_ID);
    assert.equal(result.bags.length, 2);
    assert.equal(result.bags[0].bag_number, 1);
    assert.equal(result.bags[1].bag_number, 2);
  });

  it('getSessionWithBags returns undefined for unknown session', () => {
    assert.equal(queries.getSessionWithBags('nonexistent'), undefined);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Product / Master data queries
// ══════════════════════════════════════════════════════════════════════════════

describe('Product/Master queries', () => {
  it('replacePackConfigs clears and inserts', () => {
    const configs = [
      makePackConfig({ pack_id: 1, pack_name: 'Pack A' }),
      makePackConfig({ pack_id: 2, pack_name: 'Pack B' }),
    ];
    queries.replacePackConfigs(configs);
    const products = queries.getProducts();
    assert.equal(products.length, 2);

    // Replace with a single config — old ones should be gone
    queries.replacePackConfigs([makePackConfig({ pack_id: 3, pack_name: 'Pack C' })]);
    const products2 = queries.getProducts();
    assert.equal(products2.length, 1);
    assert.equal(products2[0].pack_id, 3);
  });

  it('replaceItemMasters clears and inserts', () => {
    const items: ItemMaster[] = [
      { item_id: 1, item_name: 'Item A', item_code: 'FG001', uom: 'PCS', category: 'FG' },
      { item_id: 2, item_name: 'Item B', item_code: 'FG002', uom: 'KG', category: 'FG' },
    ];
    queries.replaceItemMasters(items);

    // Replace with single item
    queries.replaceItemMasters([
      { item_id: 3, item_name: 'Item C', item_code: 'FG003', uom: 'PCS', category: 'FG' },
    ]);
    // We can't directly query item_master via queries, but it shouldn't throw
  });

  it('getProducts returns correct shape', () => {
    queries.replacePackConfigs([
      makePackConfig({ pack_id: 10, item_id: 1, pack_name: 'Test Pack 500g', net_weight_gm: 500, mrp: 50 }),
    ]);
    const products = queries.getProducts();
    assert.equal(products.length, 1);
    const p = products[0];
    assert.equal(p.pack_id, 10);
    assert.equal(p.item_id, 1);
    assert.equal(p.name, 'Test Pack 500g');
    assert.equal(p.pack_name, 'Test Pack 500g');
    assert.equal(p.net_weight_gm, 500);
    assert.equal(p.mrp, 50);
  });

  it('getProducts returns empty array when no configs', () => {
    const products = queries.getProducts();
    assert.equal(products.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Meta queries
// ══════════════════════════════════════════════════════════════════════════════

describe('Meta queries', () => {
  it('getMeta returns null for unknown key', () => {
    assert.equal(queries.getMeta('unknown_key'), null);
  });

  it('getMeta/setMeta roundtrip', () => {
    queries.setMeta('test_key', 'test_value');
    assert.equal(queries.getMeta('test_key'), 'test_value');
  });

  it('setMeta upserts on conflict', () => {
    queries.setMeta('key1', 'value1');
    queries.setMeta('key1', 'value2');
    assert.equal(queries.getMeta('key1'), 'value2');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Auto-session queries (v4 — bag-first multi-product)
// ══════════════════════════════════════════════════════════════════════════════

describe('findOpenSessionForPack', () => {
  it('returns matching OPEN session for station + pack + date', () => {
    const s = makeSession({ session_id: 'fop-1', station_id: 'ST01', pack_config_id: 10, entry_date: '2026-04-15', status: 'OPEN' });
    queries.insertSession(s);
    const got = queries.findOpenSessionForPack('ST01', 10, '2026-04-15');
    assert.ok(got);
    assert.equal(got.session_id, 'fop-1');
  });

  it('returns undefined when no match', () => {
    assert.equal(queries.findOpenSessionForPack('ST01', 10, '2026-04-15'), undefined);
  });

  it('ignores CLOSED sessions', () => {
    const s = makeSession({ session_id: 'fop-closed', station_id: 'ST01', pack_config_id: 10, entry_date: '2026-04-15', status: 'CLOSED' });
    queries.insertSession(s);
    assert.equal(queries.findOpenSessionForPack('ST01', 10, '2026-04-15'), undefined);
  });

  it('ignores different pack_config_id', () => {
    const s = makeSession({ session_id: 'fop-diff-pack', station_id: 'ST01', pack_config_id: 20, entry_date: '2026-04-15', status: 'OPEN' });
    queries.insertSession(s);
    assert.equal(queries.findOpenSessionForPack('ST01', 10, '2026-04-15'), undefined);
  });

  it('ignores different entry_date', () => {
    const s = makeSession({ session_id: 'fop-diff-date', station_id: 'ST01', pack_config_id: 10, entry_date: '2026-04-14', status: 'OPEN' });
    queries.insertSession(s);
    assert.equal(queries.findOpenSessionForPack('ST01', 10, '2026-04-15'), undefined);
  });

  it('ignores different station_id', () => {
    const s = makeSession({ session_id: 'fop-diff-st', station_id: 'ST02', pack_config_id: 10, entry_date: '2026-04-15', status: 'OPEN' });
    queries.insertSession(s);
    assert.equal(queries.findOpenSessionForPack('ST01', 10, '2026-04-15'), undefined);
  });
});

describe('getNextDaySeq', () => {
  it('returns 1 for first session of the day', () => {
    const seq = queries.getNextDaySeq('ST01', '2026-04-15');
    assert.equal(seq, 1);
  });

  it('increments on successive calls for same station+date', () => {
    const s1 = queries.getNextDaySeq('ST01', '2026-04-15');
    const s2 = queries.getNextDaySeq('ST01', '2026-04-15');
    const s3 = queries.getNextDaySeq('ST01', '2026-04-15');
    assert.equal(s1, 1);
    assert.equal(s2, 2);
    assert.equal(s3, 3);
  });

  it('resets for a different date', () => {
    queries.getNextDaySeq('ST01', '2026-04-15');
    queries.getNextDaySeq('ST01', '2026-04-15');
    const seq = queries.getNextDaySeq('ST01', '2026-04-16');
    assert.equal(seq, 1);
  });

  it('is independent per station', () => {
    queries.getNextDaySeq('ST01', '2026-04-15');
    queries.getNextDaySeq('ST01', '2026-04-15');
    const seq = queries.getNextDaySeq('ST02', '2026-04-15');
    assert.equal(seq, 1);
  });
});

describe('listOpenSessions', () => {
  it('returns all OPEN sessions for a station', () => {
    queries.insertSession(makeSession({ session_id: 'lo-1', station_id: 'ST01', status: 'OPEN', pack_config_id: 10 }));
    queries.insertSession(makeSession({ session_id: 'lo-2', station_id: 'ST01', status: 'OPEN', pack_config_id: 20 }));
    queries.insertSession(makeSession({ session_id: 'lo-3', station_id: 'ST01', status: 'CLOSED', pack_config_id: 30 }));
    const result = queries.listOpenSessions('ST01');
    assert.equal(result.length, 2);
  });

  it('returns empty array when no open sessions', () => {
    assert.equal(queries.listOpenSessions('ST01').length, 0);
  });

  it('ignores other stations', () => {
    queries.insertSession(makeSession({ session_id: 'lo-other', station_id: 'ST02', status: 'OPEN' }));
    assert.equal(queries.listOpenSessions('ST01').length, 0);
  });
});

describe('listStaleOpenSessions', () => {
  it('returns OPEN sessions with entry_date before today', () => {
    queries.insertSession(makeSession({ session_id: 'stale-1', station_id: 'ST01', entry_date: '2026-04-14', status: 'OPEN' }));
    queries.insertSession(makeSession({ session_id: 'stale-2', station_id: 'ST01', entry_date: '2026-04-13', status: 'OPEN' }));
    queries.insertSession(makeSession({ session_id: 'fresh', station_id: 'ST01', entry_date: '2026-04-15', status: 'OPEN' }));
    const stale = queries.listStaleOpenSessions('ST01', '2026-04-15');
    assert.equal(stale.length, 2);
  });

  it('ignores CLOSED sessions even if stale', () => {
    queries.insertSession(makeSession({ session_id: 'stale-closed', station_id: 'ST01', entry_date: '2026-04-14', status: 'CLOSED' }));
    assert.equal(queries.listStaleOpenSessions('ST01', '2026-04-15').length, 0);
  });

  it('returns empty when all sessions are from today', () => {
    queries.insertSession(makeSession({ session_id: 'today-1', station_id: 'ST01', entry_date: '2026-04-15', status: 'OPEN' }));
    assert.equal(queries.listStaleOpenSessions('ST01', '2026-04-15').length, 0);
  });
});

describe('closeStaleSessionsForDate', () => {
  it('closes all OPEN sessions before today and marks PENDING', () => {
    queries.insertSession(makeSession({ session_id: 'cs-1', station_id: 'ST01', entry_date: '2026-04-14', status: 'OPEN', sync_status: 'LOCAL' }));
    queries.insertSession(makeSession({ session_id: 'cs-2', station_id: 'ST01', entry_date: '2026-04-13', status: 'OPEN', sync_status: 'LOCAL' }));
    queries.insertSession(makeSession({ session_id: 'cs-today', station_id: 'ST01', entry_date: '2026-04-15', status: 'OPEN', sync_status: 'LOCAL' }));

    const changed = queries.closeStaleSessionsForDate('ST01', '2026-04-15');
    assert.equal(changed, 2);

    const s1 = queries.getSession('cs-1')!;
    assert.equal(s1.status, 'CLOSED');
    assert.equal(s1.sync_status, 'PENDING');
    assert.ok(s1.closed_at);

    // Today's session untouched
    const today = queries.getSession('cs-today')!;
    assert.equal(today.status, 'OPEN');
    assert.equal(today.sync_status, 'LOCAL');
  });

  it('returns 0 when nothing to close', () => {
    assert.equal(queries.closeStaleSessionsForDate('ST01', '2026-04-15'), 0);
  });
});

describe('closeAndMarkPending', () => {
  it('closes session and sets sync_status to PENDING atomically', () => {
    queries.insertSession(makeSession({ session_id: 'camp-1', status: 'OPEN', sync_status: 'LOCAL' }));
    queries.closeAndMarkPending('camp-1');
    const got = queries.getSession('camp-1')!;
    assert.equal(got.status, 'CLOSED');
    assert.equal(got.sync_status, 'PENDING');
    assert.ok(got.closed_at);
  });
});

describe('getBagsSummaryToday', () => {
  it('returns grouped counts per product for a date', () => {
    queries.insertSession(makeSession({ session_id: 'sum-1', station_id: 'ST01', entry_date: '2026-04-15', pack_config_id: 10, pack_name: 'Pack A' }));
    queries.insertSession(makeSession({ session_id: 'sum-2', station_id: 'ST01', entry_date: '2026-04-15', pack_config_id: 20, pack_name: 'Pack B' }));

    queries.insertBag(makeBag('sum-1', { bag_id: 'sb-1', qr_code: 'QR-SUM-1', bag_number: 1 }));
    queries.insertBag(makeBag('sum-1', { bag_id: 'sb-2', qr_code: 'QR-SUM-2', bag_number: 2 }));
    queries.insertBag(makeBag('sum-2', { bag_id: 'sb-3', qr_code: 'QR-SUM-3', bag_number: 1 }));

    const summary = queries.getBagsSummaryToday('ST01', '2026-04-15');
    assert.equal(summary.length, 2);

    const a = summary.find(s => s.pack_config_id === 10);
    const b = summary.find(s => s.pack_config_id === 20);
    assert.ok(a);
    assert.equal(a.count, 2);
    assert.equal(a.pack_name, 'Pack A');
    assert.ok(b);
    assert.equal(b.count, 1);
  });

  it('returns empty array when no bags exist', () => {
    const summary = queries.getBagsSummaryToday('ST01', '2026-04-15');
    assert.equal(summary.length, 0);
  });

  it('ignores bags from other dates', () => {
    queries.insertSession(makeSession({ session_id: 'sum-old', station_id: 'ST01', entry_date: '2026-04-14', pack_config_id: 10, pack_name: 'Pack A' }));
    queries.insertBag(makeBag('sum-old', { bag_id: 'sb-old', qr_code: 'QR-SUM-OLD', bag_number: 1 }));
    const summary = queries.getBagsSummaryToday('ST01', '2026-04-15');
    assert.equal(summary.length, 0);
  });

  it('ignores bags from other stations', () => {
    queries.insertSession(makeSession({ session_id: 'sum-st2', station_id: 'ST02', entry_date: '2026-04-15', pack_config_id: 10, pack_name: 'Pack A' }));
    queries.insertBag(makeBag('sum-st2', { bag_id: 'sb-st2', qr_code: 'QR-SUM-ST2', bag_number: 1 }));
    const summary = queries.getBagsSummaryToday('ST01', '2026-04-15');
    assert.equal(summary.length, 0);
  });
});
