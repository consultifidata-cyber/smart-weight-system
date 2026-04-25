import { Router, type Request, type Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { DispatchQueries } from '../../db/queries.js';
import logger from '../../utils/logger.js';
import config from '../../config.js';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate local doc_no like DSP-260426-001 */
function makeDocNo(queries: DispatchQueries, entryDate: string): string {
  const parts   = entryDate.split('-');
  const dateStr = `${parts[2]}${parts[1]}${parts[0].slice(2)}`; // DDMMYY
  const seq     = (queries.countDocsByDate(entryDate) + 1).toString().padStart(3, '0');
  return `DSP-${dateStr}-${seq}`;
}

/** Deterministic idempotency key for offline → Django push */
function makeIdempotencyKey(docId: string): string {
  return createHash('sha256').update(docId).digest('hex');
}

function getQueries(req: Request): DispatchQueries {
  return (req as Request & { queries: DispatchQueries }).queries;
}

// ── GET /api/dispatch/parties ─────────────────────────────────────────────────
router.get('/parties', (req: Request, res: Response) => {
  try {
    const parties = getQueries(req).listParties();
    res.json({ ok: true, parties });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'GET /parties failed');
    res.status(500).json({ ok: false, error });
  }
});

// ── POST /api/dispatch/docs — create new dispatch doc ────────────────────────
router.post('/docs', (req: Request, res: Response) => {
  const queries = getQueries(req);
  const {
    entry_date, truck_no, customer_id, customer_name,
    location, plant_id, shift_id, delay_reason,
  } = req.body as Record<string, string | number | null>;

  if (!truck_no || !customer_name) {
    res.status(400).json({ ok: false, error: 'truck_no and customer_name are required' });
    return;
  }

  const today    = new Date().toISOString().substring(0, 10);
  const date     = (entry_date as string) || today;
  const docId    = randomUUID();
  const docNo    = makeDocNo(queries, date);
  const idemKey  = makeIdempotencyKey(docId);
  const now      = new Date().toISOString();
  const pid      = (plant_id as string) || config.plantId;

  try {
    queries.createDoc(
      docId, docNo, date,
      truck_no as string,
      customer_id ? Number(customer_id) : null,
      customer_name as string,
      (location as string) || null,
      pid,
      (shift_id as string) || null,
      (delay_reason as string) || null,
      idemKey, now,
    );

    logger.info({ docId, docNo, truck_no, customer_name }, 'Dispatch doc created');

    res.status(201).json({
      ok:     true,
      doc_id: docId,
      doc_no: docNo,
      status: 'DRAFT',
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'POST /docs failed');
    res.status(500).json({ ok: false, error });
  }
});

// ── GET /api/dispatch/docs — list all docs ───────────────────────────────────
router.get('/docs', (req: Request, res: Response) => {
  try {
    const docs = getQueries(req).listDocs();
    res.json({ ok: true, docs });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'GET /docs failed');
    res.status(500).json({ ok: false, error });
  }
});

// ── GET /api/dispatch/docs/:doc_id — full doc with lines + SKU summary ────────
router.get('/docs/:doc_id', (req: Request, res: Response) => {
  const queries = getQueries(req);
  const doc_id  = String(req.params['doc_id']);

  try {
    const doc = queries.getDoc(doc_id);
    if (!doc) {
      res.status(404).json({ ok: false, error: 'Dispatch doc not found' });
      return;
    }
    const lines   = queries.getLinesByDoc(doc_id);
    const summary = queries.getSkuSummary(doc_id);

    res.json({ ok: true, doc, lines, summary });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, doc_id }, 'GET /docs/:doc_id failed');
    res.status(500).json({ ok: false, error });
  }
});

