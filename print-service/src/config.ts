import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import type { PrinterConfig } from './types.js';

// Load global .env -- PM2 sets DOTENV_PATH to the absolute path;
// fallback resolves from cwd (service dir) up one level to project root.
dotenvConfig({ path: process.env.DOTENV_PATH || resolve(process.cwd(), '..', '.env') });

// Normalize before comparison: strip UTF-8/UTF-16 BOM (﻿), trim
// whitespace, uppercase. This defends against .env files written with
// BOM (PowerShell Set-Content default), trailing \r from Windows CRLF,
// or leading/trailing spaces. Without trim, " WINDOWS" !== "WINDOWS".
// Default is 'WINDOWS' — the only supported production mode. Cascade
// requires explicit PRINT_MODE=RAW_DIRECT opt-in.
function normalizeEnvStr(val: string | undefined, fallback: string): string {
  return (val ?? '').replace(/^﻿/, '').trim().toUpperCase() || fallback;
}

const rawPrintMode = normalizeEnvStr(process.env.PRINT_MODE, 'WINDOWS');
const rawInterface = normalizeEnvStr(process.env.PRINTER_INTERFACE, 'USB');

const config: PrinterConfig = Object.freeze({
  driver: process.env.PRINTER_DRIVER || 'tspl',
  device: process.env.PRINTER_DEVICE || 'TVSLP46NEO',
  printerName: process.env.PRINTER_NAME || 'SNBC TVSE LP 46 NEO BPLE',
  labelWidth: parseInt(process.env.PRINTER_LABEL_WIDTH || '50', 10),
  labelHeight: parseInt(process.env.PRINTER_LABEL_HEIGHT || '50', 10),
  dpi: parseInt(process.env.PRINTER_DPI || '203', 10),
  stationId: process.env.STATION_ID || 'ST01',
  apiPort: parseInt(process.env.PRINT_API_PORT || '5001', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  sendTimeoutMs: parseInt(process.env.PRINT_SEND_TIMEOUT_MS || '1000', 10),
  healthPollMs: parseInt(process.env.PRINT_HEALTH_POLL_MS || '10000', 10),  // 10 s for self-healing
  // ── Phase 1: driverless mode ──────────────────────────────────────────────
  printMode:       (rawPrintMode === 'RAW_DIRECT' ? 'RAW_DIRECT' : 'WINDOWS') as 'WINDOWS' | 'RAW_DIRECT',
  printerInterface:(rawInterface === 'COM'        ? 'COM'        : 'USB')      as 'USB' | 'COM',
  printerComPort:   process.env.PRINTER_COM_PORT   || '',
  printerUsbDevice: process.env.PRINTER_USB_DEVICE  || '',
  printerAutoDetect:(process.env.PRINTER_AUTO_DETECT || 'false').toLowerCase() === 'true',
  // Phase 4: weight-service base URL for inter-service hardware queries
  weightServiceUrl: process.env.WEIGHT_SERVICE_URL || 'http://localhost:5000',
});

export default config;
