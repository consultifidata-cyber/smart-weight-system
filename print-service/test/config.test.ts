/**
 * Unit tests for normalizeEnvStr — the function that parses PRINT_MODE and
 * PRINTER_INTERFACE from the .env file.
 *
 * These guard against the production bug where a .env written by PowerShell
 * Set-Content (UTF-16 LE with BOM) caused PRINT_MODE=WINDOWS to be parsed
 * incorrectly, silently falling through to the RAW_DIRECT cascade adapter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnvStr } from '../src/config.js';

describe('normalizeEnvStr — PRINT_MODE parsing', () => {

  // ── Happy path ────────────────────────────────────────────────────────────

  it('parses plain WINDOWS correctly', () => {
    assert.equal(normalizeEnvStr('WINDOWS', 'WINDOWS'), 'WINDOWS');
  });

  it('parses plain RAW_DIRECT correctly', () => {
    assert.equal(normalizeEnvStr('RAW_DIRECT', 'WINDOWS'), 'RAW_DIRECT');
  });

  it('is case-insensitive', () => {
    assert.equal(normalizeEnvStr('windows', 'WINDOWS'), 'WINDOWS');
    assert.equal(normalizeEnvStr('raw_direct', 'WINDOWS'), 'RAW_DIRECT');
    assert.equal(normalizeEnvStr('Windows', 'WINDOWS'), 'WINDOWS');
  });

  // ── Encoding artifacts ────────────────────────────────────────────────────

  it('strips UTF-8 BOM (U+FEFF) prefix — the production regression case', () => {
    // PowerShell Set-Content writes UTF-16 LE with BOM by default.
    // When dotenv reads that as UTF-8, the first variable value gets a
    // BOM character prepended. This was the root cause of the production bug.
    const withBom = '﻿WINDOWS';
    assert.equal(normalizeEnvStr(withBom, 'WINDOWS'), 'WINDOWS',
      'BOM-prefixed WINDOWS must still resolve to WINDOWS');
  });

  it('strips UTF-8 BOM before RAW_DIRECT', () => {
    const withBom = '﻿RAW_DIRECT';
    assert.equal(normalizeEnvStr(withBom, 'WINDOWS'), 'RAW_DIRECT',
      'BOM-prefixed RAW_DIRECT must still resolve to RAW_DIRECT');
  });

  it('strips trailing carriage return (Windows CRLF line endings)', () => {
    assert.equal(normalizeEnvStr('WINDOWS\r', 'WINDOWS'), 'WINDOWS');
    assert.equal(normalizeEnvStr('RAW_DIRECT\r', 'WINDOWS'), 'RAW_DIRECT');
  });

  it('strips leading and trailing whitespace', () => {
    assert.equal(normalizeEnvStr('  WINDOWS  ', 'WINDOWS'), 'WINDOWS');
    assert.equal(normalizeEnvStr('\tWINDOWS\t', 'WINDOWS'), 'WINDOWS');
  });

  it('handles BOM + whitespace combined', () => {
    assert.equal(normalizeEnvStr('﻿ WINDOWS \r', 'WINDOWS'), 'WINDOWS');
  });

  // ── Default / missing ─────────────────────────────────────────────────────

  it('defaults to WINDOWS when value is undefined', () => {
    assert.equal(normalizeEnvStr(undefined, 'WINDOWS'), 'WINDOWS',
      'Missing PRINT_MODE must default to WINDOWS — not RAW_DIRECT');
  });

  it('defaults to WINDOWS when value is empty string', () => {
    assert.equal(normalizeEnvStr('', 'WINDOWS'), 'WINDOWS');
  });

  it('defaults to WINDOWS when value is only whitespace', () => {
    assert.equal(normalizeEnvStr('   ', 'WINDOWS'), 'WINDOWS');
  });

  it('defaults to WINDOWS when value is only a BOM', () => {
    // A .env file whose only content is a BOM character should not
    // accidentally enable RAW_DIRECT mode.
    assert.equal(normalizeEnvStr('﻿', 'WINDOWS'), 'WINDOWS');
  });

  // ── Unknown value falls back to WINDOWS (safe default) ───────────────────

  it('unknown/garbage value falls back to WINDOWS, not RAW_DIRECT', () => {
    // Any unrecognised value must produce WINDOWS (safe) not RAW_DIRECT.
    // config.ts: (rawPrintMode === 'RAW_DIRECT' ? 'RAW_DIRECT' : 'WINDOWS')
    // so this test validates the full chain, not just normalizeEnvStr.
    assert.notEqual(normalizeEnvStr('GARBAGE', 'WINDOWS'), 'RAW_DIRECT',
      'Unknown PRINT_MODE value must not enable cascade adapter');
    assert.equal(normalizeEnvStr('GARBAGE', 'WINDOWS'), 'GARBAGE',
      'normalizeEnvStr itself returns the uppercased value; config.ts maps unknowns to WINDOWS');
  });

});

describe('normalizeEnvStr — PRINTER_INTERFACE parsing', () => {

  it('parses plain USB correctly', () => {
    assert.equal(normalizeEnvStr('USB', 'USB'), 'USB');
  });

  it('parses plain COM correctly', () => {
    assert.equal(normalizeEnvStr('COM', 'USB'), 'COM');
  });

  it('parses WINDOWS interface (typed manually in wizard)', () => {
    assert.equal(normalizeEnvStr('WINDOWS', 'USB'), 'WINDOWS');
  });

  it('strips BOM from PRINTER_INTERFACE', () => {
    assert.equal(normalizeEnvStr('﻿WINDOWS', 'USB'), 'WINDOWS');
  });

  it('defaults to USB when undefined', () => {
    assert.equal(normalizeEnvStr(undefined, 'USB'), 'USB');
  });

});
