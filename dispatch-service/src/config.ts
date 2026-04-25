import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same .env as every other service
dotenvConfig({ path: process.env.DOTENV_PATH || resolve(__dirname, '../../.env') });

export interface DispatchConfig {
  stationId:    string;
  plantId:      string;
  apiPort:      number;
  dbPath:       string;
  logLevel:     string;
}

const config: DispatchConfig = Object.freeze({
  stationId: process.env.STATION_ID || 'ST01',
  plantId:   process.env.PLANT_ID   || 'A1',
  apiPort:   parseInt(process.env.DISPATCH_API_PORT || '4000', 10),
  // Same DB file as sync-service — SQLite WAL allows concurrent access
  dbPath:    process.env.DB_PATH || resolve(__dirname, '../../sync-service/data/fg_production.db'),
  logLevel:  process.env.LOG_LEVEL || 'info',
});

export default config;
