import { Router, type Request, type Response } from 'express';
import type { PrinterDriver, PrintRequest, PrintResponse, HealthResponse } from '../../types.js';
import logger from '../../utils/logger.js';

const router = Router();

// In-memory store of recent print requests for deduplication (2s window)
const recentPrints = new Map<string, number>();

function generateEntryId(stationId: string): string {
  const now = new Date();
  const date = now.toISOString().substring(0, 10).replace(/-/g, '');
  const time = now.toISOString().substring(11, 19).replace(/:/g, '');
  return `${stationId}-${date}-${time}`;
}

function generateQRContent(product: string, weight: number, stationId: string): string {
  const timestamp = new Date().toISOString().substring(0, 19);
  return `${product}|${weight.toFixed(2)}kg|${stationId}|${timestamp}`;
}

router.post('/print', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: any };

  try {
    const body = req.body as PrintRequest;

    // Validate required fields
    if (!body.product || body.weight === undefined || !body.stationId || !body.line1 || !body.line2) {
      res.status(400).json({
        status: 'error',
        error: 'Missing required fields: product, weight, stationId, line1, line2',
      });
      return;
    }

    // Generate entry ID and QR content
    const entryId = generateEntryId(body.stationId);
    const qrContent = body.qrContent || generateQRContent(body.product, body.weight, body.stationId);

    // Deduplication: reject if identical request within 2s
    const requestKey = `${body.product}|${body.weight}|${entryId}`;
    const lastPrintTime = recentPrints.get(requestKey);
    if (lastPrintTime && Date.now() - lastPrintTime < 2000) {
      logger.warn({ requestKey }, 'Duplicate print request rejected');
      res.status(429).json({
        status: 'error',
        error: 'Duplicate print request. Please wait before printing again.',
      });
      return;
    }

    // Build label data
    const labelWidth = body.labelWidth || config.labelWidth;
    const labelHeight = body.labelHeight || config.labelHeight;

    const labelData = {
      qrContent,
      textLines: [body.line1, body.line2],
      labelWidth,
      labelHeight,
      entryId,
    };

    // Build TSPL commands
    const commands = driver.buildLabel(labelData);

    // Send to printer
    await driver.sendWin(commands);

    // Record this print request
    recentPrints.set(requestKey, Date.now());

    // Cleanup old entries (>5s)
    for (const [key, time] of recentPrints.entries()) {
      if (Date.now() - time > 5000) {
        recentPrints.delete(key);
      }
    }

    logger.info({ entryId, product: body.product, weight: body.weight }, 'Print successful');

    const response: PrintResponse = {
      status: 'ok',
      entryId,
      printedAt: new Date().toISOString(),
    };

    res.status(200).json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Print failed');

    const response: PrintResponse = {
      status: 'error',
      error: `Printer error: ${error}`,
    };

    res.status(503).json(response);
  }
});

router.get('/health', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: any };

  try {
    const connected = await driver.healthCheckWin();

    const response: HealthResponse = {
      printer: {
        driver: config.driver,
        device: config.device,
        connected,
      },
      service: 'print-service',
      stationId: config.stationId,
      status: connected ? 'ok' : 'error',
    };

    const statusCode = connected ? 200 : 503;
    res.status(statusCode).json(response);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Health check failed');

    const response: HealthResponse = {
      printer: {
        driver: config.driver,
        device: config.device,
        connected: false,
      },
      service: 'print-service',
      stationId: config.stationId,
      status: 'error',
    };

    res.status(503).json(response);
  }
});

export const printRouter = router;
