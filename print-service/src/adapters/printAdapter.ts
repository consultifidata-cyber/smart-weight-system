/**
 * Driverless print adapters — Phase 1 + Phase 7 (revised)
 *
 * Three-layer cascade, all completely driverless:
 *
 *   Layer 1 — UsbPrintAdapter
 *     Windows: writes to \\.\USBPRINxx via usbprint.sys.
 *     usbprint.sys is a generic Windows class driver that auto-installs
 *     (silently, ~2 s) when a USB Printer Class device is plugged in.
 *     Zero user action required.
 *
 *   Layer 2 — UsbDirectAdapter  [NEW — Phase 7]
 *     Uses node-usb (libusb) to claim the USB Printer Class interface directly.
 *     Works ONLY when no kernel driver owns the interface (e.g. "Unknown Device"
 *     in Device Manager). Cannot access devices already bound to usbprint.sys
 *     — that is intentional: Layer 1 handles those.
 *
 *   Layer 3 — SerialPrintAdapter
 *     Writes raw bytes to a COM port (USB-CDC mode printers, e.g. TVS LP 46 NEO
 *     with WCH/GD32 chip). Windows auto-loads usbser.sys for CDC devices.
 *     Zero user action required.
 *
 * None of these touch the Windows Print Spooler, require printer sharing,
 * or require a vendor-supplied printer driver to be installed.
 */

import { promises as fs, constants as fsConstants } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SerialPort } from 'serialport';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);

// ── Public interface ──────────────────────────────────────────────────────────

export interface PrintAdapter {
  /** Send raw printer command buffer directly to the device. */
  sendRaw(buffer: Buffer): Promise<void>;
  /** Returns true if the printer device is currently reachable. */
  healthCheck(): Promise<boolean>;
  /** Human-readable description for logging / status endpoints. */
  getInfo(): string;
}

// ── Candidate device paths ────────────────────────────────────────────────────

// Windows: usbprint.sys registers \\.\USBPRIN01 … \\.\USBPRIN09.
// The index is assigned in connection order and is stable per session.
const WIN_USB_CANDIDATES = Array.from(
  { length: 9 },
  (_, i) => `\\\\.\\USBPRIN0${i + 1}`,
);

// Linux: USB printer class devices appear at /dev/usb/lp0 … /dev/usb/lp3
const LNX_USB_CANDIDATES = Array.from(
  { length: 4 },
  (_, i) => `/dev/usb/lp${i}`,
);

// ── USB Print Adapter ─────────────────────────────────────────────────────────

export class UsbPrintAdapter implements PrintAdapter {
  private resolvedPath: string | null = null;
  private readonly candidates: readonly string[];

  /**
   * @param devicePath  Explicit path, e.g. '\\\\.\\USBPRIN02'. When omitted
   *                    the adapter auto-discovers on first send/healthCheck.
   */
  constructor(devicePath?: string) {
    if (devicePath) {
      this.resolvedPath = devicePath;
      this.candidates   = [devicePath];
    } else {
      this.candidates = process.platform === 'win32'
        ? WIN_USB_CANDIDATES
        : LNX_USB_CANDIDATES;
    }
  }

  getInfo(): string {
    return `UsbPrintAdapter(resolved=${this.resolvedPath ?? 'pending'}, platform=${process.platform})`;
  }

  // ── Device discovery ────────────────────────────────────────────────────

  /**
   * Probe each candidate path with a non-destructive open+close.
   * Returns the first accessible path, or null if none found.
   */
  private async _discover(): Promise<string | null> {
    for (const candidate of this.candidates) {
      try {
        // Open for write (O_WRONLY maps to GENERIC_WRITE | OPEN_EXISTING on
        // Windows). Immediately close — we are only probing for existence.
        const fd = await fs.open(candidate, fsConstants.O_WRONLY);
        await fd.close();
        logger.info({ devicePath: candidate }, '[usb-print] USB printer device discovered');
        return candidate;
      } catch {
        // Device not present at this index — try next
      }
    }
    logger.warn(
      { tried: this.candidates },
      '[usb-print] No USB printer device found during discovery',
    );
    return null;
  }

