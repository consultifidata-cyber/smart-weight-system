import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { dispatchRouter } from './routes/dispatch.js';
import type { DispatchQueries } from '../db/queries.js';

declare global {
  namespace Express {
    interface Request { queries: DispatchQueries; }
  }
}

export function createServer(queries: DispatchQueries): express.Express {
  const app = express();

  // CORS — allow any origin on local network (Laptop B browser)
  app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
  app.use(express.json());

  // Attach queries to every request
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.queries = queries;
    next();
  });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok:      true,
      service: 'dispatch-service',
      db:      'connected',
      port:    4000,
    });
  });

  // ── Dispatch API ─────────────────────────────────────────────────────────
  app.use('/api/dispatch', dispatchRouter);

  // ── 404 ──────────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  return app;
}
