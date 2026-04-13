import type { StabilityInput, StabilityResult, StabilityState, StabilityOptions } from '../types.js';

interface Anchor {
  weight: number;
  time: number;
}

interface LastReading extends StabilityInput {
  receivedAt: number;
}

/**
 * Determines when the weight reading is stable (consistent for a duration).
 *
 * Algorithm: Anchor the first reading. If subsequent readings stay within
 * +/-toleranceKg of the anchor for thresholdMs, declare stable and lock
 * the stableWeight to the anchor value (clean, non-jittery).
 */
export class StabilityDetector {
  private thresholdMs: number;
  private toleranceKg: number;
  private anchor: Anchor | null = null;
  private stable = false;
  private stableWeight: number | null = null;
  private lastReading: LastReading | null = null;

  constructor({ thresholdMs = 1500, toleranceKg = 0.02 }: StabilityOptions = {}) {
    this.thresholdMs = thresholdMs;
    this.toleranceKg = toleranceKg;
  }

  update(reading: StabilityInput): StabilityResult {
    const now = Date.now();
    this.lastReading = { ...reading, receivedAt: now };

    // Null/overload — reset
    if (reading.weight === null || reading.weight === undefined || reading.overload) {
      this._reset();
      return { weight: null, stable: false, stableWeight: null };
    }

    const w = reading.weight;

    // No anchor yet, or reading deviates beyond tolerance — start fresh
    if (this.anchor === null || Math.abs(w - this.anchor.weight) > this.toleranceKg) {
      this.anchor = { weight: w, time: now };
      this.stable = false;
      this.stableWeight = null;
      return { weight: w, stable: false, stableWeight: null };
    }

    // Within tolerance — check duration
    if (now - this.anchor.time >= this.thresholdMs) {
      this.stable = true;
      this.stableWeight = this.anchor.weight;
    }

    return {
      weight: w,
      stable: this.stable,
      stableWeight: this.stableWeight,
    };
  }

  getState(): StabilityState {
    return {
      weight: this.lastReading?.weight ?? null,
      stable: this.stable,
      stableWeight: this.stableWeight,
      lastReadingAt: this.lastReading?.receivedAt ?? null,
    };
  }

  private _reset(): void {
    this.anchor = null;
    this.stable = false;
    this.stableWeight = null;
  }
}
