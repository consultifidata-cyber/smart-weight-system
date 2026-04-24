import { Router, type Request, type Response } from 'express';
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

  // ── Printer state ──────────────────────────────────────────────────────────
  // driver.healthCheck() delegates to CascadingPrintAdapter which handles
  // recovery internally — safe to call on every request (cached + non-destructive)
  let printerConnected = false;
  let printerAdapter   = 'unknown';
  let printerRecovering = false;

  try {
    printerConnected  = await driver.healthCheck();
    printerAdapter    = (driver as any).adapter?.getInfo?.() ?? config.printMode;
    printerRecovering = (driver as any).adapter?.recovering === true;
  } catch { /* treat as unavailable */ }

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
