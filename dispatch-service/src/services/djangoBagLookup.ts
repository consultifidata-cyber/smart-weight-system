/**
 * Multi-station bag lookup via Django.
 *
 * Feature flag: DISPATCH_USE_DJANGO_LOOKUP=true (default: false / off)
 *
 * When OFF  → returns null immediately, no network call. Local SQLite
 *             fallback is used by the caller. This is the safe default.
 *
 * When ON   → GET ${DJANGO_SERVER_URL}/api/bags/<qr_code>/ with a 3s
 *             timeout. If Django has the bag (any station), returns the
 *             bag details. On any failure (timeout, 5xx, network error),
 *             returns null and the caller falls back to local SQLite.
 *             404 → returns null (bag not synced yet or invalid QR).
 *
 * Offline safety: every error path returns null — caller always falls
 * back to local SQLite. This function NEVER throws.
 *
 * Log rate-limit: warning about unavailability is emitted at most once
 * per 60 seconds to avoid spam during prolonged outages.
 */

import logger from '../utils/logger.js';

// ── Type returned to the scan handler ────────────────────────────────────────
// Mirrors FgBagRow from db/queries.ts but bag_id is nullable
// (local UUID does not exist for bags packed on another station).
export interface BagLookupResult {
  bag_id:           string | null;
  actual_weight_gm: number | null;
  pack_config_id:   number;
  item_id:          number;
  pack_name:        string | null;
  qr_code:          string;
  /** 'local' = came from local SQLite; 'django' = came from Django API */
  lookup_source:    'local' | 'django';
}

// ── Django response shape ─────────────────────────────────────────────────────
interface DjangoBAGResponse {
  qr_code:       string;
  found:         boolean;
  station_id?:   string;
  shift?:        string | null;
  pack_name?:    string | null;
  pack_id?:      number | null;   // = pack_config_id
  item_id?:      number | null;
  weight_kg?:    string | null;
  worker_code_1?: string | null;
  worker_code_2?: string | null;
  printed_at?:   string | null;
}

// ── Rate-limited warning ──────────────────────────────────────────────────────
let _lastWarnAt = 0;
function warnOnce(msg: string): void {
  if (Date.now() - _lastWarnAt >= 60_000) {
    logger.warn(msg);
    _lastWarnAt = Date.now();
  }
}

// ── Feature flag helper ───────────────────────────────────────────────────────
function isFlagEnabled(): boolean {
  return (process.env.DISPATCH_USE_DJANGO_LOOKUP ?? '').trim().toLowerCase() === 'true';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Try to look up a bag by QR code in Django.
 *
 * Returns BagLookupResult on success, null on any failure or when the
 * feature flag is off. NEVER throws.
 */
export async function lookupBagInDjango(
  qrCode: string,
): Promise<BagLookupResult | null> {
  if (!isFlagEnabled()) return null;

  const serverUrl = (process.env.DJANGO_SERVER_URL ?? '').trim().replace(/\/$/, '');
  const token     = (process.env.DJANGO_API_TOKEN  ?? '').trim();

  if (!serverUrl || !token) {
    warnOnce('[dispatch] DISPATCH_USE_DJANGO_LOOKUP=true but DJANGO_SERVER_URL or DJANGO_API_TOKEN not set — using local fallback');
    return null;
  }

  const url = `${serverUrl}/api/bags/${encodeURIComponent(qrCode)}/`;

  try {
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), 3_000);

    const res = await fetch(url, {
      headers: { 'Authorization': `Token ${token}` },
      signal:  controller.signal,
    }).finally(() => clearTimeout(timerId));

    if (res.status === 404) {
      // Bag not in Django yet (not synced, or truly invalid QR)
      return null;
    }

    if (!res.ok) {
      warnOnce(`[dispatch] Django bag lookup returned ${res.status} — using local fallback`);
      return null;
    }

    const body = await res.json() as DjangoBAGResponse;

    if (!body.found) return null;

    const weightGm = body.weight_kg
      ? Math.round(parseFloat(body.weight_kg) * 1000)
      : null;

    return {
      bag_id:           null,                      // no local UUID for cross-station bags
      actual_weight_gm: isNaN(weightGm ?? NaN) ? null : weightGm,
      pack_config_id:   body.pack_id   ?? 0,
      item_id:          body.item_id   ?? 0,
      pack_name:        body.pack_name ?? null,
      qr_code:          body.qr_code,
      lookup_source:    'django',
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('AbortError') || msg.includes('abort') || msg.includes('signal');
    warnOnce(
      isTimeout
        ? '[dispatch] Django bag lookup timed out (3s) — using local fallback'
        : `[dispatch] Django bag lookup unavailable — using local fallback (${msg})`,
    );
    return null;
  }
}
