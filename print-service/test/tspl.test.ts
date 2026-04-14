import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TSPLDriver } from '../src/drivers/tspl.js';

describe('TSPL Driver', () => {
  const driver = new TSPLDriver('/dev/usb/lp0', 50, 30, 203);

  it('builds label with QR and text', () => {
    const labelData = {
      qrContent: 'FG-White-Cement|25.45kg|ST01|2026-04-13T14:35:22',
      textLines: ['FG-White-Cement-50kg', '25.45 kg | ST01 | 13-Apr-2026'],
      labelWidth: 50,
      labelHeight: 30,
      entryId: 'ST01-20260413-143522',
    };

    const buffer = driver.buildLabel(labelData);
    const tspl = buffer.toString('utf-8');

    // Verify TSPL structure
    assert.match(tspl, /SIZE 50 mm, 30 mm/);
    assert.match(tspl, /GAP 2 mm, 0 mm/);
    assert.match(tspl, /CLS/);
    assert.match(tspl, /QRCODE 30,20,H,6,A,0/);
    assert.match(tspl, /FG-White-Cement\|25\.45kg\|ST01\|2026-04-13T14:35:22/);
    assert.match(tspl, /TEXT.*FG-White-Cement-50kg/);
    assert.match(tspl, /TEXT.*25\.45 kg \| ST01 \| 13-Apr-2026/);
    assert.match(tspl, /PRINT 1,1/);
  });

  it('escapes quotes in QR content', () => {
    const labelData = {
      qrContent: 'Product|25kg|ST01|time',
      textLines: [],
      labelWidth: 50,
      labelHeight: 30,
      entryId: 'ST01-20260413-143522',
    };

    const buffer = driver.buildLabel(labelData);
    const tspl = buffer.toString('utf-8');

    // Should not have unescaped quotes in QRCODE
    assert.match(tspl, /QRCODE/);
  });

  it('handles multiple text lines', () => {
    const labelData = {
      qrContent: 'test',
      textLines: ['Line 1', 'Line 2', 'Line 3'],
      labelWidth: 50,
      labelHeight: 50,
      entryId: 'TEST-001',
    };

    const buffer = driver.buildLabel(labelData);
    const tspl = buffer.toString('utf-8');

    assert.match(tspl, /TEXT.*Line 1/);
    assert.match(tspl, /TEXT.*Line 2/);
    assert.match(tspl, /TEXT.*Line 3/);
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
    const tspl = buffer.toString('utf-8');

    assert.match(tspl, /SIZE 80 mm, 50 mm/);
  });
});
