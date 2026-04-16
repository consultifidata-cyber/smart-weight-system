/**
 * QR code generation — exact port of Django's erp_core/services/qr_opening.py
 *
 * _sku_prefix() → skuPrefix()
 * _opnfg_qr_code() → generateQrCode()
 *
 * These MUST produce identical output to the Python originals so that
 * locally-printed QR labels match what Django expects.
 */

/**
 * First 3 + last 4 alphanumeric chars of name (uppercase, 7 chars max).
 *
 * Examples:
 *   "Naylon sev 200 Rs 56 - 50pcs" → "NAY0PCS"
 *   "Rice" → "RICE"
 *   "" → "FG"
 */
export function skuPrefix(name: string): string {
  const clean = (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return 'FG';
  if (clean.length <= 7) return clean;
  return clean.slice(0, 3) + clean.slice(-4);
}

/**
 * Generate FG production QR code.
 *
 * Format: <PREFIX7>-<DDMMYY>-<DaySeq02d>-<BagNo03d>
 * Example: NAY0PCS-150426-03-001
 *
 * @param packName  - FGPackConfig.pack_name (used for SKU prefix)
 * @param entryDate - YYYY-MM-DD string
 * @param daySeq    - day sequence number from open-session
 * @param bagNumber - 1-based bag number within this session
 */
export function generateQrCode(
  packName: string,
  entryDate: string,
  daySeq: number,
  bagNumber: number,
): string {
  const prefix = skuPrefix(packName);

  // Convert YYYY-MM-DD to DDMMYY
  const parts = entryDate.split('-');
  const dateStr = parts.length === 3
    ? `${parts[2]}${parts[1]}${parts[0].slice(2)}`
    : new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '');

  const seqStr = String(daySeq || 1).padStart(2, '0');
  const bagStr = String(bagNumber).padStart(3, '0');

  return `${prefix}-${dateStr}-${seqStr}-${bagStr}`;
}
