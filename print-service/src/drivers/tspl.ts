import type { PrinterDriver, LabelData } from '../types.js';
import type { PrintAdapter } from '../adapters/printAdapter.js';
import { exec } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { generateQrBitmap } from '../utils/qr-bitmap.js';

const execAsync = promisify(exec);

/**
 * Base TSPL driver implementation.
 * TSPL is used by TVS LP NEO 46 and TSC printers.
 *
 * Generic methods auto-detect the OS via process.platform and dispatch
 * to the appropriate platform-specific method.
 *
 * Linux methods: sendLinux(), healthCheckLinux()   — use device file path (e.g. /dev/usb/lp0)
 * Windows methods: sendWin(), healthCheckWin()     — use shared printer name (e.g. TVSLP46NEO)
 */
export class TSPLDriver implements PrinterDriver {
  private device: string;
  private printerName: string;
  private labelWidth: number;
  private labelHeight: number;
  private dpi: number;
  // Phase 1: when set, all send/health/reset calls route through this adapter
  // instead of the Windows spooler path. Existing sendWin / healthCheckWin /
  // resetPrinterWin methods are left entirely intact for WINDOWS mode.
  private readonly adapter: PrintAdapter | null;

  constructor(
    device: string,
    labelWidth: number,
    labelHeight: number,
    dpi: number = 203,
    printerName?: string,
    adapter?: PrintAdapter,
  ) {
    this.device = device;
    this.printerName = printerName || device;
    this.labelWidth = labelWidth;
    this.labelHeight = labelHeight;
    this.dpi = dpi;
    this.adapter = adapter ?? null;
  }

  // ── Shared label-building core ──────────────────────────────────────────

  /**
   * Core TSPL command buffer generation for a QR label using BITMAP command.
   *
   * The QR image is generated in Node.js (using the `qrcode` npm library)
   * instead of the printer's built-in QRCODE command. This matches the
   * Python `qrcode` library used for PDF labels, ensuring identical QR
   * encoding, version selection, ECC, and quiet-zone borders.
   *
   * Layout (50×50 mm = 400×400 dots at 203 DPI):
   *   - QR image: 336 dots (42mm) — includes 2-module border, matching PDF
   *   - Line 1 (font "2", 12×16 dots): counter / code
   *   - Line 2 (font "2", 12×16 dots): QR string / secondary info
   *
   * Matches Python PDF layout:
   *   QR_CODE_MM_STANDARD = 42.0 (image size including 2-module border)
   *   error_correction = ERROR_CORRECT_Q
   *   border = 2
   */
  private _buildLabelCore(data: LabelData): Buffer {
    const { qrContent, textLines } = data;
    const width = data.labelWidth || this.labelWidth;
    const height = data.labelHeight || this.labelHeight;

    // At 203 DPI: 1mm ≈ 8 dots
    const labelWidthDots = Math.round(width * 8);

    // ── Generate QR bitmap (matches Python qrcode library params) ────────
    // Target 336 dots = 42mm at 203 DPI, matching PDF's QR_CODE_MM_STANDARD
    const qrTargetDots = 336;
    const { data: bmpData, widthBytes, heightDots } = generateQrBitmap(qrContent, qrTargetDots);

    // Centre QR bitmap on the label.
    const bmpWidthDots = Math.ceil(qrTargetDots / 8) * 8; // byte-aligned width
    const bmpX = Math.round((labelWidthDots - bmpWidthDots) / 2);

    // Vertical: centre the full content block (bitmap + gap + 2 text lines)
    // Block height: 336 (bitmap) + 4 (gap) + 16 (line1) + 4 (gap) + 16 (line2) = 376
    const labelHeightDots = Math.round(height * 8);
    const contentHeight = qrTargetDots + 4 + 16 + 4 + 16; // 376 dots
    const bmpY = Math.max(0, Math.round((labelHeightDots - contentHeight) / 2));

    // ── TSPL setup commands (text, CR+LF terminated) ─────────────────────
    const setupCmds = [
      `SIZE ${width} mm, ${height} mm`,
      'GAP 2 mm, 0 mm',
      'DIRECTION 1',
      'DENSITY 14',
      'SPEED 2',
      'CLS',
    ];
    const setupBuf = Buffer.from(setupCmds.join('\r\n') + '\r\n', 'utf-8');

    // ── BITMAP command: header (text) + raw binary data ──────────────────
    // TSPL format: BITMAP x,y,width_bytes,height_dots,mode,<raw_binary>
    // mode 0 = overwrite (OR onto label)
    const bmpCmdHeader = `BITMAP ${bmpX},${bmpY},${widthBytes},${heightDots},0,`;
    const bmpHeaderBuf = Buffer.from(bmpCmdHeader, 'utf-8');

    // ── Text below QR + print command ────────────────────────────────────
    const textStartY = bmpY + heightDots + 4; // 4-dot (0.5mm) gap after bitmap

    // Line 1: font "2" (12×16 dots per char)
    const line1 = textLines[0] || '';
    const line1CharWidth = 12;
    const line1Width = line1.length * line1CharWidth;
    const line1X = Math.max(10, Math.round((labelWidthDots - line1Width) / 2));
    const line1Y = textStartY;

    // Line 2: font "2" (12×16 dots per char)
    const line2 = textLines[1] || '';
    const line2CharWidth = 12;
    const line2Width = line2.length * line2CharWidth;
    const line2X = Math.max(10, Math.round((labelWidthDots - line2Width) / 2));
    const line2Y = line1Y + 20; // 16 dots char height + 4 dots gap

    const textCmds = [
      `TEXT ${line1X},${line1Y},"2",0,1,1,"${line1}"`,
      `TEXT ${line2X},${line2Y},"2",0,1,1,"${line2}"`,
      'PRINT 1,1',
    ];
    const textBuf = Buffer.from('\r\n' + textCmds.join('\r\n') + '\r\n', 'utf-8');

    // ── Assemble: setup + bitmap_header + bitmap_data + text + print ─────
    return Buffer.concat([setupBuf, bmpHeaderBuf, bmpData, textBuf]);
  }

