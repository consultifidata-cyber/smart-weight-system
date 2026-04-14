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
}

export interface PrinterDriver {
  /**
   * Build raw command bytes for a QR label.
   */
  buildLabel(data: LabelData): Buffer;

  /**
   * Send raw bytes to the physical printer.
   */
  send(commands: Buffer): Promise<void>;

  /**
   * Check if printer is reachable / connected.
   */
  healthCheck(): Promise<boolean>;
}

export interface PrinterConfig {
  driver: string;
  device: string;
  labelWidth: number;
  labelHeight: number;
  dpi: number;
  stationId: string;
  apiPort: number;
  logLevel: string;
}