// ── POST /api/dispatch/docs/:doc_id/scan — validate + add QR ─────────────────
router.post('/docs/:doc_id/scan', (req: Request, res: Response) => {
  const queries = getQueries(req);
  const doc_id  = String(req.params['doc_id']);
  const { qr_code } = req.body as { qr_code?: string };

  if (!qr_code || !qr_code.trim()) {
    res.status(400).json({ ok: false, error: 'qr_code is required' });
    return;
  }

  const qr = qr_code.trim().toUpperCase();

  try {
    // ── Validate doc exists and is in DRAFT ──────────────────────────────────
    const doc = queries.getDoc(doc_id);
    if (!doc) {
      res.status(404).json({ ok: false, error: 'Dispatch doc not found' });
      return;
    }
    if (doc.status !== 'DRAFT') {
      res.status(409).json({ ok: false, error: `Doc is ${doc.status}, expected DRAFT` });
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // SCAN VALIDATION — exact rules from Phase DA specification
    // ────────────────────────────────────────────────────────────────────────

    // A. Already in THIS dispatch? → YELLOW warning, do not insert
    if (queries.checkQrInDoc(doc_id, qr)) {
      logger.warn({ doc_id, qr }, 'QR already in this dispatch (duplicate scan)');
      res.json({
        ok:     true,
        result: 'ALREADY_SCANNED',
        color:  'yellow',
        message: 'Already scanned — did you scan twice?',
        qr_code: qr,
      });
      return;
    }

    // B. In another non-declined dispatch? → RED blocked
    const blockedBy = queries.checkQrInOtherDocs(qr, doc_id);
    if (blockedBy) {
      logger.warn({ doc_id, qr, blockedBy }, 'QR blocked — in another dispatch');
      res.json({
        ok:     false,
        result: 'BLOCKED',
        color:  'red',
        message: `Blocked — already in ${blockedBy.doc_no} (${blockedBy.customer_name})`,
        qr_code: qr,
        blocked_by: blockedBy,
      });
      return;
    }

    // C / D. Lookup in fg_bag to get bag details
    const bag    = queries.getBagByQr(qr);
    const lineId = randomUUID();
    const now    = new Date().toISOString();

    if (!bag) {
      // C. Not in local fg_bag → ORANGE, insert as EXTERNAL
      queries.insertScanLine(
        lineId, doc_id, qr,
        null, null, null, null,
        0,           // weight unknown — no contribution to total
        'EXTERNAL', now,
      );
      logger.warn({ doc_id, qr, line_id: lineId }, 'QR not in local records — inserted as EXTERNAL');
      res.json({
        ok:      true,
        result:  'EXTERNAL',
        color:   'orange',
        message: 'QR not in local records — may be from another station',
        qr_code: qr,
        line_id: lineId,
      });
      return;
    }

    // D. Found in fg_bag → GREEN, insert as LOCAL
    queries.insertScanLine(
      lineId, doc_id, qr,
      bag.bag_id,
      bag.pack_name,
      bag.pack_config_id,
      bag.item_id,
      bag.actual_weight_gm ?? 0,
      'LOCAL', now,
    );

    logger.info(
      { doc_id, qr, line_id: lineId, pack_name: bag.pack_name, weight_gm: bag.actual_weight_gm },
      'Bag scanned and added to dispatch',
    );

    res.json({
      ok:      true,
      result:  'SUCCESS',
      color:   'green',
      message: 'Bag added to dispatch',
      qr_code: qr,
      line_id: lineId,
      bag: {
        bag_id:           bag.bag_id,
        pack_name:        bag.pack_name,
        actual_weight_gm: bag.actual_weight_gm,
      },
    });

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, doc_id, qr }, 'POST /scan failed');
    res.status(500).json({ ok: false, error });
  }
});

// ── POST /api/dispatch/docs/:doc_id/close ────────────────────────────────────
router.post('/docs/:doc_id/close', (req: Request, res: Response) => {
  const queries = getQueries(req);
  const doc_id  = String(req.params['doc_id']);

  try {
    const doc = queries.getDoc(doc_id);
    if (!doc) {
      res.status(404).json({ ok: false, error: 'Dispatch doc not found' });
      return;
    }
    if (doc.status !== 'DRAFT') {
      res.status(409).json({ ok: false, error: `Doc is already ${doc.status}` });
      return;
    }
    if (doc.total_bags === 0) {
      res.status(400).json({ ok: false, error: 'Cannot close empty dispatch — scan at least one bag first' });
      return;
    }

    const now     = new Date().toISOString();
    const changed = queries.closeDoc(doc_id, now);

    if (changed === 0) {
      res.status(409).json({ ok: false, error: 'Doc could not be closed (already closed?)' });
      return;
    }

    const updated = queries.getDoc(doc_id);
    logger.info({ doc_id, doc_no: doc.doc_no, total_bags: doc.total_bags }, 'Dispatch doc closed — queued for sync');

    res.json({
      ok:             true,
      doc_id,
      doc_no:         doc.doc_no,
      status:         'CLOSED',
      sync_status:    'PENDING',
      total_bags:     updated?.total_bags,
      total_weight_gm: updated?.total_weight_gm,
      closed_at:      now,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error, doc_id }, 'POST /close failed');
    res.status(500).json({ ok: false, error });
  }
});

export const dispatchRouter = router;
