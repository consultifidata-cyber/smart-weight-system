import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { Queries } from '../src/db/queries.js';
import { createServer } from '../src/api/server.js';
import { SyncEngine } from '../src/sync/engine.js';
import type { FGSession, FGBag, FGPackConfig, ItemMaster } from '../src/types.js';
import type { SyncServiceConfig } from '../src/config.js';
import type express from 'express';

// ── In-memory database ─────────────────────────────────────────────

export function createTestDb(): { db: Database.Database; queries: Queries } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return { db, queries: new Queries(db) };
}

// ── Mock DjangoClient ──────────────────────────────────────────────

export class MockDjangoClient {
  isConfigured = true;

  // Configurable responses
  openSessionResponse = {
    doc_id: 100,
    prod_no: 'FGP-150426-03',
    day_seq: 3,
    entry_date: '2026-04-15',
    pack_name: 'Test Pack 500g',
  };

  addBagResponse = {
    line_id: 200,
    qr_code: 'TESTP-150426-03-001',
    bag_number: 1,
    total_bags: 1,
  };

  closeSessionResponse = {
    prod_no: 'FGP-150426-03',
    total_bags: 3,
    doc_status: 'POSTED',
    verification_status: 'VERIFIED',
  };

  pushEntryResult = {
    success: true as boolean,
    server_prod_no: 'FGP-150426-03',
    server_doc_id: 100,
    retryable: undefined as boolean | undefined,
    error: undefined as string | undefined,
  };

  masterConfigs: FGPackConfig[] = [];
  masterItems: ItemMaster[] = [];

  // Track calls
  calls: { method: string; args: unknown[] }[] = [];

  // Control failures
  shouldFail = false;
  failError = 'Mock error';

  async healthCheck(): Promise<boolean> {
    this.calls.push({ method: 'healthCheck', args: [] });
    return !this.shouldFail;
  }

  async fetchPackConfigs(): Promise<FGPackConfig[]> {
    this.calls.push({ method: 'fetchPackConfigs', args: [] });
    if (this.shouldFail) throw new Error(this.failError);
    return this.masterConfigs;
  }

  async fetchItemMasters(): Promise<ItemMaster[]> {
    this.calls.push({ method: 'fetchItemMasters', args: [] });
    if (this.shouldFail) throw new Error(this.failError);
    return this.masterItems;
  }

  async openSession(data: unknown) {
    this.calls.push({ method: 'openSession', args: [data] });
    if (this.shouldFail) throw new Error(this.failError);
    return this.openSessionResponse;
  }

  async addBag(data: unknown) {
    this.calls.push({ method: 'addBag', args: [data] });
    if (this.shouldFail) throw new Error(this.failError);
    return this.addBagResponse;
  }

  async closeSession(docId: number) {
    this.calls.push({ method: 'closeSession', args: [docId] });
    if (this.shouldFail) throw new Error(this.failError);
    return this.closeSessionResponse;
  }

  async pushEntry(data: unknown) {
    this.calls.push({ method: 'pushEntry', args: [data] });
    return this.pushEntryResult;
  }
}

// ── Test config ────────────────────────────────────────────────────

export const testConfig: SyncServiceConfig = {
  stationId: 'ST01',
  plantId: 'BNJRS10',
  apiPort: 0,
  logLevel: 'silent',
  dbPath: ':memory:',
  djangoServerUrl: 'http://localhost:8000',
  djangoApiToken: 'test-token',
  syncRetryIntervalMs: 1000,
  masterSyncIntervalMs: 60000,
  syncPushTimeoutMs: 5000,
  offlineDaySeqStart: 90,
  offlineDaySeqEnd: 99,
};

// ── App factory ────────────────────────────────────────────────────

export function createTestApp(options?: {
  client?: MockDjangoClient;
  queries?: Queries;
}): { app: express.Express; queries: Queries; client: MockDjangoClient; syncEngine: SyncEngine } {
  const { db, queries } = options?.queries
    ? { db: null, queries: options.queries }
    : createTestDb();
  const client = options?.client || new MockDjangoClient();

  const syncEngine = new SyncEngine(queries, client as any, testConfig as any);
  const pullMasterData = async () => ({ products: 0, items: 0 });
  const app = createServer(queries, testConfig, undefined, pullMasterData, client as any, syncEngine);

  return { app, queries, client, syncEngine };
}

// ── Data factories ─────────────────────────────────────────────────

let _sessionCounter = 0;

export function makeSession(overrides?: Partial<FGSession>): FGSession {
  _sessionCounter++;
  return {
    session_id: `sess-${_sessionCounter}`,
    doc_id: null,
    prod_no: null,
    day_seq: 1,
    station_id: 'ST01',
    plant_id: 'BNJRS10',
    entry_date: '2026-04-15',
    shift: null,
    item_id: 1,
    pack_config_id: 10,
    pack_name: 'Test Pack 500g',
    status: 'OPEN',
    is_offline: 1,
    idempotency_key: `key-${_sessionCounter}`,
    created_at: new Date().toISOString(),
    closed_at: null,
    sync_status: 'PENDING',
    sync_attempts: 0,
    sync_error: null,
    last_sync_at: null,
    ...overrides,
  };
}

let _bagCounter = 0;

export function makeBag(sessionId: string, overrides?: Partial<FGBag>): FGBag {
  _bagCounter++;
  return {
    bag_id: `bag-${_bagCounter}`,
    session_id: sessionId,
    bag_number: _bagCounter,
    item_id: 1,
    pack_config_id: 10,
    offer_id: null,
    actual_weight_gm: 500,
    qr_code: `QR-${_bagCounter}`,
    batch_no: null,
    note: null,
    line_id: null,
    synced: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function makePackConfig(overrides?: Partial<FGPackConfig>): FGPackConfig {
  return {
    pack_id: 10,
    item_id: 1,
    pack_name: 'Test Pack 500g',
    net_weight_gm: 500,
    pcs_per_bag: 1,
    bag_type: 'POUCH',
    mrp: 50,
    ptr: null,
    ptd: null,
    ...overrides,
  };
}
