/**
 * Printer Auto-Detection — Phase 2
 *
 * Strategy (Windows):
 *   1. Probe  \\.\USBPRIN01 … \\.\USBPRIN20  — find every writable USB printer path.
 *   2. Query  PnP device tree via PowerShell  — harvest VID, PID, friendly name.
 *   3. Merge  — correlate probed paths with PnP metadata by enumeration order.
 *   4. Classify — map VID or name patterns to print protocol (TSPL / ZPL / ESC_POS).
 *   5. Select — rank candidates; prefer protocol match > VID match > first writable.
 *
 * Strategy (Linux):
 *   Probe /dev/usb/lp0 … lp3.  No VID/PID enrichment (udevadm added in Phase 4).
 *
 * Windows path \\.\USBPRINxx is exposed by usbprint.sys — a built-in Windows
 * class driver that installs automatically.  NO printer-specific driver required.
 *
 * Result is cached for 10 s to avoid repeated PowerShell spawns on rapid calls.
 */

import { promises as fs, constants as fsConstants } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);

// ── Public types ──────────────────────────────────────────────────────────────

export type PrintProtocol = 'TSPL' | 'ZPL' | 'ESC_POS' | 'UNKNOWN';

export interface DetectedPrinter {
  /** Direct device path: \\.\USBPRIN01 (Windows) or /dev/usb/lp0 (Linux) */
  devicePath: string;
  /** 1-based USBPRIN index (0-based for Linux lp devices) */
  index: number;
  /** true = path opened for write successfully */
  writable: boolean;
  /** USB Vendor ID — uppercase hex, no 0x prefix, e.g. '1203' */
  vid: string | null;
  /** USB Product ID — uppercase hex, no 0x prefix */
  pid: string | null;
  /** Manufacturer string from PnP */
  manufacturer: string | null;
  /** Friendly device name from PnP, e.g. 'TSC TTP-244 Pro' */
  name: string | null;
  /** Print protocol inferred from VID lookup or name pattern */
  likelyProtocol: PrintProtocol;
  /** Confidence level of protocol inference */
  metaSource: 'VID_MATCHED' | 'NAME_MATCHED' | 'UNKNOWN';
}

export interface DetectionResult {
  /** All discovered + enriched candidates */
  printers: DetectedPrinter[];
  /** Auto-selected best match, or null if nothing found */
  selected: DetectedPrinter | null;
  /** Human-readable explanation of the selection decision */
  selectionReason: string;
  /** false on unsupported platforms */
  platformSupported: boolean;
  /** ISO timestamp when detection ran */
  detectedAt: string;
}

// ── Known VID → protocol + manufacturer ──────────────────────────────────────
// Sources: USB-IF registry, vendor datasheets, community testing.
// Key: uppercase hex VID, no 0x prefix.

const VID_MAP: Readonly<Record<string, { protocol: PrintProtocol; manufacturer: string }>> = {
  // ── TSPL family (TSC / TVS / SNBC label printers) ─────────────────────────
  '1203': { protocol: 'TSPL', manufacturer: 'TSC Auto-ID Technology' },       // TSC TTP-244, DA-220, etc.
  '0FE6': { protocol: 'TSPL', manufacturer: 'IDS / TVS Electronics' },        // TVS LP series (IDS bridge)
  '154F': { protocol: 'TSPL', manufacturer: 'SNBC' },                         // SNBC / TVS rebrand
  '28E9': { protocol: 'TSPL', manufacturer: 'GD32 / WCH (TVS LP 46 NEO)' },  // GD32-based USB-CDC bridge
  '067B': { protocol: 'TSPL', manufacturer: 'Prolific PL2303 (USB-serial)' }, // Prolific bridge in some TVS units
  '4B43': { protocol: 'TSPL', manufacturer: 'SEWOO (TSC-compatible)' },
  '20D1': { protocol: 'TSPL', manufacturer: 'Argox (TSC-compatible)' },
  // ── ZPL family (Zebra / Honeywell / Bixolon) ──────────────────────────────
  '0A5F': { protocol: 'ZPL',  manufacturer: 'Zebra Technologies' },
  '0C2E': { protocol: 'ZPL',  manufacturer: 'Honeywell' },
  '1504': { protocol: 'ZPL',  manufacturer: 'Bixolon' },
  '05F9': { protocol: 'ZPL',  manufacturer: 'PSC / Datalogic' },
  // ── ESC/POS family (receipt / POS printers) ───────────────────────────────
  '04B8': { protocol: 'ESC_POS', manufacturer: 'Epson' },
  '0519': { protocol: 'ESC_POS', manufacturer: 'Star Micronics' },
  '1D90': { protocol: 'ESC_POS', manufacturer: 'Citizen' },
  '0416': { protocol: 'ESC_POS', manufacturer: 'WinChipHead (ESC/POS bridge)' },
} as const;

