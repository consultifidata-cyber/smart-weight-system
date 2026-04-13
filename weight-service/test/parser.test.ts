import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/serial/parser.js';

describe('Weight Parser', () => {
  it('parses simple positive weight', () => {
    const r = parse('+025.450')!;
    assert.equal(r.weight, 25.45);
    assert.equal(r.sign, '+');
    assert.equal(r.unit, 'kg');
    assert.equal(r.overload, false);
    assert.equal(r.scaleStable, null);
  });

  it('parses negative weight', () => {
    const r = parse('-001.200')!;
    assert.equal(r.weight, -1.2);
    assert.equal(r.sign, '-');
  });

  it('parses zero weight', () => {
    const r = parse('+000.000')!;
    assert.equal(r.weight, 0);
    assert.equal(r.sign, '+');
  });

  it('parses weight with unit', () => {
    const r = parse('+025.450 kg')!;
    assert.equal(r.weight, 25.45);
    assert.equal(r.unit, 'kg');
  });

  it('parses weight with grams unit', () => {
    const r = parse('+250.5 g')!;
    assert.equal(r.weight, 250.5);
    assert.equal(r.unit, 'g');
  });

  it('parses weight with stability prefix ST (stable)', () => {
    const r = parse('ST,+025.450, kg')!;
    assert.equal(r.weight, 25.45);
    assert.equal(r.scaleStable, true);
  });

  it('parses weight with stability prefix US (unstable)', () => {
    const r = parse('US,+025.450, kg')!;
    assert.equal(r.weight, 25.45);
    assert.equal(r.scaleStable, false);
  });

  it('parses weight with leading/trailing whitespace', () => {
    const r = parse('  +025.450 kg  ')!;
    assert.equal(r.weight, 25.45);
  });

  it('detects overload (OL)', () => {
    const r = parse('OL')!;
    assert.equal(r.weight, null);
    assert.equal(r.overload, true);
  });

  it('detects overload (OVER)', () => {
    const r = parse('OVER')!;
    assert.equal(r.weight, null);
    assert.equal(r.overload, true);
  });

  it('returns null for empty string', () => {
    assert.equal(parse(''), null);
  });

  it('returns null for null input', () => {
    assert.equal(parse(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(parse(undefined), null);
  });

  it('returns null for garbled data', () => {
    assert.equal(parse('!@#$%^&*'), null);
  });

  it('strips control characters', () => {
    const r = parse('\x00+025.450\x00')!;
    assert.equal(r.weight, 25.45);
  });

  it('parses large weight', () => {
    const r = parse('+999.999')!;
    assert.equal(r.weight, 999.999);
  });

  it('parses integer weight (no decimal)', () => {
    const r = parse('+25')!;
    assert.equal(r.weight, 25);
  });

  it('includes timestamp', () => {
    const r = parse('+025.450')!;
    assert.ok(r.timestamp);
    assert.ok(new Date(r.timestamp).getTime() > 0);
  });

  it('preserves raw string', () => {
    const r = parse('  +025.450 kg  ')!;
    assert.equal(r.raw, '+025.450 kg');
  });
});
