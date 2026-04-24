/**
 * Scale / Weighing Machine Auto-Detection — Phase 3
 *
 * Lists all serial ports and ranks candidates by likelihood of being a
 * USB-to-serial adapter connected to a weighing scale.
 *
 * Detection is additive — it never alters the active WeightReader connection.
 * The result is used at startup (when SCALE_AUTO_DETECT=true and no explicit
 * SERIAL_PORT is set) and is exposed via GET /hardware/scales.
 *
 * The existing WeightReader._autoDetectPort() continues to operate unchanged
 * as a runtime fallback after 3 port-open failures.
 *
 * Confidence levels:
 *   HIGH   — USB Vendor ID matched to a known USB-serial bridge chip.
 *   MEDIUM — Manufacturer string or friendly name matched a known pattern.
 *   LOW    — PnP ID contains 'USB\VID' but no specific chip identified.
 */

import { SerialPort } from 'serialport';
import logger from '../utils/logger.js';

// ── Public types ──────────────────────────────────────────────────────────────

export type ScaleConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DetectedScale {
  /** OS serial port path, e.g. 'COM3' or '/dev/ttyUSB0' */
  path: string;
  /** Driver or OS-reported manufacturer string */
  manufacturer: string | null;
  /** USB serial number (often absent for clone chips) */
  serialNumber: string | null;
  /** USB Vendor ID — uppercase hex, e.g. '1A86' */
  vendorId: string | null;
  /** USB Product ID — uppercase hex */
  productId: string | null;
  /** Windows PnP ID, e.g. 'USB\\VID_1A86&PID_7523\\...' */
  pnpId: string | null;
  /** OS friendly name, e.g. 'USB-SERIAL CH340 (COM3)' */
  friendlyName: string | null;
  /** Confidence that this is a USB-serial adapter connected to a scale */
  confidence: ScaleConfidence;
  /** Human-readable explanation of the confidence rating */
  reason: string;
}

export interface ScaleDetectionResult {
  /** All candidates ranked HIGH → MEDIUM → LOW */
  ports: DetectedScale[];
  /** Auto-selected best candidate, or null */
  selected: DetectedScale | null;
  /** Why this port was selected */
  selectionReason: string;
  /** Total serial ports found on the system (including non-USB) */
  totalPortCount: number;
  /** ISO timestamp of last detection run */
  detectedAt: string;
}

// ── Known USB-serial VID table ────────────────────────────────────────────────
// Key: uppercase hex VID.  Most weighing scales use one of these bridge chips.

const VID_TABLE: Readonly<Record<string, { chip: string; confidence: ScaleConfidence }>> = {
  '1A86': { chip: 'WCH CH340/CH341',                confidence: 'HIGH' },
  '0403': { chip: 'FTDI FT232/FT2232',              confidence: 'HIGH' },
  '10C4': { chip: 'Silicon Labs CP210x',            confidence: 'HIGH' },
  '067B': { chip: 'Prolific PL2303',                confidence: 'HIGH' },
  '04D8': { chip: 'Microchip MCP2200/MCP2221',      confidence: 'HIGH' },
  '0483': { chip: 'STMicro USB CDC (custom)',       confidence: 'MEDIUM' },
  '16C0': { chip: 'VOTI / Teensy CDC',              confidence: 'MEDIUM' },
  '2341': { chip: 'Arduino Uno/Mega CDC',           confidence: 'MEDIUM' },  // Some scales use Arduino internals
  '239A': { chip: 'Adafruit CDC',                   confidence: 'MEDIUM' },
} as const;

// ── Manufacturer / friendly-name pattern table ────────────────────────────────

interface PatternEntry {
  regex:      RegExp;
  chip:       string;
  confidence: ScaleConfidence;
}

