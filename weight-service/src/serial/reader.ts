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
  /** Phase E: force-close port if no data received for this many ms (0 = disabled). */
  noDataTimeoutMs?: number;
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

  // Phase E: no-data watchdog ─────────────────────────────────────────────────
  // Fixes the "one bag works then weight freezes" symptom caused by Windows USB
  // Selective Suspend putting the CH340/FTDI adapter into low-power mode while
  // port.isOpen stays true — no close/error event fires, so openWithRetry()
  // would never trigger without this watchdog.
  private lastDataAt = 0;                                            // epoch ms of last line received
  private noDataWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly noDataTimeoutMs: number;

  // How often the watchdog interval fires (at most every 5 s, at least timeout/3).
  // Using timeout/3 catches a freeze within one full timeout window.
  private get _watchdogIntervalMs(): number {
    return Math.min(Math.ceil(this.noDataTimeoutMs / 3), 5000);
  }

  constructor(serialConfig: WeightReaderConfig, options: WeightReaderOptions = {}) {
    super();
    this.serialConfig   = serialConfig;
    this.configuredPort = serialConfig.port;
    this.binding        = options.binding || undefined;
    // Disable watchdog for simulator (binding present) or when explicitly set to 0
    this.noDataTimeoutMs = (options.binding || (serialConfig.noDataTimeoutMs ?? 0) <= 0)
      ? 0
      : (serialConfig.noDataTimeoutMs ?? 15000);
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
          try { this.port?.close(); } catch { /* ignore */ }
          reject(new Error(`Timeout opening ${this.serialConfig.port} (${OPEN_TIMEOUT_MS}ms)`));
        }
      }, OPEN_TIMEOUT_MS);

      this.port!.open((err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          logger.error({ port: this.serialConfig.port, err: err.message }, 'Failed to open serial port');
          reject(err);
          return;
        }
        this.reconnectAttempts = 0;
        this.lastDataAt = Date.now();      // Phase E: reset clock on successful open
        this._startNoDataWatchdog();       // Phase E: begin watching for data silence
        logger.info(
          {
            port:            this.serialConfig.port,
            baudRate:        this.serialConfig.baudRate,
            watchdogMs:      this.noDataTimeoutMs || 'disabled',
          },
          'Serial port opened',
        );
        this.emit('open');
        resolve();
      });
    });
  }

  // ── Phase E: no-data watchdog ──────────────────────────────────────────────

  private _startNoDataWatchdog(): void {
    if (!this.noDataTimeoutMs) return;   // disabled
    this._stopNoDataWatchdog();

    this.noDataWatchdogTimer = setInterval(() => {
      if (!this.port?.isOpen || this.closing) return;

      const silentMs = Date.now() - this.lastDataAt;
      if (silentMs >= this.noDataTimeoutMs) {
        logger.warn(
          {
            port:      this.serialConfig.port,
            silentMs,
            threshold: this.noDataTimeoutMs,
          },
          '[watchdog] No scale data received — forcing port reconnect ' +
          '(likely USB Selective Suspend or CH340 driver freeze)',
        );
        this._stopNoDataWatchdog();
        // Force-close the port.  _onClose() fires → openWithRetry() restarts.
        // This is identical to a physical USB disconnect/reconnect from the
        // software perspective.
        try { this.port!.close(); } catch { /* _onClose() will handle */ }
      }
    }, this._watchdogIntervalMs);
  }

  private _stopNoDataWatchdog(): void {
    if (this.noDataWatchdogTimer) {
      clearInterval(this.noDataWatchdogTimer);
      this.noDataWatchdogTimer = null;
    }
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
    this.lastDataAt = Date.now();   // Phase E: heartbeat — resets the watchdog clock
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
    this._stopNoDataWatchdog();   // Phase E: stop watchdog before reconnect
    logger.warn('Serial port closed');
    this.emit('close');

    if (!this.closing) {
      this.reconnectAttempts = 0;
      this.lastLogAt = 0;
      this.autoDetectDone = false;
      logger.info('Attempting reconnection...');
      this.openWithRetry().catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this._stopNoDataWatchdog();   // Phase E
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

  /** Phase E: milliseconds since the last raw line was received (0 if never). */
  get dataAgeSec(): number {
    return this.lastDataAt ? Math.floor((Date.now() - this.lastDataAt) / 1000) : 0;
  }

  /** Phase E: configured watchdog timeout in ms (0 = disabled). */
  get watchdogMs(): number {
    return this.noDataTimeoutMs;
  }
}
