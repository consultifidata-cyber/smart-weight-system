import type { StabilityDetector } from './stability/detector.js';
import type { WeightReader } from './serial/reader.js';

// --- Parser types ---

export interface WeightReading {
  raw: string;
  weight: number | null;
  sign: string | null;
  unit: string | null;
  scaleStable: boolean | null;
  overload: boolean;
  timestamp: string;
}

// --- Stability types ---

export interface StabilityInput {
  weight: number | null;
  overload?: boolean;
}

export interface StabilityResult {
  weight: number | null;
  stable: boolean;
  stableWeight: number | null;
}

export interface StabilityState extends StabilityResult {
  lastReadingAt: number | null;
}

export interface StabilityOptions {
  thresholdMs?: number;
  toleranceKg?: number;
}

// --- Config types ---

export interface SerialConfig {
  port: string;
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: number;
  simulate: boolean;
}

export interface AppConfig {
  stationId: string;
  serial: SerialConfig;
  api: { port: number };
  stability: { thresholdMs: number; toleranceKg: number };
  logLevel: string;
}

// --- API types ---

export interface ServerContext {
  stabilityDetector: StabilityDetector;
  weightReader: WeightReader;
  config: AppConfig;
}

// Augment Express Request to include our context
declare global {
  namespace Express {
    interface Request {
      ctx: ServerContext;
    }
  }
}