  // ── Send ────────────────────────────────────────────────────────────────

  async sendRaw(buffer: Buffer): Promise<void> {
    if (!this.resolvedPath) {
      this.resolvedPath = await this._discover();
      if (!this.resolvedPath) {
        throw new Error(
          `USB printer not found. Checked: ${this.candidates.join(', ')}. ` +
          `Verify the printer is connected and powered on.`,
        );
      }
    }

    if (process.platform === 'win32') {
      await this._sendWin(buffer, this.resolvedPath);
    } else {
      await this._sendLinux(buffer, this.resolvedPath);
    }

    logger.debug(
      { path: this.resolvedPath, bytes: buffer.length },
      '[usb-print] Raw send complete',
    );
  }

  /**
   * Windows send strategy:
   *   1. Direct fs write to \\.\USBPRINxx (fast, no subprocess).
   *   2. PowerShell [IO.FileStream] fallback (handles sharing-flag edge cases
   *      on some Windows 10 builds where direct open returns a sharing violation).
   */
  private async _sendWin(buffer: Buffer, devicePath: string): Promise<void> {
    // ── Attempt 1: direct fd write ──────────────────────────────────────────
    try {
      const fd = await fs.open(devicePath, fsConstants.O_WRONLY);
      await fd.write(buffer);
      await fd.close();
      return;
    } catch (directErr) {
      logger.debug(
        { path: devicePath, err: String(directErr) },
        '[usb-print] Direct fd write failed — falling back to PowerShell FileStream',
      );
      this.resolvedPath = null; // May have re-enumerated; force re-discovery next call
    }

    // ── Attempt 2: PowerShell FileStream (explicit ReadWrite share mode) ───
    const tmpFile = join(tmpdir(), `sws_usb_${Date.now()}.bin`);
    try {
      await fs.writeFile(tmpFile, buffer);

      // Single-quoted PS strings: escape embedded single quotes as ''
      const psDevice = devicePath.replace(/'/g, "''");
      const psTmp    = tmpFile.replace(/\\/g, '\\\\').replace(/'/g, "''");

      const psScript = [
        `$d = '${psDevice}'`,
        `$t = '${psTmp}'`,
        `$st = [IO.File]::Open($d, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)`,
        `$b  = [IO.File]::ReadAllBytes($t)`,
        `$st.Write($b, 0, $b.Length)`,
        `$st.Flush()`,
        `$st.Close()`,
      ].join('; ');

      await execAsync(
        `powershell -NonInteractive -NoProfile -Command "${psScript}"`,
        { timeout: 5000 },
      );
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  /** Linux: direct device file write — identical to existing sendLinux(). */
  private async _sendLinux(buffer: Buffer, devicePath: string): Promise<void> {
    try {
      await fs.writeFile(devicePath, buffer);
    } catch (err) {
      // Clear cached path: device may have re-enumerated (e.g. lp0 → lp1)
      this.resolvedPath = null;
      throw new Error(`USB write failed on ${devicePath}: ${String(err)}`);
    }
  }

  // ── Health check ────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    // Use cached path if we have one, otherwise probe the first candidate
    const probe = this.resolvedPath ?? this.candidates[0];
    try {
      // fs.access F_OK → GetFileAttributesW on Windows → device-path existence check
      await fs.access(probe as string, fsConstants.F_OK);
      return true;
    } catch {
      this.resolvedPath = null; // Stale — force re-discovery next send
      return false;
    }
  }
}

// ── Serial Print Adapter ──────────────────────────────────────────────────────

export class SerialPrintAdapter implements PrintAdapter {
  private readonly portPath: string;
  private readonly baudRate: number;
  private port: SerialPort | null = null;

  /**
   * @param portPath  COM port, e.g. 'COM4' (Windows) or '/dev/ttyUSB0' (Linux)
   * @param baudRate  Most label printers default to 9600
   */
  constructor(portPath: string, baudRate: number = 9600) {
    this.portPath = portPath;
    this.baudRate = baudRate;
  }

  getInfo(): string {
    return `SerialPrintAdapter(port=${this.portPath}, baud=${this.baudRate}, open=${this.port?.isOpen ?? false})`;
  }

  // ── Port management ─────────────────────────────────────────────────────

  private async _ensureOpen(): Promise<SerialPort> {
    if (this.port?.isOpen) return this.port;

    const port = new SerialPort({
      path:     this.portPath,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (err) {
          reject(new Error(`Cannot open printer port ${this.portPath}: ${err.message}`));
        } else {
          logger.info(
            { port: this.portPath, baud: this.baudRate },
            '[serial-print] Port opened',
          );
          resolve();
        }
      });
    });

    this.port = port;
    return port;
  }

  // ── Send ────────────────────────────────────────────────────────────────

  async sendRaw(buffer: Buffer): Promise<void> {
    const port = await this._ensureOpen();

    await new Promise<void>((resolve, reject) => {
      port.write(buffer, (writeErr) => {
        if (writeErr) { reject(writeErr); return; }
        // drain() blocks until all bytes have left the OS transmit buffer
        port.drain((drainErr) => {
          if (drainErr) reject(drainErr);
          else resolve();
        });
      });
    });

    logger.debug(
      { port: this.portPath, bytes: buffer.length },
      '[serial-print] Raw send complete',
    );
  }

  // ── Health check ────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    if (this.port?.isOpen) return true;
    try {
      const ports = await SerialPort.list();
      const found = ports.some((p) => p.path === this.portPath);
      if (!found) {
        logger.debug(
          { port: this.portPath, available: ports.map(p => p.path) },
          '[serial-print] Port not in available COM list',
        );
      }
      return found;
    } catch {
      return false;
    }
  }
}

