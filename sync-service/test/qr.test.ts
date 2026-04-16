import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skuPrefix, generateQrCode } from '../src/sync/qr.js';

// ── skuPrefix ──────────────────────────────────────────────────────

describe('skuPrefix', () => {
  it('returns "FG" for empty string', () => {
    assert.equal(skuPrefix(''), 'FG');
  });

  it('returns "FG" for null/undefined input', () => {
    assert.equal(skuPrefix(null as any), 'FG');
    assert.equal(skuPrefix(undefined as any), 'FG');
  });

  it('returns full name uppercased when ≤7 alphanumeric chars', () => {
    assert.equal(skuPrefix('Rice'), 'RICE');
    assert.equal(skuPrefix('AB12CD'), 'AB12CD');
    assert.equal(skuPrefix('SevenCh'), 'SEVENCH');
  });

  it('returns first3+last4 when >7 alphanumeric chars', () => {
    // "Naylon sev 200 Rs 56 - 50pcs" → clean "NAYLONSEV200RS5650PCS" → NAY+0PCS = "NAY0PCS"
    assert.equal(skuPrefix('Naylon sev 200 Rs 56 - 50pcs'), 'NAY0PCS');
  });

  it('strips non-alphanumeric characters', () => {
    // "A-B.C@D" → "ABCD" (4 chars, ≤7) → "ABCD"
    assert.equal(skuPrefix('A-B.C@D'), 'ABCD');
  });

  it('handles string with only special chars', () => {
    assert.equal(skuPrefix('---'), 'FG');
  });

  it('handles long name correctly', () => {
    // "kasturi rs5" → clean "KASTURIRS5" (10 chars) → KAS + IRS5 = "KASIRS5"
    assert.equal(skuPrefix('kasturi rs5'), 'KASIRS5');
  });

  it('handles exactly 7 chars', () => {
    assert.equal(skuPrefix('ABCDEFG'), 'ABCDEFG');
  });

  it('handles exactly 8 chars (triggers first3+last4)', () => {
    // "ABCDEFGH" → ABC + EFGH = "ABCEFGH"
    assert.equal(skuPrefix('ABCDEFGH'), 'ABCEFGH');
  });
});

// ── generateQrCode ─────────────────────────────────────────────────

describe('generateQrCode', () => {
  it('formats as PREFIX-DDMMYY-SEQ02d-BAG03d', () => {
    const qr = generateQrCode('Rice', '2026-04-15', 3, 1);
    assert.equal(qr, 'RICE-150426-03-001');
  });

  it('converts YYYY-MM-DD to DDMMYY', () => {
    const qr = generateQrCode('FG', '2026-01-05', 1, 1);
    // date part should be 050126
    assert.equal(qr, 'FG-050126-01-001');
  });

  it('pads daySeq to 2 digits', () => {
    const qr = generateQrCode('FG', '2026-04-15', 3, 1);
    assert.match(qr, /-03-/);
  });

  it('pads bagNumber to 3 digits', () => {
    const qr = generateQrCode('FG', '2026-04-15', 1, 7);
    assert.match(qr, /-007$/);
  });

  it('uses daySeq=1 when 0 is passed', () => {
    const qr = generateQrCode('FG', '2026-04-15', 0, 1);
    assert.match(qr, /-01-/);
  });

  it('uses daySeq=1 when undefined is passed', () => {
    const qr = generateQrCode('FG', '2026-04-15', undefined as any, 1);
    assert.match(qr, /-01-/);
  });

  it('uses skuPrefix for the prefix portion', () => {
    const qr = generateQrCode('Naylon sev 200 Rs 56 - 50pcs', '2026-04-15', 3, 1);
    assert.ok(qr.startsWith('NAY0PCS-'));
  });

  it('handles large bag numbers', () => {
    const qr = generateQrCode('FG', '2026-04-15', 1, 150);
    assert.match(qr, /-150$/);
  });

  it('handles double-digit daySeq', () => {
    const qr = generateQrCode('FG', '2026-04-15', 12, 1);
    assert.match(qr, /-12-/);
  });

  it('matches Python output for known test vector', () => {
    // Python: _opnfg_qr_code("Naylon sev 200 Rs 56 - 50pcs", "2026-04-15", 3, 1)
    // Expected: NAY0PCS-150426-03-001
    assert.equal(
      generateQrCode('Naylon sev 200 Rs 56 - 50pcs', '2026-04-15', 3, 1),
      'NAY0PCS-150426-03-001',
    );
  });

  it('matches Python output for short pack name', () => {
    assert.equal(
      generateQrCode('Rice', '2026-04-15', 1, 5),
      'RICE-150426-01-005',
    );
  });
});
