/**
 * Hardware status contract — Phase 4
 *
 * Shared types used by hardwareManager.ts, the /hardware/status endpoint,
 * and the /hardware/diagnostics endpoint.
 * No logic lives here — pure type definitions only.
 */

// ── Confidence mirrors Phase 2/3 levels but adds NONE for "not found" ────────
export type HardwareConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

// ── Per-device status ─────────────────────────────────────────────────────────

export interface PrinterStatusDetail {
  /** Device was found and is accessible */
  detected:       boolean;
  /** USB device path (RAW_DIRECT) or Windows share name (WINDOWS) */
  devicePath:     string | null;
  vid:            string | null;
  pid:            string | null;
  manufacturer:   string | null;
  /** Friendly device name from PnP / Windows */
  name:           string | null;
  likelyProtocol: string;
  confidence:     HardwareConfidence;
  /** Can we actually write bytes to this device right now? */
  writable:       boolean;
  /** How many candidates were found (> 1 = ambiguous) */
  candidateCount: number;
  /** 'WINDOWS' or 'RAW_DIRECT' */
  mode:           string;
  /** Non-null when there is a problem the operator should fix */
  warning:        string | null;
}

export interface ScaleStatusDetail {
  /** A USB-serial adapter was detected for the scale */
  detected:        boolean;
  /** COM port path the scale is on (or should be on) */
  path:            string | null;
  vendorId:        string | null;
  manufacturer:    string | null;
  friendlyName:    string | null;
  confidence:      HardwareConfidence;
  /** weight-service is actively connected to the COM port */
  connected:       boolean;
  /** Running in simulation mode (SIMULATE_SERIAL=true) */
  simulate:        boolean;
  candidateCount:  number;
  /** Port that weight-service is currently configured to use */
  configuredPort:  string | null;
  warning:         string | null;
  /** false when weight-service could not be reached over HTTP */
  serviceReachable: boolean;
}

// ── Unified status ────────────────────────────────────────────────────────────

export interface HardwareStatus {
  /** true when both printer and scale are operational */
  ok:                  boolean;
  printer:             PrinterStatusDetail;
  scale:               ScaleStatusDetail;
  /** Aggregated human-readable warnings for the operator */
  warnings:            string[];
  /** true only when BOTH devices are fully ready for production use */
  readyForProduction:  boolean;
  /** Mode summary for quick inspection */
  mode: {
    printMode:         string;
    printerInterface:  string;
    printerAutoDetect: boolean;
    scaleSimulate:     boolean;
  };
  checkedAt: string;
}

// ── Diagnostics report ────────────────────────────────────────────────────────

export interface AppInfo {
  version:     string;
  platform:    string;
  arch:        string;
  nodeVersion: string;
}

export interface DiagnosticsConfig {
  stationId:         string;
  plantId:           string;
  printMode:         string;
  printerInterface:  string;
  printerAutoDetect: boolean;
  /** Explicit USB device path override, or empty */
  printerUsbDevice:  string;
  printerComPort:    string;
  /** Windows share name (WINDOWS mode only) */
  printerDevice:     string;
  /** Full Windows printer name (WINDOWS mode only) */
  printerName:       string;
  weightServiceUrl:  string;
}

export interface DiagnosticsPrinter {
  candidates:       unknown[];   // DetectedPrinter[] from printerDetect.ts
  selected:         unknown | null;
  selectionReason:  string;
  healthOk:         boolean;
  healthNote:       string;
}

export interface DiagnosticsScale {
  candidates:      unknown[];   // DetectedScale[] from scaleDetect.ts (via weight-service)
  selected:        unknown | null;
  selectionReason: string;
  connected:       boolean;
  configuredPort:  string | null;
  simulate:        boolean;
  serviceReachable: boolean;
}

export interface DiagnosticsReport {
  app:        AppInfo;
  config:     DiagnosticsConfig;
  hardware:   HardwareStatus;
  printer:    DiagnosticsPrinter;
  scale:      DiagnosticsScale;
  generatedAt: string;
}