// ── USB Direct Adapter (libusb / node-usb) — Phase 7 ─────────────────────────
//
// Uses libusb to claim the USB Printer Class interface directly.
//
// When to use:
//   ✓ Printer shows as "Unknown Device" in Windows Device Manager (no driver bound)
//   ✓ Linux (always — libusb can detach kernel driver)
//   ✗ Windows when usbprint.sys IS loaded → use UsbPrintAdapter (\\.\USBPRINxx) instead
//
// libusb cannot claim an interface already bound to a kernel driver on Windows.
// LIBUSB_ERROR_ACCESS is caught and treated as "device not available here;
// try UsbPrintAdapter instead".

const USB_PRINTER_CLASS = 0x07;
const LIBUSB_TRANSFER_TIMEOUT_MS = 5_000;

export class UsbDirectAdapter implements PrintAdapter {
  private _iface:    unknown = null;  // usb.Interface — typed as unknown to avoid top-level usb import
  private _endpoint: unknown = null;  // usb.OutEndpoint
  private _device:   unknown = null;  // usb.Device

  getInfo(): string {
    return `UsbDirectAdapter(libusb, claimed=${this._endpoint !== null})`;
  }

  // ── Connect: enumerate devices, claim printer interface ──────────────────

  async connect(): Promise<void> {
    // Dynamic import so the module only loads when actually needed.
    // This avoids native-module load failures crashing the service when
    // the 'usb' package pre-built binary is not available for a given Node ABI.
    let usbMod: typeof import('usb');
    try {
      usbMod = await import('usb');
    } catch (importErr) {
      throw new Error(
        `UsbDirectAdapter: 'usb' package not available: ${String(importErr)}. ` +
        `Run npm install in print-service.`,
      );
    }

    const devices = usbMod.getDeviceList();

    for (const dev of devices) {
      let opened = false;
      try {
        dev.open();
        opened = true;

        for (const iface of (dev as any).interfaces as any[]) {
          if (iface.descriptor.bInterfaceClass !== USB_PRINTER_CLASS) continue;

          try {
            // Linux: detach kernel driver so we can claim the interface
            if (process.platform !== 'win32' && iface.isKernelDriverActive?.()) {
              iface.detachKernelDriver();
              logger.debug('[usb-direct] Detached kernel driver from printer interface');
            }

            iface.claim();

            const ep = (iface.endpoints as any[]).find((e: any) => e.direction === 'out');
            if (!ep) {
              iface.release(true);
              continue;
            }

            this._device   = dev;
            this._iface    = iface;
            this._endpoint = ep;
            logger.info(
              { idVendor: dev.deviceDescriptor?.idVendor, idProduct: dev.deviceDescriptor?.idProduct },
              '[usb-direct] USB Printer Class interface claimed via libusb',
            );
            return;
          } catch (claimErr) {
            // LIBUSB_ERROR_ACCESS: usbprint.sys owns this device on Windows.
            // This is expected — caller should use UsbPrintAdapter instead.
            logger.debug(
              { err: String(claimErr) },
              '[usb-direct] Interface claim failed (likely bound to usbprint.sys)',
            );
          }
        }

        dev.close();
        opened = false;
      } catch {
        if (opened) { try { (dev as any).close(); } catch { /* best effort */ } }
      }
    }

    throw new Error(
      'UsbDirectAdapter: No claimable USB Printer Class (0x07) interface found. ' +
      'On Windows this adapter only works when no kernel driver (e.g. usbprint.sys) ' +
      'owns the device. If \\\\.\\\\ USBPRIN01 exists, the printer is already accessible ' +
      'via UsbPrintAdapter — use that instead.',
    );
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async sendRaw(buffer: Buffer): Promise<void> {
    if (!this._endpoint) await this.connect();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[usb-direct] Transfer timeout after ${LIBUSB_TRANSFER_TIMEOUT_MS}ms`));
      }, LIBUSB_TRANSFER_TIMEOUT_MS);

      (this._endpoint as any).transfer(buffer, (err: Error | undefined) => {
        clearTimeout(timer);
        if (err) {
          this._endpoint = null; // Force reconnect next time
          reject(new Error(`[usb-direct] Transfer failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // ── Health check ──────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    if (this._endpoint) return true;

    let usbMod: typeof import('usb');
    try {
      usbMod = await import('usb');
    } catch {
      return false;
    }

    // Check if any USB Printer Class device is present (don't try to claim it here)
    for (const dev of usbMod.getDeviceList()) {
      let opened = false;
      try {
        dev.open();
        opened = true;
        const hasPrinterClass = (dev as any).interfaces?.some(
          (iface: any) => iface.descriptor.bInterfaceClass === USB_PRINTER_CLASS,
        ) ?? false;
        dev.close();
        if (hasPrinterClass) return true;
      } catch {
        if (opened) { try { (dev as any).close(); } catch { /* best effort */ } }
      }
    }
    return false;
  }

  disconnect(): void {
    try {
      if (this._iface) (this._iface as any).release(true);
    } catch { /* best effort */ }
    try {
      if (this._device) (this._device as any).close();
    } catch { /* best effort */ }
    this._iface    = null;
    this._endpoint = null;
    this._device   = null;
  }
}

// ── Cascading Print Adapter — Self-Healing Layer ──────────────────────────────
//
// Wraps the three adapter layers into a single self-healing adapter:
//   Layer 1: UsbPrintAdapter  (\\.\USBPRINxx — usbprint.sys, auto-installed)
//   Layer 2: UsbDirectAdapter (node-usb/libusb — no-driver USB devices)
//   Layer 3: SerialPrintAdapter (COM port — USB-CDC printers)
//
// Recovery behaviour:
//   - healthCheck() re-probes the cascade automatically when current fails.
//   - sendRaw() retries once on failure after switching to the next adapter.
//   - Logs "Printer lost → re-detecting..." / "Recovered via <adapter>"
//   - No restart required. Recovery completes within one heartbeat cycle.

export class CascadingPrintAdapter implements PrintAdapter {
  private _current:     PrintAdapter | null = null;
  private _currentName  = 'none';
  private _recovering   = false;

