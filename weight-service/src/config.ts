import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (smart-weight-system/)
dotenvConfig({ path: resolve(__dirname, '../../.env') });

const simulate = process.env.SIMULATE_SERIAL === 'true';

console.log(process.env.platform);

const config: AppConfig = Object.freeze({
  stationId: process.env.STATION_ID || 'ST01',

  serial: Object.freeze({
    port: 'COM4',
    baudRate: parseInt(process.env.SERIAL_BAUD_RATE!, 10) || 9600,
    dataBits: parseInt(process.env.SERIAL_DATA_BITS!, 10) || 8,
    parity: process.env.SERIAL_PARITY || 'none',
    stopBits: parseInt(process.env.SERIAL_STOP_BITS!, 10) || 1,
    simulate,
  }),

  api: Object.freeze({
    port: parseInt(process.env.WEIGHT_API_PORT!, 10) || 5000,
  }),

  stability: Object.freeze({
    thresholdMs: parseInt(process.env.STABILITY_THRESHOLD_MS!, 10) || 1500,
    toleranceKg: parseFloat(process.env.STABILITY_TOLERANCE_KG!) || 0.02,
  }),

  logLevel: process.env.LOG_LEVEL || 'info',
});

// Validate
if (!simulate && !config.serial.port) {
  throw new Error('SERIAL_PORT is required when SIMULATE_SERIAL is not true');
}

export default config;
