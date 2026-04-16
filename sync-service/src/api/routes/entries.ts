import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { generateIdempotencyKey } from '../../sync/idempotency.js';
import logger from '../../utils/logger.js';
import type { FGEntry, FGEntryLine, SyncStatus } from '../../types.js';

const router = Router();

// POST /entries — Create a new FG production entry
router.post('/', (req: Request, res: Response) => {
  const { queries, config, pushNow } = req.ctx;
  const body = req.body;

  // Validate required fields
  if (!body.station_id || !body.plant_id || !body.entry_date || !body.item_id || !body.pack_config_id || !body.num_bags) {
    res.status(400).json({
      status: 'error',
      error: 'Missing required fields: station_id, plant_id, entry_date, item_id, pack_config_id, num_bags',
    });
    return;
  }

  try {
    const now = new Date().toISOString();
    const localEntryId = randomUUID();

    const idempotencyKey = generateIdempotencyKey({
      station_id: body.station_id,
      plant_id: String(body.plant_id),
      entry_date: body.entry_date,
      item_id: String(body.item_id),
      pack_config_id: String(body.pack_config_id),
      num_bags: body.num_bags,
      created_at: now,
    });

    const entry: FGEntry = {
      local_entry_id: localEntryId,
      station_id: body.station_id,
      plant_id: body.plant_id,
      entry_date: body.entry_date,
      shift: body.shift || null,
      production_run_id: body.production_run_id || null,
      created_by: body.created_by || `operator@${config.stationId}`,
      created_at: now,
      idempotency_key: idempotencyKey,
      sync_status: 'PENDING',
      sync_attempts: 0,
      last_sync_error: null,
      last_sync_at: null,
      server_prod_no: null,
      server_doc_id: null,
    };

    const line: FGEntryLine = {
      local_entry_id: localEntryId,
      item_id: body.item_id,
      pack_config_id: body.pack_config_id,
      offer_id: body.offer_id || null,
      num_bags: body.num_bags,
      base_uom: body.base_uom || 'PCS',
      batch_no: body.batch_no || null,
      note: body.note || null,
    };

    queries.insertEntry(entry, [line]);

    logger.info({ localEntryId, item_id: body.item_id, pack_config_id: body.pack_config_id }, 'FG entry created');

    // Fire-and-forget: trigger immediate sync push
    if (pushNow) {
      setImmediate(() => pushNow(localEntryId));
    }

    res.status(201).json({
      status: 'ok',
      local_entry_id: localEntryId,
      sync_status: 'PENDING',
      created_at: now,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);

    // SQLite UNIQUE constraint on idempotency_key
    if (error.includes('UNIQUE constraint failed: fg_entry.idempotency_key')) {
      logger.warn({ error }, 'Duplicate entry rejected');
      res.status(409).json({
        status: 'error',
        error: 'Duplicate entry',
      });
      return;
    }

    logger.error({ error }, 'Failed to create entry');
    res.status(500).json({ status: 'error', error });
  }
});

// GET /entries — List entries with optional filters
router.get('/', (req: Request, res: Response) => {
  const { queries } = req.ctx;

  try {
    const date = req.query.date as string | undefined;
    const status = req.query.status as SyncStatus | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const result = queries.listEntries({ date, status, limit });
    res.json(result);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to list entries');
    res.status(500).json({ status: 'error', error });
  }
});

// GET /entries/:id — Get a single entry with lines
router.get('/:id', (req: Request, res: Response) => {
  const { queries } = req.ctx;

  try {
    const entry = queries.getEntryWithLines(req.params.id);
    if (!entry) {
      res.status(404).json({ status: 'error', error: 'Entry not found' });
      return;
    }
    res.json(entry);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to get entry');
    res.status(500).json({ status: 'error', error });
  }
});

export const entriesRouter = router;
