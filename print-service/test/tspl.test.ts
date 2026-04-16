import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TSPLDriver } from '../src/drivers/tspl.js';
import { generateQrBitmap } from '../src/utils/qr-bitmap.js';

/**
 * Helper: extract the text portions of a TSPL buffer that contains
 * a BITMAP command (setup text + binary bitmap data + footer text).
 *
 * The BITMAP binary data starts after "BITMAP x,y,w,h,0," and is
 * exactly widthBytes * heightDots bytes long.
 */
function extractTextParts(buffer: Buffer): { setup: string; footer: string } {
  const raw = buffer;

  // Find the BITMAP command header in the buffer
  const bmpMarker = Buffer.from('BITMAP ');
  const bmpStart = raw.indexOf(bmpMarker);
  if (bmpStart === -1) {
    // No BITMAP command — return whole buffer as setup
    return { setup: raw.toString('utf-8'), footer: '' };
  }

  // Setup text is everything before the BITMAP command
  const setup = raw.subarray(0, bmpStart).toString('utf-8');

  // Parse BITMAP header to find where binary data starts and its length
  // Format: BITMAP x,y,widthBytes,heightDots,mode,<binary>
  const headerEnd = raw.indexOf(0x2C, bmpStart + 7); // find first comma after "BITMAP "
  // We need to find the comma after mode (5th parameter)
  let commaCount = 0;
  let pos = bmpStart + 7; // skip "BITMAP "
  while (pos < raw.length && commaCount < 5) {
    if (raw[pos] === 0x2C) commaCount++; // 0x2C = ','
    pos++;
  }
  // pos is now right after the 5th comma — binary data starts here

  // Extract widthBytes and heightDots from the header to compute binary length
  const headerStr = raw.subarray(bmpStart, pos).toString('utf-8');
  const parts = headerStr.replace('BITMAP ', '').split(',');
  const widthBytes = parseInt(parts[2], 10);
  const heightDots = parseInt(parts[3], 10);
  const binaryLen = widthBytes * heightDots;

  // Footer text starts after binary data
  const footerStart = pos + binaryLen;
  const footer = footerStart < raw.length
    ? raw.subarray(footerStart).toString('utf-8')
    : '';

  return { setup, footer };
}

describe('TSPL Driver', () => {
  const driver = new TSPLDriver('/dev/usb/lp0', 50, 50, 203);

  it('builds label with BITMAP QR and text', () => {
    const labelData = {
      qrContent: 'FG-White-Cement|25.45kg|ST01|2026-04-13T14:35:22',
      textLines: ['FG-White-Cement-50kg', '25.45 kg | ST01 | 13-Apr-2026'],
      labelWidth: 50,
      labelHeight: 50,
      entryId: 'ST01-20260413-143522',
    };

    const buffer = driver.buildLabel(labelData);
    const { setup, footer } = extractTextParts(buffer);

    // Verify TSPL setup commands
    assert.match(setup, /SIZE 50 mm, 50 mm/);
    assert.match(setup, /GAP 2 mm, 0 mm/);
    assert.match(setup, /CLS/);
    assert.match(setup, /DENSITY 14/);
    assert.match(setup, /SPEED 2/);

    // Verify BITMAP command is present (not QRCODE)
    assert.ok(buffer.indexOf(Buffer.from('BITMAP ')) !== -1, 'Should contain BITMAP command');
    assert.ok(buffer.indexOf(Buffer.from('QRCODE')) === -1, 'Should NOT contain QRCODE command');

    // Verify text lines in footer
    assert.match(footer, /TEXT.*"2".*FG-White-Cement-50kg/);
    assert.match(footer, /TEXT.*"2".*25\.45 kg \| ST01 \| 13-Apr-2026/);
    assert.match(footer, /PRINT 1,1/);

    // Buffer should be large (contains bitmap data ~14KB+)
    assert.ok(buffer.length > 10000, `Buffer should be large (got ${buffer.length})`);
  });

  it('generates consistent QR for same content', () => {
    const labelData = {
      qrContent: 'NAY0PCS-150426-01-001',
      textLines: ['000001', 'NAY0PCS-150426-01-001'],
      labelWidth: 50,
      labelHeight: 50,
      entryId: 'ST01-20260413-143522',
    };

    const buffer1 = driver.buildLabel(labelData);
    const buffer2 = driver.buildLabel(labelData);

    assert.ok(buffer1.equals(buffer2), 'Same content should produce identical output');
  });

  it('handles empty text lines', () => {
    const labelData = {
      qrContent: 'Product|25kg|ST01|time',
      textLines: [],
      labelWidth: 50,
      labelHeight: 50,
      entryId: 'ST01-20260413-143522',
    };

    const buffer = driver.buildLabel(labelData);
    assert.ok(buffer.length > 10000);
    assert.ok(buffer.indexOf(Buffer.from('BITMAP ')) !== -1);
  });

  it('handles multiple text lines (only first two used)', () => {
    const labelData = {
      qrContent: 'test',
      textLines: ['Line 1', 'Line 2', 'Line 3'],
      labelWidth: 50,
      labelHeight: 50,
      entryId: 'TEST-001',
    };

    const buffer = driver.buildLabel(labelData);
    const { footer } = extractTextParts(buffer);

    assert.match(footer, /TEXT.*Line 1/);
    assert.match(footer, /TEXT.*Line 2/);
    // Line 3 is not rendered (only 2 text lines on label)
  });

  it('respects custom label dimensions', () => {
    const driver80x50 = new TSPLDriver('/dev/usb/lp0', 80, 50, 203);
    const labelData = {
      qrContent: 'test',
      textLines: [],
      labelWidth: 80,
      labelHeight: 50,
      entryId: 'TEST-001',
    };

    const buffer = driver80x50.buildLabel(labelData);
    const { setup } = extractTextParts(buffer);

    assert.match(setup, /SIZE 80 mm, 50 mm/);
  });
});

