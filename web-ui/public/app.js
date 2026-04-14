/* global Alpine, CONFIG, CounterManager */

function weightApp() {
  return {
    // State machine: IDLE | PRODUCT_SELECTED | READY | PRINTING | SUCCESS | ERROR
    state: 'IDLE',

    // Weight data
    weight: null,
    unit: 'kg',
    stable: false,
    stableWeight: null,
    weightStatus: 'unknown', // ok | disconnected | no_data | unknown

    // Printer health
    printerConnected: false,

    // Product selection
    products: [],
    selectedProduct: '',

    // Counters
    counter: null,

    // Print result
    lastEntryId: null,
    errorMessage: null,

    // Timers
    _weightPollId: null,
    _healthPollId: null,
    _autoResetId: null,

    init() {
      this.counter = new CounterManager();
      this.loadProducts();
      this.startPolling();
    },

    destroy() {
      clearInterval(this._weightPollId);
      clearInterval(this._healthPollId);
      clearTimeout(this._autoResetId);
    },

    // --- Product loading (offline-first) ---

    loadProducts() {
      var self = this;

      // Try server API first
      if (CONFIG.productApiUrl) {
        this._fetchWithTimeout(CONFIG.productApiUrl)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (Array.isArray(data) && data.length > 0) {
              self.products = data;
              try { localStorage.setItem('products', JSON.stringify(data)); } catch (e) { /* ignore */ }
              return;
            }
            throw new Error('Empty product list');
          })
          .catch(function () {
            self._loadProductsFallback();
          });
      } else {
        this._loadProductsFallback();
      }
    },

    _loadProductsFallback() {
      try {
        var cached = localStorage.getItem('products');
        if (cached) {
          var parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.products = parsed;
            return;
          }
        }
      } catch (e) { /* ignore */ }

      this.products = CONFIG.products;
    },

    // --- Polling ---

    startPolling() {
      var self = this;
      this.pollWeight();
      this.pollPrinterHealth();
      this._weightPollId = setInterval(function () { self.pollWeight(); }, CONFIG.weightPollMs);
      this._healthPollId = setInterval(function () { self.pollPrinterHealth(); }, CONFIG.healthPollMs);
    },

    pollWeight() {
      var self = this;
      this._fetchWithTimeout(CONFIG.weightServiceUrl + '/weight')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          self.weight = data.weight;
          self.unit = data.unit || 'kg';
          self.stable = data.stable || false;
          self.stableWeight = data.stableWeight;
          self.weightStatus = data.status || 'ok';
          self._updateStateFromWeight();
        })
        .catch(function () {
          self.weight = null;
          self.stable = false;
          self.stableWeight = null;
          self.weightStatus = 'disconnected';
          self._updateStateFromWeight();
        });
    },

    pollPrinterHealth() {
      var self = this;
      this._fetchWithTimeout(CONFIG.printServiceUrl + '/print/health')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          self.printerConnected = data.printer && data.printer.connected;
        })
        .catch(function () {
          self.printerConnected = false;
        });
    },

    _updateStateFromWeight() {
      if (this.state === 'PRODUCT_SELECTED' && this.stable) {
        this.state = 'READY';
      } else if (this.state === 'READY' && !this.stable) {
        this.state = 'PRODUCT_SELECTED';
      }
    },

    // --- Actions ---

    selectProduct() {
      if (this.selectedProduct) {
        if (this.stable) {
          this.state = 'READY';
        } else {
          this.state = 'PRODUCT_SELECTED';
        }
      } else {
        this.state = 'IDLE';
      }
    },

    async doPrint() {
      if (this.state !== 'READY') return;

      this.state = 'PRINTING';
      this.errorMessage = null;

      var line1 = this.counter.nextLine1();
      var line2 = this.counter.nextLine2(this.selectedProduct);

      var body = {
        product: this.selectedProduct,
        weight: this.stableWeight || this.weight,
        stationId: CONFIG.stationId,
        line1: line1,
        line2: line2,
      };

      try {
        var res = await this._fetchWithTimeout(CONFIG.printServiceUrl + '/print/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        var data = await res.json();

        if (res.ok && data.status === 'ok') {
          this.lastEntryId = data.entryId;
          this.state = 'SUCCESS';
          var self = this;
          this._autoResetId = setTimeout(function () { self._resetAfterPrint(); }, CONFIG.autoResetMs);
        } else if (res.status === 429) {
          this.errorMessage = 'Already printed \u2014 please wait';
          this.state = 'ERROR';
          var self2 = this;
          setTimeout(function () { self2._dismissError(); }, 3000);
        } else {
          this.errorMessage = data.error || 'Print failed';
          this.state = 'ERROR';
          var self3 = this;
          setTimeout(function () { self3._dismissError(); }, 5000);
        }
      } catch (err) {
        this.errorMessage = 'Cannot reach print service';
        this.state = 'ERROR';
        var self4 = this;
        setTimeout(function () { self4._dismissError(); }, 5000);
      }
    },

    _resetAfterPrint() {
      this.selectedProduct = '';
      this.lastEntryId = null;
      this.errorMessage = null;
      this.state = 'IDLE';
    },

    _dismissError() {
      this.errorMessage = null;
      if (this.selectedProduct && this.stable) {
        this.state = 'READY';
      } else if (this.selectedProduct) {
        this.state = 'PRODUCT_SELECTED';
      } else {
        this.state = 'IDLE';
      }
    },

    // --- Display helpers ---

    get weightDisplay() {
      if (this.weightStatus === 'disconnected' || this.weightStatus === 'no_data') {
        return '--';
      }
      if (this.weight === null) return '--';
      return this.weight.toFixed(2);
    },

    get weightColorClass() {
      if (this.weightStatus !== 'ok') return 'weight-error';
      if (this.stable) return 'weight-stable';
      return 'weight-settling';
    },

    get weightLabel() {
      if (this.weightStatus === 'disconnected') return 'Scale Disconnected';
      if (this.weightStatus === 'no_data') return 'No Weight Data';
      if (this.stable) return 'Stable';
      return 'Settling...';
    },

    get printButtonText() {
      switch (this.state) {
        case 'IDLE': return 'Select Product';
        case 'PRODUCT_SELECTED': return 'Waiting for Stable Weight...';
        case 'READY': return 'PRINT';
        case 'PRINTING': return 'Printing...';
        case 'SUCCESS': return 'Printed!';
        case 'ERROR': return 'Retry Print';
        default: return 'PRINT';
      }
    },

    get printButtonDisabled() {
      return this.state !== 'READY';
    },

    // --- Utility ---

    _fetchWithTimeout(url, options) {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, CONFIG.fetchTimeoutMs);
      var opts = Object.assign({}, options || {}, { signal: controller.signal });
      return fetch(url, opts).finally(function () { clearTimeout(timeoutId); });
    },
  };
}