  private readonly _usbDevice: string | undefined;
  private readonly _comPort:   string | undefined;

  constructor(opts: { usbDevice?: string; comPort?: string } = {}) {
    this._usbDevice = opts.usbDevice;
    this._comPort   = opts.comPort;
  }

  getInfo(): string {
    return `CascadingPrintAdapter(active=${this._currentName}, recovering=${this._recovering})`;
  }

  /** Whether a recovery cycle is currently in progress. */
  get recovering(): boolean { return this._recovering; }

  // ── Internal cascade probe ────────────────────────────────────────────────

  private async _probe(): Promise<{ adapter: PrintAdapter; name: string } | null> {
    // Layer 1 — \\.\USBPRINxx
    const usbAdapter = new UsbPrintAdapter(this._usbDevice);
    if (await usbAdapter.healthCheck()) {
      const path = (usbAdapter as any).resolvedPath as string | null;
      return { adapter: usbAdapter, name: `USBPRIN:${path ?? 'auto'}` };
    }

    // Layer 2 — libusb direct
    const directAdapter = new UsbDirectAdapter();
    if (await directAdapter.healthCheck()) {
      return { adapter: directAdapter, name: 'libusb' };
    }

    // Layer 3 — COM port (USB-CDC printers, e.g. TVS LP 46 NEO WCH variant)
    if (this._comPort) {
      const serialAdapter = new SerialPrintAdapter(this._comPort);
      if (await serialAdapter.healthCheck()) {
        return { adapter: serialAdapter, name: `COM:${this._comPort}` };
      }
    }

    return null;
  }

