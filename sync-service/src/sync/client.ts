import logger from '../utils/logger.js';
import type {
  FGPackConfig,
  ItemMaster,
  SyncResult,
  OpenSessionResponse,
  AddBagResponse,
  CloseSessionResponse,
  PushEntryResponse,
} from '../types.js';

/**
 * Client for Django Station API (/api/station/*).
 *
 * Auth: sends Authorization: Token <token> which is checked by
 * Django's @station_token_required decorator against the WeighStation table.
 */
export class DjangoClient {
  private serverUrl: string;
  private apiToken: string;
  private timeoutMs: number;

  constructor(serverUrl: string, apiToken: string, timeoutMs: number = 10000) {
    this.serverUrl = serverUrl;
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
  }

  get isConfigured(): boolean {
    return !!this.serverUrl;
  }

  private get authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Token ${this.apiToken}`,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Health check (unauthenticated)
  // ════════════════════════════════════════════════════════════════════════

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured) return false;

    try {
      const response = await fetch(`${this.serverUrl}/api/station/health/`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Master data pull
  // ════════════════════════════════════════════════════════════════════════

  async fetchPackConfigs(): Promise<FGPackConfig[]> {
    if (!this.isConfigured) return [];

    const response = await fetch(`${this.serverUrl}/api/station/pack-configs/`, {
      headers: this.authHeaders,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch pack configs: ${response.status}`);
    }

    const data = await response.json() as { configs: FGPackConfig[] };
    return data.configs;
  }

  async fetchItemMasters(): Promise<ItemMaster[]> {
    if (!this.isConfigured) return [];

    const response = await fetch(`${this.serverUrl}/api/station/item-masters/`, {
      headers: this.authHeaders,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch item masters: ${response.status}`);
    }

    const data = await response.json() as { items: ItemMaster[] };
    return data.items;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Session lifecycle
  // ════════════════════════════════════════════════════════════════════════

  async openSession(data: {
    item_id: number;
    pack_config_id: number;
    entry_date?: string;
    shift?: string | null;
  }): Promise<OpenSessionResponse> {
    const response = await fetch(`${this.serverUrl}/api/station/open-session/`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`open-session failed: ${response.status} ${body}`);
    }

    return response.json() as Promise<OpenSessionResponse>;
  }

  async addBag(data: {
    doc_id: number;
    item_id: number;
    pack_config_id: number;
    qr_code: string;
    actual_weight_gm: number | null;
    offer_id?: number | null;
    batch_no?: string | null;
    note?: string | null;
  }): Promise<AddBagResponse> {
    const response = await fetch(`${this.serverUrl}/api/station/add-bag/`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`add-bag failed: ${response.status} ${body}`);
    }

    return response.json() as Promise<AddBagResponse>;
  }

  async closeSession(docId: number): Promise<CloseSessionResponse> {
    const response = await fetch(`${this.serverUrl}/api/station/close-session/`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({ doc_id: docId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`close-session failed: ${response.status} ${body}`);
    }

    return response.json() as Promise<CloseSessionResponse>;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Offline catch-up (bulk push)
  // ════════════════════════════════════════════════════════════════════════

  async pushEntry(data: {
    idempotency_key: string;
    entry_date: string;
    shift?: string | null;
    bags: Array<{
      item_id: number;
      pack_config_id: number;
      offer_id?: number | null;
      actual_weight_gm: number | null;
      qr_code: string;
      batch_no?: string | null;
      note?: string | null;
    }>;
  }): Promise<SyncResult> {
    if (!this.isConfigured) {
      return { success: false, retryable: true, error: 'Django server URL not configured' };
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/station/push-entry/`, {
        method: 'POST',
        headers: this.authHeaders,
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        const result = await response.json() as PushEntryResponse;
        logger.info({ prod_no: result.prod_no, total_bags: result.total_bags }, 'Entry pushed to Django');
        return {
          success: true,
          server_prod_no: result.prod_no,
          server_doc_id: result.doc_id,
        };
      }

      const errorBody = await response.text().catch(() => '');

      if (response.status >= 400 && response.status < 500) {
        return { success: false, retryable: false, error: `${response.status}: ${errorBody}` };
      }

      return { success: false, retryable: true, error: `Server error ${response.status}: ${errorBody}` };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ error }, 'Push entry failed (network)');
      return { success: false, retryable: true, error };
    }
  }
}
