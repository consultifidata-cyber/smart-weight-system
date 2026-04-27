/**
 * Report print endpoints — v2.3.0
 *
 * POST /print/report-workers  — all-workers summary (multi-label)
 * POST /print/report-worker   — single worker detail (one label)
 *
 * Both require the printer to be connected (same getCachedHealth()
 * check as /print/print — reuses the same single source of truth).
 *
 * TSPL layout: font "2" at 1x (12 dots/char), 50mm wide, variable height.
 * Same constants as buildWorkerSummaryTSPL in print.ts.
 */

import { Router, type Request, type Response } from 'express';
import { getCachedHealth } from '../../hardware/printerHealthCache.js';
import logger from '../../utils/logger.js';
import type { PrinterDriver, PrinterConfig } from '../../types.js';

const router = Router();

// ── Shared TSPL constants ────────────────────────────────────────────────────

const FONT      = '2';
const LINE_H    = 20;        // dots per text line (16 char + 4 gap)
const DPM       = 8;         // dots per mm at 203 DPI
const LEFT_X    = 10;        // left margin in dots
const CHARS     = 31;        // max printable chars per line
const DASH      = '-'.repeat(CHARS);

const rpad = (s: string, n: number): string =>
  String(s).replace(/"/g, "'").slice(0, n).padEnd(n);
const lpad = (v: string | number, n: number): string =>
  String(v).slice(-n).padStart(n);

function textLine(y: number, content: string): string {
  return `TEXT ${LEFT_X},${y},"${FONT}",0,1,1,"${content}"`;
}

function buildTSPL(lines: string[]): Buffer {
  const PAD_TOP = 8;
  const PAD_BOT = 16;
  const heightMm = Math.ceil((PAD_TOP + lines.length * LINE_H + PAD_BOT) / DPM);
  const cmds: string[] = [
    `SIZE 50 mm, ${heightMm} mm`,
    'GAP 2 mm, 0 mm',
    'DIRECTION 1',
    'DENSITY 14',
    'SPEED 2',
    'CLS',
    ...lines.map((line, i) => textLine(PAD_TOP + i * LINE_H, line)),
    'PRINT 1,1',
  ];
  return Buffer.from(cmds.join('\r\n') + '\r\n', 'utf-8');
}

// ── All-workers report (multi-label) ─────────────────────────────────────────

interface WorkerRow {
  worker_code: string;
  worker_name: string;
  bags:        number;
  total_kg:    string;
}

interface WorkersReport {
  date:      string;
  shift:     string;
  totals:    { workers_active: number; total_bags: number; total_kg: string };
  workers:   WorkerRow[];
}

const WORKERS_PER_DATA_LABEL = 5;

function buildWorkerReportLabels(report: WorkersReport): Buffer[] {
  const labels: Buffer[] = [];

  // ── Months helper ─────────────────────────────────────────────────────
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDate = (iso: string): string => {
    const p = iso.split('-');
    return p.length === 3 ? `${p[2]}-${MONTHS[parseInt(p[1],10)-1] ?? '?'}-${p[0]}` : iso;
  };

  const dateStr  = fmtDate(report.date);
  const shiftStr = `Shift ${report.shift}`;
  const workers  = report.workers ?? [];
  const totalPages = 1 + Math.ceil(workers.length / WORKERS_PER_DATA_LABEL) + 1;
  let pageNo = 1;

  // ── Label 1: header ──────────────────────────────────────────────────
  labels.push(buildTSPL([
    DASH,
    rpad('PRODUCTION REPORT', CHARS),
    rpad(`${dateStr}  ${shiftStr}`, CHARS),
    DASH,
    `Workers active: ${String(report.totals?.workers_active ?? 0)}`,
    `Total bags    : ${String(report.totals?.total_bags ?? 0)}`,
    `Total kg      : ${String(report.totals?.total_kg ?? '0')}`,
    DASH,
    rpad(`Page 1 of ${totalPages}`, CHARS),
    DASH,
  ]));
  pageNo++;

  // ── Labels 2..N: data (5 workers per label) ───────────────────────────
  for (let i = 0; i < workers.length; i += WORKERS_PER_DATA_LABEL) {
    const chunk = workers.slice(i, i + WORKERS_PER_DATA_LABEL);
    const lines: string[] = [
      DASH,
      rpad(`Page ${pageNo} of ${totalPages}`, CHARS),
      DASH,
      rpad('Code  Name         Bags   kg', CHARS),
      DASH,
    ];
    for (const w of chunk) {
      const code  = rpad(w.worker_code,  5);
      const name  = rpad(w.worker_name, 12);
      const bags  = lpad(w.bags,         4);
      const kg    = lpad(w.total_kg,     7);
      lines.push(`${code} ${name} ${bags} ${kg}`);
    }
    lines.push(DASH);
    labels.push(buildTSPL(lines));
    pageNo++;
  }

  // ── Last label: footer ────────────────────────────────────────────────
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  labels.push(buildTSPL([
    DASH,
    rpad('END OF REPORT', CHARS),
    `Printed: ${fmtDate(now.toISOString().substring(0,10))} ${hhmm}`,
    DASH,
  ]));

  return labels;
}

// ── Worker detail report (single label) ──────────────────────────────────────

interface ShiftDetail {
  shift:    string;
  bags:     number;
  total_kg: string;
}

interface WorkerReport {
  date:       string;
  worker_code: string;
  worker_name: string;
  shifts:     ShiftDetail[];
  day_total:  { bags: number; total_kg: string };
}

function buildWorkerDetailLabel(report: WorkerReport): Buffer {
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDate = (iso: string): string => {
    const p = iso.split('-');
    return p.length === 3 ? `${p[2]}-${MONTHS[parseInt(p[1],10)-1] ?? '?'}-${p[0]}` : iso;
  };

  const lines: string[] = [
    DASH,
    rpad('WORKER SUMMARY', CHARS),
    rpad(fmtDate(report.date), CHARS),
    rpad(`${report.worker_code} - ${report.worker_name}`, CHARS),
    DASH,
  ];

  for (const s of (report.shifts ?? [])) {
    lines.push(`Shift ${s.shift}: ${lpad(s.bags, 4)} bags`);
    lines.push(`        ${lpad(s.total_kg, 7)} kg`);
  }

  lines.push(DASH);
  lines.push(`TOTAL: ${lpad((report.day_total?.bags ?? 0), 4)} bags`);
  lines.push(`       ${lpad((report.day_total?.total_kg ?? '0'), 7)} kg`);
  lines.push(DASH);

  return buildTSPL(lines);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /print/report-workers
 * Body: WorkersReport (from GET /api/reports/workers/)
 * Sends multiple labels sequentially.
 */
router.post('/report-workers', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: PrinterConfig };

  // Reuse same printer-state check as /print/print (X2 requirement)
  if (!getCachedHealth()) {
    res.status(503).json({
      status: 'error',
      error:  'printer_disconnected',
      message: 'Printer is not connected. Check USB cable.',
    });
    return;
  }

  try {
    const report = req.body as WorkersReport;

    if (!report?.date || !report?.shift) {
      res.status(400).json({ status: 'error', error: 'date and shift are required' });
      return;
    }

    const labels = buildWorkerReportLabels(report);

    logger.info(
      { date: report.date, shift: report.shift, labels: labels.length, workers: report.workers?.length ?? 0 },
      'Printing all-workers report',
    );

    // Send labels sequentially
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
 * Body: WorkerReport (from GET /api/reports/worker/<code>/)
 * Sends a single label.
 */
router.post('/report-worker', async (req: Request, res: Response) => {
  const { driver, config } = req.ctx as { driver: PrinterDriver; config: PrinterConfig };

  if (!getCachedHealth()) {
    res.status(503).json({
      status: 'error',
      error:  'printer_disconnected',
      message: 'Printer is not connected. Check USB cable.',
    });
    return;
  }

  try {
    const report = req.body as WorkerReport;

    if (!report?.worker_code || !report?.date) {
      res.status(400).json({ status: 'error', error: 'worker_code and date are required' });
      return;
    }

    const label = buildWorkerDetailLabel(report);

    logger.info(
      { worker: report.worker_code, date: report.date },
      'Printing worker detail report',
    );

    await driver.send(label, config.sendTimeoutMs);

    res.json({ status: 'ok', labels_printed: 1 });

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Worker detail report print failed');
    res.status(503).json({ status: 'error', error });
  }
});

export const printReportsRouter = router;