const MFR_PATTERNS: readonly PatternEntry[] = [
  { regex: /CH340|CH341|WCH|QinHeng|wch\.cn/i,              chip: 'WCH CH340/CH341',     confidence: 'HIGH'   },
  { regex: /FTDI|Future Technology|FT232|FT2232/i,           chip: 'FTDI',                confidence: 'HIGH'   },
  { regex: /Silicon\s*Labs|CP210|SiLabs/i,                   chip: 'Silicon Labs CP210x', confidence: 'HIGH'   },
  { regex: /Prolific|PL2303/i,                               chip: 'Prolific PL2303',     confidence: 'HIGH'   },
  { regex: /Microchip|MCP2200|MCP2221/i,                     chip: 'Microchip CDC',       confidence: 'HIGH'   },
  { regex: /USB.?SERIAL|USB-SERIAL|USB Serial|SERIAL.*USB/i, chip: 'USB-Serial (generic)',confidence: 'MEDIUM' },
  { regex: /Qinheng|1a86/i,                                  chip: 'WCH (alt name)',      confidence: 'HIGH'   },
];

const FRIENDLY_PATTERNS: readonly PatternEntry[] = [
  { regex: /CH340|CH341/i,   chip: 'WCH CH340/CH341',     confidence: 'HIGH'   },
  { regex: /FT232|FT2232/i,  chip: 'FTDI',                confidence: 'HIGH'   },
  { regex: /CP210/i,         chip: 'Silicon Labs CP210x', confidence: 'HIGH'   },
  { regex: /PL2303/i,        chip: 'Prolific PL2303',     confidence: 'HIGH'   },
  { regex: /MCP220/i,        chip: 'Microchip CDC',       confidence: 'HIGH'   },
  { regex: /USB.?SERIAL/i,   chip: 'USB-Serial (generic)',confidence: 'MEDIUM' },
];

// ── Classify a single port ────────────────────────────────────────────────────

function classifyPort(raw: Awaited<ReturnType<typeof SerialPort.list>>[number]): DetectedScale | null {
  const vid = raw.vendorId?.toUpperCase().trim() ?? null;
  const mfr = raw.manufacturer ?? null;
  const friendly = (raw as Record<string, unknown>).friendlyName as string | null ?? null;
  const pnpId = raw.pnpId ?? null;

  // ── VID lookup — HIGH confidence ─────────────────────────────────────────
  if (vid) {
    const entry = VID_TABLE[vid];
    if (entry) {
      return {
        path:         raw.path,
        manufacturer: mfr,
        serialNumber: raw.serialNumber ?? null,
        vendorId:     vid,
        productId:    raw.productId?.toUpperCase() ?? null,
        pnpId,
        friendlyName: friendly,
        confidence:   entry.confidence,
        reason:       `VID ${vid} = ${entry.chip}`,
      };
    }
  }

  // ── Manufacturer pattern — HIGH / MEDIUM ──────────────────────────────────
  if (mfr) {
    for (const { regex, chip, confidence } of MFR_PATTERNS) {
      if (regex.test(mfr)) {
        return {
          path: raw.path, manufacturer: mfr, serialNumber: raw.serialNumber ?? null,
          vendorId: vid, productId: raw.productId?.toUpperCase() ?? null, pnpId,
          friendlyName: friendly, confidence,
          reason: `Manufacturer "${mfr}" matches ${chip}`,
        };
      }
    }
  }

  // ── Friendly name pattern ─────────────────────────────────────────────────
  if (friendly) {
    for (const { regex, chip, confidence } of FRIENDLY_PATTERNS) {
      if (regex.test(friendly)) {
        return {
          path: raw.path, manufacturer: mfr, serialNumber: raw.serialNumber ?? null,
          vendorId: vid, productId: raw.productId?.toUpperCase() ?? null, pnpId,
          friendlyName: friendly, confidence,
          reason: `Friendly name "${friendly}" matches ${chip}`,
        };
      }
    }
  }

  // ── PnP ID contains USB VID — LOW confidence ──────────────────────────────
  // Device has a USB connection but chip is unrecognised (clone / OEM chip)
  if (pnpId?.toUpperCase().includes('USB\\VID_')) {
    return {
      path: raw.path, manufacturer: mfr, serialNumber: raw.serialNumber ?? null,
      vendorId: vid, productId: raw.productId?.toUpperCase() ?? null, pnpId,
      friendlyName: friendly,
      confidence: 'LOW',
      reason: `USB device (VID ${vid ?? 'unknown'}) — chip not in known table`,
    };
  }

  // Not a USB-serial candidate
  return null;
}

