import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StabilityDetector } from '../src/stability/detector.js';

describe('StabilityDetector', () => {
  let detector: StabilityDetector;

  beforeEach(() => {
    detector = new StabilityDetector({ thresholdMs: 100, toleranceKg: 0.02 });
  });

  it('starts unstable', () => {
    const state = detector.getState();
    assert.equal(state.stable, false);
    assert.equal(state.stableWeight, null);
  });

  it('remains unstable before threshold', () => {
    const result = detector.update({ weight: 25.45 });
    assert.equal(result.stable, false);
    assert.equal(result.weight, 25.45);
  });

  it('becomes stable after consistent readings exceed threshold', async () => {
    detector.update({ weight: 25.45 });

    // Wait longer than thresholdMs
    await new Promise(r => setTimeout(r, 120));

    const result = detector.update({ weight: 25.45 });
    assert.equal(result.stable, true);
    assert.equal(result.stableWeight, 25.45);
  });

  it('stays stable with readings within tolerance', async () => {
    detector.update({ weight: 25.45 });
    await new Promise(r => setTimeout(r, 120));

    // Reading within tolerance (0.01 < 0.02)
    const result = detector.update({ weight: 25.46 });
    assert.equal(result.stable, true);
    assert.equal(result.stableWeight, 25.45); // Locked to anchor
  });

  it('resets when reading exceeds tolerance', async () => {
    detector.update({ weight: 25.45 });
    await new Promise(r => setTimeout(r, 120));
    detector.update({ weight: 25.45 }); // now stable

    // Big jump
    const result = detector.update({ weight: 30.00 });
    assert.equal(result.stable, false);
    assert.equal(result.stableWeight, null);
  });

  it('resets on null weight', () => {
    detector.update({ weight: 25.45 });
    const result = detector.update({ weight: null });
    assert.equal(result.stable, false);
    assert.equal(result.weight, null);
  });

  it('resets on overload', () => {
    detector.update({ weight: 25.45 });
    const result = detector.update({ weight: null, overload: true });
    assert.equal(result.stable, false);
  });

  it('handles zero weight becoming stable', async () => {
    detector.update({ weight: 0 });
    await new Promise(r => setTimeout(r, 120));

    const result = detector.update({ weight: 0 });
    assert.equal(result.stable, true);
    assert.equal(result.stableWeight, 0);
  });

  it('getState reflects last update', () => {
    detector.update({ weight: 12.5 });
    const state = detector.getState();
    assert.equal(state.weight, 12.5);
    assert.equal(state.stable, false);
    assert.ok(state.lastReadingAt! > 0);
  });
});
