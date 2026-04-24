import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { entriesRouter } from './routes/entries.js';
import { productsRouter } from './routes/products.js';
import { syncRouter } from './routes/sync.js';
import { bagsRouter } from './routes/bags.js';
import { workersRouter } from './routes/workers.js';
import logger from '../utils/logger.js';
import type { Queries } from '../db/queries.js';
import type { SyncServiceConfig } from '../config.js';
import type { DjangoClient } from '../sync/client.js';
import type { SyncEngine } from '../sync/engine.js';

declare global {
  namespace Express {
    interface Request {
      ctx: {
        queries: Queries;
        config: SyncServiceConfig;
        pushNow?: (localEntryId: string) => void;
        pullMasterData?: () => Promise<{ products: number; items: number }>;
        client?: DjangoClient;
        syncEngine?: SyncEngine;
      };
    }
  }
}

export function createServer(
  queries: Queries,
  config: SyncServiceConfig,
  pushNow?: (localEntryId: string) => void,
  pullMasterData?: () => Promise<{ products: number; items: number }>,
  client?: DjangoClient,
  syncEngine?: SyncEngine,
): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Attach context to every request
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.ctx = { queries, config, pushNow, pullMasterData, client, syncEngine };
    next();
  });

  // Routes
  app.use('/entries', entriesRouter);
  app.use('/products', productsRouter);
  app.use('/sync', syncRouter);
  app.use('/bags', bagsRouter);
  app.use('/workers', workersRouter);

  // Root health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      service: 'sync-service',
      stationId: config.stationId,
      status: 'ok',
      database: 'connected',
      uptime: process.uptime(),
    });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', error: 'Not found' });
  });

  return app;
}