// ── Name pattern → protocol fallback ─────────────────────────────────────────

const NAME_PATTERNS: ReadonlyArray<{ regex: RegExp; protocol: PrintProtocol }> = [
  { regex: /TVS|SNBC|TSC|LP\s*46|LP46|BPLE|TTP[\s-]?\d|DA[\s-]?\d|T200|T300/i, protocol: 'TSPL'    },
  { regex: /Zebra|ZD\d|GX\d{2}|GT\d{3}|ZT\d{3}|QLn|ZQ\d{3}/i,                  protocol: 'ZPL'     },
  { regex: /Epson|TM[\s-]\w+|Star|TSP\d|Citizen|ESC[\s/]?POS|Receipt/i,          protocol: 'ESC_POS' },
];

// ── Path candidates ───────────────────────────────────────────────────────────

const MAX_WIN_INDEX = 20;
const LINUX_PATHS   = Array.from({ length: 4 }, (_, i) => `/dev/usb/lp${i}`);

function winPath(i: number): string {
  return `\\\\.\\USBPRIN${String(i).padStart(2, '0')}`;
}

// ── Step 1: Probe writable paths ──────────────────────────────────────────────

async function probeWritablePaths(): Promise<Array<{ devicePath: string; index: number }>> {
  const found: Array<{ devicePath: string; index: number }> = [];

  if (process.platform === 'win32') {
    for (let i = 1; i <= MAX_WIN_INDEX; i++) {
      const p = winPath(i);
      try {
        const fd = await fs.open(p, fsConstants.O_WRONLY);
        await fd.close();
        found.push({ devicePath: p, index: i });
        logger.debug({ path: p }, '[printer-detect] USBPRIN path is writable');
      } catch {
        // Not accessible — keep scanning in case indices are non-contiguous
        // (e.g. USBPRIN01 assigned, then USBPRIN03 after re-plug cycle)
        if (i > 5 && found.length === 0) break; // Nothing in first 5 — stop early
      }
    }
  } else {
    for (let i = 0; i < LINUX_PATHS.length; i++) {
      try {
        await fs.access(LINUX_PATHS[i], fsConstants.W_OK);
        found.push({ devicePath: LINUX_PATHS[i], index: i });
      } catch { /* not present */ }
    }
  }

  logger.info({ count: found.length, paths: found.map(f => f.devicePath) }, '[printer-detect] Writable paths found');
  return found;
}

// ── Step 2: WMI metadata via PowerShell (Windows only) ───────────────────────

interface PnpDevice {
  name: string;
  vid:  string;
  pid:  string;
}

