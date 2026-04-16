import QRCode from 'qrcode';

/**
 * Result of generating a QR bitmap for TSPL BITMAP command.
 */
export interface QrBitmapResult {
  /** Raw monochrome bitmap data for TSPL: 0=black (dot printed), 1=white (no dot), MSB first, row-by-row. */
  data: Buffer;
  /** Image width in bytes (widthDots / 8, rounded up). */
  widthBytes: number;
  /** Image height in dots. */
  heightDots: number;
}

/**
 * Generate a QR code as a monochrome bitmap suitable for the TSPL BITMAP command.
 *
 * Uses the `qrcode` npm library — the Node.js equivalent of Python's `qrcode`
 * library used for PDF labels. This ensures identical QR encoding (version,
 * ECC, mask pattern selection) between thermal labels and PDF labels.
 *
 * Parameters match the Python PDF flow:
 *   - ECC Q (25% recovery)
 *   - 2-module quiet zone border (same as Python border=2)
 *   - Auto version selection (V2 for our 16-21 char content)
 *
 * @param content  The string to encode in the QR code
 * @param targetDots  Target image size in dots (square). Default 336 = 42mm at 203 DPI.
 * @returns Bitmap data ready for TSPL BITMAP command
 */
export function generateQrBitmap(content: string, targetDots: number = 336): QrBitmapResult {
  // Generate QR matrix — same parameters as Python's qrcode.QRCode(
  //   version=None, error_correction=ERROR_CORRECT_Q, border=2)
  const qr = QRCode.create(content || ' ', {
    errorCorrectionLevel: 'Q',
  });

  const moduleCount = qr.modules.size;        // e.g. 25 for V2
  const moduleData = qr.modules.data;          // Uint8Array, 1=dark 0=light
  const margin = 2;                            // match Python border=2
  const totalModules = moduleCount + margin * 2; // e.g. 25 + 4 = 29

  // Scale factor: how many dots per module
  const scale = Math.floor(targetDots / totalModules); // e.g. floor(336/29) = 11
  const scaledSize = totalModules * scale;              // e.g. 29 * 11 = 319

  // Centre the scaled QR within the target size (pad with white)
  const padBefore = Math.floor((targetDots - scaledSize) / 2); // e.g. floor(17/2) = 8
  const padAfter = targetDots - scaledSize - padBefore;         // e.g. 17 - 8 = 9

  // Width must be a multiple of 8 for TSPL BITMAP (1 bit per pixel, byte-aligned)
  const widthDots = Math.ceil(targetDots / 8) * 8; // round up to multiple of 8
  const widthBytes = widthDots / 8;
  const heightDots = targetDots;

  // Allocate buffer: widthBytes * heightDots
  // TSPL convention: 0 = black (dot printed), 1 = white (no dot)
  // Start with all 1s (white), then CLEAR bits for dark QR modules.
  const data = Buffer.alloc(widthBytes * heightDots, 0xFF); // all white (1)

  // Fill the bitmap row by row
  for (let y = 0; y < targetDots; y++) {
    // Map y to the module coordinate (accounting for padding and scaling)
    const innerY = y - padBefore;

    for (let x = 0; x < targetDots; x++) {
      const innerX = x - padBefore;

      let isDark = false;

      if (innerX >= 0 && innerX < scaledSize && innerY >= 0 && innerY < scaledSize) {
        // Map scaled pixel to module coordinate
        const modX = Math.floor(innerX / scale) - margin;
        const modY = Math.floor(innerY / scale) - margin;

        if (modX >= 0 && modX < moduleCount && modY >= 0 && modY < moduleCount) {
          isDark = moduleData[modY * moduleCount + modX] === 1;
        }
        // else: within margin area → white (isDark stays false)
      }
      // else: within padding area → white

      if (isDark) {
        // Clear bit to 0 (= black in TSPL), MSB-first format
        const byteIndex = y * widthBytes + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8); // MSB first
        data[byteIndex] &= ~(1 << bitIndex);
      }
    }
  }

  return { data, widthBytes, heightDots };
}
