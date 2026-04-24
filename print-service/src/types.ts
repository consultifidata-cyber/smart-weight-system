export interface LabelData {
  qrContent: string;      // What the QR code encodes
  textLines: string[];    // Human-readable lines below QR
  labelWidth: number;     // mm
  labelHeight: number;    // mm
  entryId: string;        // Unique ID for this bag
}

export interface PrintRequest {
  product: string;
  weight: number;
  stationId: string;
  line1: string;           // Primary code displayed below QR (large font)
  line2: string;           // Secondary code displayed below line1 (smaller font)
  qrContent?: string;      // Optional; auto-generated if omitted
  labelWidth?: number;     // Optional; falls back to config
  labelHeight?: number;    // Optional; falls back to config
}

export interface PrintResponse {
  status: "ok" | "error";
  entryId?: string;
  printedAt?: string;
  error?: string;
}

export interface HealthResponse {
  printer: {
    driver: string;
    device: string;
    connected: boolean;
  };
  service: string;
  stationId: string;
  status: "ok" | "error";
  lastCheckedAt?: string;
}

export interface PrinterDriver {
  // ── Generic (auto-detect platform via process.platform) ──
  buildLabel(data: LabelData): Buffer;
  send(commands: Buffer, timeoutMs?: number): Promise<void>;
  healthCheck(timeoutMs?: number): Promise<boolean>;
  resetPrinter(): Promise<void>;

  // ── Linux-specific ──
  buildLabelLinux(data: LabelData): Buffer;
  sendLinux(commands: Buffer, timeoutMs?: number): Promise<void>;
  healthCheckLinux(timeoutMs?: number): Promise<boolean>;
  resetPrinterLinux(): Promise<void>;

  // ── Windows-specific ──
  buildLabelWin(data: LabelData): Buffer;
  sendWin(commands: Buffer, timeoutMs?: number): Promise<void>;
  healthCheckWin(timeoutMs?: number): Promise<boolean>;
  resetPrinterWin(): Promise<void>;
}

export interface PrinterConfig {
  driver: string;
  device: string;
  printerName: string;
  labelWidth: number;
  labelHeight: number;
  dpi: number;
  stationId: string;
  apiPort: number;
  logLevel: string;
  sendTimeoutMs: number;
  healthPollMs: number;
  // ── Phase 1: driverless printing ──────────────────────────────────────────
  /** 'WINDOWS' = existing copy/b spooler path (default, backwards-compat).
   *  'RAW_DIRECT' = driverless USB or COM send via PrintAdapter. */
  printMode: 'WINDOWS' | 'RAW_DIRECT';
  /** Active only when printMode = 'RAW_DIRECT'. */
  printerInterface: 'USB' | 'COM';
  /** COM port for serial print adapter, e.g. 'COM4'. Required when printerInterface = 'COM'. */
  printerComPort: string;
  /** Optional explicit USB device path, e.g. '\\\\.\\USBPRIN02'. Auto-detected when empty. */
  printerUsbDevice: string;
  /** When true and PRINT_MODE=RAW_DIRECT, run printerDetect at startup to resolve USB path.
   *  Ignored if PRINTER_USB_DEVICE is set explicitly. */
  printerAutoDetect: boolean;
  // ── Phase 4: unified hardware manager ─────────────────────────────────────
  /** Base URL of the weight-service for inter-service calls (default: http://localhost:5000) */
  weightServiceUrl: string;
}
