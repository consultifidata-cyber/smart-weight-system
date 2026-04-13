import { Router, type Request, type Response } from 'express';

const router = Router();

router.get('/weight', (req: Request, res: Response) => {
  const { stabilityDetector, weightReader, config } = req.ctx;
  const state = stabilityDetector.getState();

  const noData = state.weight === null || state.lastReadingAt === null;
  const stale = state.lastReadingAt !== null && (Date.now() - state.lastReadingAt > 5000);
  const disconnected = !weightReader.isConnected;

  if (disconnected) {
    res.status(503).json({
      weight: null,
      unit: null,
      stable: false,
      stableWeight: null,
      raw: null,
      stationId: config.stationId,
      timestamp: new Date().toISOString(),
      status: 'disconnected',
      error: `Serial port ${config.serial.port} is not connected.`,
    });
    return;
  }

  if (noData || stale) {
    res.status(503).json({
      weight: null,
      unit: null,
      stable: false,
      stableWeight: null,
      raw: null,
      stationId: config.stationId,
      timestamp: new Date().toISOString(),
      status: 'no_data',
      error: 'No weight readings received. Check scale connection.',
    });
    return;
  }

  res.json({
    weight: state.weight,
    unit: 'kg',
    stable: state.stable,
    stableWeight: state.stableWeight,
    stationId: config.stationId,
    timestamp: new Date().toISOString(),
    status: 'ok',
  });
});

router.get('/health', (req: Request, res: Response) => {
  const { stabilityDetector, weightReader, config } = req.ctx;
  const state = stabilityDetector.getState();
  const connected = weightReader.isConnected;

  const lastReadingAge = state.lastReadingAt ? Date.now() - state.lastReadingAt : null;

  const body = {
    service: 'weight-service',
    stationId: config.stationId,
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    serial: {
      port: config.serial.simulate ? 'SIMULATED' : config.serial.port,
      connected,
      simulate: config.serial.simulate,
      lastReadingAge,
    },
  };

  res.status(connected ? 200 : 503).json(body);
});

export { router as weightRouter };
