import { Router, type Request, type Response } from 'express';
import type { PrinterDriver, PrintRequest, PrintResponse, HealthResponse, PrinterConfig } from '../../types.js';
import { getCachedHealth, setIsPrinting } from '../../hardware/printerHealthCache.js';
import logger from '../../utils/logger.js';

// ── Worker Summary TSPL builder ───────────────────────────────────────────────
// Produces a text-only strip label matching the layout spec:
//   50 mm wide, variable height, font "2" 1× (12 dots/char, 16 dots tall)
//   Line height: 20 dots (16 char + 4 gap) = 2.5 mm per line
//   31 usable chars per line at left margin 10 dots
//
// Column layout (31 chars):  WID(5) + ' ' + NAME(12) + ' ' + ITEM(7) + ' ' + BAGS(4)
function buildWorkerSummaryTSPL(summary: Record<string, unknown>): Buffer {
  const FONT   = '2';
  const LINE_H = 20;        // dots per line (16 char height + 4 gap)
  const DPM    = 8;         // dots per mm at 203 DPI
  const LEFT_X = 10;        // left margin dots
  const CHARS  = 31;        // max printable chars per line
  const DASH   = '-'.repeat(CHARS);

  // Column widths (chars) — must sum to CHARS with separating spaces
  const C_WID  = 5;   // worker_id   (e.g. "W001 ")
  const C_NAME = 12;  // worker_name (2-word truncation done by backend; pad here)
  const C_ITEM = 7;   // item name   (hard-cut, ASCII only)
  const C_BAGS = 4;   // bags count  (right-aligned)
  // 5+1+12+1+7+1+4 = 31 ✓

  // Strip non-ASCII and double-quotes (TSPL TEXT uses " as string delimiter)
  const sanitize = (s: string): string =>
    s.replace(/[^\x20-\x7E]/g, '?').replace(/"/g, "'");

  const rpad = (s: string, n: number): string => sanitize(String(s)).slice(0, n).padEnd(n);
  const lpad = (v: string | number, n: number): string => String(v).slice(-n).padStart(n);

  const dataRow = (wid: string, name: string, item: string, bags: number | string): string =>
    rpad(wid, C_WID) + ' ' + rpad(name, C_NAME) + ' ' + rpad(item, C_ITEM) + ' ' + lpad(bags, C_BAGS);

  const subtotalRow = (bags: number): string => {
    const indent = C_WID + 1 + C_NAME + 1;  // 19 spaces (aligns under ITEM column)
    return ' '.repeat(indent) + rpad('Sub:', C_ITEM) + ' ' + lpad(bags, C_BAGS);
  };

  // "2026-04-26" → "26-Apr-2026"
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDate = (iso: string): string => {
    const p = iso.split('-');
    if (p.length !== 3) return iso;
    const m = parseInt(p[1], 10) - 1;
    return `${p[2]}-${MONTHS[m] ?? '?'}-${p[0]}`;
  };

  // ── Build text lines ────────────────────────────────────────────────────────
  const lines: string[] = [];
  const station  = sanitize(String(summary.station   ?? 'ST01'));
  const dateStr  = fmtDate(String(summary.date       ?? ''));
  const shiftStr = `Shift ${String(summary.shift ?? '?')}`;

  lines.push(DASH);
  lines.push(`${station.padEnd(6)}${dateStr}  ${shiftStr}`);
  lines.push(DASH);
  lines.push(dataRow('WID', 'Name', 'Item', 'Bags'));
  lines.push(DASH);

  const rows       = Array.isArray(summary.rows)             ? summary.rows             : [];
  const subTotals  = Array.isArray(summary.worker_subtotals) ? summary.worker_subtotals : [];
  const subMap: Record<string, number> = {};
  (subTotals as Array<{ worker_id: string; bags: number }>)
    .forEach(w => { subMap[String(w.worker_id)] = Number(w.bags); });

  let prevWid: string | null = null;
  (rows as Array<{ worker_id: string; worker_name: string; item: string; bags: number }>)
    .forEach((r, i) => {
      const wid  = String(r.worker_id   ?? '');
      const name = String(r.worker_name ?? '');
      const item = String(r.item        ?? '');
      const bags = Number(r.bags        ?? 0);

      // Worker boundary: emit previous worker's subtotal + separator
      if (prevWid !== null && wid !== prevWid) {
        lines.push(subtotalRow(subMap[prevWid] ?? 0));
        lines.push(DASH);
      }

      lines.push(dataRow(wid, name, item, bags));
      prevWid = wid;

      // Last row: emit final worker's subtotal
      if (i === rows.length - 1) {
        lines.push(subtotalRow(subMap[wid] ?? 0));
      }
    });

  // Footer
  lines.push(DASH);
  lines.push(`GRAND TOTAL: ${String(summary.grand_total ?? 0)} bags`);
  lines.push(DASH);

  // ── Calculate label height ──────────────────────────────────────────────────
  const PAD_TOP  = 8;   // dots before first line
  const PAD_BOT  = 16;  // dots after last line
  const heightMm = Math.ceil((PAD_TOP + lines.length * LINE_H + PAD_BOT) / DPM);

  // ── Assemble TSPL commands ──────────────────────────────────────────────────
  const cmds: string[] = [
    `SIZE 50 mm, ${heightMm} mm`,
    'GAP 2 mm, 0 mm',
    'DIRECTION 1',
    'DENSITY 14',
    'SPEED 2',
    'CLS',
    ...lines.map((line, i) =>
      `TEXT ${LEFT_X},${PAD_TOP + i * LINE_H},"${FONT}",0,1,1,"${line}"`),
    'PRINT 1,1',
  ];

  return Buffer.from(cmds.join('\r\n') + '\r\n', 'utf-8');
}

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
    if (!body.product || !body.stationId || !body.line1 || !body.line2 ||
        body.weight === undefined || body.weight === null || typeof body.weight !== 'number' || body.weight <= 0 || !isFinite(body.weight)) {
      res.status(400).json({
        status: 'error',
        error: 'Missing required fields: product, weight, stationId, line1, line2',
      });
      return;
    }

    // H1.2 — Pre-flight: reject job immediately if printer is not connected.
    // Prevents silent job queuing in the Windows spooler when printer is unplugged.
    // The background probe (5 s interval) keeps this cache current.
    if (!getCachedHealth()) {
      res.status(503).json({
        status:  'error',
        error:   'printer_disconnected',
        message: 'Printer is not connected. Check USB cable.',
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

    // Pause health probe during send — avoids competing with the spooler
    setIsPrinting(true);
    try {
      await driver.send(commands, config.sendTimeoutMs);
    } finally {
      setTimeout(() => setIsPrinting(false), 2000);
    }

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

router.get('/health', (req: Request, res: Response) => {
  const { config } = req.ctx as { driver: PrinterDriver; config: any };

  try {
    // Read from background probe cache — O(1), never times out.
    // The probe runs every 30 s with 3-failure hysteresis in printerHealthCache.ts.
    const connected = getCachedHealth();

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

/**
 * POST /print/worker-summary
 * Accepts the JSON from GET /bags/worker-summary, builds a text-only
 * TSPL strip, and sends it to the label printer.
 */
router.post('/worker-summary', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: PrinterConfig };

  try {
    const summary = req.body as Record<string, unknown>;

    if (!summary || !Array.isArray(summary.rows)) {
      res.status(400).json({ status: 'error', error: 'Invalid summary — expected rows array.' });
      return;
    }

    if ((summary.grand_total as number) === 0) {
      res.status(400).json({ status: 'error', error: 'Nothing to print — grand total is 0.' });
      return;
    }

    const commands = buildWorkerSummaryTSPL(summary);
    await driver.send(commands, config.sendTimeoutMs);

    logger.info(
      { station: summary.station, date: summary.date, shift: summary.shift, rows: (summary.rows as unknown[]).length },
      'Worker summary printed',
    );
    res.json({ status: 'ok', printedAt: new Date().toISOString() });

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Worker summary print failed');
    res.status(503).json({ status: 'error', error });
  }
});

router.post('/reset', async (req: Request, res: Response) => {
  const { driver } = req.ctx as { driver: PrinterDriver; config: any };

  try {
    logger.info('Printer reset requested');
    await driver.resetPrinter();
    const connected = await driver.healthCheck();
    logger.info({ connected }, 'Printer reset complete');
    res.json({ status: connected ? 'ok' : 'error', connected });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Printer reset failed');
    res.status(503).json({ status: 'error', error });
  }
});

export const printRouter = router;
