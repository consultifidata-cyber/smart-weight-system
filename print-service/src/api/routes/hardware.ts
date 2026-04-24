import { Router, type Request, type Response } from 'express';
import { detectPrinters, clearDetectionCache } from '../../hardware/printerDetect.js';
import { detectAll, refresh, getDiagnostics } from '../../hardware/hardwareManager.js';
import logger from '../../utils/logger.js';

const router = Router();

/**
 * GET /hardware/printers
 *
 * Probes USB device paths and queries PnP metadata to return all detected
 * label printers with VID/PID, protocol guess, and the auto-selected device.
 *
 * Query params:
 *   ?refresh=true   — bypass 10s cache, run fresh detection
 *
 * Response shape:
 * {
 *   ok: true,
 *   printers: [ { devicePath, vid, pid, name, likelyProtocol, writable, ... } ],
 *   selected: { ... } | null,
 *   selectionReason: "string",
 *   detectedAt: "ISO timestamp",
 *   platformSupported: true
 * }
 */
router.get('/printers', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query['refresh'] === 'true';
    const result = await detectPrinters('TSPL', forceRefresh);

    res.json({
      ok:               true,
      printers:         result.printers,
      selected:         result.selected,
      selectionReason:  result.selectionReason,
      detectedAt:       result.detectedAt,
      platformSupported: result.platformSupported,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, '[hardware-route] Detection failed');
    res.status(500).json({ ok: false, error });
  }
});

/**
 * POST /hardware/printers/refresh
 *
 * Forces cache invalidation and runs a fresh detection.
 * Useful after manually connecting a printer.
 */
router.post('/printers/refresh', async (req: Request, res: Response) => {
  try {
    clearDetectionCache();
    const result = await detectPrinters('TSPL', true);
    logger.info(
      { count: result.printers.length, selected: result.selected?.devicePath },
      '[hardware-route] Forced refresh complete',
    );
    res.json({
      ok:              true,
      printers:        result.printers,
      selected:        result.selected,
      selectionReason: result.selectionReason,
      detectedAt:      result.detectedAt,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error });
  }
});

// ── GET /hardware/status ──────────────────────────────────────────────────────

/**
 * GET /hardware/status
 *
 * Unified view of both printer and scale readiness.
 * Calls printerDetect (local) + weight-service /hardware/scales (HTTP, 3s timeout).
 *
 * Response shape:
 * {
 *   ok: true,
 *   printer: { detected, devicePath, vid, pid, name, confidence, writable, warning, ... },
 *   scale:   { detected, path, vendorId, connected, confidence, warning, serviceReachable, ... },
 *   warnings: ["...", "..."],
 *   readyForProduction: true/false,
 *   mode: { printMode, printerInterface, printerAutoDetect, scaleSimulate },
 *   checkedAt: "ISO"
 * }
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await detectAll();
    res.status(status.ok ? 200 : 503).json({ ok: status.ok, ...status });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, '[hardware/status] detectAll failed');
    res.status(500).json({ ok: false, error });
  }
});

/**
 * POST /hardware/status/refresh
 *
 * Force-clears all detection caches and re-checks both devices.
 */
router.post('/status/refresh', async (_req: Request, res: Response) => {
  try {
    const status = await refresh();
    logger.info(
      { readyForProduction: status.readyForProduction, warnings: status.warnings.length },
      '[hardware/status] Forced refresh complete',
    );
    res.json({ ok: status.ok, ...status });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error });
  }
});

// ── GET /hardware/diagnostics ─────────────────────────────────────────────────

/**
 * GET /hardware/diagnostics
 *
 * Full diagnostic bundle for support and pre-install validation.
 * Includes:
 *   - app version, OS, Node.js version
 *   - all printer candidates with VID/PID
 *   - all scale candidates with confidence
 *   - current config (sensitive values excluded)
 *   - last health check results
 *   - human-readable warnings
 *
 * NEVER includes: DJANGO_API_TOKEN, database paths, private keys.
 */
router.get('/diagnostics', async (_req: Request, res: Response) => {
  try {
    const report = await getDiagnostics();
    res.json({ ok: true, ...report });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, '[hardware/diagnostics] Report generation failed');
    res.status(500).json({ ok: false, error });
  }
});

export const hardwareRouter = router;