  // ── Platform-specific: buildLabel ───────────────────────────────────────

  buildLabelLinux(data: LabelData): Buffer {
    return this._buildLabelCore(data);
  }

  buildLabelWin(data: LabelData): Buffer {
    return this._buildLabelCore(data);
  }

  /** Generic dispatcher — auto-detects platform. */
  buildLabel(data: LabelData): Buffer {
    return process.platform === 'linux'
      ? this.buildLabelLinux(data)
      : this.buildLabelWin(data);
  }

  // ── Platform-specific: send ─────────────────────────────────────────────

  /**
   * Send TSPL commands to the printer device (Linux).
   * Supports raw device files: /dev/lp0, /dev/usb/lp0, /dev/bus/usb/001/082, etc.
   */
  async sendLinux(commands: Buffer, timeoutMs: number = 1000): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    try {
      await fs.writeFile(this.device, commands, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send print commands to ${this.device}: ${error}`);
    }
  }

  /**
   * Send TSPL commands to a Windows shared printer via copy /b.
   * Writes commands to a temp file, then copies to \\localhost\<shareName>.
   */
  async sendWin(commands: Buffer, timeoutMs: number = 1000): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    const tempFile = join(tmpdir(), `tspl_${Date.now()}.bin`);
    try {
      await fs.writeFile(tempFile, commands);
      const uncPath = `\\\\localhost\\${this.device}`;
      await execAsync(`copy /b "${tempFile}" "${uncPath}"`, { timeout: timeoutMs });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send print commands to \\\\localhost\\${this.device}: ${error}`);
    } finally {
      const fs2 = await import('fs').then(m => m.promises);
      await fs2.unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Generic dispatcher.
   * RAW_DIRECT mode: routes through the injected PrintAdapter (driverless).
   * WINDOWS mode   : falls through to existing sendWin / sendLinux (unchanged).
   */
  async send(commands: Buffer, timeoutMs?: number): Promise<void> {
    if (this.adapter) {
      return this.adapter.sendRaw(commands);
    }
    return process.platform === 'linux'
      ? this.sendLinux(commands, timeoutMs)
      : this.sendWin(commands, timeoutMs);
  }

  // ── Platform-specific: healthCheck ──────────────────────────────────────

  /**
   * Health check: verify device is accessible (Linux — fs.access on device file).
   */
  async healthCheckLinux(_timeoutMs?: number): Promise<boolean> {
    const fs = await import('fs').then(m => m.promises);
    try {
      await fs.access(this.device);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Health check for Windows: query printer status via PowerShell Get-Printer.
   * Uses the full Windows printer name (e.g. "SNBC TVSE LP 46 NEO BPLE").
   */
  async healthCheckWin(timeoutMs: number = 10_000): Promise<boolean> {
    try {
      const safeN = this.printerName.replace(/'/g, "''");

      // Step 1 — Quick spooler check (~100ms).
      // Catches explicit offline/error states the spooler already knows about.
      const t1 = Math.min(3000, Math.floor(timeoutMs * 0.3));
      const { stdout: spoolerOut } = await execAsync(
        `powershell -NonInteractive -NoProfile -Command "(Get-Printer -Name '${safeN}').PrinterStatus"`,
        { timeout: t1 },
      );
      const spoolerStatus = spoolerOut.trim();
      if (['Offline', 'Error', 'Unknown', 'NotAvailable', ''].includes(spoolerStatus)) {
        return false;
      }

      // Step 2 — Physical USB connectivity check (~200ms).
      // The Windows print spooler keeps a printer as "Idle" for minutes after
      // the USB cable is physically removed. But usbprint.sys removes the raw
      // \\.\USBPRINxx device path IMMEDIATELY on cable pull. Testing file-open
      // on those paths gives instant disconnect detection without relying on the
      // spooler's delayed state update.
      const t2 = Math.min(5000, Math.floor(timeoutMs * 0.6));
      const physScript =
        '$f=$false;' +
        'for($i=1;$i-le9;$i++){' +
          '$p="\\\\.\\USBPRIN0$i";' +
          'try{$s=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$s.Close();$f=$true;break}' +
          'catch{}}; ' +
        "if($f){'CONNECTED'}else{'DISCONNECTED'}";
      const { stdout: physOut } = await execAsync(
        `powershell -NonInteractive -NoProfile -Command "${physScript}"`,
        { timeout: t2 },
      );

      return physOut.trim() === 'CONNECTED';
    } catch {
      return false;
    }
  }

  /**
   * Generic dispatcher.
   * RAW_DIRECT mode: asks the adapter whether the device is reachable.
   * WINDOWS mode   : falls through to existing healthCheckWin / healthCheckLinux.
   */
  async healthCheck(timeoutMs?: number): Promise<boolean> {
    if (this.adapter) {
      return this.adapter.healthCheck();
    }
    return process.platform === 'linux'
      ? this.healthCheckLinux(timeoutMs)
      : this.healthCheckWin(timeoutMs);
  }

  // ── Platform-specific: resetPrinter ─────────────────────────────────────

  /**
   * Reset printer on Linux: unbind/rebind the USB device.
   * Derives the USB bus ID from the configured device path.
   */
  async resetPrinterLinux(): Promise<void> {
    try {
      // Find USB device path from the device file (e.g. /dev/usb/lp0)
      const { stdout } = await execAsync(
        `udevadm info --query=path --name=${this.device} 2>/dev/null`,
        { timeout: 3000 },
      );
      // Extract USB device ID (e.g. "1-2") from sysfs path
      const match = stdout.match(/\/usb\d+\/([\d.-]+)\//);
      if (match) {
        const usbId = match[1];
        await execAsync(`echo "${usbId}" > /sys/bus/usb/drivers/usb/unbind`, { timeout: 2000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        await execAsync(`echo "${usbId}" > /sys/bus/usb/drivers/usb/bind`, { timeout: 2000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch {
      // Best-effort reset — if it fails, the caller will see the next healthCheck fail
    }
  }

  /**
   * Reset printer on Windows: restart the print spooler service and clear stuck jobs.
   */
  async resetPrinterWin(): Promise<void> {
    // Stop spooler
    await execAsync('net stop spooler', { timeout: 8000 }).catch(() => {});

    // Clear stuck jobs from spool directory
    const spoolDir = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\spool\\PRINTERS`;
    try {
      const fs = await import('fs').then(m => m.promises);
      const files = await fs.readdir(spoolDir).catch(() => [] as string[]);
      for (const f of files) {
        await fs.unlink(join(spoolDir, f)).catch(() => {});
      }
    } catch { /* best effort */ }

    // Restart spooler
    await execAsync('net start spooler', { timeout: 8000 });

    // Wait for printer to re-enumerate on the spooler
    await new Promise(r => setTimeout(r, 3000));
  }

  /**
   * Generic dispatcher.
   * RAW_DIRECT mode: no spooler involved — clear the adapter's cached device
   *   path so it re-discovers on the next send (handles USB re-enumeration).
   * WINDOWS mode   : falls through to existing resetPrinterWin / resetPrinterLinux.
   */
  async resetPrinter(): Promise<void> {
    if (this.adapter) {
      // Force re-discovery: UsbPrintAdapter clears resolvedPath on healthCheck failure.
      // Calling healthCheck here achieves the re-probe without touching the spooler.
      await this.adapter.healthCheck().catch(() => {});
      return;
    }
    return process.platform === 'linux'
      ? this.resetPrinterLinux()
      : this.resetPrinterWin();
  }
}
