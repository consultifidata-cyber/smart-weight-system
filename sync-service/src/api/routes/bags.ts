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

  const { pack_config_id, weight_gm, worker_code_1, worker_code_2 } = req.body;

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
        shift: null,
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

export const bagsRouter = router;
