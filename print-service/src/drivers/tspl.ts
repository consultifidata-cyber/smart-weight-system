import type { PrinterDriver, LabelData } from '../types.js';

/**
 * Base TSPL driver implementation.
 * TSPL is used by TVS LP NEO 46 and TSC printers.
 */
export class TSPLDriver implements PrinterDriver {
  private device: string;
  private labelWidth: number;
  private labelHeight: number;
  private dpi: number;

  constructor(device: string, labelWidth: number, labelHeight: number, dpi: number = 203) {
    this.device = device;
    this.labelWidth = labelWidth;
    this.labelHeight = labelHeight;
    this.dpi = dpi;
  }

  /**
   * Build TSPL command buffer for a QR label.
   * 
   * Layout:
   *   - QR code (50x50 dots = ~12mm at 203 DPI)
   *   - Product name
   *   - Weight + Station + Date/Time
   */
  buildLabel(data: LabelData): Buffer {
    const { qrContent, textLines, entryId } = data;
    const width = data.labelWidth || this.labelWidth;
    const height = data.labelHeight || this.labelHeight;

    // At 203 DPI: 1mm ≈ 8 dots
    const labelWidthDots = Math.round(width * 8);
    const labelHeightDots = Math.round(height * 8);

    const commands: string[] = [];

    // Printer setup
    commands.push(`SIZE ${width} mm, ${height} mm`);
    commands.push('GAP 2 mm, 0 mm');
    commands.push('DIRECTION 1');
    commands.push('DENSITY 15');
    commands.push('SPEED 8');
    commands.push('CLS');

    // QR code — centered horizontally
    // QR version for typical 30-50 char content ≈ 33 modules. Total width = modules × moduleSize.
    const qrModuleSize = 8;
    const estimatedQrModules = 33;
    const qrWidth = estimatedQrModules * qrModuleSize; // ~198 dots
    const qrX = Math.round((labelWidthDots - qrWidth) / 2);
    const qrY = 15;
    commands.push(`QRCODE ${qrX},${qrY},H,${qrModuleSize},A,0,"${qrContent}"`);

    // Text below QR — centered horizontally
    // TSPL font char widths: font "2" = 12px wide, font "43" = 16px wide
    const qrBottom = qrY + qrWidth + 50; // small gap after QR

    // Line 1: large font "3" (16x24 dots per char)
    const line1 = textLines[0] || '';
    const line1CharWidth = 16;
    const line1Width = line1.length * line1CharWidth;
    const line1X = Math.max(10, Math.round((labelWidthDots - line1Width) / 2));
    commands.push(`TEXT ${line1X},${qrBottom},"3",0,1,1,"${line1}"`);

    // Line 2: smaller font "2" (12x16 dots per char)
    const line2 = textLines[1] || '';
    const line2CharWidth = 12;
    const line2Width = line2.length * line2CharWidth;
    const line2X = Math.max(10, Math.round((labelWidthDots - line2Width) / 2));
    const line2Y = qrBottom + 38; // minimal gap below line 1
    commands.push(`TEXT ${line2X},${line2Y},"2",0,1,1,"${line2}"`);

    commands.push('PRINT 1,1');

    // TSPL requires CR+LF terminators for each command
    const tsplString = commands.join('\r\n') + '\r\n';
    return Buffer.from(tsplString, 'utf-8');
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
   * Health check: verify device is accessible
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
}
