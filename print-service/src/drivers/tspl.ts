import type { PrinterDriver, LabelData } from '../types.js';
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
 * Linux methods: send(), healthCheck()       — use device file path (e.g. /dev/usb/lp0)
 * Windows methods: sendWin(), healthCheckWin() — use shared printer name (e.g. TVSLP46NEO)
 */
export class TSPLDriver implements PrinterDriver {
  private device: string;
  private printerName: string;
  private labelWidth: number;
  private labelHeight: number;
  private dpi: number;

  constructor(device: string, labelWidth: number, labelHeight: number, dpi: number = 203, printerName?: string) {
    this.device = device;
    this.printerName = printerName || device;
    this.labelWidth = labelWidth;
    this.labelHeight = labelHeight;
    this.dpi = dpi;
  }

  /**
   * Build TSPL command buffer for a QR label using BITMAP command.
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
  buildLabel(data: LabelData): Buffer {
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
    const bmpX = Math.round((labelWidthDots - bmpWidthDots) / 2) + 80; // +80 dots = 10mm right shift

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
    const line1X = Math.max(10, Math.round((labelWidthDots - line1Width) / 2)) + 80; // +80 dots = 10mm right shift
    const line1Y = textStartY;

    // Line 2: font "2" (12×16 dots per char)
    const line2 = textLines[1] || '';
    const line2CharWidth = 12;
    const line2Width = line2.length * line2CharWidth;
    const line2X = Math.max(10, Math.round((labelWidthDots - line2Width) / 2)) + 80; // +80 dots = 10mm right shift
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

  /**
   * Send TSPL commands to the printer device.
   * Supports raw device files: /dev/lp0, /dev/usb/lp0, /dev/bus/usb/001/082, etc.
   */
  async send(commands: Buffer): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    try {
      await fs.writeFile(this.device, commands);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send print commands to ${this.device}: ${error}`);
    }
  }

  /**
   * Health check: verify device is accessible (Linux)
   */
  async healthCheck(): Promise<boolean> {
    const fs = await import('fs').then(m => m.promises);
    try {
      await fs.access(this.device);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send TSPL commands to a Windows shared printer via copy /b.
   * Writes commands to a temp file, then copies to \\localhost\<shareName>.
   */
  async sendWin(commands: Buffer): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    const tempFile = join(tmpdir(), `tspl_${Date.now()}.bin`);
    try {
      await fs.writeFile(tempFile, commands);
      const uncPath = `\\\\localhost\\${this.device}`;
      await execAsync(`copy /b "${tempFile}" "${uncPath}"`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send print commands to \\\\localhost\\${this.device}: ${error}`);
    } finally {
      // Clean up temp file
      const fs2 = await import('fs').then(m => m.promises);
      await fs2.unlink(tempFile).catch(() => {});
    }
  }

  /**
   * Health check for Windows: query printer status via PowerShell Get-Printer.
   * Uses the full Windows printer name (e.g. "SNBC TVSE LP 46 NEO BPLE").
   */
  async healthCheckWin(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `powershell -Command "(Get-Printer -Name '${this.printerName}').PrinterStatus"`,
      );
      return stdout.trim() === 'Normal';
    } catch {
      return false;
    }
  }
}
