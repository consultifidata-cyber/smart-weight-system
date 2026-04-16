// ── Sync status lifecycle ──
// LOCAL  = created locally, no Django doc yet
// ONLINE = open on both SQLite and Django (doc_id set, bags syncing individually)
// PENDING = closed locally, waiting to push to Django
// SYNCING = push in progress
// SYNCED  = fully pushed and confirmed by Django
// FAILED  = non-retryable push failure
export type SyncStatus = 'LOCAL' | 'ONLINE' | 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';

// ── Session status lifecycle (bag-by-bag) ──
export type SessionStatus = 'OPEN' | 'CLOSED';

// ══════════════════════════════════════════════════════════════════════════════
// Legacy FG Entry types (kept for backward compat with existing data)
// ══════════════════════════════════════════════════════════════════════════════

export interface FGEntry {
  local_entry_id: string;
  station_id: string;
  plant_id: number;
  entry_date: string;       // YYYY-MM-DD
  shift: string | null;
  production_run_id: number | null;
  created_by: string;
  created_at: string;       // ISO 8601
  idempotency_key: string;
  sync_status: SyncStatus;
  sync_attempts: number;
  last_sync_error: string | null;
  last_sync_at: string | null;
  server_prod_no: string | null;
  server_doc_id: number | null;
}

export interface FGEntryLine {
  id?: number;
  local_entry_id: string;
  item_id: number;
  pack_config_id: number;
  offer_id: number | null;
  num_bags: number;
  base_uom: string;
  batch_no: string | null;
  note: string | null;
}

export interface FGEntryWithLines extends FGEntry {
  lines: FGEntryLine[];
}

export interface CreateEntryRequest {
  station_id: string;
  plant_id: number;
  entry_date: string;
  shift?: string | null;
  production_run_id?: number | null;
  created_by?: string;
  item_id: number;
  pack_config_id: number;
  offer_id?: number | null;
  num_bags: number;
  base_uom?: string;
  batch_no?: string | null;
  weight: number;
  note?: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Session flow types (bag-by-bag)
// ══════════════════════════════════════════════════════════════════════════════

export interface FGSession {
  session_id: string;
  doc_id: number | null;           // Django FGProductionDoc.pk (null if offline)
  prod_no: string | null;          // e.g. "FGP-150426-03" (null if offline)
  day_seq: number;                 // from Django open-session or offline range
  station_id: string;
  plant_id: string;
  entry_date: string;              // YYYY-MM-DD
  shift: string | null;
  item_id: number;
  pack_config_id: number;
  pack_name: string;
  status: SessionStatus;
  is_offline: number;              // 0 or 1 (SQLite boolean)
  idempotency_key: string | null;
  created_at: string;
  closed_at: string | null;
  sync_status: SyncStatus;
  sync_attempts: number;
  sync_error: string | null;
  last_sync_at: string | null;
}

export interface FGBag {
  bag_id: string;
  session_id: string;
  bag_number: number;
  item_id: number;
  pack_config_id: number;
  offer_id: number | null;
  actual_weight_gm: number | null;
  qr_code: string;
  batch_no: string | null;
  note: string | null;
  line_id: number | null;          // Django FGProductionLine.pk (null if offline)
  synced: number;                  // 0 or 1 (SQLite boolean)
  created_at: string;
}

export interface FGSessionWithBags extends FGSession {
  bags: FGBag[];
}

// ── Django Station API response types ──

export interface OpenSessionResponse {
  status: string;
  doc_id: number;
  prod_no: string;
  day_seq: number;
  entry_date: string;
  pack_name: string;
}

export interface AddBagResponse {
  status: string;
  line_id: number;
  qr_code: string;
  bag_number: number;
  total_bags: number;
  idempotent?: boolean;
}

export interface CloseSessionResponse {
  status: string;
  doc_id: number;
  prod_no: string;
  total_bags: number;
  doc_status: string;
  verification_status: string;
  posted_at: string | null;
}

export interface PushEntryResponse {
  status: string;
  doc_id: number;
  prod_no: string;
  total_bags: number;
  idempotent?: boolean;
  doc_status?: string;
  verification_status?: string;
  posted_at?: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Master data
// ══════════════════════════════════════════════════════════════════════════════

export interface FGPackConfig {
  pack_id: number;
  item_id: number;
  pack_name: string;
  net_weight_gm: number | null;
  pcs_per_bag: number | null;
  bag_type: string | null;
  mrp: number | null;
  ptr: number | null;
  ptd: number | null;
  updated_at?: string;
}

export interface ItemMaster {
  item_id: number;
  item_name: string;
  item_code: string | null;
  uom: string | null;
  category: string | null;
  updated_at?: string;
}

export interface ProductForDropdown {
  pack_id: number;
  item_id: number;
  name: string;
  pack_name: string;
  net_weight_gm: number | null;
  pcs_per_bag: number | null;
  bag_type: string | null;
  mrp: number | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Sync results
// ══════════════════════════════════════════════════════════════════════════════

export interface SyncResult {
  success: boolean;
  retryable?: boolean;
  server_prod_no?: string;
  server_doc_id?: number;
  error?: string;
}

export interface SyncStatusResponse {
  server_reachable: boolean;
  pending_entries: number;
  failed_entries: number;
  synced_today: number;
  last_sync_at: string | null;
  last_master_sync_at: string | null;
  pending_sessions: number;
  closed_sessions_today: number;
  total_bags_today: number;
}
