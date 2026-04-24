import { MockBinding } from '@serialport/binding-mock';
import type { SerialPort } from 'serialport';
import logger from '../utils/logger.js';

// MockBinding requires a valid-looking port name for each platform.
// '/dev/SIMULATED' is rejected by serialport on Windows; use a high COM number
// that is virtually guaranteed to not exist as a real device.
export const SIMULATED_PATH = process.platform === 'win32' ? 'COM99' : '/dev/SIMULATED';
const EMIT_INTERVAL_MS = 200; // 5 Hz

type SimPhase = 'idle' | 'settling' | 'stable' | 'removing';

interface MockPort {
  emitData(data: Buffer): void;
}

/**
 * Simulates an Essae DS-252 weighing scale by writing realistic
 * ASCII weight data into a mock serial port.
 *
 * Cycles through: empty -> settling -> stable -> removing -> repeat
 */
export class WeightSimulator {
  readonly path = SIMULATED_PATH;
  private port: MockPort | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private phase: SimPhase = 'idle';
  private phaseStart = 0;
  private targetWeight = 0;
  private currentWeight = 0;
  cycleCount = 0;

  /** Initialize the mock binding and return it for injection into WeightReader. */
  init(): typeof MockBinding {
    MockBinding.createPort(this.path, { echo: false, record: true });
    logger.info({ path: this.path }, 'Simulator mock port created');
    return MockBinding;
  }

  /**
   * Start emitting simulated weight data.
   * @param serialPort - The opened SerialPort instance (its .port property gives access to the mock binding)
   */
  start(serialPort: SerialPort): void {
    this.port = (serialPort as unknown as { port: MockPort }).port;
    if (!this.port || typeof this.port.emitData !== 'function') {
      logger.error('Simulator: could not access mock port binding. Is the port opened with MockBinding?');
      return;
    }

    this._startPhase('idle');
    this.intervalId = setInterval(() => this._tick(), EMIT_INTERVAL_MS);
    logger.info('Simulator started — cycling weight scenarios');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Simulator stopped');
  }

  private _startPhase(phase: SimPhase): void {
    this.phase = phase;
    this.phaseStart = Date.now();

    if (phase === 'idle') {
      this.currentWeight = 0;
      this.targetWeight = 0;
    } else if (phase === 'settling') {
      // Random target between 1 and 50 kg
      this.targetWeight = Math.round((Math.random() * 49 + 1) * 1000) / 1000;
      this.currentWeight = this.targetWeight * 1.08; // Start with overshoot
    }
  }

  private _tick(): void {
    const elapsed = Date.now() - this.phaseStart;

    switch (this.phase) {
      case 'idle':
        this.currentWeight = this._jitter(0, 0.005);
        if (elapsed > 3000) this._startPhase('settling');
        break;

      case 'settling':
        // Exponential decay toward target
        this.currentWeight = this.targetWeight + (this.currentWeight - this.targetWeight) * 0.85;
        if (elapsed > 2000) this._startPhase('stable');
        break;

      case 'stable':
        this.currentWeight = this._jitter(this.targetWeight, 0.01);
        if (elapsed > 5000) this._startPhase('removing');
        break;

      case 'removing':
        this.currentWeight = this.currentWeight * 0.7;
        if (this.currentWeight < 0.01) {
          this.currentWeight = 0;
          this.cycleCount++;
          this._startPhase('idle');
        }
        break;
    }

    this._emit(this.currentWeight);
  }

  private _jitter(base: number, amplitude: number): number {
    return base + (Math.random() - 0.5) * 2 * amplitude;
  }

  private _emit(weight: number): void {
    if (!this.port) return;

    const sign = weight >= 0 ? '+' : '-';
    const abs = Math.abs(weight).toFixed(3).padStart(7, '0');
    const line = `${sign}${abs}\r\n`;

    this.port.emitData(Buffer.from(line, 'ascii'));
  }
}
