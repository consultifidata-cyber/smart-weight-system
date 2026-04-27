/**
 * Report print endpoints — v2.3.0 (item-wise, local data source)
 *
 * POST /print/report-workers  — all-workers, item breakdown (multi-label)
 * POST /print/report-worker   — single worker, all items for the day
 *
 * Data comes from the local sync-service /bags/worker-summary endpoint,
 * NOT from Django. This means reports work offline and are item-wise.
 *
 * Label width: 50 mm (400 dots at 203 DPI).
 * Height: variable per label — works for continuous roll and pre-cut.
 * Each label fits within 50 mm height.
 */

import { Router, type Request, type Response } from 'express';
import { getCachedHealth } from '../../hardware/printerHealthCache.js';
import logger from '../../utils/logger.js';
import type { PrinterDriver, PrinterConfig } from '../../types.js';

const router = Router();

// ── TSPL constants ────────────────────────────────────────────────────────────

const FONT   = '2';
const LINE_H = 20;        // 16 dots char + 4 dots gap
const DPM    = 8;         // dots per mm at 203 DPI
const LEFT_X = 10;
const CHARS  = 31;        // (400 dots - 10 left - 10 right) / 12 dots/char
const DASH   = '-'.repeat(CHARS);

const rpad = (s: string | number, n: number): string =>
  String(s).replace(/"/g, "'").slice(0, n).padEnd(n);
const lpad = (v: string | number, n: number): string =>
  String(v).slice(-n).padStart(n);

function buildTSPL(lines: string[]): Buffer {
  const PAD_TOP  = 8;
  const PAD_BOT  = 16;
  const heightMm = Math.ceil((PAD_TOP + lines.length * LINE_H + PAD_BOT) / DPM);
  const cmds = [
    `SIZE 50 mm, ${heightMm} mm`,
    'GAP 2 mm, 0 mm',
    'DIRECTION 1',
    'DENSITY 14',
    'SPEED 2',
    'CLS',
    ...lines.map((line, i) => `TEXT ${LEFT_X},${PAD_TOP + i * LINE_H},"${FONT}",0,1,1,"${line}"`),
    'PRINT 1,1',
  ];
  return Buffer.from(cmds.join('\r\n') + '\r\n', 'utf-8');
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(iso: string): string {
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}-${MONTHS[parseInt(p[1],10)-1] ?? '?'}-${p[0]}` : iso;
}

// ── All-workers report ────────────────────────────────────────────────────────
// Data shape: response from GET /bags/worker-summary (local sync-service)

interface WorkerSummaryRow {
  worker_id:   string;
  worker_name: string;
  item:        string;
  bags:        number;
}

interface WorkerSubtotal {
  worker_id: string;
  bags:      number;
}

interface WorkerSummaryPayload {
  station:          string;
  date:             string;
  shift:            string;
  rows:             WorkerSummaryRow[];
  worker_subtotals: WorkerSubtotal[];
  grand_total:      number;
}

function buildAllWorkersLabels(payload: WorkerSummaryPayload): Buffer[] {
  const labels: Buffer[] = [];
  const rows       = payload.rows       ?? [];
  const subtotals  = payload.worker_subtotals ?? [];
  const subMap     = new Map(subtotals.map(s => [s.worker_id, s.bags]));

  // Group rows by worker (order preserved)
  const workerOrder: string[] = [];
  const workerItems = new Map<string, { name: string; items: WorkerSummaryRow[] }>();
  for (const row of rows) {
    if (!workerItems.has(row.worker_id)) {
      workerOrder.push(row.worker_id);
      workerItems.set(row.worker_id, { name: row.worker_name, items: [] });
    }
    workerItems.get(row.worker_id)!.items.push(row);
  }

  const dateStr  = fmtDate(payload.date);
  const shiftStr = `Shift ${payload.shift}`;

  // ── Header label ─────────────────────────────────────────────────────────
  labels.push(buildTSPL([
    DASH,
    rpad('PRODUCTION REPORT', CHARS),
    rpad(`${dateStr}  ${shiftStr}`, CHARS),
    DASH,
    `Workers : ${workerOrder.length}`,
    `Total   : ${payload.grand_total} bags`,
    DASH,
  ]));

  // ── One label per worker (item breakdown) ─────────────────────────────────
  // Worker header line:  W001 Ramesh Kumar     47 bags
  // Item lines:            Rice 5kg         32
  //                        Wheat 5kg        15
  // Column math: code(5)+sp+name(14)+sp+bags(6)+"bags" = 5+1+14+1+6+4 = 31 ✓
  // Item lines:  "  "+item(21)+sp+bags(4) = 2+21+1+4 = 28 (3 spare)

  const MAX_ITEMS_PER_LABEL = 12; // ~28 lines max → ~71mm → safe for continuous roll

  for (const wid of workerOrder) {
    const worker   = workerItems.get(wid)!;
    const subTotal = subMap.get(wid) ?? 0;
    const headerLine = rpad(wid, 5) + ' ' + rpad(worker.name, 14) + ' ' + lpad(subTotal, 5) + ' bags';

    // Split items across labels if more than MAX_ITEMS_PER_LABEL
    for (let i = 0; i < worker.items.length; i += MAX_ITEMS_PER_LABEL) {
      const chunk = worker.items.slice(i, i + MAX_ITEMS_PER_LABEL);
      const isFirst = i === 0;
      const lines: string[] = [];

      lines.push(isFirst ? headerLine : rpad(`${wid} (cont'd)`, CHARS));
      lines.push(DASH);
      for (const it of chunk) {
        lines.push('  ' + rpad(it.item, 21) + ' ' + lpad(it.bags, 4));
      }
      lines.push(DASH);
      labels.push(buildTSPL(lines));
    }
  }

  // ── Footer label ──────────────────────────────────────────────────────────
  const now   = new Date();
  const hhmm  = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  labels.push(buildTSPL([
    DASH,
    `GRAND TOTAL: ${payload.grand_total} bags`,
    `Printed: ${fmtDate(now.toISOString().substring(0,10))} ${hhmm}`,
    DASH,
  ]));

  return labels;
}

