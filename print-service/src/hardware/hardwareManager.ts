/**
 * Unified Hardware Manager — Phase 4
 *
 * Single point of truth for hardware readiness:
 *   - Printer status: calls printerDetect.ts (local, same process)
 *   - Scale status:   calls weight-service GET /hardware/scales (HTTP, 3s timeout)
 *
 * Does NOT modify running connections.
 * Does NOT touch print or weight business logic.
 * Manual SERIAL_PORT and PRINTER_USB_DEVICE overrides are respected by the
 * underlying detectors; hardwareManager only reads and reports their results.
 */

import { readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from '../config.js';
import { detectPrinters, clearDetectionCache as clearPrinterCache } from './printerDetect.js';
import logger from '../utils/logger.js';
import type {
  HardwareStatus,
  PrinterStatusDetail,
  ScaleStatusDetail,
  HardwareConfidence,
  DiagnosticsReport,
  DiagnosticsConfig,
  DiagnosticsPrinter,
  DiagnosticsScale,
  AppInfo,
} from './hardwareStatus.js';

const execAsync = promisify(exec);

// ── App version (read once at startup) ───────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
let APP_VERSION = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dir, '../../package.json'), 'utf8'));
  APP_VERSION = (pkg as { version?: string }).version ?? '1.0.0';
} catch { /* version unreadable — use default */ }

// ── Inter-service HTTP helper ─────────────────────────────────────────────────

