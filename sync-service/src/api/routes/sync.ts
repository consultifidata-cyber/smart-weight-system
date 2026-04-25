import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';

const router = Router();

// GET /sync/status — Overall sync engine status
router.get('/status', (req: Request, res: Response) => {
  const { queries, config } = req.ctx;

  try {
    const counts = queries.getStatusCounts();
    const today = new Date().toISOString().substring(0, 10);
    const syncedToday = queries.countSyncedToday(today);
    const lastMasterSync = queries.getMeta('last_master_sync_at');

    // Session stats
    const closedSessionsToday = queries.countClosedSessionsToday(today);
    const bagsToday = queries.countBagsToday(today);
    const pendingSessions = queries.listPendingSessions(1).length > 0
      ? queries.listPendingSessions(100).length
      : 0;

    const serverConfigured = !!config.djangoServerUrl;

    res.json({
      server_reachable: serverConfigured,
      pending_entries: counts['PENDING'] || 0,
      failed_entries: counts['FAILED'] || 0,
      synced_today: syncedToday,
      last_sync_at: queries.getMeta('last_sync_at'),
      last_master_sync_at: lastMasterSync,
      pending_sessions: pendingSessions,
      closed_sessions_today: closedSessionsToday,
      total_bags_today: bagsToday,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to get sync status');
    res.status(500).json({ status: 'error', error });
  }
});

// POST /sync/master-refresh — Force immediate master data pull
router.post('/master-refresh', async (req: Request, res: Response) => {
  const { pullMasterData } = req.ctx;

  if (!pullMasterData) {
    res.status(503).json({ status: 'error', error: 'Sync engine not available' });
    return;
  }

  try {
    const result = await pullMasterData();
    res.json({
      status:         'ok',
      products_count: result.products,
      items_count:    result.items,
      workers_count:  result.workers,   // Phase G
      synced_at:      new Date().toISOString(),
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Master data refresh failed');
    res.status(503).json({ status: 'error', error });
  }
});

// POST /sync/push-pending — Force immediate push of all pending offline sessions
router.post('/push-pending', async (req: Request, res: Response) => {
  const { syncEngine, queries } = req.ctx;

  if (!syncEngine) {
    res.status(503).json({ status: 'error', error: 'Sync engine not available' });
    return;
  }

  try {
    const pendingBefore = queries.listPendingSessions(100).length;

    if (pendingBefore === 0) {
      res.json({ status: 'ok', message: 'No pending sessions to push', pushed: 0 });
      return;
    }

    await syncEngine.retryPendingSessions();

    const pendingAfter = queries.listPendingSessions(100).length;
    const pushed = pendingBefore - pendingAfter;

    res.json({
      status: 'ok',
      pending_before: pendingBefore,
      pending_after: pendingAfter,
      pushed,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Manual push-pending failed');
    res.status(500).json({ status: 'error', error });
  }
});

// POST /sync/requeue-failed — Reset all FAILED sessions back to PENDING for retry
router.post('/requeue-failed', (req: Request, res: Response) => {
  const { queries } = req.ctx;

  try {
    const requeued = queries.requeueFailedSessions();
    logger.info({ requeued }, 'Requeued failed sessions');
    res.json({
      status: 'ok',
      requeued,
      message: requeued === 0
        ? 'No failed sessions to requeue'
        : `Requeued ${requeued} session(s) for retry`,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Requeue failed sessions error');
    res.status(500).json({ status: 'error', error });
  }
});

// POST /sync/flush — End-of-shift: close all open sessions, push to Django
router.post('/flush', async (req: Request, res: Response) => {
  const { syncEngine } = req.ctx;

  if (!syncEngine) {
    res.status(503).json({ status: 'error', error: 'Sync engine not available' });
    return;
  }

  try {
    const result = await syncEngine.flushAllOpenSessions();

    res.json({
      status: 'ok',
      closed: result.closed,
      pushed: result.pushed,
      message: result.closed === 0
        ? 'No open sessions to flush'
        : `Closed ${result.closed} session(s), pushed ${result.pushed}`,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Flush failed');
    res.status(500).json({ status: 'error', error });
  }
});

export const syncRouter = router;
