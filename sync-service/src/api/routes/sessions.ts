import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { generateQrCode } from '../../sync/qr.js';
import { generateSessionIdempotencyKey } from '../../sync/idempotency.js';
import logger from '../../utils/logger.js';
import type { FGSession, FGBag } from '../../types.js';

const router = Router();

// POST /sessions/open — Start a new bag-by-bag session
router.post('/open', async (req: Request, res: Response) => {
  const { queries, config, client } = req.ctx;

  const { item_id, pack_config_id, entry_date, shift, offer_id } = req.body;

  if (!item_id || !pack_config_id) {
    res.status(400).json({ status: 'error', error: 'item_id and pack_config_id are required' });
    return;
  }

  // Check if there's already an open session for this station
  const existing = queries.getOpenSession(config.stationId);
  if (existing) {
    res.status(409).json({
      status: 'error',
      error: 'A session is already open',
      session_id: existing.session_id,
    });
    return;
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const sessionDate = entry_date || new Date().toISOString().substring(0, 10);
  const idempotencyKey = generateSessionIdempotencyKey(config.stationId, sessionDate, sessionId);

  let isOffline = false;
  let docId: number | null = null;
  let prodNo: string | null = null;
  let daySeq: number = config.offlineDaySeqStart;
  let packName = '';

  // Try online first
  if (client?.isConfigured) {
    try {
      const resp = await client.openSession({
        item_id,
        pack_config_id,
        entry_date: sessionDate,
        shift: shift || null,
      });
      docId = resp.doc_id;
      prodNo = resp.prod_no;
      daySeq = resp.day_seq;
      packName = resp.pack_name;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ error }, 'Django open-session failed, falling back to offline mode');
      isOffline = true;
    }
  } else {
    isOffline = true;
  }

  // Offline: resolve pack_name from local cache
  if (isOffline && !packName) {
    const products = queries.getProducts();
    const match = products.find(p => p.pack_id === pack_config_id);
    packName = match?.pack_name || 'FG';

    // Allocate offline day_seq (use a simple counter within the range)
    const lastUsed = queries.getMeta('offline_day_seq_counter');
    daySeq = lastUsed
      ? Math.min(parseInt(lastUsed, 10) + 1, config.offlineDaySeqEnd)
      : config.offlineDaySeqStart;
    queries.setMeta('offline_day_seq_counter', String(daySeq));
  }

  try {
    const session: FGSession = {
      session_id: sessionId,
      doc_id: docId,
      prod_no: prodNo,
      day_seq: daySeq,
      station_id: config.stationId,
      plant_id: config.plantId,
      entry_date: sessionDate,
      shift: shift || null,
      item_id,
      pack_config_id,
      pack_name: packName,
      status: 'OPEN',
      is_offline: isOffline ? 1 : 0,
      idempotency_key: idempotencyKey,
      created_at: now,
      closed_at: null,
      sync_status: isOffline ? 'PENDING' : 'SYNCED',
      sync_attempts: 0,
      sync_error: null,
      last_sync_at: null,
    };

    queries.insertSession(session);

    logger.info(
      { sessionId, docId, prodNo, daySeq, isOffline },
      'Session opened',
    );

    res.status(201).json({
      status: 'ok',
      session_id: sessionId,
      doc_id: docId,
      prod_no: prodNo,
      day_seq: daySeq,
      entry_date: sessionDate,
      pack_name: packName,
      is_offline: isOffline,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to create session');
    res.status(500).json({ status: 'error', error });
  }
});

// POST /sessions/:sessionId/add-bag — Add one weighed bag
router.post('/:sessionId/add-bag', async (req: Request, res: Response) => {
  const { queries, config, client } = req.ctx;
  const { sessionId } = req.params;

  const session = queries.getSession(sessionId);
  if (!session) {
    res.status(404).json({ status: 'error', error: 'Session not found' });
    return;
  }
  if (session.status !== 'OPEN') {
    res.status(409).json({ status: 'error', error: `Session is ${session.status}, expected OPEN` });
    return;
  }

  const {
    actual_weight_gm = null,
    offer_id = null,
    batch_no = null,
    note = null,
  } = req.body;

  const bagId = randomUUID();
  const now = new Date().toISOString();
  const bagNumber = queries.getNextBagNumber(sessionId);

  // Generate QR code locally using the session's day_seq
  const qrCode = generateQrCode(
    session.pack_name,
    session.entry_date,
    session.day_seq,
    bagNumber,
  );

  let lineId: number | null = null;
  let synced = 0;

  // If online, push to Django
  if (!session.is_offline && session.doc_id && client?.isConfigured) {
    try {
      const resp = await client.addBag({
        doc_id: session.doc_id,
        item_id: session.item_id,
        pack_config_id: session.pack_config_id,
        qr_code: qrCode,
        actual_weight_gm: actual_weight_gm,
        offer_id: offer_id,
        batch_no: batch_no,
        note: note,
      });
      lineId = resp.line_id;
      synced = 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ error, bagNumber, qrCode }, 'Django add-bag failed, storing locally');
      // Bag saved locally; will be pushed via push-entry when session closes offline
    }
  }

  try {
    const bag: FGBag = {
      bag_id: bagId,
      session_id: sessionId,
      bag_number: bagNumber,
      item_id: session.item_id,
      pack_config_id: session.pack_config_id,
      offer_id: offer_id,
      actual_weight_gm: actual_weight_gm,
      qr_code: qrCode,
      batch_no: batch_no,
      note: note,
      line_id: lineId,
      synced: synced,
      created_at: now,
    };

    queries.insertBag(bag);

    const totalBags = queries.getNextBagNumber(sessionId) - 1;

    logger.info(
      { sessionId, bagId, bagNumber, qrCode, actualWeight: actual_weight_gm, synced: !!synced },
      'Bag added',
    );

    res.status(201).json({
      status: 'ok',
      bag_id: bagId,
      qr_code: qrCode,
      bag_number: bagNumber,
      total_bags: totalBags,
      line_id: lineId,
      actual_weight_gm: actual_weight_gm,
      synced: !!synced,
    });
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

// POST /sessions/:sessionId/close — Close the session
router.post('/:sessionId/close', async (req: Request, res: Response) => {
  const { queries, client } = req.ctx;
  const { sessionId } = req.params;

  const session = queries.getSession(sessionId);
  if (!session) {
    res.status(404).json({ status: 'error', error: 'Session not found' });
    return;
  }
  if (session.status !== 'OPEN') {
    res.status(409).json({ status: 'error', error: `Session is ${session.status}, expected OPEN` });
    return;
  }

  const bags = queries.getBagsBySession(sessionId);
  if (bags.length === 0) {
    res.status(400).json({ status: 'error', error: 'Session has no bags' });
    return;
  }

  // If online and doc exists, close on Django
  if (!session.is_offline && session.doc_id && client?.isConfigured) {
    try {
      const resp = await client.closeSession(session.doc_id);
      queries.updateSessionClosed(sessionId);
      queries.updateSessionSyncStatus(sessionId, 'SYNCED', null);

      logger.info(
        { sessionId, prodNo: resp.prod_no, totalBags: resp.total_bags },
        'Session closed (online)',
      );

      res.json({
        status: 'ok',
        session_id: sessionId,
        prod_no: resp.prod_no,
        total_bags: resp.total_bags,
        doc_status: resp.doc_status,
        verification_status: resp.verification_status,
        is_offline: false,
      });
      return;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn({ error, sessionId }, 'Django close-session failed, marking for offline push');
      // Fall through to offline handling
    }
  }

  // Offline close: mark session as PENDING_PUSH for the sync engine to push later
  queries.updateSessionStatus(sessionId, 'CLOSED');
  queries.updateSessionSyncStatus(sessionId, 'PENDING', null);

  logger.info({ sessionId, totalBags: bags.length }, 'Session closed (offline, pending push)');

  res.json({
    status: 'ok',
    session_id: sessionId,
    prod_no: session.prod_no,
    total_bags: bags.length,
    doc_status: 'PENDING_PUSH',
    verification_status: null,
    is_offline: true,
  });
});

// GET /sessions/:sessionId — Get session details with bags
router.get('/:sessionId', (req: Request, res: Response) => {
  const { queries } = req.ctx;
  const { sessionId } = req.params;

  try {
    const session = queries.getSessionWithBags(sessionId);
    if (!session) {
      res.status(404).json({ status: 'error', error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to get session');
    res.status(500).json({ status: 'error', error });
  }
});

// GET /sessions — List recent sessions
router.get('/', (req: Request, res: Response) => {
  const { queries } = req.ctx;

  try {
    const today = new Date().toISOString().substring(0, 10);
    const closedToday = queries.countClosedSessionsToday(today);
    const bagsToday = queries.countBagsToday(today);
    const openSession = queries.getOpenSession(req.ctx.config.stationId);

    res.json({
      open_session: openSession || null,
      closed_today: closedToday,
      bags_today: bagsToday,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to list sessions');
    res.status(500).json({ status: 'error', error });
  }
});

export const sessionsRouter = router;