async function queryPnpDevices(): Promise<PnpDevice[]> {
  if (process.platform !== 'win32') return [];

  // Write PS1 to temp file — avoids all inline escaping issues.
  const suffix    = `${Date.now()}_${process.pid}`;
  const ps1File   = join(tmpdir(), `sws_detect_${suffix}.ps1`);
  const jsonFile  = join(tmpdir(), `sws_detect_${suffix}.json`);
  const jsonEsc   = jsonFile.replace(/\\/g, '\\\\');

  // PowerShell 5.1 script — compatible with Windows 10/11.
  // Enumerates USB PnP devices, extracts VID+PID from InstanceId, outputs JSON.
  const psContent = `
$ErrorActionPreference = 'SilentlyContinue'
$out = '${jsonEsc}'
try {
  $items = @(
    Get-PnpDevice -PresentOnly |
    Where-Object { $_.InstanceId -match 'USB\\\\VID_' -and $_.Status -eq 'OK' } |
    ForEach-Object {
      $vid = [regex]::Match($_.InstanceId, 'VID_([0-9A-Fa-f]{4})').Groups[1].Value.ToUpper()
      $pid = [regex]::Match($_.InstanceId, 'PID_([0-9A-Fa-f]{4})').Groups[1].Value.ToUpper()
      if (-not $vid) { return }
      [PSCustomObject]@{
        name = if ($_.FriendlyName) { $_.FriendlyName } else { '' }
        vid  = $vid
        pid  = $pid
      }
    }
  )
  if ($items.Count -gt 0) {
    ($items | ConvertTo-Json -Compress) | Out-File -FilePath $out -Encoding ASCII
  } else {
    '[]' | Out-File -FilePath $out -Encoding ASCII
  }
} catch {
  '[]' | Out-File -FilePath $out -Encoding ASCII
}
`.trimStart();

  try {
    await fs.writeFile(ps1File, psContent, 'utf8');
    await execAsync(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${ps1File}"`,
      { timeout: 10_000 },
    );

    const raw  = (await fs.readFile(jsonFile, 'utf8')).replace(/^﻿/, '').trim();
    const data = JSON.parse(raw || '[]');

    // PowerShell returns a plain object (not array) when there is exactly 1 item.
    const devices: PnpDevice[] = Array.isArray(data) ? data : [data];
    logger.info({ count: devices.length }, '[printer-detect] PnP device query complete');
    return devices.filter(d => d && d.vid);
  } catch (err) {
    logger.warn(
      { err: String(err) },
      '[printer-detect] PnP query failed — detection continues without VID/PID metadata',
    );
    return [];
  } finally {
    await Promise.all([
      fs.unlink(ps1File).catch(() => {}),
      fs.unlink(jsonFile).catch(() => {}),
    ]);
  }
}

// ── Step 3: Classify protocol ─────────────────────────────────────────────────

function classify(
  vid: string | null,
  name: string | null,
): Pick<DetectedPrinter, 'likelyProtocol' | 'manufacturer' | 'metaSource'> {
  if (vid) {
    const entry = VID_MAP[vid.toUpperCase()];
    if (entry) {
      return {
        likelyProtocol: entry.protocol,
        manufacturer:   entry.manufacturer,
        metaSource:     'VID_MATCHED',
      };
    }
  }
  if (name) {
    for (const { regex, protocol } of NAME_PATTERNS) {
      if (regex.test(name)) {
        return { likelyProtocol: protocol, manufacturer: null, metaSource: 'NAME_MATCHED' };
      }
    }
  }
  return { likelyProtocol: 'UNKNOWN', manufacturer: null, metaSource: 'UNKNOWN' };
}

// ── Step 4: Merge probed paths + PnP metadata ─────────────────────────────────
//
// Correlation strategy: OS assigns \\.\USBPRIN indices and PnP enumerates
// in the same USB enumeration order.  When counts match → 1:1 by index.
// When counts differ → best-effort by index, remainder gets path-only records.

function merge(
  probed: Array<{ devicePath: string; index: number }>,
  pnp:    PnpDevice[],
): DetectedPrinter[] {
  return probed.map((p, i) => {
    const dev = pnp[i] ?? null;
    const { likelyProtocol, manufacturer, metaSource } = classify(
      dev?.vid ?? null,
      dev?.name ?? null,
    );
    return {
      devicePath:     p.devicePath,
      index:          p.index,
      writable:       true,
      vid:            dev?.vid  ?? null,
      pid:            dev?.pid  ?? null,
      manufacturer:   manufacturer ?? null,
      name:           dev?.name ?? null,
      likelyProtocol,
      metaSource,
    };
  });
}

