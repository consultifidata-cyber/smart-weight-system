import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PrinterConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
dotenvConfig({ path: resolve(__dirname, '../../.env') });

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
});

export default config;
