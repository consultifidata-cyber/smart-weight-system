import type { PrinterDriver, PrinterConfig } from '../types.js';
import { TSPLDriver } from './tspl.js';
import logger from '../utils/logger.js';

/**
 * Factory function: create a PrinterDriver instance based on config.
 */
export function createDriver(config: PrinterConfig): PrinterDriver {
  const { driver, device, labelWidth, labelHeight, dpi } = config;

  logger.info({ driver, device }, 'Creating printer driver');

  switch (driver.toLowerCase()) {
    case 'tspl':
      return new TSPLDriver(device, labelWidth, labelHeight, dpi, config.printerName);

    // Future: TSC driver, ESCPOS driver, CUPS driver, etc.
    case 'TSC':
      throw new Error('TSC driver not yet implemented');

    default:
      throw new Error(`Unknown printer driver: ${driver}`);
  }
}