// ── Step 5: Auto-select best candidate ───────────────────────────────────────

function autoSelect(
  printers: DetectedPrinter[],
  prefer: PrintProtocol,
): { selected: DetectedPrinter | null; reason: string } {
  if (printers.length === 0) {
    return { selected: null, reason: 'No writable USB printer paths found' };
  }

  const label = (p: DetectedPrinter) => p.name ?? p.devicePath;

  // Rank 1: VID-confirmed match for preferred protocol
  const byVid = printers.find(p => p.likelyProtocol === prefer && p.metaSource === 'VID_MATCHED');
  if (byVid) {
    return {
      selected: byVid,
      reason: `VID ${byVid.vid} confirmed ${prefer} (${byVid.manufacturer ?? ''}) at ${byVid.devicePath}`,
    };
  }

  // Rank 2: Name-matched for preferred protocol
  const byName = printers.find(p => p.likelyProtocol === prefer && p.metaSource === 'NAME_MATCHED');
  if (byName) {
    return {
      selected: byName,
      reason: `Name pattern matched ${prefer} — "${label(byName)}" at ${byName.devicePath}`,
    };
  }

  // Rank 3: Any TSPL (label printer use-case is always TSPL)
  const anyTspl = printers.find(p => p.likelyProtocol === 'TSPL');
  if (anyTspl) {
    return {
      selected: anyTspl,
      reason: `First TSPL-compatible printer — "${label(anyTspl)}" at ${anyTspl.devicePath}`,
    };
  }

  // Rank 4: First writable path regardless of protocol
  return {
    selected: printers[0],
    reason: `No protocol match — using first writable path ${printers[0].devicePath}`,
  };
}

// ── Result cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10_000;

interface CachedResult {
  result:    DetectionResult;
  expiresAt: number;
}

let cache: CachedResult | null = null;

/** Invalidate the cache (call after a printer is connected / disconnected). */
export function clearDetectionCache(): void {
  cache = null;
  logger.debug('[printer-detect] Detection cache cleared');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect connected USB printers and select the best one.
 *
 * @param preferProtocol  Protocol to prioritise when multiple printers found (default: TSPL)
 * @param forceRefresh    Bypass 10s cache and re-probe immediately
 */
export async function detectPrinters(
  preferProtocol: PrintProtocol = 'TSPL',
  forceRefresh    = false,
): Promise<DetectionResult> {
  // Serve from cache if still valid
  if (!forceRefresh && cache && Date.now() < cache.expiresAt) {
    logger.debug('[printer-detect] Returning cached result');
    return cache.result;
  }

  logger.info({ platform: process.platform }, '[printer-detect] Starting printer detection');

  if (process.platform !== 'win32') {
    // Linux: path-probe only (no VID/PID enrichment yet)
    const probed = await probeWritablePaths();
    const printers: DetectedPrinter[] = probed.map(p => ({
      devicePath: p.devicePath, index: p.index, writable: true,
      vid: null, pid: null, manufacturer: null, name: null,
      likelyProtocol: 'UNKNOWN', metaSource: 'UNKNOWN',
    }));
    const { selected, reason } = autoSelect(printers, preferProtocol);
    const result: DetectionResult = {
      printers, selected, selectionReason: reason,
      platformSupported: true, detectedAt: new Date().toISOString(),
    };
    cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
    return result;
  }

  // Windows: parallel probe + WMI query
  const [probed, pnp] = await Promise.all([
    probeWritablePaths(),
    queryPnpDevices(),
  ]);

  const printers = merge(probed, pnp);
  const { selected, reason } = autoSelect(printers, preferProtocol);

  if (selected) {
    logger.info(
      { path: selected.devicePath, vid: selected.vid, protocol: selected.likelyProtocol, reason },
      '[printer-detect] Auto-selected printer',
    );
  } else {
    logger.warn({ reason }, '[printer-detect] No printer auto-selected');
  }

  const result: DetectionResult = {
    printers, selected, selectionReason: reason,
    platformSupported: true, detectedAt: new Date().toISOString(),
  };
  cache = { result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
