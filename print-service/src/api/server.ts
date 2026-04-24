import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { printRouter } from './routes/print.js';
import { hardwareRouter } from './routes/hardware.js';
import { systemStatusRouter } from './routes/systemStatus.js';
import logger from '../utils/logger.js';
import type { PrinterDriver, PrinterConfig } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      ctx: {
        driver: PrinterDriver;
        config: PrinterConfig;
      };
    }
  }
}

export function createServer(
  driver: PrinterDriver,
  config: PrinterConfig,
): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Middleware: attach driver and config to request context
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.ctx = { driver, config };
    next();
  });

  // Routes
  app.use('/print', printRouter);
  app.use('/hardware', hardwareRouter);
  app.use('/system', systemStatusRouter);
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      service: 'print-service',
      stationId: config.stationId,
      status: 'ok',
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ status: 'error', error: 'Not found' });
  });

  return app;
}
