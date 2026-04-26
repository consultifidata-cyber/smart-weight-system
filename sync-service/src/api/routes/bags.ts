import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { generateQrCode } from '../../sync/qr.js';
import {
  generateSessionIdempotencyKey,
  generateBagIdempotencyKey,        // Phase B
} from '../../sync/idempotency.js';
import logger from '../../utils/logger.js';
import type { FGSession, FGBag } from '../../types.js';

const router = Router();

/**
 * POST /bags/add — Add one weighed bag (sessionless multi-product flow)
 *
 * Body: { pack_config_id: number, weight_gm: number }
 *
 * Internally: finds or creates an OPEN session for (station, pack_config, today),
 * allocates day_seq if new session, generates QR, inserts bag.
 *
 * Returns: { qr_code, bag_number, pack_name, total_bags_today, session_bags }
 */
router.post('/add', (req: Request, res: Response) => {
  const { queries, config } = req.ctx;

  const { pack_config_id, weight_gm, worker_code_1, worker_code_2, shift } = req.body;

  if (!pack_config_id) {
    res.status(400).json({ status: 'error', error: 'pack_config_id is required' });
    return;
  }

  if (weight_gm === undefined || weight_gm === null || typeof weight_gm !== 'number' || weight_gm <= 0 || !isFinite(weight_gm)) {
    res.status(400).json({ status: 'error', error: 'Valid weight_gm (positive number) is required' });
    return;
  }

  if (!worker_code_1) {
    res.status(400).json({ status: 'error', error: 'worker_code_1 is required' });
    return;
  }

  const today = new Date().toISOString().substring(0, 10);
  const now = new Date().toISOString();

  try {
    // Step 1: Find or create session for this (station, pack_config, today)
    let session = queries.findOpenSessionForPack(config.stationId, pack_config_id, today);

    if (!session) {
      // Resolve pack_name + item_id from local cache
      const products = queries.getProducts();
      const product = products.find(p => p.pack_id === pack_config_id);

      if (!product) {
        res.status(400).json({ status: 'error', error: 'Unknown pack_config_id. Run master data sync first.' });
        return;
      }

      // Allocate day_seq
      const daySeq = queries.getNextDaySeq(config.stationId, today);
      const sessionId = randomUUID();
      const idempotencyKey = generateSessionIdempotencyKey(config.stationId, today, sessionId);

      const newSession: FGSession = {
        session_id: sessionId,
        doc_id: null,
        prod_no: null,
        day_seq: daySeq,
        station_id: config.stationId,
        plant_id: config.plantId,
        entry_date: today,
        shift: (shift && ['A','B','C'].includes(String(shift).toUpperCase()))
          ? String(shift).toUpperCase() : null,
        item_id: product.item_id,
        pack_config_id: pack_config_id,
        pack_name: product.pack_name,
        status: 'OPEN',
        is_offline: 1,
        idempotency_key: idempotencyKey,
        created_at: now,
        closed_at: null,
        sync_status: 'LOCAL',
        sync_attempts: 0,
        sync_error: null,
        last_sync_at: null,
      };

      queries.insertSession(newSession);
      session = newSession;

      logger.info(
        { sessionId, packConfigId: pack_config_id, daySeq, packName: product.pack_name },
        'Auto-created session for pack config',
      );
    }

    // Step 2: Add bag to session
    const bagId    = randomUUID();
    const bagNumber = queries.getNextBagNumber(session.session_id);

    const qrCode = generateQrCode(
      session.pack_name,
      session.entry_date,
      session.day_seq,
      bagNumber,
    );

    // Phase B: stable idempotency key — same bag always produces the same key
    // regardless of how many times it is retried or replayed.
    const bagIdempotencyKey = generateBagIdempotencyKey(
      config.stationId, session.session_id, bagNumber, qrCode,
    );

    const bag: FGBag = {
      bag_id: bagId,
      session_id: session.session_id,
      bag_number: bagNumber,
      item_id: session.item_id,
      pack_config_id: session.pack_config_id,
      offer_id: null,
      actual_weight_gm: weight_gm ?? null,
      qr_code: qrCode,
      batch_no: null,
      note: null,
      line_id: null,
      synced: 0,
      created_at: now,
      worker_code_1: worker_code_1 || null,
      worker_code_2: worker_code_2 || null,
      idempotency_key: bagIdempotencyKey,   // Phase B
      sync_attempts:   0,                   // Phase D
      last_sync_error: null,                // Phase D
    };

    queries.insertBag(bag);

    const sessionBags = queries.getNextBagNumber(session.session_id) - 1;
    const totalBagsToday = queries.countBagsToday(today);

    logger.info(
      { bagId, qrCode, bagNumber, packName: session.pack_name, weightGm: weight_gm },
      'Bag added',
    );

    res.status(201).json({
      status: 'ok',
      bag_id: bagId,
      qr_code: qrCode,
      bag_number: bagNumber,
      pack_name: session.pack_name,
      day_seq: session.day_seq,
      session_bags: sessionBags,
      total_bags_today: totalBagsToday,
    });

    // Layer 1: fire-and-forget inline sync — push this bag to Django immediately
    // Does not block the HTTP response; errors are logged internally
    req.ctx.syncEngine?.syncBagNow();
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);

    if (typeof error === 'string' && error.includes('UNIQUE constraint failed: fg_bag.qr_code')) {
      res.status(409).json({ status: 'error', error: 'Duplicate QR code' });
      return;
    }

    logger.error({ error }, 'Failed to add bag');
    res.status(500).json({ status: 'error', error });
  }
});

