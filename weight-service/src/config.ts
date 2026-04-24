import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import type { AppConfig } from './types.js';

// Load global .env -- PM2 sets DOTENV_PATH to the absolute path;
// fallback resolves from cwd (service dir) up one level to project root.
dotenvConfig({ path: process.env.DOTENV_PATH || resolve(process.cwd(), '..', '.env') });

const simulate      = process.env.SIMULATE_SERIAL === 'true';
const portExplicit  = !!process.env.SERIAL_PORT;
const scaleAutoDetect = (process.env.SCALE_AUTO_DETECT || 'false').toLowerCase() === 'true';

const config: AppConfig = Object.freeze({
  stationId: process.env.STATION_ID || 'ST01',

  serial: Object.freeze({
    port: process.env.SERIAL_PORT || (process.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0'),
    baudRate: parseInt(process.env.SERIAL_BAUD_RATE!, 10) || 9600,
    dataBits: parseInt(process.env.SERIAL_DATA_BITS!, 10) || 8,
    parity: process.env.SERIAL_PARITY || 'none',
    stopBits: parseInt(process.env.SERIAL_STOP_BITS!, 10) || 1,
    simulate,
    scaleAutoDetect,
    portExplicit,
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