// ── Single-worker report ──────────────────────────────────────────────────────
// Data shape: rows from /bags/worker-summary filtered for one worker,
// combined across all three shifts by the frontend.

interface WorkerDetailPayload {
  date:         string;
  worker_code:  string;
  worker_name:  string;
  rows:         Array<{ item: string; bags: number }>;
  grand_total:  number;
}

function buildWorkerDetailLabels(payload: WorkerDetailPayload): Buffer[] {
  const labels: Buffer[] = [];
  const rows = payload.rows ?? [];

  const headerLines = [
    DASH,
    rpad('WORKER SUMMARY', CHARS),
    rpad(`${payload.worker_code} - ${payload.worker_name}`, CHARS),
    rpad(fmtDate(payload.date), CHARS),
    DASH,
  ];

  // Split into labels of up to 12 items each
  const MAX_ITEMS = 12;
  const chunks = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += MAX_ITEMS) {
    chunks.push(rows.slice(i, i + MAX_ITEMS));
  }

  // Column: item(22) + sp + bags(4) + " bags" = 22+1+4+5 = 32 → trim item to 21
  // "  " indent + item(21) + " " + bags(4) + " bags" = 2+21+1+4+5 = 33 → too long
  // Use: item(20) + " " + lpad(bags,4) = 20+1+4 = 25 (6 spare, no "bags" label)
  // OR:  item(20) + " " + lpad(bags,4) + " bags" = 30 — fits!

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const isFirst = ci === 0;
    const lines: string[] = isFirst ? [...headerLines] : [DASH, rpad('(continued)', CHARS), DASH];

    if (rows.length === 0) {
      lines.push(rpad('No bags recorded', CHARS));
    } else {
      for (const row of chunk) {
        lines.push(rpad(row.item, 20) + ' ' + lpad(row.bags, 4) + ' bags');
      }
    }

    lines.push(DASH);

    // Footer only on last chunk
    if (ci === chunks.length - 1) {
      lines.push(`TOTAL: ${lpad(payload.grand_total, 4)} bags`);
      lines.push(DASH);
    }

    labels.push(buildTSPL(lines));
  }

  return labels;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /print/report-workers
 * Body: WorkerSummaryPayload (from GET sync-service/bags/worker-summary)
 * Prints: header label + one label per worker (items) + footer label
 */
router.post('/report-workers', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: PrinterConfig };

  if (!getCachedHealth()) {
    res.status(503).json({ status: 'error', error: 'printer_disconnected', message: 'Printer not connected.' });
    return;
  }

  try {
    const payload = req.body as WorkerSummaryPayload;
    if (!payload?.date || !payload?.shift) {
      res.status(400).json({ status: 'error', error: 'date and shift required' });
      return;
    }

    const labels = buildAllWorkersLabels(payload);
    logger.info(
      { date: payload.date, shift: payload.shift, workers: (payload.worker_subtotals ?? []).length, labels: labels.length },
      'Printing all-workers report',
    );

    for (const label of labels) {
      await driver.send(label, config.sendTimeoutMs);
    }
    res.json({ status: 'ok', labels_printed: labels.length });

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'All-workers report print failed');
    res.status(503).json({ status: 'error', error });
  }
});

/**
 * POST /print/report-worker
 * Body: WorkerDetailPayload (worker rows combined from all shifts by frontend)
 * Prints: single variable-height label (or multiple if >12 items)
 */
router.post('/report-worker', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: PrinterConfig };

  if (!getCachedHealth()) {
    res.status(503).json({ status: 'error', error: 'printer_disconnected', message: 'Printer not connected.' });
    return;
  }

  try {
    const payload = req.body as WorkerDetailPayload;
    if (!payload?.worker_code || !payload?.date) {
      res.status(400).json({ status: 'error', error: 'worker_code and date required' });
      return;
    }

    const labels = buildWorkerDetailLabels(payload);
    logger.info({ worker: payload.worker_code, date: payload.date, labels: labels.length }, 'Printing worker detail report');

    for (const label of labels) {
      await driver.send(label, config.sendTimeoutMs);
    }
    res.json({ status: 'ok', labels_printed: labels.length });

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Worker detail report print failed');
    res.status(503).json({ status: 'error', error });
  }
});

export const printReportsRouter = router;
