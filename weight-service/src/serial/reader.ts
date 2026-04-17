import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { parse } from './parser.js';
import logger from '../utils/logger.js';
import type { WeightReading } from '../types.js';

const BASE_DELAY_MS = 3000;
const MAX_DELAY_MS = 30000;
const LOG_EVERY_ATTEMPT_THRESHOLD = 10;          // log first N attempts in detail
const LOG_THROTTLE_INTERVAL_MS = 5 * 60 * 1000;  // then one line every 5 min

export interface WeightReaderConfig {
  port: string;
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: number;
}

export interface WeightReaderOptions {
  binding?: unknown;
}

export class WeightReader extends EventEmitter {
  private serialConfig: WeightReaderConfig;
  private binding: unknown;
  public port: SerialPort | null = null;
  private lineParser: ReadlineParser | null = null;
  private reconnectAttempts = 0;
  private lastLogAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(serialConfig: WeightReaderConfig, options: WeightReaderOptions = {}) {
    super();
    this.serialConfig = serialConfig;
    this.binding = options.binding || undefined;
  }

  async open(): Promise<void> {
    this.closing = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {
      path: this.serialConfig.port,
      baudRate: this.serialConfig.baudRate,
      dataBits: this.serialConfig.dataBits,
      parity: this.serialConfig.parity,
      stopBits: this.serialConfig.stopBits,
      autoOpen: false,
    };

    if (this.binding) {
      opts.binding = this.binding;
    }

    this.port = new SerialPort(opts);
    this.lineParser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    this.lineParser.on('data', (line: string) => this._onLine(line));
    this.port.on('error', (err: Error) => this._onError(err));
    this.port.on('close', () => this._onClose());

    return new Promise<void>((resolve, reject) => {
      this.port!.open((err: Error | null) => {
        if (err) {
          logger.error({ port: this.serialConfig.port, err: err.message }, 'Failed to open serial port');
          reject(err);
          return;
        }
        this.reconnectAttempts = 0;
        logger.info({ port: this.serialConfig.port, baudRate: this.serialConfig.baudRate }, 'Serial port opened');
        this.emit('open');
        resolve();
      });
    });
  }

  async openWithRetry(): Promise<void> {
    // Infinite retry: loop until port opens successfully or service shuts down.
    // Log first N attempts in detail, then throttle to one line every 5 min
    // to keep logs bounded during long offline periods (e.g. overnight power cut).
    while (!this.closing) {
      try {
        await this.open();
        this.lastLogAt = 0;
        return;
      } catch {
        this.reconnectAttempts++;
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1), MAX_DELAY_MS);

        const now = Date.now();
        const shouldLog =
          this.reconnectAttempts <= LOG_EVERY_ATTEMPT_THRESHOLD ||
          now - this.lastLogAt >= LOG_THROTTLE_INTERVAL_MS;

        if (shouldLog) {
          if (this.reconnectAttempts === LOG_EVERY_ATTEMPT_THRESHOLD + 1) {
            logger.warn('Serial port still offline — throttling reconnect logs to once every 5 min');
          } else {
            logger.warn({ attempt: this.reconnectAttempts, retryInMs: delay }, 'Retrying serial port connection');
          }
          this.lastLogAt = now;
        }

        await new Promise<void>(r => { this.reconnectTimer = setTimeout(r, delay); });
      }
    }
  }

  private _onLine(rawLine: string): void {
    const reading: WeightReading | null = parse(rawLine);
    if (reading) {
      this.emit('reading', reading);
    } else {
      logger.debug({ rawLine }, 'Unparseable serial data');
    }
  }

  private _onError(err: Error): void {
    logger.error({ err: err.message }, 'Serial port error');
    this.emit('error', err);
  }

  private _onClose(): void {
    logger.warn('Serial port closed');
    this.emit('close');

    if (!this.closing) {
      this.reconnectAttempts = 0;
      this.lastLogAt = 0;
      logger.info('Attempting reconnection...');
      this.openWithRetry().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.port && this.port.isOpen) {
      return new Promise<void>((resolve) => {
        this.port!.close((err: Error | null) => {
          if (err) logger.warn({ err: err.message }, 'Error closing serial port');
          resolve();
        });
      });
    }
  }

  get isConnected(): boolean {
    return this.port?.isOpen ?? false;
  }
}
