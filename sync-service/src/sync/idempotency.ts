import { createHash } from 'crypto';

/** Legacy idempotency key for bulk FGEntry (kept for backward compat). */
export function generateIdempotencyKey(fields: {
  station_id: string;
  plant_id: string;
  entry_date: string;
  item_id: string;
  pack_config_id: string;
  num_bags: number;
  created_at: string;
}): string {
  const canonical = [
    fields.station_id,
    fields.plant_id,
    fields.entry_date,
    fields.item_id,
    fields.pack_config_id,
    String(fields.num_bags),
    fields.created_at,
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex');
}

/** Session-level idempotency key for push-entry (offline catch-up). */
export function generateSessionIdempotencyKey(
  stationId: string,
  entryDate: string,
  sessionId: string,
): string {
  const canonical = [stationId, entryDate, sessionId].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 64);
}
