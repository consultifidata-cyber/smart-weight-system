import type { WeightReading } from '../types.js';

/**
 * Parses raw ASCII weight lines from the Essae DS-252 weighing scale.
 *
 * Supported formats:
 *   "+025.450"              — simple signed value
 *   "+025.450 kg"           — with unit
 *   "ST,+025.450, kg"       — with stability prefix (ST=stable, US=unstable)
 *   "  +025.450 kg  "       — with leading/trailing whitespace
 *   "OL" / "OVER"           — overload
 */

const WEIGHT_REGEX = /(?:(?<status>ST|US|OL|NT),?\s*)?(?<sign>[+-])?\s*(?<value>\d+\.?\d*)\s*(?<unit>kg|g|lb|oz)?/i;
const OVERLOAD_REGEX = /\b(OL|OVER)\b/i;

export function parse(rawLine: string | null | undefined): WeightReading | null {
  if (!rawLine || typeof rawLine !== 'string') return null;

  const trimmed = rawLine.replace(/[\x00-\x08\x0E-\x1F]/g, '').trim();
  if (!trimmed) return null;

  // Check overload first
  if (OVERLOAD_REGEX.test(trimmed)) {
    return {
      raw: trimmed,
      weight: null,
      sign: null,
      unit: null,
      scaleStable: null,
      overload: true,
      timestamp: new Date().toISOString(),
    };
  }

  const match = trimmed.match(WEIGHT_REGEX);
  if (!match || !match.groups || match.groups.value === undefined) return null;

  const sign = match.groups.sign || '+';
  const value = parseFloat(match.groups.value);
  if (isNaN(value)) return null;

  const weight = sign === '-' ? -value : value;
  const unit = (match.groups.unit || 'kg').toLowerCase();

  let scaleStable: boolean | null = null;
  if (match.groups.status) {
    const s = match.groups.status.toUpperCase();
    if (s === 'ST') scaleStable = true;
    else if (s === 'US') scaleStable = false;
  }

  return {
    raw: trimmed,
    weight,
    sign,
    unit,
    scaleStable,
    overload: false,
    timestamp: new Date().toISOString(),
  };
}
