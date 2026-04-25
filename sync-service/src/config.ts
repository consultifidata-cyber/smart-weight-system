import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// __dirname is still needed for the default DB_PATH resolution below.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load global .env -- PM2 sets DOTENV_PATH to the absolute path;
// fallback resolves from cwd (service dir) up one level to project root.
dotenvConfig({ path: process.env.DOTENV_PATH || resolve(process.cwd(), '..', '.env') });

export interface SyncServiceConfig {
  stationId: string;
  plantId: string;
  apiPort: number;
  logLevel: string;
  dbPath: string;

  // Django server
  djangoServerUrl: string;
  djangoApiToken: string;

  // Sync timers
  bagSyncIntervalMs: number;
  syncRetryIntervalMs: number;
  masterSyncIntervalMs: number;
  syncPushTimeoutMs: number;

  // Offline fallback — day_seq range for QR codes when Django is unreachable
  offlineDaySeqStart: number;
  offlineDaySeqEnd: number;
}

const config: SyncServiceConfig = Object.freeze({
  stationId: process.env.STATION_ID || 'ST01',
  plantId: process.env.PLANT_ID || 'A1',
  apiPort: parseInt(process.env.SYNC_API_PORT || '5002', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath: process.env.DB_PATH || resolve(__dirname, '../data/fg_production.db'),

  djangoServerUrl: process.env.DJANGO_SERVER_URL || 'http://127.0.0.1:8000',
  djangoApiToken: process.env.DJANGO_API_TOKEN || '',

  bagSyncIntervalMs: parseInt(process.env.BAG_SYNC_INTERVAL_MS || '10000', 10),
  syncRetryIntervalMs: parseInt(process.env.SYNC_RETRY_INTERVAL_MS || '60000', 10),
  // Phase G: reduced from 1 hour to 5 minutes so new workers/FG items appear quickly.
  masterSyncIntervalMs: parseInt(process.env.MASTER_SYNC_INTERVAL_MS || '300000', 10),
  syncPushTimeoutMs: parseInt(process.env.SYNC_PUSH_TIMEOUT_MS || '10000', 10),

  offlineDaySeqStart: parseInt(process.env.OFFLINE_DAY_SEQ_START || '90', 10),
  offlineDaySeqEnd: parseInt(process.env.OFFLINE_DAY_SEQ_END || '99', 10),
});

export default config;
