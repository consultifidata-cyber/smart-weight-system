import { Router, type Request, type Response } from 'express';
import { detectScales, clearScaleDetectionCache } from '../../hardware/scaleDetect.js';
import logger from '../../utils/logger.js';

const router = Router();

/**
 * GET /hardware/scales
 *
 * Scans all serial ports and returns USB-serial adapter candidates ranked by
 * confidence.  Includes the currently configured port and connection status.
 *
 * Query params:
 *   ?refresh=true   — bypass 10 s cache, re-scan immediately
 *
 * Response shape:
 * {
 *   ok: true,
 *   ports: [
 *     {
 *       path, vendorId, productId, manufacturer, friendlyName,
 *       confidence, reason, serialNumber, pnpId
 *     }, ...
 *   ],
 *   selected: { ... } | null,
 *   selectionReason: "string",
 *   configuredPort: "COM3",
 *   activePort: "COM3",
 *   connected: true,
 *   simulate: false,
 *   totalPortCount: 4,
 *   detectedAt: "ISO timestamp"
 * }
 */
router.get('/scales', async (req: Request, res: Response) => {
  try {
    const { weightReader, config } = req.ctx;
    const forceRefresh = req.query['refresh'] === 'true';

    const result = await detectScales(undefined, forceRefresh);

    res.json({
      ok:              true,
      ports:           result.ports,
      selected:        result.selected,
      selectionReason: result.selectionReason,
      // Runtime state from the live WeightReader
      configuredPort:  config.serial.simulate ? 'SIMULATED' : config.serial.port,
      activePort:      weightReader.isConnected
        ? (config.serial.simulate ? 'SIMULATED' : config.serial.port)
        : null,
      connected:       weightReader.isConnected,
      simulate:        config.serial.simulate,
      totalPortCount:  result.totalPortCount,
      detectedAt:      result.detectedAt,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, '[hardware-scales] Detection failed');
    res.status(500).json({ ok: false, error });
  }
});

/**
 * POST /hardware/scales/refresh
 *
 * Force-invalidates the detection cache and re-scans.
 * Call this after reconnecting the scale cable.
 */
router.post('/scales/refresh', async (req: Request, res: Response) => {
  try {
    clearScaleDetectionCache();
    const result = await detectScales(undefined, true);
    logger.info(
      { count: result.ports.length, selected: result.selected?.path },
      '[hardware-scales] Forced refresh complete',
    );
    res.json({
      ok:              true,
      ports:           result.ports,
      selected:        result.selected,
      selectionReason: result.selectionReason,
      totalPortCount:  result.totalPortCount,
      detectedAt:      result.detectedAt,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error });
  }
});

export const hardwareRouter = router;
