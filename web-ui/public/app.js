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
    weightServiceReachable: false,

    // ── Products (FGPackConfig list from sync-service) ──
    products: [],
    selectedPackId: '',

    // ── Today's bag count ──
    totalBagsToday: 0,
    bagsByProduct: [], // [{ pack_config_id, pack_name, count }]

    // ── Last bag (for label display + reprint) ──
    lastBag: null, // { qr_code, bag_number, pack_name, weight_gm, weight_kg, line1 }

    // ── Recent products (last 5 unique, most-recent first) ──
    recentProducts: [], // [{ pack_id, name }, ...]

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
      try {
        var cached = localStorage.getItem('recent_products');
        if (cached) {
          var parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) this.recentProducts = parsed;
        }
      } catch (e) { /* ignore */ }
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
          self.weightServiceReachable = true;
        })
        .catch(function () {
          self.weight = null;
          self.stable = false;
          self.stableWeight = null;
          self.weightStatus = 'disconnected';
          self.weightServiceReachable = false;
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

        // Update recent products panel
        this._updateRecentProducts(Number(this.selectedPackId), bagData.pack_name);

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
    // Display helpers
    // ══════════════════════════════════════════════════════════════

    get canPrint() {
      return this.state === 'IDLE' && this.weightStatus === 'ok' && this.stable && this.selectedPackId;
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

    get weightStatusText() {
      if (this.weightStatus === 'ok') return 'Weight Machine Connected';
      if (this.weightServiceReachable && this.weightStatus === 'disconnected') return 'Connecting to Weight Machine';
      return 'Weight Machine Disconnected';
    },

    get weightStatusClass() {
      if (this.weightStatus === 'ok') return 'status-connected';
      if (this.weightServiceReachable && this.weightStatus === 'disconnected') return 'status-connecting';
      return 'status-disconnected';
    },

    get printerStatusText() {
      return this.printerConnected ? 'Printer Connected' : 'Printer Disconnected';
    },

    get syncStatusText() {
      return this.syncConnected ? 'Sync Connected' : 'Sync Disconnected';
    },

    get printButtonText() {
      if (this.state === 'PRINTING') return 'Printing...';
      if (this.state === 'PRINTED') return 'Printed!';
      if (this.state === 'PRINT_FAILED') return 'Retry Print';
      if (this.weightStatus !== 'ok') return 'Scale Disconnected';
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

    // ══════════════════════════════════════════════════════════════
    // Internal helpers
    // ══════════════════════════════════════════════════════════════

    selectRecentProduct(packId) {
      this.selectedPackId = String(packId);
    },

    _updateRecentProducts(packId, packName) {
      var filtered = this.recentProducts.filter(function(p) {
        return String(p.pack_id) !== String(packId);
      });
      filtered.unshift({ pack_id: packId, name: packName });
      this.recentProducts = filtered.slice(0, 5);
      try { localStorage.setItem('recent_products', JSON.stringify(this.recentProducts)); } catch (e) { /* ignore */ }
    },

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
