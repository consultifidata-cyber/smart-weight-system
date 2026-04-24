import config from './config.js';
import logger from './utils/logger.js';
import { StabilityDetector } from './stability/detector.js';
import { WeightReader } from './serial/reader.js';
import { WeightSimulator, SIMULATED_PATH } from './serial/simulator.js';
import { createServer } from './api/server.js';
import type { WeightReading } from './types.js';

async function main(): Promise<void> {
  logger.info({ stationId: config.stationId, simulate: config.serial.simulate }, 'Starting weight service');

  // 1. Create stability detector
  const stabilityDetector = new StabilityDetector({
    thresholdMs: config.stability.thresholdMs,
    toleranceKg: config.stability.toleranceKg,
  });

  // 2. Create serial reader (with simulator if configured)
  let simulator: WeightSimulator | null = null;
  let readerOptions: { binding?: unknown } = {};
  let serialPort = config.serial.port;

  if (config.serial.simulate) {
    simulator = new WeightSimulator();
    const binding = simulator.init();
    readerOptions.binding = binding;
    serialPort = SIMULATED_PATH;
    logger.info('Using simulated serial port');
  }

  const weightReader = new WeightReader(
    { ...config.serial, port: serialPort },
    readerOptions,
  );

  // 3. Wire reader events to stability detector
  weightReader.on('reading', (reading: WeightReading) => {
    stabilityDetector.update(reading);
  });

  weightReader.on('error', (err: Error) => {
    logger.error({ err: err.message }, 'Weight reader error');
  });

  // 4. Open serial port
  try {
    await weightReader.openWithRetry();
  } catch {
    logger.error('Could not open serial port — API will report disconnected state');
  }

  // 5. Start simulator data generation (after port is open)
  if (simulator && weightReader.port) {
    simulator.start(weightReader.port);
  }

  // 6. Start HTTP server
  const app = createServer({ stabilityDetector, weightReader, config });
  const server = app.listen(config.api.port, () => {
    logger.info({
      stationId: config.stationId,
      port: config.api.port,
      serialPort,
      simulate: config.serial.simulate,
    }, `Weight service ready → http://localhost:${config.api.port}`);
  });

  // 7. Graceful shutdown
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down...');
    if (simulator) simulator.stop();
    server.close(async () => {
      await weightReader.close();
      logger.info('Weight service stopped');
      process.exit(0);
    });
    // Force exit after 8s if graceful shutdown stalls
    setTimeout(() => process.exit(1), 8000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
