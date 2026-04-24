import type { PrinterDriver, PrinterConfig } from '../types.js';
import type { PrintAdapter } from '../adapters/printAdapter.js';
import { UsbPrintAdapter, UsbDirectAdapter, SerialPrintAdapter } from '../adapters/printAdapter.js';
import { detectPrinters } from '../hardware/printerDetect.js';
import { TSPLDriver } from './tspl.js';
import logger from '../utils/logger.js';

/**
 * Factory — async because auto-detection may probe USB paths and spawn PowerShell.
 *
 * WINDOWS mode (PRINT_MODE=WINDOWS, default):
 *   No adapter. TSPLDriver uses existing sendWin / healthCheckWin unchanged.
 *
 * RAW_DIRECT mode (PRINT_MODE=RAW_DIRECT):
 *   Completely driverless. Three-layer cascade when PRINTER_INTERFACE=USB:
 *
 *   Layer 1 — UsbPrintAdapter (\\.\USBPRINxx)
 *     Works when Windows auto-installed usbprint.sys (USB Printer Class devices).
 *     usbprint.sys ships inside Windows — no user driver install needed.
 *
 *   Layer 2 — UsbDirectAdapter (node-usb / libusb)
 *     Works when no kernel driver owns the USB interface (rare "Unknown Device"
 *     case). On Windows, libusb CANNOT access devices bound to usbprint.sys —
 *     that is intentional: layer 1 handles those cases.
 *
 *   Layer 3 — SerialPrintAdapter (COM port)
 *     Works when printer uses USB-CDC mode (e.g. TVS LP 46 NEO with WCH chip).
 *     Windows auto-installs usbser.sys for CDC devices. No user action needed.
 *     Requires PRINTER_INTERFACE=COM and PRINTER_COM_PORT=COMx in .env.
 */
export async function createDriver(config: PrinterConfig): Promise<PrinterDriver> {
  const { driver, device, labelWidth, labelHeight, dpi } = config;

  let adapter: PrintAdapter | undefined;

  if (config.printMode === 'RAW_DIRECT') {

    // ── Explicit COM override ────────────────────────────────────────────────
    if (config.printerInterface === 'COM') {
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
      // ── USB mode: Layer 1 → 2 → lazy ──────────────────────────────────────

      // Explicit device path → skip detection, use exactly what was configured
      if (config.printerUsbDevice) {
        adapter = new UsbPrintAdapter(config.printerUsbDevice);
        logger.info(
          { path: config.printerUsbDevice },
          'Using explicit PRINTER_USB_DEVICE',
        );

      } else if (config.printerAutoDetect) {
        // Auto-detect: first try \\.\USBPRINxx (layer 1), then libusb (layer 2)
        logger.info('[driver-factory] Auto-detecting printer (USBPRIN → libusb cascade)...');

        const result = await detectPrinters('TSPL');

        if (result.selected) {
          // Layer 1: USBPRIN path found via PnP detection
          adapter = new UsbPrintAdapter(result.selected.devicePath);
          logger.info(
            {
              layer:    1,
              path:     result.selected.devicePath,
              vid:      result.selected.vid,
              protocol: result.selected.likelyProtocol,
            },
            'Layer 1 (USBPRIN) printer path resolved',
          );
        } else {
          // Layer 2: no USBPRIN path — try libusb direct access
          logger.info('[driver-factory] No USBPRIN path found — probing via libusb (layer 2)...');
          const direct = new UsbDirectAdapter();
          const directAvail = await direct.healthCheck();
          if (directAvail) {
            adapter = direct;
            logger.info({ layer: 2 }, 'Layer 2 (libusb) printer adapter ready');
          } else {
            // Neither found — use lazy UsbPrintAdapter (probes on first send)
            logger.warn(
              { reason: result.selectionReason },
              'No printer found at startup — adapter will probe on first send(). ' +
              'Ensure printer is connected and powered on.',
            );
            adapter = new UsbPrintAdapter();
          }
        }

      } else {
        // No auto-detect: create lazy UsbPrintAdapter (probes on first send)
        adapter = new UsbPrintAdapter();
        logger.info(
          { mode: 'RAW_DIRECT', interface: 'USB' },
          'USB adapter created — device path probed on first send()',
        );
      }
    }
  } else {
    logger.info({ mode: 'WINDOWS', device }, 'Windows spooler printer driver (existing path)');
  }

  // ── Instantiate TSPL/ZPL/ESC-POS protocol driver ─────────────────────────
  switch (driver.toLowerCase()) {
    case 'tspl':
      return new TSPLDriver(device, labelWidth, labelHeight, dpi, config.printerName, adapter);

    case 'tsc':
      throw new Error('TSC driver not yet implemented');

    default:
      throw new Error(`Unknown printer driver: ${driver}`);
  }
}
