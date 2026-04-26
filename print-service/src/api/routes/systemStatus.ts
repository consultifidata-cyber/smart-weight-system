import { Router, type Request, type Response } from 'express';
import { getCachedHealth } from '../../hardware/printerHealthCache.js';
import logger from '../../utils/logger.js';

const router = Router();

/**
 * GET /system/status
 *
 * Lightweight combined health status — fast, no detection scan.
 * Reads the live state of the CascadingPrintAdapter and queries
 * weight-service /health for scale state.
 *
 * Response:
 * {
 *   healthy: true,
 *   printer: { state: "connected" | "recovering" | "unavailable", adapter: "USBPRIN:01" },
 *   scale:   { state: "connected" | "recovering" | "unavailable", port: "COM3" },
 *   checkedAt: "ISO"
 * }
 *
 * HTTP 200 = healthy, HTTP 503 = degraded.
 */
router.get('/status', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx;

  // ── Printer state — read from background probe cache (O(1), never blocks) ──
  // The probe runs every 30 s in index.ts and requires 3 consecutive failures
  // before flipping to "unavailable". This endpoint never times out.
  let printerConnected  = getCachedHealth();
  let printerAdapter    = config.printMode;   // WINDOWS or RAW_DIRECT
  let printerRecovering = false;

  const printerState =
    printerConnected  ? 'connected'   :
    printerRecovering ? 'recovering'  : 'unavailable';

  // ── Scale state (weight-service /health) ───────────────────────────────────
  let scaleState     = 'unavailable';
  let scalePort: string | null = null;
  let scaleSimulate  = false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const r = await fetch(`${config.weightServiceUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const h = await r.json() as {
      serial?: { connected?: boolean; port?: string; simulate?: boolean };
    };
    const serial = h.serial ?? {};
    scaleSimulate = serial.simulate ?? false;
    scalePort     = serial.port ?? null;
    scaleState    = (serial.connected || scaleSimulate) ? 'connected' : 'recovering';
  } catch { /* weight-service unreachable */ }

  // ── Overall health ─────────────────────────────────────────────────────────
  const healthy =
    printerState === 'connected' &&
    (scaleState  === 'connected');

  const status = {
    healthy,
    printer: {
      state:     printerState,
      adapter:   printerAdapter,
      simulate:  false,
    },
    scale: {
      state:     scaleState,
      port:      scalePort,
      simulate:  scaleSimulate,
    },
    checkedAt: new Date().toISOString(),
  };

  if (!healthy) {
    logger.debug({ printerState, scaleState }, '[system-status] Degraded');
  }

  res.status(healthy ? 200 : 503).json(status);
});

export const systemStatusRouter = router;
