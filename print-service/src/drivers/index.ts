import type { PrinterDriver, PrinterConfig } from '../types.js';
import type { PrintAdapter } from '../adapters/printAdapter.js';
import { CascadingPrintAdapter, SerialPrintAdapter } from '../adapters/printAdapter.js';
import { TSPLDriver } from './tspl.js';
import logger from '../utils/logger.js';

/**
 * Factory — creates the appropriate printer driver based on config.
 *
 * WINDOWS mode (PRINT_MODE=WINDOWS, default):
 *   No adapter. TSPLDriver uses existing sendWin / healthCheckWin unchanged.
 *
 * RAW_DIRECT + PRINTER_INTERFACE=COM:
 *   SerialPrintAdapter — for USB-CDC printers (e.g. TVS LP 46 NEO WCH variant).
 *
 * RAW_DIRECT + PRINTER_INTERFACE=USB (default):
 *   CascadingPrintAdapter — self-healing three-layer cascade:
 *     1. \\.\USBPRINxx  (usbprint.sys, auto-loaded by Windows, no user action)
 *     2. libusb/node-usb (for devices with no Windows driver bound)
 *     3. COM port        (fallback if comPort configured and USB layers fail)
 *   Recovery happens automatically on every 10 s heartbeat — no restart needed.
 */
export async function createDriver(config: PrinterConfig): Promise<PrinterDriver> {
  const { driver, device, labelWidth, labelHeight, dpi } = config;

  // ── Startup diagnostic — log every relevant value so production logs are
  // self-contained and unambiguous. This is the first thing to check when
  // the printer shows red.
  logger.info(
    {
      printMode:        config.printMode,
      printerInterface: config.printerInterface,
      device:           config.device,
      printerName:      config.printerName,
      printerUsbDevice: config.printerUsbDevice || '(empty)',
      printerComPort:   config.printerComPort   || '(empty)',
    },
    'Print driver init — effective config',
  );

  let adapter: PrintAdapter | undefined;

  // ── WINDOWS mode: use Windows print spooler — NO adapter, NO cascade.
  // This branch is an explicit early path so the cascade block below is
  // structurally unreachable when PRINT_MODE=WINDOWS. Any future refactor
  // that accidentally removes this guard will fail the TypeScript type check
  // because `adapter` is still `undefined` and TSPLDriver accepts that.
  if (config.printMode !== 'RAW_DIRECT') {
    logger.info({ mode: 'WINDOWS', device }, 'Windows spooler printer driver');
    // adapter stays undefined → TSPLDriver routes to sendWin / healthCheckWin
    return new TSPLDriver(device, labelWidth, labelHeight, dpi, config.printerName, undefined);
  }

  // ── RAW_DIRECT mode only below this point ────────────────────────────────

  if (config.printerInterface === 'COM') {
    // Explicit COM mode — USB-CDC printer on a specific serial port
    if (!config.printerComPort) {
      throw new Error(
        'PRINTER_COM_PORT is required when PRINT_MODE=RAW_DIRECT and PRINTER_INTERFACE=COM',
      );
    }
    adapter = new SerialPrintAdapter(config.printerComPort);
    logger.info(
      { mode: 'RAW_DIRECT', interface: 'COM', port: config.printerComPort },
      'Driverless serial (USB-CDC) print adapter ready',
    );

  } else {
    // USB mode — CascadingPrintAdapter handles USBPRIN → libusb → COM internally.
    adapter = new CascadingPrintAdapter({
      usbDevice: config.printerUsbDevice || undefined,
      comPort:   config.printerComPort   || undefined,
    });
    logger.info(
      {
        mode:      'RAW_DIRECT',
        interface: 'USB',
        cascade:   'USBPRIN → libusb → COM',
        usbDevice: config.printerUsbDevice || 'auto',
        comPort:   config.printerComPort   || 'none',
      },
      'Self-healing cascading print adapter created',
    );
  }

  switch (driver.toLowerCase()) {
    case 'tspl':
      return new TSPLDriver(device, labelWidth, labelHeight, dpi, config.printerName, adapter);
    case 'tsc':
      throw new Error('TSC driver not yet implemented');
    default:
      throw new Error(`Unknown printer driver: ${driver}`);
  }
}
