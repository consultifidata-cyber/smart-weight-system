/* global Alpine, CONFIG */

function weightApp() {
  return {
    // ── State: IDLE | PRINTING | PRINT_FAILED | PRINTED ──
    state: 'IDLE',

    // ── Weight data ──
    weight: null,
    unit: 'kg',
    stable: false,
    stableWeight: null,
    weightStatus: 'unknown', // ok | disconnected | no_data | unknown

    // ── Connectivity ──
    printerConnected: false,
    syncConnected: false,

    // ── Products (FGPackConfig list from sync-service) ──
    products: [],
    selectedPackId: '',

    // ── Today's bag count ──
    totalBagsToday: 0,
    bagsByProduct: [], // [{ pack_config_id, pack_name, count }]

    // ── Last bag (for label display + reprint) ──
    lastBag: null, // { qr_code, bag_number, pack_name, weight_gm, weight_kg, line1 }

    // ── UI ──
    errorMessage: null,

    // ── Counter (line1 on label) ──
    counter: null,

    // ── Timers ──
    _weightPollId: null,
    _healthPollId: null,
    _autoResetId: null,

    // ══════════════════════════════════════════════════════════════
    // Init / Destroy
    // ══════════════════════════════════════════════════════════════

    init() {
      this.counter = new CounterManager();
      this.loadProducts();
      this.refreshTodaySummary();
      this.startPolling();
    },

    destroy() {
      clearInterval(this._weightPollId);
      clearInterval(this._healthPollId);
      clearTimeout(this._autoResetId);
    },

    // ══════════════════════════════════════════════════════════════
    // Product loading (offline-first with localStorage cache)
    // ══════════════════════════════════════════════════════════════

    loadProducts() {
      var self = this;
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
          try {
            var cached = localStorage.getItem('products');
            if (cached) {
              var parsed = JSON.parse(cached);
              if (Array.isArray(parsed) && parsed.length > 0) {
                self.products = parsed;
              }
            }
          } catch (e) { /* ignore */ }
        });
    },

    // ══════════════════════════════════════════════════════════════
    // Today's summary (bag counts per product)
    // ══════════════════════════════════════════════════════════════

    refreshTodaySummary() {
      var self = this;
      this._fetchWithTimeout(CONFIG.syncServiceUrl + '/bags/today')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          self.totalBagsToday = data.total_bags || 0;
          self.bagsByProduct = data.by_product || [];
        })
        .catch(function () { /* keep stale count */ });
    },

    // ══════════════════════════════════════════════════════════════
    // Polling
    // ══════════════════════════════════════════════════════════════

    startPolling() {
      var self = this;
      this.pollWeight();
      this.pollHealth();
      this._weightPollId = setInterval(function () { self.pollWeight(); }, CONFIG.weightPollMs);
      this._healthPollId = setInterval(function () { self.pollHealth(); }, CONFIG.healthPollMs);
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
        })
        .catch(function () {
          self.weight = null;
          self.stable = false;
          self.stableWeight = null;
          self.weightStatus = 'disconnected';
        });
    },

    pollHealth() {
      var self = this;
      this._fetchWithTimeout(CONFIG.printServiceUrl + '/print/health')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          self.printerConnected = data.printer && data.printer.connected;
        })
        .catch(function () { self.printerConnected = false; });

      this._fetchWithTimeout(CONFIG.syncServiceUrl + '/health')
        .then(function (res) { return res.json(); })
        .then(function (data) { self.syncConnected = data.status === 'ok'; })
        .catch(function () { self.syncConnected = false; });
    },

    // ══════════════════════════════════════════════════════════════
    // Add bag + Print (core action)
    // ══════════════════════════════════════════════════════════════

    async doPrint() {
      if (!this.canPrint) return;

      this.state = 'PRINTING';
      this.errorMessage = null;

      var weightKg = this.stableWeight || this.weight;
      var weightGm = Math.round(weightKg * 1000);

      // Weight validation against expected net_weight_gm
      var self = this;
      var product = this.products.find(function (p) {
        return String(p.pack_id) === String(self.selectedPackId);
      });
      var expectedGm = product ? product.net_weight_gm : null;

      if (expectedGm && Math.abs(weightGm - expectedGm) > expectedGm * (CONFIG.weightTolerancePct || 0.20)) {
        var expectedKg = (expectedGm / 1000).toFixed(2);
        if (!confirm('Weight ' + weightKg.toFixed(2) + 'kg differs from expected ' + expectedKg + 'kg. Print anyway?')) {
          this.state = 'IDLE';
          return;
        }
      }

      // Step 1: Add bag to sync-service (auto-creates session internally)
      try {
        var addRes = await this._fetchWithTimeout(
          CONFIG.syncServiceUrl + '/bags/add',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pack_config_id: Number(this.selectedPackId),
              weight_gm: weightGm,
            }),
          }
        );

        var bagData = await addRes.json();

        if (!addRes.ok) {
          throw new Error(bagData.error || 'Failed to add bag');
        }

        // Generate line1 counter
        var line1 = this.counter.nextLine1();

        this.lastBag = {
          qr_code: bagData.qr_code,
          bag_number: bagData.bag_number,
          pack_name: bagData.pack_name,
          weight_gm: weightGm,
          weight_kg: weightKg,
          line1: line1,
        };
        this.totalBagsToday = bagData.total_bags_today;

        // Update per-product count in local summary
        this._updateLocalProductCount(bagData.pack_name);

      } catch (err) {
        this.errorMessage = 'Add bag failed: ' + (err.message || 'Unknown error');
        this.state = 'IDLE';
        var self2 = this;
        setTimeout(function () { self2.errorMessage = null; }, 5000);
        return;
      }

      // Step 2: Send label to printer
      await this._printLabel(weightKg);
    },

    async retryPrint() {
      if (this.state !== 'PRINT_FAILED' || !this.lastBag) return;

      this.state = 'PRINTING';
      this.errorMessage = null;
      await this._printLabel(this.lastBag.weight_kg);
    },

    async _printLabel(weightKg) {
      try {
        var qrCode = this.lastBag.qr_code;
        var packName = this.lastBag.pack_name || '';
        var line1 = this.lastBag.line1 + ' | ' + weightKg.toFixed(2) + ' kg';

        var printRes = await this._fetchWithTimeout(CONFIG.printServiceUrl + '/print/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: packName,
            weight: weightKg,
            stationId: CONFIG.stationId,
            line1: line1,
            line2: qrCode,
            qrContent: qrCode,
          }),
        });

        var printData = await printRes.json();

        if (printRes.ok && printData.status === 'ok') {
          this.state = 'PRINTED';
          var self = this;
          this._autoResetId = setTimeout(function () {
            if (self.state === 'PRINTED') {
              self.state = 'IDLE';
            }
          }, CONFIG.autoResetMs);
        } else {
          this.state = 'PRINT_FAILED';
          this.errorMessage = 'Print failed: ' + (printData.error || 'Unknown error');
          var self2 = this;
          setTimeout(function () { self2.errorMessage = null; }, 8000);
        }
      } catch (err) {
        this.state = 'PRINT_FAILED';
        this.errorMessage = 'Cannot reach printer';
        var self3 = this;
        setTimeout(function () { self3.errorMessage = null; }, 8000);
      }
    },

    // ══════════════════════════════════════════════════════════════
    // Reprint last bag (no new bag, no counter increment)
    // ══════════════════════════════════════════════════════════════

    async reprintLast() {
      if (!this.lastBag) return;
      if (this.state === 'PRINTING' || this.state === 'PRINTED') return;

      var prevState = this.state;
      this.state = 'PRINTING';
      this.errorMessage = null;

      try {
        var printRes = await this._fetchWithTimeout(CONFIG.printServiceUrl + '/print/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: this.lastBag.pack_name || '',
            weight: this.lastBag.weight_kg,
            stationId: CONFIG.stationId,
            line1: this.lastBag.line1,
            line2: this.lastBag.qr_code,
            qrContent: this.lastBag.qr_code,
          }),
        });

        var data = await printRes.json();

        if (printRes.ok && data.status === 'ok') {
          this.state = 'PRINTED';
          var self = this;
          this._autoResetId = setTimeout(function () {
            if (self.state === 'PRINTED') {
              self.state = 'IDLE';
            }
          }, CONFIG.autoResetMs);
        } else {
          this.errorMessage = 'Reprint failed';
          this.state = prevState;
          var self2 = this;
          setTimeout(function () { self2.errorMessage = null; }, 5000);
        }
      } catch (err) {
        this.errorMessage = 'Cannot reach printer';
        this.state = prevState;
        var self3 = this;
        setTimeout(function () { self3.errorMessage = null; }, 5000);
      }
    },

    // ══════════════════════════════════════════════════════════════
    // End Shift (manual flush — optional)
    // ══════════════════════════════════════════════════════════════

    async endShift() {
      if (!confirm('End shift? This will close all open sessions and push data to the server.')) return;

      this.errorMessage = null;

      try {
        var res = await this._fetchWithTimeout(CONFIG.syncServiceUrl + '/sync/flush', {
          method: 'POST',
        });
        var data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Flush failed');
        }

        alert('Shift ended. ' + (data.message || ''));
        this.refreshTodaySummary();
      } catch (err) {
        this.errorMessage = 'End shift failed: ' + (err.message || 'Unknown error');
        var self = this;
        setTimeout(function () { self.errorMessage = null; }, 5000);
      }
    },

    // ══════════════════════════════════════════════════════════════
    // Display helpers
    // ══════════════════════════════════════════════════════════════

    get canPrint() {
      return this.state === 'IDLE' && this.stable && this.selectedPackId;
    },

    get weightDisplay() {
      if (this.weightStatus === 'disconnected' || this.weightStatus === 'no_data') return '--';
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
      if (this.state === 'PRINTING') return 'Printing...';
      if (this.state === 'PRINTED') return 'Printed!';
      if (this.state === 'PRINT_FAILED') return 'Retry Print';
      if (!this.selectedPackId) return 'Select Product';
      if (!this.stable) return 'Waiting for Stable Weight...';
      return 'PRINT';
    },

    get printButtonDisabled() {
      if (this.state === 'PRINT_FAILED') return false; // allow retry
      return !this.canPrint;
    },

    get lastBagDisplay() {
      if (!this.lastBag) return '';
      var w = this.lastBag.weight_gm
        ? (this.lastBag.weight_gm / 1000).toFixed(2) + ' kg'
        : '';
      return '#' + this.lastBag.bag_number + '  ' + this.lastBag.qr_code + '  ' + w;
    },

    get expectedWeightGm() {
      if (!this.selectedPackId) return null;
      var self = this;
      var product = this.products.find(function (p) {
        return String(p.pack_id) === String(self.selectedPackId);
      });
      return product ? product.net_weight_gm : null;
    },

    get expectedWeightRange() {
      var gm = this.expectedWeightGm;
      if (!gm) return '';
      var tol = CONFIG.weightTolerancePct || 0.20;
      var lo = ((gm * (1 - tol)) / 1000).toFixed(2);
      var hi = ((gm * (1 + tol)) / 1000).toFixed(2);
      return lo + ' - ' + hi + ' kg';
    },

    // ══════════════════════════════════════════════════════════════
    // Internal helpers
    // ══════════════════════════════════════════════════════════════

    _updateLocalProductCount(packName) {
      var found = false;
      for (var i = 0; i < this.bagsByProduct.length; i++) {
        if (this.bagsByProduct[i].pack_name === packName) {
          this.bagsByProduct[i].count++;
          found = true;
          break;
        }
      }
      if (!found) {
        this.bagsByProduct.push({ pack_name: packName, count: 1 });
      }
    },

    _fetchWithTimeout(url, options) {
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, CONFIG.fetchTimeoutMs);
      var opts = Object.assign({}, options || {}, { signal: controller.signal });
      return fetch(url, opts).finally(function () { clearTimeout(timeoutId); });
    },
  };
}