  // ── Recovery ─────────────────────────────────────────────────────────────

  private async _recover(reason: string): Promise<boolean> {
    if (this._recovering) return false;   // guard: one recovery at a time
    this._recovering = true;

    logger.warn(
      { reason, prev: this._currentName },
      '[cascade] Printer lost — re-detecting…',
    );

    const found = await this._probe();
    this._recovering = false;

    if (found) {
      this._current     = found.adapter;
      this._currentName = found.name;
      logger.info({ adapter: found.name }, '[cascade] Printer recovered');
      return true;
    }

    this._current     = null;
    this._currentName = 'none';
    logger.warn('[cascade] Re-detection found no printer — will retry on next heartbeat');
    return false;
  }

  // ── Health check (drives the 10 s heartbeat recovery loop) ───────────────

  async healthCheck(): Promise<boolean> {
    // No adapter yet — initial probe
    if (!this._current) {
      const found = await this._probe();
      if (found) {
        this._current     = found.adapter;
        this._currentName = found.name;
        logger.info({ adapter: found.name }, '[cascade] Printer connected');
      }
      return !!found;
    }

    // Current adapter exists — test it
    const ok = await this._current.healthCheck();
    if (!ok) {
      await this._recover('health check returned false');
      return this._current !== null;
    }
    return true;
  }

  // ── Send (auto-fallback on failure) ───────────────────────────────────────

  async sendRaw(buffer: Buffer): Promise<void> {
    // Ensure we have an adapter
    if (!this._current) {
      const found = await this._probe();
      if (!found) {
        throw new Error('[cascade] No printer adapter available — is the printer connected?');
      }
      this._current     = found.adapter;
      this._currentName = found.name;
    }

    try {
      await this._current.sendRaw(buffer);
    } catch (firstErr) {
      logger.warn(
        { adapter: this._currentName, err: String(firstErr) },
        '[cascade] Send failed — switching adapter…',
      );

      const recovered = await this._recover('send failed');
      if (!recovered || !this._current) {
        throw new Error(
          `[cascade] Print failed on all adapters. Last error: ${String(firstErr)}`,
        );
      }

      // One retry on the newly selected adapter
      await this._current.sendRaw(buffer);
    }
  }
}
