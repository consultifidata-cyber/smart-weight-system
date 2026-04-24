import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { weightRouter } from './routes/weight.js';
import { hardwareRouter } from './routes/hardware.js';
import logger from '../utils/logger.js';
import type { ServerContext } from '../types.js';

export function createServer(ctx: ServerContext): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Inject dependencies into request context
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.ctx = ctx;
    next();
  });

  app.use('/', weightRouter);
  app.use('/hardware', hardwareRouter);

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message }, 'Unhandled API error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
