/* global Alpine, CONFIG */

function weightApp() {
  return {
    // ── State: IDLE | PRINTING | PRINT_RETRYING | PRINT_FAILED | PRINTED ──
    state: 'IDLE',

    // ── Weight data ──
    weight: null,
    unit: 'kg',
    stable: false,
    stableWeight: null,
    weightStatus: 'unknown',

    // ── Connectivity ──
    printerConnected: false,
    syncConnected: false,
    weightServiceReachable: false,

    // ── Products ──
    products: [],
    selectedPackId: '',

    // ── Workers ──
    workers: [],
    selectedWorker1: '',
    selectedWorker2: '',

    // ── Today's bag count ──
    totalBagsToday: 0,
    bagsByProduct: [],

    // ── Last bag (for reprint + prominent "last printed" display) ──
    lastBag: null,

    // ── Recent products (left panel) — now stores richer data ──
    recentProducts: [],

    // ── UI state ──
    errorMessage: null,
    errorModal: { show: false, title: '', body: '', showRetry: false },

    // ── Refresh state ──
    refreshing: false,

    // ── Counter ──
    counter: null,

    // ── Print retry state ──
    printAttempt: 0,
    printMaxAttempts: 0,
    printResetting: false,

    // ── Phase F: double-click lock ──
    _printLockUntil: 0,

    // ── Phase G: last master sync timestamp ──
    lastMasterSyncAt: null,

    // ── Timers ──
    _weightPollId: null,
    _healthPollId: null,
    _autoResetId: null,
    _syncStatusPollId: null,

    // ══════════════════════════════════════════════════════════════
    // Init / Destroy
    // ══════════════════════════════════════════════════════════════

    init() {
      this.counter = new CounterManager();
      this.loadProducts();
      this.loadWorkers();
      this.refreshTodaySummary();
      this.startPolling();
      try {
        var cached = localStorage.getItem('recent_products');
        if (cached) {
          var parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) this.recentProducts = parsed;
        }
      } catch (e) { /* ignore */ }
      try {
        var w1 = localStorage.getItem('selectedWorker1');
        if (w1) this.selectedWorker1 = w1;
        var w2 = localStorage.getItem('selectedWorker2');
        if (w2) this.selectedWorker2 = w2;
      } catch (e) { /* ignore */ }
    },

    destroy() {
      clearInterval(this._weightPollId);
      clearInterval(this._healthPollId);
      clearInterval(this._syncStatusPollId);
      clearTimeout(this._autoResetId);
    },

    // ══════════════════════════════════════════════════════════════
    // Product / worker loading (offline-first with localStorage cache)
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
              if (Array.isArray(parsed) && parsed.length > 0) self.products = parsed;
            }
          } catch (e) { /* ignore */ }
        });
    },

    _workerRetryCount: 0,
    _workerRetryId: null,

    loadWorkers() {
      var self = this;
      this._fetchWithTimeout(CONFIG.workerApiUrl)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (Array.isArray(data) && data.length > 0) {
            self.workers = data;
            self._workerRetryCount = 0;
            if (self._workerRetryId) { clearTimeout(self._workerRetryId); self._workerRetryId = null; }
            try { localStorage.setItem('workers', JSON.stringify(data)); } catch (e) { /* ignore */ }
            return;
          }
          throw new Error('Empty worker list');
        })
        .catch(function () {
          try {
            var cached = localStorage.getItem('workers');
            if (cached) {
              var parsed = JSON.parse(cached);
              if (Array.isArray(parsed) && parsed.length > 0) self.workers = parsed;
            }
          } catch (e) { /* ignore */ }
          if (self.workers.length === 0 && self._workerRetryCount < 10) {
            self._workerRetryCount++;
            self._workerRetryId = setTimeout(function () { self.loadWorkers(); }, 15000);
          }
        });
    },

    // ── Phase G: manual refresh — forces Django re-pull via sync-service ──
    // Calls POST /sync/master-refresh which fetches latest workers + FG items
    // from the live ERP before reloading the UI dropdowns.
    async refreshMasterData() {
      if (this.refreshing) return;
      this.refreshing = true;

      try {
        // Tell sync-service to pull fresh data from Django right now
        var res = await this._fetchWithTimeout(
          CONFIG.syncServiceUrl + '/sync/master-refresh',
          { method: 'POST' },
          12000  // longer timeout: Django network call
        );
        var data = res.ok ? await res.json() : null;

        if (data && data.status === 'ok') {
          this.lastMasterSyncAt = data.synced_at;
          // Show counts briefly if available
          if (data.workers_count !== undefined || data.products_count !== undefined) {
            var msg = [];
            if (data.workers_count  !== undefined) msg.push(data.workers_count  + ' workers');
            if (data.products_count !== undefined) msg.push(data.products_count + ' products');
            // non-blocking info only (no errorMessage — this is success)
          }
        }
      } catch (err) {
        // Network error — sync-service may be starting; fall through and reload cache
      }

      // Reload UI dropdowns from sync-service cache (now refreshed from Django)
      this.loadProducts();
      this.loadWorkers();
      await this.refreshTodaySummary();

      var self = this;
      setTimeout(function () { self.refreshing = false; }, 1500);
    },

    // ── Phase G: fetch last master sync timestamp from sync status ──────────
    _fetchSyncStatus() {
      var self = this;
      this._fetchWithTimeout(CONFIG.syncServiceUrl + '/sync/status')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.last_master_sync_at) {
            self.lastMasterSyncAt = data.last_master_sync_at;
          }
        })
        .catch(function () { /* best effort */ });
    },

    // ══════════════════════════════════════════════════════════════
    // Today's summary
    // ══════════════════════════════════════════════════════════════

    refreshTodaySummary() {
      var self = this;
      return this._fetchWithTimeout(CONFIG.syncServiceUrl + '/bags/today')
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
      this._weightPollId    = setInterval(function () { self.pollWeight(); }, CONFIG.weightPollMs);
      this._healthPollId    = setInterval(function () { self.pollHealth(); }, CONFIG.healthPollMs);
      // Phase G: poll sync status every 2 minutes to keep lastMasterSyncAt fresh
      this._syncStatusPollId = setInterval(function () { self._fetchSyncStatus(); }, 120000);
      this._fetchSyncStatus();  // initial fetch on startup
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
      // Phase F: hard double-click lock — ignore any tap within 2 seconds of last tap
      var now = Date.now();
      if (now < this._printLockUntil) return;
      this._printLockUntil = now + (CONFIG.printLockMs || 2000);

      if (!this.canPrint) return;

      this.state = 'PRINTING';
      this.errorMessage = null;
      this.errorModal.show = false;

      var weightKg = this.stableWeight || this.weight;
      var weightGm = Math.round(weightKg * 1000);

      try {
        var addRes = await this._fetchWithTimeout(
          CONFIG.syncServiceUrl + '/bags/add',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pack_config_id: Number(this.selectedPackId),
              weight_gm: weightGm,
              worker_code_1: this.selectedWorker1,
              worker_code_2: this.selectedWorker2 || null,
            }),
          }
        );

        var bagData = await addRes.json();

        if (!addRes.ok) {
          throw new Error(bagData.error || 'Failed to add bag');
        }

        var line1 = this.counter.nextLine1();

        this.lastBag = {
          qr_code: bagData.qr_code,
          bag_number: bagData.bag_number,
          pack_name: bagData.pack_name,
          weight_gm: weightGm,
          weight_kg: weightKg,
          line1: line1,
          printed_at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        };
        this.totalBagsToday = bagData.total_bags_today;

        this._updateRecentProducts(Number(this.selectedPackId), bagData.pack_name, weightKg, bagData.bag_number);
        this._updateLocalProductCount(bagData.pack_name);

      } catch (err) {
        // Phase F: show full-screen error modal for add-bag failure
        this._showErrorModal('SYNC ERROR', 'Could not save bag to system.\n\n' + (err.message || 'Network error'), false);
        this.state = 'IDLE';
        this._playBeep('error');
        return;
      }

      await this._printLabel(weightKg);
    },

    async retryPrint() {
      if (this.state !== 'PRINT_FAILED' || !this.lastBag) return;

      this.state = 'PRINTING';
      this.errorMessage = null;
      this.errorModal.show = false;
      await this._printLabel(this.lastBag.weight_kg);
    },

    async _printLabel(weightKg) {
      var maxAttempts = CONFIG.printRetryAttempts || 3;
      this.printMaxAttempts = maxAttempts;

      var qrCode = this.lastBag.qr_code;
      var packName = this.lastBag.pack_name || '';
      var line1 = this.lastBag.line1 + ' | ' + weightKg.toFixed(2) + ' kg';
      var printPayload = {
        product: packName,
        weight: weightKg,
        stationId: CONFIG.stationId,
        line1: line1,
        line2: qrCode,
        qrContent: qrCode,
      };

      for (var attempt = 1; attempt <= maxAttempts; attempt++) {
        this.printAttempt = attempt;
        if (attempt > 1) {
          this.state = 'PRINT_RETRYING';
          this.errorMessage = 'Retrying print...';
        }

        try {
          var printRes = await this._fetchWithTimeout(
            CONFIG.printServiceUrl + '/print/print',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(printPayload),
            },
            CONFIG.printFetchTimeoutMs
          );

          var printData = await printRes.json();

          if (printRes.ok && printData.status === 'ok') {
            this.state = 'PRINTED';
            this.errorMessage = null;
            // Phase F: beep on success
            this._playBeep('success');
            var self = this;
            this._autoResetId = setTimeout(function () {
              if (self.state === 'PRINTED') self.state = 'IDLE';
            }, CONFIG.autoResetMs);
            return;
          }
        } catch (err) {
          // continue to next attempt
        }

        if (attempt < maxAttempts) {
          await new Promise(function (r) { setTimeout(r, CONFIG.printRetryDelayMs || 500); });
        }
      }

      // Phase F: all attempts failed — show FULL SCREEN error modal, not small text
      this.state = 'PRINT_FAILED';
      this.errorMessage = null;
      this._showErrorModal(
        '⚠  PRINTER ERROR',
        'Label could not be printed after ' + maxAttempts + ' attempts.\n\nTap RETRY PRINT to try again, or check printer connection.',
        true
      );
      this._playBeep('error');
      this._resetPrinterBackground();
    },

    // ══════════════════════════════════════════════════════════════
    // Phase F: Full-screen error modal
    // ══════════════════════════════════════════════════════════════

    _showErrorModal(title, body, showRetry) {
      this.errorModal = { show: true, title: title, body: body, showRetry: !!showRetry };
    },

    dismissErrorModal() {
      this.errorModal.show = false;
      if (this.state === 'PRINT_FAILED') {
        // Keep state so retry button still works via main UI
      }
    },

    // ══════════════════════════════════════════════════════════════
    // Phase F: Web Audio beep
    // ══════════════════════════════════════════════════════════════

    _playBeep(type) {
      if (!CONFIG.enableBeep) return;
      try {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        var ctx = new AudioCtx();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'success') {
          // Two rising tones: pleasant confirmation
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
          gain.gain.setValueAtTime(0.25, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.35);
        } else {
          // Two falling tones: alert
          osc.frequency.setValueAtTime(440, ctx.currentTime);
          osc.frequency.setValueAtTime(220, ctx.currentTime + 0.18);
          gain.gain.setValueAtTime(0.3, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.55);
        }
      } catch (e) { /* audio blocked or unavailable — silent */ }
    },

    // ══════════════════════════════════════════════════════════════
    // Background printer reset
    // ══════════════════════════════════════════════════════════════

    async _resetPrinterBackground() {
      this.printResetting = true;
      try {
        var res = await this._fetchWithTimeout(
          CONFIG.printServiceUrl + '/print/reset',
          { method: 'POST' },
          CONFIG.printResetTimeoutMs || 20000
        );
        var data = await res.json();
        if (!data.connected) {
          this.errorModal.body += '\n\nPrinter is still offline.';
        }
      } catch (err) { /* best effort */ }
      finally {
        this.printResetting = false;
      }
    },

    // ══════════════════════════════════════════════════════════════
    // Reprint last bag
    // ══════════════════════════════════════════════════════════════

    async reprintLast() {
      if (!this.lastBag) return;
      if (this.state === 'PRINTING' || this.state === 'PRINTED' || this.state === 'PRINT_RETRYING') return;

      // Phase F: same lock for reprint
      var now = Date.now();
      if (now < this._printLockUntil) return;
      this._printLockUntil = now + (CONFIG.printLockMs || 2000);

      this.state = 'PRINTING';
      this.errorMessage = null;
      this.errorModal.show = false;
      await this._printLabel(this.lastBag.weight_kg);
    },

    // ══════════════════════════════════════════════════════════════
    // Display helpers
    // ══════════════════════════════════════════════════════════════

    get filteredWorkers2() {
      var w1 = this.selectedWorker1;
      if (!w1) return this.workers;
      return this.workers.filter(function (w) { return w.worker_code !== w1; });
    },

    get canPrint() {
      return this.state === 'IDLE'
        && this.weightStatus === 'ok'
        && this.stable
        && this.selectedPackId
        && this.printerConnected
        && this.selectedWorker1;
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
      if (this.stable) return '✓ Stable — Ready to Print';
      return 'Settling…';
    },

    get weightStatusText() {
      if (this.weightStatus === 'ok') return 'Scale OK';
      if (this.weightServiceReachable && this.weightStatus === 'disconnected') return 'Scale Connecting';
      return 'Scale OFF';
    },

    get weightStatusClass() {
      if (this.weightStatus === 'ok') return 'status-connected';
      if (this.weightServiceReachable && this.weightStatus === 'disconnected') return 'status-connecting';
      return 'status-disconnected';
    },

    get printerStatusText() {
      return this.printerConnected ? 'Printer OK' : 'Printer OFF';
    },

    get syncStatusText() {
      return this.syncConnected ? 'Server OK' : 'Server OFF';
    },

    // Phase F: bigger, clearer print button text
    get printButtonText() {
      if (this.state === 'PRINTING')      return '⏳  PRINTING…  PLEASE WAIT';
      if (this.state === 'PRINT_RETRYING') return '⏳  RETRYING  (' + this.printAttempt + ' / ' + this.printMaxAttempts + ')';
      if (this.state === 'PRINTED')       return '✓  PRINT SUCCESS';
      if (this.state === 'PRINT_FAILED')  return '⚠  RETRY PRINT';
      if (this.weightStatus !== 'ok')     return '⚠  Scale Not Ready';
      if (!this.printerConnected)         return '⚠  Printer Not Connected';
      if (!this.selectedPackId)           return 'Select Product First';
      if (!this.selectedWorker1)          return 'Select Worker First';
      if (!this.stable)                   return 'Waiting for Stable Weight…';
      return 'PRINT';
    },

    get printButtonDisabled() {
      if (this.state === 'PRINT_FAILED') return false;
      if (this.state === 'PRINT_RETRYING') return true;
      return !this.canPrint;
    },

    // Phase G: human-readable "HH:MM" or "Never" for last master sync display
    get lastMasterSyncDisplay() {
      if (!this.lastMasterSyncAt) return 'Never';
      try {
        var d = new Date(this.lastMasterSyncAt);
        return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      } catch (e) { return '?'; }
    },

    // Phase G: how many minutes ago was last master sync (for stale warning)
    get masterSyncAgeMin() {
      if (!this.lastMasterSyncAt) return null;
      return Math.floor((Date.now() - new Date(this.lastMasterSyncAt).getTime()) / 60000);
    },

    get lastBagDisplay() {
      if (!this.lastBag) return '';
      var w = this.lastBag.weight_gm
        ? (this.lastBag.weight_gm / 1000).toFixed(2) + ' kg'
        : '';
      return '#' + this.lastBag.bag_number + '  ' + this.lastBag.pack_name + '  ' + w;
    },

    // ══════════════════════════════════════════════════════════════
    // Internal helpers
    // ══════════════════════════════════════════════════════════════

    selectRecentProduct(packId) {
      this.selectedPackId = String(packId);
    },

    // Phase F: store richer data in recent list (weight + time for left panel)
    _updateRecentProducts(packId, packName, weightKg, bagNumber) {
      var filtered = this.recentProducts.filter(function(p) {
        return String(p.pack_id) !== String(packId);
      });
      filtered.unshift({
        pack_id:    packId,
        name:       packName,
        weight_kg:  weightKg ? weightKg.toFixed(2) : null,
        bag_number: bagNumber || null,
        time:       new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      });
      this.recentProducts = filtered.slice(0, 8);
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
      if (!found) this.bagsByProduct.push({ pack_name: packName, count: 1 });
    },

    onWorker1Change() {
      try { localStorage.setItem('selectedWorker1', this.selectedWorker1); } catch (e) { /* ignore */ }
      if (this.selectedWorker2 && this.selectedWorker2 === this.selectedWorker1) {
        this.selectedWorker2 = '';
        try { localStorage.setItem('selectedWorker2', ''); } catch (e) { /* ignore */ }
      }
    },

    onWorker2Change() {
      try { localStorage.setItem('selectedWorker2', this.selectedWorker2); } catch (e) { /* ignore */ }
    },

    _fetchWithTimeout(url, options, timeoutMs) {
      var ms = timeoutMs || CONFIG.fetchTimeoutMs;
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, ms);
      var opts = Object.assign({}, options || {}, { signal: controller.signal });
      return fetch(url, opts).finally(function () { clearTimeout(timeoutId); });
    },
  };
}
