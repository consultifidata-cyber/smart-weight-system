/**
 * Background printer health probe with hysteresis.
 *
 * Problem it solves:
 *   The Windows spooler (Get-Printer / WMI) can take 3-10 s to respond
 *   under benign load. Calling healthCheck() on every HTTP request
 *   or every 10 s creates frequent timeouts that the UI misreads as
 *   "printer offline", causing the status dot to flicker red and the
 *   "System not ready" overlay to appear.
 *
 * Design:
 *   - Background probe runs every 30 s with a 10 s generous timeout.
 *   - HTTP handlers read the cached boolean — always O(1), never blocks.
 *   - Hysteresis: 3 consecutive failures required before state flips to
 *     "unavailable". A single timeout does not flip state.
 *   - Probe is skipped while a print job is in progress (avoids
 *     competing with the spooler).
 *   - Optimistic start: _healthy = true so the first /system/status
 *     call returns "connected" immediately without waiting for the
 *     first probe to complete.
 */

import type { PrinterDriver } from '../types.js';
import logger from '../utils/logger.js';

const PROBE_INTERVAL_MS = 30_000;   // background probe cadence
const FAIL_THRESHOLD    = 3;         // consecutive failures to flip unavailable
const PROBE_TIMEOUT_MS  = 10_000;   // generous — spooler can be slow

let _healthy          = true;        // optimistic: don't block first request
let _consecutiveFails = 0;
let _timerId: ReturnType<typeof setInterval> | null = null;
let _isPrinting       = false;

/** Read current cached state — O(1), never blocks. */
export function getCachedHealth(): boolean {
  return _healthy;
}

/** Signal that a print job is in progress — probe is paused. */
export function setIsPrinting(v: boolean): void {
  _isPrinting = v;
}

/** Start the background probe loop. Safe to call multiple times. */
export function startProbe(driver: PrinterDriver): void {
  if (_timerId !== null) return;

  const runProbe = async (): Promise<void> => {
    if (_isPrinting) {
      logger.debug('[health-probe] Skipped — print in progress');
      return;
    }

    let ok = false;
    try {
      ok = await driver.healthCheck(PROBE_TIMEOUT_MS);
    } catch {
      ok = false;
    }

    if (ok) {
      if (!_healthy) {
        logger.info('[health-probe] Printer recovered');
      }
      _consecutiveFails = 0;
      _healthy = true;
    } else {
      _consecutiveFails++;
      if (_consecutiveFails >= FAIL_THRESHOLD && _healthy) {
        logger.warn(
          { consecutiveFails: _consecutiveFails },
          'Printer unavailable — will retry next heartbeat',
        );
        _healthy = false;
      } else if (_consecutiveFails < FAIL_THRESHOLD) {
        logger.debug(
          { consecutiveFails: _consecutiveFails, threshold: FAIL_THRESHOLD },
          '[health-probe] Failed probe — hysteresis active, not yet marking unavailable',
        );
      }
    }
  };

  // First probe immediately but non-blocking
  runProbe().catch(() => {});

  _timerId = setInterval(() => { runProbe().catch(() => {}); }, PROBE_INTERVAL_MS);

  logger.info(
    { intervalMs: PROBE_INTERVAL_MS, failThreshold: FAIL_THRESHOLD, timeoutMs: PROBE_TIMEOUT_MS },
    '[health-probe] Background printer health probe started',
  );
}

/** Stop the probe loop on graceful shutdown. */
export function stopProbe(): void {
  if (_timerId !== null) {
    clearInterval(_timerId);
    _timerId = null;
  }
}

/**
 * Test-only: reset module state so each test starts with a known cache value.
 * Never import this in production code.
 */
export function _resetForTest(healthy = true): void {
  _healthy          = healthy;
  _consecutiveFails = 0;
  _isPrinting       = false;
  stopProbe();
}