// ── Ranking ───────────────────────────────────────────────────────────────────

const CONFIDENCE_RANK: Record<ScaleConfidence, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 };

function rank(a: DetectedScale, b: DetectedScale): number {
  const diff = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  if (diff !== 0) return diff;
  // Equal confidence: prefer lower COM index (first connected)
  const aNum = parseInt(a.path.replace(/\D/g, ''), 10) || 0;
  const bNum = parseInt(b.path.replace(/\D/g, ''), 10) || 0;
  return aNum - bNum;
}

// ── Result cache (10 s TTL) ───────────────────────────────────────────────────

const CACHE_TTL_MS = 10_000;
let cache: { result: ScaleDetectionResult; expiresAt: number } | null = null;

export function clearScaleDetectionCache(): void {
  cache = null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * List and rank all USB-serial ports that could be connected to a scale.
 *
 * @param excludePath  Port path to skip (e.g. the currently configured port if
 *                     it already failed, matching reader._autoDetectPort() behaviour).
 * @param forceRefresh Bypass 10 s cache.
 */
export async function detectScales(
  excludePath?: string,
  forceRefresh = false,
): Promise<ScaleDetectionResult> {
  if (!forceRefresh && cache && Date.now() < cache.expiresAt) {
    logger.debug('[scale-detect] Returning cached detection result');
    return cache.result;
  }

  logger.info('[scale-detect] Scanning serial ports...');

  let rawPorts: Awaited<ReturnType<typeof SerialPort.list>> = [];
  try {
    rawPorts = await SerialPort.list();
  } catch (err) {
    logger.error({ err: String(err) }, '[scale-detect] SerialPort.list() failed');
    const empty: ScaleDetectionResult = {
      ports: [], selected: null, totalPortCount: 0,
      selectionReason: `SerialPort.list() error: ${String(err)}`,
      detectedAt: new Date().toISOString(),
    };
    return empty;
  }

  logger.info(
    { total: rawPorts.length, paths: rawPorts.map(p => p.path) },
    '[scale-detect] All serial ports found',
  );

  // Classify and filter
  const candidates: DetectedScale[] = rawPorts
    .filter(p => p.path !== excludePath)
    .map(classifyPort)
    .filter((c): c is DetectedScale => c !== null)
    .sort(rank);

  // Detailed log of ranked candidates
  if (candidates.length > 0) {
    logger.info(
      {
        candidates: candidates.map(c => ({
          path: c.path,
          confidence: c.confidence,
          reason: c.reason,
          vid: c.vendorId,
        })),
      },
      '[scale-detect] Ranked USB-serial candidates',
    );
  } else {
    logger.warn('[scale-detect] No USB-serial adapter candidates found');
  }

  // Select best
  const selected = candidates.length > 0 ? candidates[0] : null;
  const selectionReason = selected
    ? `${selected.confidence} confidence — ${selected.reason} (${selected.path})`
    : `No USB-serial adapter found among ${rawPorts.length} port(s)`;

  if (selected) {
    logger.info(
      { path: selected.path, confidence: selected.confidence, reason: selected.reason },
      '[scale-detect] Selected scale port',
    );
  }

  const result: ScaleDetectionResult = {
    ports: candidates,
    selected,
    selectionReason,
    totalPortCount: rawPorts.length,
    detectedAt: new Date().toISOString(),
  };

  cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
