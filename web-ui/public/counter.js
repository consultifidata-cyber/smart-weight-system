/**
 * Generates a product code from a product name.
 * First word → up to 3 chars uppercase + Last word → up to 4 chars uppercase.
 *
 * "kasturi rs5"          → "KASRS5"
 * "ch lite chura rs10"   → "CHRS10"
 * "premium cement 50kg"  → "PRE50KG"
 */
function generateProductCode(name) {
  var trimmed = (name || '').trim();
  if (!trimmed) return 'UNKNOWN';

  var words = trimmed.split(/\s+/);
  var first = words[0].substring(0, 3).toUpperCase();

  if (words.length === 1) {
    return first;
  }

  var last = words[words.length - 1].substring(0, 4).toUpperCase();
  return first + last;
}

/**
 * Formats a date as DDMMYY.
 */
function formatDateDDMMYY(date) {
  var dd = String(date.getDate()).padStart(2, '0');
  var mm = String(date.getMonth() + 1).padStart(2, '0');
  var yy = String(date.getFullYear()).slice(-2);
  return dd + mm + yy;
}

/**
 * Manages daily counters for line1 (global) and line2 (per-product).
 * All counters reset when the date changes.
 * State is persisted to localStorage to survive page refreshes mid-shift.
 */
function CounterManager() {
  this._dateStr = formatDateDDMMYY(new Date());
  this._globalCount = 0;          // line1 counter
  this._productIndexMap = {};     // productName → index (00, 01, ...)
  this._nextProductIndex = 0;
  this._productCountMap = {};     // productName → count (1, 2, 3, ...)

  // Restore persisted state (if same date)
  this._restore();
}

/**
 * Check if the date has changed; if so, reset all counters.
 */
CounterManager.prototype._checkDayReset = function () {
  var today = formatDateDDMMYY(new Date());
  if (today !== this._dateStr) {
    // Clean up previous day's localStorage entry
    try { localStorage.removeItem(this._storageKey()); } catch (e) { /* ignore */ }
    this._dateStr = today;
    this._globalCount = 0;
    this._productIndexMap = {};
    this._nextProductIndex = 0;
    this._productCountMap = {};
  }
};

/**
 * Generate line1: global daily counter, 6 digits zero-padded.
 * Call this ONCE per print (it increments the counter).
 */
CounterManager.prototype.nextLine1 = function () {
  this._checkDayReset();
  this._globalCount++;
  this._persist();
  return String(this._globalCount).padStart(6, '0');
};

/**
 * Generate line2 for a given product name.
 * Format: {ProductCode}-{DDMMYY}-{ProductIndex}-{ProductCount}
 * Call this ONCE per print (it increments the product count).
 */
CounterManager.prototype.nextLine2 = function (productName) {
  this._checkDayReset();

  var code = generateProductCode(productName);

  // Assign product index if new
  if (!(productName in this._productIndexMap)) {
    this._productIndexMap[productName] = this._nextProductIndex;
    this._nextProductIndex++;
    this._productCountMap[productName] = 0;
  }

  // Increment product count
  this._productCountMap[productName]++;
  this._persist();

  var idx = String(this._productIndexMap[productName]).padStart(2, '0');
  var cnt = String(this._productCountMap[productName]).padStart(4, '0');

  return code + '-' + this._dateStr + '-' + idx + '-' + cnt;
};

/**
 * localStorage key for persisting counter state.
 */
CounterManager.prototype._storageKey = function () {
  var stationId = (typeof CONFIG !== 'undefined' && CONFIG.stationId) ? CONFIG.stationId : 'DEFAULT';
  return 'counter_state_' + stationId + '_' + this._dateStr;
};

/**
 * Persist current counter state to localStorage.
 */
CounterManager.prototype._persist = function () {
  try {
    var state = {
      dateStr: this._dateStr,
      globalCount: this._globalCount,
      productIndexMap: this._productIndexMap,
      nextProductIndex: this._nextProductIndex,
      productCountMap: this._productCountMap,
    };
    localStorage.setItem(this._storageKey(), JSON.stringify(state));
  } catch (e) { /* localStorage unavailable or full — continue without persistence */ }
};

/**
 * Restore counter state from localStorage if date matches.
 */
CounterManager.prototype._restore = function () {
  try {
    var raw = localStorage.getItem(this._storageKey());
    if (!raw) return;
    var state = JSON.parse(raw);
    if (state.dateStr !== this._dateStr) return;
    this._globalCount = state.globalCount || 0;
    this._productIndexMap = state.productIndexMap || {};
    this._nextProductIndex = state.nextProductIndex || 0;
    this._productCountMap = state.productCountMap || {};
  } catch (e) { /* corrupted data — start fresh */ }
};

/**
 * Get current state (for display/debugging).
 */
CounterManager.prototype.getState = function () {
  return {
    date: this._dateStr,
    globalCount: this._globalCount,
    productIndexMap: Object.assign({}, this._productIndexMap),
    productCountMap: Object.assign({}, this._productCountMap),
  };
};

// Export for Node.js testing, globals for browser
if (typeof exports !== 'undefined') {
  exports.generateProductCode = generateProductCode;
  exports.formatDateDDMMYY = formatDateDDMMYY;
  exports.CounterManager = CounterManager;
}