async function fetchJson<T>(url: string, timeoutMs = 3000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── Windows printer health check (WINDOWS mode only) ─────────────────────────

async function checkWindowsHealth(printerName: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const safeN = printerName.replace(/'/g, "''");
    const { stdout: spoolerOut } = await execAsync(
      `powershell -NonInteractive -NoProfile -Command "(Get-Printer -Name '${safeN}').PrinterStatus"`,
      { timeout: 3000 },
    );
    const s = spoolerOut.trim();
    if (['Offline', 'Error', 'Unknown', 'NotAvailable', ''].includes(s)) return false;

    // Same two-layer logic as tspl.ts healthCheckWin
    const script =
      `$p=Get-Printer -Name '${safeN}' -EA SilentlyContinue;` +
      `if(-not $p){'DISCONNECTED'}` +
      `elseif([string]$p.PrinterStatus -in @('Offline','Error','Unknown','')){'DISCONNECTED'}` +
      `else{` +
        `$w=(Get-WmiObject Win32_PnPEntity -Filter ""PNPDeviceID LIKE 'USBPRINT%'"" -EA SilentlyContinue | Select-Object -First 1);` +
        `if($w){'CONNECTED'}else{'DISCONNECTED'}` +
      `}`;
    const { stdout } = await execAsync(
      `powershell -NonInteractive -NoProfile -Command "${script}"`,
      { timeout: 6000 },
    );
    return stdout.trim() === 'CONNECTED';
  } catch {
    return false;
  }
}

// ── Warning builders ──────────────────────────────────────────────────────────

function printerWarning(
  mode: string,
  detected: boolean,
  candidateCount: number,
  printerName: string,
): string | null {
  if (!detected) {
    return mode === 'WINDOWS'
      ? `Windows printer "${printerName}" not found or not responding. ` +
        `Verify it is installed in Settings → Printers and powered on.`
      : `No USB printer device found. ` +
        `Connect the label printer via USB and power it on. ` +
        `Checked paths: \\\\.\\USBPRINxx (Windows) or /dev/usb/lpX (Linux).`;
  }
  if (candidateCount > 1) {
    return `${candidateCount} printer candidates found. ` +
      `Using highest-confidence device. ` +
      `Set PRINTER_USB_DEVICE=\\\\.\\USBPRINxx to pin a specific device.`;
  }
  return null;
}

function scaleWarning(
  serviceReachable: boolean,
  detected: boolean,
  connected: boolean,
  candidateCount: number,
  path: string | null,
  weightUrl: string,
): string | null {
  if (!serviceReachable) {
    return `Weight service not reachable at ${weightUrl}. ` +
      `Ensure weight-service is running (default port 5000).`;
  }
  if (!detected) {
    return `No USB-serial adapter found for scale. ` +
      `Connect the USB cable and install the CH340/FTDI driver from the scale vendor.`;
  }
  if (!connected) {
    return `Scale adapter found (${path}) but weight-service is not connected. ` +
      `Check SERIAL_PORT value — it may need to match ${path}.`;
  }
  if (candidateCount > 1) {
    return `${candidateCount} USB-serial adapters found. ` +
      `Using highest-confidence port. ` +
      `Set SERIAL_PORT=COMx to pin a specific port.`;
  }
  return null;
}

// ── Per-device status builders ────────────────────────────────────────────────

export async function getPrinterStatus(): Promise<PrinterStatusDetail> {
  const mode = config.printMode;

  if (mode === 'WINDOWS') {
    // Windows spooler mode: health check via PowerShell Get-Printer
    const healthy = await checkWindowsHealth(config.printerName);
    return {
      detected:       healthy,
      devicePath:     config.device,          // Windows share name
      vid:            null,
      pid:            null,
      manufacturer:   null,
      name:           config.printerName,
      likelyProtocol: config.driver.toUpperCase(),
      confidence:     (healthy ? 'HIGH' : 'NONE') as HardwareConfidence,
      writable:       healthy,
      candidateCount: healthy ? 1 : 0,
      mode,
      warning: printerWarning(mode, healthy, healthy ? 1 : 0, config.printerName),
    };
  }

  // RAW_DIRECT: USB or COM adapter detection
  const result = await detectPrinters('TSPL');
  const sel    = result.selected;

  const confidence: HardwareConfidence =
    sel?.metaSource === 'VID_MATCHED' ? 'HIGH' :
    sel?.metaSource === 'NAME_MATCHED' ? 'MEDIUM' :
    sel ? 'LOW' : 'NONE';

  return {
    detected:       !!sel,
    devicePath:     sel?.devicePath ?? null,
    vid:            sel?.vid        ?? null,
    pid:            sel?.pid        ?? null,
    manufacturer:   sel?.manufacturer ?? null,
    name:           sel?.name         ?? null,
    likelyProtocol: sel?.likelyProtocol ?? 'UNKNOWN',
    confidence,
    writable:       !!sel,
    candidateCount: result.printers.length,
    mode,
    warning: printerWarning(mode, !!sel, result.printers.length, config.printerName),
  };
}

// ── Scale status (calls weight-service) ───────────────────────────────────────

interface ScalesApiResponse {
  ok:              boolean;
  ports:           Array<{
    path: string; vendorId?: string; manufacturer?: string;
    friendlyName?: string; confidence: string; reason: string;
    serialNumber?: string; pnpId?: string;
  }>;
  selected:        { path: string; vendorId?: string; manufacturer?: string;
                     friendlyName?: string; confidence: string; } | null;
  selectionReason: string;
  configuredPort:  string | null;
  connected:       boolean;
  simulate:        boolean;
  totalPortCount:  number;
  detectedAt:      string;
}

export async function getScaleStatus(): Promise<ScaleStatusDetail> {
  const weightUrl = config.weightServiceUrl;
  let data: ScalesApiResponse;

  try {
    data = await fetchJson<ScalesApiResponse>(`${weightUrl}/hardware/scales`);
  } catch {
    return {
      detected: false, path: null, vendorId: null, manufacturer: null, friendlyName: null,
      confidence: 'NONE', connected: false, simulate: false, candidateCount: 0,
      configuredPort: null,
      warning: scaleWarning(false, false, false, 0, null, weightUrl),
      serviceReachable: false,
    };
  }

  const sel = data.selected;
  const confidence: HardwareConfidence =
    sel?.confidence === 'HIGH'   ? 'HIGH'   :
    sel?.confidence === 'MEDIUM' ? 'MEDIUM' :
    sel                          ? 'LOW'    : 'NONE';

  return {
    detected:        !!sel || data.simulate,
    path:            sel?.path ?? data.configuredPort ?? null,
    vendorId:        sel?.vendorId     ?? null,
    manufacturer:    sel?.manufacturer ?? null,
    friendlyName:    sel?.friendlyName ?? null,
    confidence:      data.simulate ? 'HIGH' : confidence,
    connected:       data.connected ?? false,
    simulate:        data.simulate  ?? false,
    candidateCount:  data.ports?.length ?? 0,
    configuredPort:  data.configuredPort ?? null,
    warning: data.simulate
      ? null  // simulation mode is always "ready"
      : scaleWarning(true, !!sel, data.connected, data.ports?.length ?? 0, sel?.path ?? null, weightUrl),
    serviceReachable: true,
  };
}

// ── Unified detection ──────────────────────────────────────────────────────────

export async function detectAll(): Promise<HardwareStatus> {
  const [printer, scale] = await Promise.all([
    getPrinterStatus(),
    getScaleStatus(),
  ]);

  const warnings: string[] = [
    printer.warning,
    scale.warning,
  ].filter((w): w is string => w !== null);

  const readyForProduction =
    printer.detected &&
    printer.writable &&
    scale.serviceReachable &&
    (scale.detected || scale.simulate) &&
    (scale.connected || scale.simulate);

  const ok = printer.detected && (scale.connected || scale.simulate);

  const status: HardwareStatus = {
    ok,
    printer,
    scale,
    warnings,
    readyForProduction,
    mode: {
      printMode:         config.printMode,
      printerInterface:  config.printerInterface,
      printerAutoDetect: config.printerAutoDetect,
      scaleSimulate:     scale.simulate,
    },
    checkedAt: new Date().toISOString(),
  };

  logger.info(
    { ok, readyForProduction, warnings: warnings.length },
    '[hardware-mgr] detectAll complete',
  );

  return status;
}

export async function healthCheck(): Promise<HardwareStatus> {
  return detectAll();
}

/** Force-clears printer detection cache then re-runs detectAll. */
export async function refresh(): Promise<HardwareStatus> {
  clearPrinterCache();
  logger.info('[hardware-mgr] Forced refresh — printer cache cleared');
  return detectAll();
}

// ── Diagnostics report ─────────────────────────────────────────────────────────

export async function getDiagnostics(): Promise<DiagnosticsReport> {
  const [status, printerDetection] = await Promise.all([
    detectAll(),
    detectPrinters('TSPL'),
  ]);

  // Fetch scale raw candidates from weight-service (best-effort)
  let scaleRaw: ScalesApiResponse | null = null;
  try {
    scaleRaw = await fetchJson<ScalesApiResponse>(`${config.weightServiceUrl}/hardware/scales`);
  } catch { /* weight-service unreachable — already captured in status */ }

  const app: AppInfo = {
    version:     APP_VERSION,
    platform:    process.platform,
    arch:        process.arch,
    nodeVersion: process.version,
  };

  const cfg: DiagnosticsConfig = {
    stationId:         config.stationId,
    plantId:           process.env.PLANT_ID ?? '',
    printMode:         config.printMode,
    printerInterface:  config.printerInterface,
    printerAutoDetect: config.printerAutoDetect,
    printerUsbDevice:  config.printerUsbDevice,
    printerComPort:    config.printerComPort,
    // WINDOWS mode values (may be irrelevant in RAW_DIRECT)
    printerDevice:     config.device,
    printerName:       config.printerName,
    weightServiceUrl:  config.weightServiceUrl,
    // NOTE: DJANGO_API_TOKEN and DJANGO_SERVER_URL are intentionally excluded
  };

  const printerDiag: DiagnosticsPrinter = {
    candidates:      printerDetection.printers,
    selected:        printerDetection.selected,
    selectionReason: printerDetection.selectionReason,
    healthOk:        status.printer.detected,
    healthNote:      status.printer.warning ?? 'OK',
  };

  const scaleDiag: DiagnosticsScale = {
    candidates:      scaleRaw?.ports ?? [],
    selected:        scaleRaw?.selected ?? null,
    selectionReason: scaleRaw?.selectionReason ?? (status.scale.serviceReachable ? '' : 'Weight service unreachable'),
    connected:       status.scale.connected,
    configuredPort:  status.scale.configuredPort,
    simulate:        status.scale.simulate,
    serviceReachable: status.scale.serviceReachable,
  };

  return {
    app,
    config:     cfg,
    hardware:   status,
    printer:    printerDiag,
    scale:      scaleDiag,
    generatedAt: new Date().toISOString(),
  };
}