describe('QR Bitmap Generator', () => {
  it('generates bitmap with correct dimensions', () => {
    const result = generateQrBitmap('NAY0PCS-150426-01-001', 336);

    // 336 dots → round up to 344 (multiple of 8) for width_bytes
    assert.equal(result.widthBytes, Math.ceil(336 / 8)); // 42 bytes
    assert.equal(result.heightDots, 336);
    assert.equal(result.data.length, result.widthBytes * result.heightDots);
  });

  it('produces deterministic output', () => {
    const r1 = generateQrBitmap('TEST-150426-01-001', 336);
    const r2 = generateQrBitmap('TEST-150426-01-001', 336);

    assert.ok(r1.data.equals(r2.data));
  });

  it('produces different output for different content', () => {
    const r1 = generateQrBitmap('AAA-150426-01-001', 336);
    const r2 = generateQrBitmap('BBB-150426-01-002', 336);

    assert.ok(!r1.data.equals(r2.data));
  });

  it('handles empty content', () => {
    const result = generateQrBitmap('', 336);
    assert.ok(result.data.length > 0);
    assert.equal(result.heightDots, 336);
  });

  it('bitmap has dark and light pixels', () => {
    const result = generateQrBitmap('NAY0PCS-150426-01-001', 336);

    // Count set bits (dark pixels)
    let darkCount = 0;
    for (let i = 0; i < result.data.length; i++) {
      let byte = result.data[i];
      while (byte) {
        darkCount += byte & 1;
        byte >>= 1;
      }
    }

    const totalPixels = result.widthBytes * 8 * result.heightDots;
    // QR should have roughly 30-60% dark modules in the data area,
    // but with margin the overall percentage is lower
    assert.ok(darkCount > 0, 'Should have dark pixels');
    assert.ok(darkCount < totalPixels, 'Should have light pixels');
    // At least 5% dark (finder patterns alone guarantee this)
    assert.ok(darkCount > totalPixels * 0.05, `Dark pixel ratio too low: ${darkCount}/${totalPixels}`);
  });

  it('respects custom target size', () => {
    const small = generateQrBitmap('TEST', 200);
    const large = generateQrBitmap('TEST', 400);

    assert.equal(small.heightDots, 200);
    assert.equal(large.heightDots, 400);
    assert.ok(large.data.length > small.data.length);
  });
});
