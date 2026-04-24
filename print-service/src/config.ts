import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import type { PrinterConfig } from './types.js';

// Load global .env -- PM2 sets DOTENV_PATH to the absolute path;
// fallback resolves from cwd (service dir) up one level to project root.
dotenvConfig({ path: process.env.DOTENV_PATH || resolve(process.cwd(), '..', '.env') });

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
  healthPollMs: parseInt(process.env.PRINT_HEALTH_POLL_MS || '30000', 10),
});

export default config;
