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
const AUTO_DETECT_AFTER_ATTEMPTS = 3;            // scan ports after this many failures
const OPEN_TIMEOUT_MS = 10000;                   // timeout for port.open()
const CLOSE_TIMEOUT_MS = 5000;                   // timeout for port.close()
const LIST_TIMEOUT_MS = 5000;                    // timeout for SerialPort.list()

// Known USB-to-serial adapter manufacturers (case-insensitive match)
const KNOWN_MANUFACTURERS = ['ftdi', 'prolific', 'ch340', 'wch', 'silicon labs', 'qinheng'];

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
  private autoDetectDone = false;
  private configuredPort: string;

  constructor(serialConfig: WeightReaderConfig, options: WeightReaderOptions = {}) {
    super();
    this.serialConfig = serialConfig;
    this.configuredPort = serialConfig.port;
    this.binding = options.binding || undefined;
  }

  async open(): Promise<void> {
    this.closing = false;

    // Clean up previous port/parser to prevent event listener accumulation
    if (this.port) {
      this.port.removeAllListeners();
      if (this.port.isOpen) {
        try { this.port.close(); } catch { /* ignore */ }
      }
      this.port = null;
    }
    if (this.lineParser) {
      this.lineParser.removeAllListeners();
      this.lineParser = null;
    }

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
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // Force-close the port to prevent late callback
          try { this.port?.close(); } catch { /* ignore */ }
          reject(new Error(`Timeout opening ${this.serialConfig.port} (${OPEN_TIMEOUT_MS}ms)`));
        }
      }, OPEN_TIMEOUT_MS);

      this.port!.open((err: Error | null) => {
        if (settled) return; // timeout already fired
        settled = true;
        clearTimeout(timer);
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
    // Clear any stale reconnect timer from a previous cycle
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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

        // After N failures on configured port, try auto-detection once
        if (this.reconnectAttempts === AUTO_DETECT_AFTER_ATTEMPTS && !this.autoDetectDone && !this.binding) {
          this.autoDetectDone = true;
          const detected = await this._autoDetectPort();
          if (detected) {
            // Port was found and opened successfully
            this.lastLogAt = 0;
            return;
          }
          // Auto-detect failed, continue normal backoff on configured port
        }

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

  /**
   * Scan available serial ports and try each candidate that matches known
   * USB-to-serial adapter manufacturers. Returns true if a port was
   * successfully opened.
   */
  private async _autoDetectPort(): Promise<boolean> {
    logger.info(
      { configuredPort: this.configuredPort },
      'Configured port failed 3 times — scanning for available serial ports',
    );

    let ports: Awaited<ReturnType<typeof SerialPort.list>>;
    try {
      ports = await Promise.race([
        SerialPort.list(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`SerialPort.list() timed out (${LIST_TIMEOUT_MS}ms)`)), LIST_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to list serial ports');
      return false;
    }

    if (ports.length === 0) {
      logger.warn('No serial ports found during auto-detection');
      return false;
    }

    // Filter to known manufacturers, excluding the already-tried configured port
    const candidates = ports.filter(p => {
      if (p.path === this.configuredPort) return false;
      const mfr = (p.manufacturer || '').toLowerCase();
      return KNOWN_MANUFACTURERS.some(known => mfr.includes(known));
    });

    if (candidates.length === 0) {
      logger.warn(
        { availablePorts: ports.map(p => ({ path: p.path, manufacturer: p.manufacturer })) },
        'No matching USB-to-serial adapters found during auto-detection',
      );
      return false;
    }

    logger.info(
      { candidates: candidates.map(p => ({ path: p.path, manufacturer: p.manufacturer })) },
      'Found candidate serial ports — trying each',
    );

    for (const candidate of candidates) {
      if (this.closing) return false;

      try {
        this.serialConfig = { ...this.serialConfig, port: candidate.path };
        await this.open();
        logger.info(
          { detectedPort: candidate.path, manufacturer: candidate.manufacturer },
          'Auto-detected serial port — connection successful',
        );
        return true;
      } catch {
        logger.debug({ port: candidate.path }, 'Auto-detect candidate failed');
      }
    }

    // All candidates failed, restore configured port for normal retry loop
    this.serialConfig = { ...this.serialConfig, port: this.configuredPort };
    logger.warn('All auto-detect candidates failed — resuming retry on configured port');
    return false;
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
      this.autoDetectDone = false; // Allow auto-detection again on next disconnect
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
        const timer = setTimeout(() => {
          logger.warn('Serial port close timed out, forcing');
          resolve();
        }, CLOSE_TIMEOUT_MS);
        this.port!.close((err: Error | null) => {
          clearTimeout(timer);
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