/**
 * GET /bags/today — Summary of today's bags per product
 */
router.get('/today', (req: Request, res: Response) => {
  const { queries, config } = req.ctx;
  const today = new Date().toISOString().substring(0, 10);

  try {
    const summary = queries.getBagsSummaryToday(config.stationId, today);
    const totalBags = queries.countBagsToday(today);

    res.json({
      date: today,
      station_id: config.stationId,
      total_bags: totalBags,
      by_product: summary,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to get today summary');
    res.status(500).json({ status: 'error', error });
  }
});

/**
 * GET /bags/worker-summary  — per-worker, per-item bag count for one shift
 *
 * Query params (both optional — default to current shift / current shift-date):
 *   date   YYYY-MM-DD
 *   shift  A | B | C
 *
 * Shift windows:
 *   A = 06:00–13:59  (same day)
 *   B = 14:00–21:59  (same day)
 *   C = 22:00–05:59  (spans midnight)
 *
 * Shift C midnight wrap explained:
 *   A Shift-C session is created on the day the shift STARTS (e.g. 2026-04-26)
 *   and tagged entry_date='2026-04-26' shift='C'. Bags packed after midnight
 *   (00:00–05:59 on 2026-04-27) still belong to that same session. Because we
 *   filter by session.entry_date + session.shift (not by bag.created_at), no
 *   timestamp arithmetic is needed — the ORM join handles it transparently.
 *   The window_start/window_end in the response are for display only.
 */
router.get('/worker-summary', (req: Request, res: Response) => {
  const { queries, config } = req.ctx;

  // ── Current-shift helpers ──────────────────────────────────────────────────
  function currentShift(): 'A' | 'B' | 'C' {
    const h = new Date().getHours();
    if (h >= 6  && h < 14) return 'A';
    if (h >= 14 && h < 22) return 'B';
    return 'C';
  }

  function currentShiftDate(): string {
    const now = new Date();
    // Shift C after midnight (00:00–05:59): shift started *yesterday*
    if (now.getHours() < 6) {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return d.toISOString().substring(0, 10);
    }
    return now.toISOString().substring(0, 10);
  }

  // ── Validate / default params ──────────────────────────────────────────────
  const shiftParam = (req.query['shift'] as string | undefined)?.toUpperCase();
  const dateParam  =  req.query['date']  as string | undefined;

  const shift = shiftParam ?? currentShift();
  const date  = dateParam  ?? currentShiftDate();

  if (!['A', 'B', 'C'].includes(shift)) {
    res.status(400).json({ status: 'error', error: `Invalid shift '${shift}'. Must be A, B or C.` });
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00'))) {
    res.status(400).json({ status: 'error', error: `Invalid date '${date}'. Expected YYYY-MM-DD.` });
    return;
  }

  // ── Shift window for response metadata ────────────────────────────────────
  function shiftWindow(d: string, s: string): { window_start: string; window_end: string } {
    if (s === 'A') return { window_start: `${d}T06:00:00`, window_end: `${d}T13:59:59` };
    if (s === 'B') return { window_start: `${d}T14:00:00`, window_end: `${d}T21:59:59` };
    // Shift C: starts 22:00 on date d, ends 05:59:59 on d+1
    const next = new Date(d + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    const nextDate = next.toISOString().substring(0, 10);
    return { window_start: `${d}T22:00:00`, window_end: `${nextDate}T05:59:59` };
  }

  try {
    const dbRows = queries.getWorkerSummary(config.stationId, date, shift);
    const { window_start, window_end } = shiftWindow(date, shift);

    // Truncate worker name to first 2 words — fits on 50 mm label width
    const shortName = (name: string | null): string =>
      name ? name.trim().split(/\s+/).slice(0, 2).join(' ') : '';

    const rows = dbRows.map(r => ({
      worker_id:   r.worker_code,
      worker_name: shortName(r.worker_name),
      item:        r.item_name,
      bags:        r.bag_count,
    }));

    // Worker subtotals + grand total computed here (not in SQL) — explicit aggregation
    const subtotalMap = new Map<string, number>();
    for (const r of rows) {
      subtotalMap.set(r.worker_id, (subtotalMap.get(r.worker_id) ?? 0) + r.bags);
    }
    const worker_subtotals = Array.from(subtotalMap.entries())
      .map(([worker_id, bags]) => ({ worker_id, bags }));
    const grand_total = worker_subtotals.reduce((sum, w) => sum + w.bags, 0);

    res.json({
      station:         config.stationId,
      date,
      shift,
      window_start,
      window_end,
      rows,
      worker_subtotals,
      grand_total,
    });

  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, date, shift }, 'Failed to get worker summary');
    res.status(500).json({ status: 'error', error });
  }
});

export const bagsRouter = router;
