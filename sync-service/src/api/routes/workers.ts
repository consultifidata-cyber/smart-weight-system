import { Router, type Request, type Response } from 'express';

const router = Router();

/**
 * GET /workers — Serve cached worker list to web-ui
 */
router.get('/', (req: Request, res: Response) => {
  const workers = req.ctx.queries.getWorkers();
  res.json(workers);
});

export const workersRouter = router;
