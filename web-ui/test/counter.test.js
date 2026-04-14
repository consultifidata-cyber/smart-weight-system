const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { generateProductCode, formatDateDDMMYY, CounterManager } = require('../public/counter.js');

describe('generateProductCode', () => {
  it('kasturi rs5 → KASRS5', () => {
    assert.equal(generateProductCode('kasturi rs5'), 'KASRS5');
  });

  it('ch lite chura rs10 → CHRS10', () => {
    assert.equal(generateProductCode('ch lite chura rs10'), 'CHRS10');
  });

  it('premium cement 50kg → PRE50KG', () => {
    assert.equal(generateProductCode('premium cement 50kg'), 'PRE50KG');
  });

  it('single word product → first 3 chars only', () => {
    assert.equal(generateProductCode('cement'), 'CEM');
  });

  it('two letter first word → uses all available chars', () => {
    assert.equal(generateProductCode('ch rs10'), 'CHRS10');
  });

  it('trims whitespace', () => {
    assert.equal(generateProductCode('  kasturi rs5  '), 'KASRS5');
  });

  it('empty string → UNKNOWN', () => {
    assert.equal(generateProductCode(''), 'UNKNOWN');
  });

  it('null/undefined → UNKNOWN', () => {
    assert.equal(generateProductCode(null), 'UNKNOWN');
    assert.equal(generateProductCode(undefined), 'UNKNOWN');
  });

  it('last word longer than 4 chars → truncated to 4', () => {
    assert.equal(generateProductCode('abc longword'), 'ABCLONG');
  });
});

describe('formatDateDDMMYY', () => {
  it('formats date correctly', () => {
    var d = new Date(2026, 3, 14); // April 14, 2026
    assert.equal(formatDateDDMMYY(d), '140426');
  });

  it('pads single digit day and month', () => {
    var d = new Date(2026, 0, 5); // January 5, 2026
    assert.equal(formatDateDDMMYY(d), '050126');
  });
});

describe('CounterManager', () => {
  var counter;

  beforeEach(() => {
    counter = new CounterManager();
  });

  describe('nextLine1 (global daily counter)', () => {
    it('starts at 000001', () => {
      assert.equal(counter.nextLine1(), '000001');
    });

    it('increments sequentially', () => {
      assert.equal(counter.nextLine1(), '000001');
      assert.equal(counter.nextLine1(), '000002');
      assert.equal(counter.nextLine1(), '000003');
    });

    it('pads to 6 digits', () => {
      for (var i = 0; i < 99; i++) counter.nextLine1();
      assert.equal(counter.nextLine1(), '000100');
    });
  });

  describe('nextLine2 (product-specific code)', () => {
    it('first product gets index 00, count 0001', () => {
      var line2 = counter.nextLine2('kasturi rs5');
      var today = formatDateDDMMYY(new Date());
      assert.equal(line2, 'KASRS5-' + today + '-00-0001');
    });

    it('same product increments count', () => {
      counter.nextLine2('kasturi rs5');
      var line2 = counter.nextLine2('kasturi rs5');
      var today = formatDateDDMMYY(new Date());
      assert.equal(line2, 'KASRS5-' + today + '-00-0002');
    });

    it('new product gets next index', () => {
      counter.nextLine2('kasturi rs5');
      var line2 = counter.nextLine2('ch lite chura rs10');
      var today = formatDateDDMMYY(new Date());
      assert.equal(line2, 'CHRS10-' + today + '-01-0001');
    });

    it('returning to first product keeps its index and increments its count', () => {
      counter.nextLine2('kasturi rs5');    // 00-0001
      counter.nextLine2('kasturi rs5');    // 00-0002
      counter.nextLine2('ch lite chura rs10'); // 01-0001
      var line2 = counter.nextLine2('kasturi rs5'); // 00-0003
      var today = formatDateDDMMYY(new Date());
      assert.equal(line2, 'KASRS5-' + today + '-00-0003');
    });
  });

  describe('full sequence (matches plan example)', () => {
    it('produces correct line1 and line2 for mixed product prints', () => {
      var today = formatDateDDMMYY(new Date());

      // Print 1: kasturi rs5
      assert.equal(counter.nextLine1(), '000001');
      assert.equal(counter.nextLine2('kasturi rs5'), 'KASRS5-' + today + '-00-0001');

      // Print 2: kasturi rs5
      assert.equal(counter.nextLine1(), '000002');
      assert.equal(counter.nextLine2('kasturi rs5'), 'KASRS5-' + today + '-00-0002');

      // Print 3: kasturi rs5
      assert.equal(counter.nextLine1(), '000003');
      assert.equal(counter.nextLine2('kasturi rs5'), 'KASRS5-' + today + '-00-0003');

      // Print 4: ch lite chura rs10 (new product)
      assert.equal(counter.nextLine1(), '000004');
      assert.equal(counter.nextLine2('ch lite chura rs10'), 'CHRS10-' + today + '-01-0001');

      // Print 5: ch lite chura rs10
      assert.equal(counter.nextLine1(), '000005');
      assert.equal(counter.nextLine2('ch lite chura rs10'), 'CHRS10-' + today + '-01-0002');

      // Print 6: kasturi rs5 (back to first product)
      assert.equal(counter.nextLine1(), '000006');
      assert.equal(counter.nextLine2('kasturi rs5'), 'KASRS5-' + today + '-00-0004');
    });
  });

  describe('daily reset', () => {
    it('resets all counters when date changes', () => {
      counter.nextLine1(); // 000001
      counter.nextLine2('kasturi rs5'); // 00-0001

      // Simulate date change by modifying internal state
      counter._dateStr = '000000'; // Force a date mismatch

      // Next calls should detect the new day and reset
      assert.equal(counter.nextLine1(), '000001'); // reset to 1
      var today = formatDateDDMMYY(new Date());
      assert.equal(counter.nextLine2('kasturi rs5'), 'KASRS5-' + today + '-00-0001'); // reset
    });
  });

  describe('getState', () => {
    it('returns current counter state', () => {
      counter.nextLine1();
      counter.nextLine2('kasturi rs5');

      var state = counter.getState();
      assert.equal(state.globalCount, 1);
      assert.equal(state.productIndexMap['kasturi rs5'], 0);
      assert.equal(state.productCountMap['kasturi rs5'], 1);
    });
  });
});
