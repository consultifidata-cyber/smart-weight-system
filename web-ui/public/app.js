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

    // ── Worker grid (Phase UI) ─────────────────────────────────────────────
    // pinnedWorkerCodes: ordered array of up to 15 worker codes shown as BIG buttons.
    // Positions are stable — workers learn "my button is always in slot 4".
    // When a non-pinned worker is selected, the least-recently-used pinned worker
    // is evicted and the new one takes that exact slot (position preserved).
    PINNED_LIMIT:     15,
    pinnedWorkerCodes: [],   // max 15 codes, ORDER IS STABLE
    workerLastUsed:   {},    // { code: timestamp } — for eviction decisions
    workerPanelOpen:  false, // worker info/lookup panel
    workerSearch:     '',    // type-ahead filter in worker modal
    wsModal: { show: false, date: '', shift: '', loading: false, data: null, error: '', stale: false, printing: false, printDone: false },
    _healthPollFails: 0,   // consecutive /print/health failures before flipping dot red

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

    // ── Phase H: readiness gate ──
    systemReady:        false,
    systemReadyChecked: false,
    systemReadyIssues:  [],
    systemChecking:     false,  // true while a readiness check is in flight
    _systemStartupRetry: 0,
    _readinessRetryId:  null,
    _readinessMonitorId: null,
    _systemLastOkAt:    0,
    _consecutiveReadinessFailures: 0,
    systemBlipping:     false,
    printToast:         { show: false, msg: '' },
    pinModal:           { show: false, input: '', error: '' },
    // H1 — live device state from /system/status (3s poll)
    scaleConnected:         false,
    printerCountdown:       null,  // null = not counting; number = seconds remaining
    scaleCountdown:         null,
    _printerCountdownId:    null,
    _scaleCountdownId:      null,
    // H2/H3 — shift + clock
    _clockTick:             0,     // incremented every minute; makes shiftClockLabel reactive
    // Promotion animation state
    _promotedCode:          '',
    _promotedTimerId:       null,

    // 1.2 — Duplicate print guard
    _lastPrintSignature:    null,   // { workerCode, packId, weightGm, ts }
    _dupGuardModal:         false,  // pending duplicate confirmation
    _dupGuardTimerId:       null,   // auto-dismiss after 5s

    // 2.1 — Audio toggle (enableBeep already in CONFIG; persist user override)
    soundEnabled:           CONFIG.enableBeep !== false,

    // 2.2 — Per-worker shift bag counts
    workerShiftCounts:      {},   // { workerCode: count } — current shift
    _currentShiftForCounts: '',  // shift letter when counts were last saved

    // 1.1 — Pending sync badge (from existing SQLite queue via /sync/status)
    syncPendingCount:       0,
    syncPendingModal:       false,

    // 3.1 — Hardware status modal
    hwModal:                { show: false, loading: false, data: null },
    _hwRefreshTimerId:      null,

    // 4.3 — Sync latency (seconds since last push)
    _lastSyncPushAt:        null,
    _syncLatencySec:        null,
    _syncLatencyTimerId:    null,

    // 5.1 — Error log buffer (flushed on next successful server contact)
    _errorBuffer:           [],

    // 5.2 — Startup self-test
    selfTest: { show: false, scale: 'checking', printer: 'checking', sync: 'checking', errors: {} },
    // v2.3.0 — all-workers report modal
    reportsModal: {
      show: false, loading: false, error: '',
      selectedDate: '', selectedShift: 'ALL',
    },
    // v2.3.0 — single-worker report modal
    workerReportModal: {
      show: false, loading: false, error: '',
      workerCode: '', workerName: '', selectedDate: '',
    },

    // Shift is auto-computed — no prompt, no checklist
    shiftConfirmed:     true,

    // ── Phase H: data safety indicator (sync health) ──
    syncHealth: 'unknown',   // 'green' | 'yellow' | 'red' | 'unknown'

    // ── Phase H: panic button ──
    generatingReport: false,

    // ── Phase H: training mode ──
    trainingMode: false,

    // ── Timers ──
    _weightPollId: null,
    _healthPollId: null,
    _autoResetId: null,
    _syncStatusPollId: null,
    _syncHealthPollId: null,

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

      // Restore pinned worker slots and last-used timestamps
      try {
        var pc = localStorage.getItem('pinnedWorkerCodes');
        if (pc) this.pinnedWorkerCodes = JSON.parse(pc);
        var lu = localStorage.getItem('workerLastUsed');
        if (lu) this.workerLastUsed = JSON.parse(lu);
      } catch (e) { /* ignore */ }

      // Phase H: restore training mode preference
      try {
        if (localStorage.getItem('trainingMode') === '1') this.trainingMode = true;
      } catch (e) { /* ignore */ }

      // 5.1 — Install global error handlers + flush any buffered errors
      var _app = this;
      window.onerror = function (msg, src, line, col, err) {
        _app.logError('window', err || { message: msg }, { src: src, line: line, col: col });
      };
      window.onunhandledrejection = function (e) {
        _app.logError('promise', e.reason, {});
      };

      // 2.1 — Restore audio preference
      try {
        var storedSound = localStorage.getItem('soundEnabled');
        if (storedSound !== null) this.soundEnabled = storedSound !== 'false';
      } catch (e) {}

      // 2.2 — Restore worker shift counts (reset if shift changed)
      this._restoreWorkerShiftCounts();

      // 4.3 — Start sync latency 1s ticker
      this._startSyncLatencyTicker();

      // 5.2 — Startup self-test (runs async, dismisses if all-pass)
      this._runSelfTest();

      // Load Django URL + token from server for report API calls
      this._loadFlags();

      // H3 — clock ticker updates shiftClockLabel every minute
      var self2 = this;
      setInterval(function () { self2._clockTick++; }, 60000);

      // Start continuous readiness monitor (5 s interval, hysteresis)
      this.startReadinessMonitor();
    },

    destroy() {
      clearInterval(this._weightPollId);
      clearInterval(this._healthPollId);
      clearInterval(this._syncStatusPollId);
      clearInterval(this._syncHealthPollId);
      clearInterval(this._readinessMonitorId);
      clearInterval(this._syncLatencyTimerId);
      clearInterval(this._printerCountdownId);
      clearInterval(this._scaleCountdownId);
      clearTimeout(this._readinessRetryId);
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

    // ══════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════
    // Readiness Gate — hysteresis + continuous monitoring
    // ══════════════════════════════════════════════════════════════

    // Starts a continuous 5s monitor. Brief failures show inline
    // "Reconnecting..." banner. Persistent failures (≥3 failures AND
    // ≥20s since last good check) show the full-screen gate.
    startReadinessMonitor() {
      var self = this;
      this.checkSystemReady();
      if (this._readinessMonitorId) clearInterval(this._readinessMonitorId);
      this._readinessMonitorId = setInterval(function () {
        self.checkSystemReady();
      }, 5000);
    },

    checkSystemReady() {
      var self = this;
      this._doReadinessCheck().then(function () {
        if (self.systemReady) {
          // System is healthy — record timestamp and reset counters
          self._systemLastOkAt = Date.now();
          self._consecutiveReadinessFailures = 0;
          self._systemStartupRetry = 6;  // skip grace period on future checks
          self.systemReadyChecked = false;  // hide gate
          self.systemBlipping     = false;  // hide inline toast
          return;
        }

        self._consecutiveReadinessFailures++;

        // Grace period: first ~30s after startup — silent retries, show nothing
        if (self._systemStartupRetry < 6) {
          self._systemStartupRetry++;
          self.systemReadyChecked = false;
          self.systemBlipping     = false;
          return;
        }

        // Past grace period: decide between blip and persistent failure
        var secSinceOk = self._systemLastOkAt > 0
          ? (Date.now() - self._systemLastOkAt) / 1000 : Infinity;

        if (self._consecutiveReadinessFailures < 3 || secSinceOk < 20) {
          // Brief blip — inline toast only, DO NOT show full-screen gate
          self.systemBlipping     = true;
          self.systemReadyChecked = false;
        } else {
          // Persistent failure — show full-screen gate
          self.systemBlipping     = false;
          self.systemReadyChecked = true;
        }
      });
    },

    async _doReadinessCheck() {
      this.systemChecking = true;
      var issues = [];

      // ── Print service + hardware status ──────────────────────────────────
      try {
        var res  = await this._fetchWithTimeout(CONFIG.printServiceUrl + '/system/status', {}, 5000);
        var data = await res.json();
        if (data.printer && data.printer.state !== 'connected') {
          issues.push('Label printer not ready - power it ON and check the USB cable.');
        }
        // P1.1 fix: use data.scale.state (not data.scale.connected)
        if (data.scale && data.scale.state !== 'connected' && !data.scale.simulate) {
          issues.push('Weight machine not sending data. Check the cable behind the laptop is plugged in firmly.');
        }
      } catch (e) {
        issues.push('Printer software is starting up. Wait 30 seconds, then tap Retry.');
      }

      // ── Sync service — products and workers from Django ───────────────────
      if (this.products.length === 0) {
        issues.push('Product list not loaded. Check internet connection to office server, then tap Retry.');
      }
      if (this.workers.length === 0) {
        issues.push('Worker list not loaded. Tell supervisor to check internet, then tap Retry.');
      }

      this.systemReadyIssues = issues;
      this.systemReady       = issues.length === 0;
      this.systemChecking    = false;
      // Note: systemReadyChecked and systemBlipping are set by checkSystemReady()
    },

    // ── PIN override ──────────────────────────────────────────────
    openPinOverride() {
      this.pinModal = { show: true, input: '', error: '' };
    },
    closePinModal() {
      this.pinModal.show = false;
    },
    tryPinOverride() {
      var correct = String(CONFIG.supervisorPin || '1234');
      if (this.pinModal.input === correct) {
        this.systemReady        = true;
        this.systemReadyChecked = false;
        this.systemBlipping     = false;
        this._systemLastOkAt    = Date.now();
        this._consecutiveReadinessFailures = 0;
        this.closePinModal();
      } else {
        this.pinModal.error = 'Wrong PIN - try again.';
        this.pinModal.input = '';
      }
    },

    // ══════════════════════════════════════════════════════════════
    // Phase H — Shift Start Checklist
    // ══════════════════════════════════════════════════════════════

    // Shift is automatic — no checklist, no prompt, no confirmShift needed

    // ══════════════════════════════════════════════════════════════
    // Phase H — Data Safety Indicator (sync health)
    // ══════════════════════════════════════════════════════════════

    _pollSyncHealth() {
      var self = this;
      this._fetchWithTimeout(CONFIG.syncServiceUrl + '/sync/status')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var lastSync = data.last_sync_at;
          var pending  = (data.pending_sessions || 0) + (data.pending_entries || 0);
          if (lastSync) self._lastSyncPushAt = new Date(lastSync).getTime();
          self.syncPendingCount = pending;   // 1.1 — drive the amber badge

          if (!lastSync && pending === 0) {
            // No syncs yet but nothing pending — likely fresh install, OK
            self.syncHealth = 'green';
            return;
          }

          var ageMs = lastSync ? Date.now() - new Date(lastSync).getTime() : Infinity;

          if (ageMs < 2 * 60 * 1000 || (ageMs < 5 * 60 * 1000 && pending === 0)) {
            self.syncHealth = 'green';
          } else if (ageMs < 15 * 60 * 1000) {
            self.syncHealth = 'yellow';
          } else {
            self.syncHealth = 'red';
          }
        })
        .catch(function () { self.syncHealth = 'red'; });
    },

    get syncHealthClass() {
      return {
        'sync-health-green':   this.syncHealth === 'green',
        'sync-health-yellow':  this.syncHealth === 'yellow',
        'sync-health-red':     this.syncHealth === 'red',
        'sync-health-unknown': this.syncHealth === 'unknown',
      };
    },

    get syncHealthText() {
      if (this.syncHealth === 'green')   return '● LIVE SYNC';
      if (this.syncHealth === 'yellow')  return '● SYNCING…';
      if (this.syncHealth === 'red')     return '● SYNC STOPPED';
      return '● SYNC UNKNOWN';
    },

    // ══════════════════════════════════════════════════════════════
    // Phase H — Panic Button (Download Report)
    // ══════════════════════════════════════════════════════════════

    async generateReport() {
      if (this.generatingReport) return;
      this.generatingReport = true;
      try {
        var res = await this._fetchWithTimeout(
          'http://localhost:3000/ops/report',
          { method: 'POST' },
          40000
        );
        var data = await res.json();
        if (data.status === 'ok') {
          alert('✓ Support report saved.\n\nFile: ' + data.path + '\n\nSend this file to support.');
        } else {
          throw new Error(data.error || 'unknown error');
        }
      } catch (e) {
        alert(
          '⚠ Could not auto-generate report.\n\n' +
          'Run manually (as Administrator):\n' +
          'powershell -File "C:\\SmartWeightSystem\\tools\\health-report.ps1"'
        );
      } finally {
        this.generatingReport = false;
      }
    },

    // ══════════════════════════════════════════════════════════════
    // Phase H — Training Mode
    // ══════════════════════════════════════════════════════════════

    toggleTrainingMode() {
      this.trainingMode = !this.trainingMode;
      try { localStorage.setItem('trainingMode', this.trainingMode ? '1' : '0'); } catch (e) { /* ignore */ }
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
      this._weightPollId     = setInterval(function () { self.pollWeight(); }, CONFIG.weightPollMs);
      this._healthPollId     = setInterval(function () { self.pollHealth(); }, CONFIG.healthPollMs);
      // Phase G: poll sync status every 2 minutes to keep lastMasterSyncAt fresh
      this._syncStatusPollId = setInterval(function () { self._fetchSyncStatus(); }, 120000);
      this._fetchSyncStatus();
      // Phase H: poll sync health every 30 seconds for the safety indicator
      this._syncHealthPollId = setInterval(function () { self._pollSyncHealth(); }, 30000);
      this._pollSyncHealth();
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
      // H1.3 — read /system/status for live printer + scale state (3s poll)
      var self = this;
      this._fetchWithTimeout(CONFIG.printServiceUrl + '/system/status', {}, 4000)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var prevPrinter = self.printerConnected;
          var prevScale   = self.scaleConnected;

          self.printerConnected = !!(data.printer && data.printer.state === 'connected');
          self.scaleConnected   = !!(data.scale   && data.scale.state   === 'connected');
          self._healthPollFails = 0;

          // Start/stop countdown on state change
          if (prevPrinter && !self.printerConnected) self._startCountdown('printer');
          if (!prevPrinter && self.printerConnected)  self._stopCountdown('printer');
          if (prevScale   && !self.scaleConnected)   self._startCountdown('scale');
          if (!prevScale  && self.scaleConnected)    self._stopCountdown('scale');
        })
        .catch(function () {
          self._healthPollFails = (self._healthPollFails || 0) + 1;
          if (self._healthPollFails >= 3) {
            var prevP = self.printerConnected, prevS = self.scaleConnected;
            self.printerConnected = false;
            self.scaleConnected   = false;
            if (prevP) self._startCountdown('printer');
            if (prevS) self._startCountdown('scale');
          }
        });

      this._fetchWithTimeout(CONFIG.syncServiceUrl + '/health')
        .then(function (res) { return res.json(); })
        .then(function (data) { self.syncConnected = data.status === 'ok'; })
        .catch(function () { self.syncConnected = false; });
    },

    // H4 — reconnect countdown per device
    _startCountdown(device) {
      var self = this;
      var countdownKey = device + 'Countdown';
      var timerId      = '_' + device + 'CountdownId';
      if (self[timerId]) clearInterval(self[timerId]);
      self[countdownKey] = 30;
      self[timerId] = setInterval(function () {
        if (self[countdownKey] > 0) { self[countdownKey]--; }
        if (self[countdownKey] <= 0) {
          // Force probe by triggering a fresh poll
          self[countdownKey] = 30;
          self.pollHealth();
        }
      }, 1000);
    },

    _stopCountdown(device) {
      var timerId      = '_' + device + 'CountdownId';
      var countdownKey = device + 'Countdown';
      if (this[timerId]) { clearInterval(this[timerId]); this[timerId] = null; }
      this[countdownKey] = null;
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

      // 1.2 — Duplicate-print guard: same worker + same product + weight within ±5g within 3s?
      var weightKg0 = this.stableWeight || this.weight;
      var weightGm0 = Math.round(weightKg0 * 1000);
      var sig = { workerCode: this.selectedWorker1, packId: this.selectedPackId, weightGm: weightGm0, ts: now };
      if (this._lastPrintSignature) {
        var prev = this._lastPrintSignature;
        var sameWorker  = prev.workerCode === sig.workerCode;
        var samePack    = prev.packId     === sig.packId;
        var sameWeight  = Math.abs(prev.weightGm - sig.weightGm) <= 5;
        var withinWindow = (now - prev.ts) < 3000;
        if (sameWorker && samePack && sameWeight && withinWindow) {
          if (!this._dupGuardModal) {
            // First duplicate attempt — show warning, auto-dismiss in 5s
            this._dupGuardModal = true;
            if (this._dupGuardTimerId) clearTimeout(this._dupGuardTimerId);
            var self4 = this;
            this._dupGuardTimerId = setTimeout(function () {
              self4._dupGuardModal = false;
              self4._lastPrintSignature = null;
            }, 5000);
            return;
          }
          // Second tap while guard is active — confirmed duplicate, fall through
          if (this._dupGuardTimerId) clearTimeout(this._dupGuardTimerId);
        }
      }
      this._dupGuardModal = false;

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
              shift: this.currentShift,
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

        // 1.2 — Record print signature for duplicate guard
        this._lastPrintSignature = { workerCode: this.selectedWorker1, packId: this.selectedPackId, weightGm: weightGm, ts: Date.now() };
        // Auto-expire signature after 3s so the guard doesn't persist
        var self3 = this;
        setTimeout(function () { if (self3._lastPrintSignature && Date.now() - self3._lastPrintSignature.ts >= 3000) self3._lastPrintSignature = null; }, 3100);

        // 2.2 — Increment per-worker shift bag count
        var wc = this.selectedWorker1;
        if (wc) {
          this.workerShiftCounts[wc] = (this.workerShiftCounts[wc] || 0) + 1;
          this._saveWorkerShiftCounts();
        }

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

          // H7 — abort retry loop on printer_disconnected: job must NOT queue
          if (printRes.status === 503 && printData.error === 'printer_disconnected') {
            this.state = 'PRINT_FAILED';
            this._showErrorModal(
              '⚠  PRINTER NOT CONNECTED',
              'Printer is not connected.\n\nCheck the USB cable, then tap RETRY PRINT.',
              true
            );
            this._playBeep('error');
            return;
          }

          if (printRes.ok && printData.status === 'ok') {
            this.state = 'PRINTED';
            this.errorMessage = null;
            // Brief confirmation toast: product + weight + worker
            this._showPrintToast(
              (this.lastBag ? this.lastBag.pack_name : 'Label') + ' — ' +
              (weightKg ? weightKg.toFixed(2) + ' kg' : '') +
              (this.selectedWorker1 ? '  ·  ' + this.selectedWorker1 : '') +
              '  ✓ printed'
            );
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

    _showPrintToast(msg) {
      var self = this;
      if (this._printToastTimer) clearTimeout(this._printToastTimer);
      this.printToast = { show: true, msg: msg };
      this._printToastTimer = setTimeout(function () {
        self.printToast.show = false;
      }, 3000);
    },
    dismissPrintToast() {
      this.printToast.show = false;
      if (this._printToastTimer) clearTimeout(this._printToastTimer);
    },

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
      if (!this.soundEnabled) return;
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

    // H2 — current shift from local time (no prompt)
    get currentShift() {
      var h = new Date().getHours();
      return h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'C';
    },

    // H3 — "Shift A · 14:23" — uses _clockTick for minute-level reactivity
    get shiftClockLabel() {
      var _ = this._clockTick;  // reactive dependency — re-evaluates every minute
      var now = new Date();
      var h = now.getHours(), m = now.getMinutes();
      var shift = h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'C';
      return 'Shift ' + shift + ' · ' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
    },

    // H4 — printer pill text with countdown
    get printerStatusText() {
      if (!this.printerConnected) {
        if (this.printerCountdown !== null) return 'DISCONNECTED · ' + this.printerCountdown + 's';
        return 'Printer OFF';
      }
      return 'Printer OK';
    },

    get syncStatusText() {
      return this.syncConnected ? 'Server OK' : 'Server OFF';
    },

    // H5 — print button states, explicit priority order
    get printButtonText() {
      // Active states
      if (this.state === 'PRINTING')       return 'Printing...';
      if (this.state === 'PRINT_RETRYING') return 'Retrying (' + this.printAttempt + '/' + this.printMaxAttempts + ')';
      if (this.state === 'PRINTED')        return '✓  Print Success';
      if (this.state === 'PRINT_FAILED')   return '⚠  Retry Print';
      // Device disconnected (highest priority blocking state)
      if (!this.printerConnected)          return '⚠  Printer Not Connected';
      if (this.weightStatus === 'disconnected' || !this.weightServiceReachable) return '⚠  Scale Not Connected';
      // Missing selections
      if (!this.selectedPackId)            return 'Select Product First';
      if (!this.selectedWorker1)           return 'Select Worker First';
      // Weight not stable
      if (this.weightStatus !== 'ok')      return 'Scale Not Ready';
      if (!this.stable)                    return 'Waiting for Stable Weight...';
      return 'PRINT';
    },

    get printButtonDisabled() {
      if (this.state === 'PRINT_FAILED') return false;  // Retry Print is enabled
      if (this.state === 'PRINTING' || this.state === 'PRINT_RETRYING') return true;
      if (this.state === 'PRINTED') return true;
      // Block on device disconnect
      if (!this.printerConnected) return true;
      if (this.weightStatus === 'disconnected' || !this.weightServiceReachable) return true;
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

    // ── Worker grid methods ────────────────────────────────────────────────

    /** Pinned worker objects in stable slot order (shown as big buttons). */
    get pinnedWorkerObjects() {
      return this.pinnedWorkerCodes
        .map(function(code) { return this.workers.find(function(w) { return w.worker_code === code; }); }.bind(this))
        .filter(Boolean);
    },

    /** Workers not in the pinned set (shown in the More modal). */
    get otherWorkerObjects() {
      var pinned = new Set(this.pinnedWorkerCodes);
      return this.workers.filter(function(w) { return !pinned.has(w.worker_code); });
    },

    /** The most-recently-tapped worker code among the pinned 15 (for MRU indicator). */
    get mruWorkerCode() {
      var maxTs = 0;
      var mru   = '';
      for (var code of this.pinnedWorkerCodes) {
        var ts = this.workerLastUsed[code] || 0;
        if (ts > maxTs) { maxTs = ts; mru = code; }
      }
      return mru;
    },

    /** Always 15 slots; null = empty slot for stable grid layout. */
    get pinnedSlots() {
      var objects = this.pinnedWorkerObjects;
      var slots = [];
      for (var i = 0; i < 15; i++) {
        slots.push(objects[i] || null);
      }
      return slots;
    },

    /** CSS class for recent item button based on product MRP price. */
    recentBtnClass(packId) {
      var p = this.products.find(function(x) { return x.pack_id === packId; });
      if (!p || p.mrp === null || p.mrp === undefined) return '';
      var mrp = Number(p.mrp);
      if (mrp === 5)  return 'price-5';
      if (mrp === 10) return 'price-10';
      return '';
    },

    /**
     * Select a worker from the grid.
     * If the worker is outside the pinned 15, they replace the least-recently-used
     * pinned worker AT THE SAME SLOT so other workers' button positions don't shift.
     */
    selectWorkerCode(code, isWorker2) {
      if (isWorker2) {
        this.selectedWorker2 = (this.selectedWorker2 === code) ? '' : code;
        try { localStorage.setItem('selectedWorker2', this.selectedWorker2); } catch (e) {}
        return;
      }

      // Toggle off if tapping the already-selected worker
      if (this.selectedWorker1 === code) {
        this.selectedWorker1 = '';
        try { localStorage.setItem('selectedWorker1', ''); } catch (e) {}
        return;
      }

      this.selectedWorker1 = code;
      var now = Date.now();
      this.workerLastUsed[code] = now;

      // Keep position stable: only evict/add when new worker is outside pinned set
      var wasPromoted = false;
      if (!this.pinnedWorkerCodes.includes(code)) {
        wasPromoted = true;
        if (this.pinnedWorkerCodes.length < this.PINNED_LIMIT) {
          this.pinnedWorkerCodes.push(code);
        } else {
          var oldestCode = null;
          var oldestTime = Infinity;
          var self = this;
          this.pinnedWorkerCodes.forEach(function(c) {
            var t = self.workerLastUsed[c] || 0;
            if (t < oldestTime) { oldestTime = t; oldestCode = c; }
          });
          var idx = this.pinnedWorkerCodes.indexOf(oldestCode);
          if (idx >= 0) this.pinnedWorkerCodes[idx] = code;
        }
      }

      // Brief promotion animation for newly-added worker slots
      if (wasPromoted) {
        var self2 = this;
        if (this._promotedTimerId) clearTimeout(this._promotedTimerId);
        this._promotedCode = code;
        this._promotedTimerId = setTimeout(function () { self2._promotedCode = ''; }, 400);
      }

      try { localStorage.setItem('pinnedWorkerCodes', JSON.stringify(this.pinnedWorkerCodes)); } catch (e) {}
      try { localStorage.setItem('workerLastUsed', JSON.stringify(this.workerLastUsed)); } catch (e) {}
      try { localStorage.setItem('selectedWorker1', code); } catch (e) {}
    },

    // ══════════════════════════════════════════════════════════════════════
    // Worker Productivity Summary modal
    // ══════════════════════════════════════════════════════════════════════

    // Flat list for the preview table: mixes 'row' and 'subtotal' entries
    // so the template needs only a single x-for loop.
    get wsDisplayRows() {
      var m = this.wsModal;
      if (!m.data || !m.data.rows || m.data.rows.length === 0) return [];
      var subtotalMap = {};
      (m.data.worker_subtotals || []).forEach(function (w) { subtotalMap[w.worker_id] = w.bags; });
      var result = [];
      var prev = null;
      m.data.rows.forEach(function (row, i) {
        if (prev !== null && row.worker_id !== prev) {
          result.push({ type: 'subtotal', label: 'Subtotal', bags: subtotalMap[prev] || 0 });
        }
        result.push({ type: 'row', worker_id: row.worker_id, worker_name: row.worker_name, item: row.item, bags: row.bags });
        prev = row.worker_id;
        if (i === m.data.rows.length - 1) {
          result.push({ type: 'subtotal', label: 'Subtotal', bags: subtotalMap[row.worker_id] || 0 });
        }
      });
      return result;
    },

    _wsShiftForHour(h) {
      if (h >= 6  && h < 14) return 'A';
      if (h >= 14 && h < 22) return 'B';
      return 'C';
    },

    openWorkerSummaryModal() {
      var now   = new Date();
      var h     = now.getHours();
      var shift = this._wsShiftForHour(h);
      var d;
      // Shift C after midnight (00:00–05:59): shift started yesterday
      if (h < 6) {
        var yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        d = yest.toISOString().substring(0, 10);
      } else {
        d = now.toISOString().substring(0, 10);
      }
      this.wsModal = { show: true, date: d, shift: shift, loading: false, data: null, error: '', stale: false, printing: false, printDone: false };
    },

    closeWorkerSummaryModal() {
      this.wsModal.show = false;
    },

    async loadWorkerSummaryPreview() {
      var m = this.wsModal;
      m.loading = true;
      m.error   = '';
      m.data    = null;
      m.stale   = false;
      try {
        var url = CONFIG.syncServiceUrl + '/bags/worker-summary?date=' + m.date + '&shift=' + m.shift;
        var res = await this._fetchWithTimeout(url, {}, 8000);
        var json = await res.json();
        if (!res.ok) {
          m.error = json.error || ('Server error ' + res.status);
        } else {
          m.data = json;
        }
      } catch (e) {
        m.error = 'Could not reach sync service - is it running?';
      } finally {
        m.loading = false;
      }
    },

    onWsParamChange() {
      // Clear preview when date/shift changes after a successful load
      if (this.wsModal.data) { this.wsModal.stale = true; }
    },

    async printWorkerSummary() {
      var m = this.wsModal;
      if (!m.data || m.data.grand_total === 0) return;

      m.printing  = true;
      m.printDone = false;

      // Dry-run: uncomment next line to log TSPL payload without sending
      // console.log('[worker-summary] payload:', JSON.stringify(m.data, null, 2)); return;

      var self = this;
      try {
        var res = await this._fetchWithTimeout(
          CONFIG.printServiceUrl + '/print/worker-summary',
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(m.data),
          },
          15000,   // label strip can be long — allow more time than a bag label
        );

        if (res.ok) {
          m.printDone = true;
          setTimeout(function () { self.closeWorkerSummaryModal(); }, 1500);
        } else {
          var errJson = await res.json().catch(function () { return {}; });
          self._showErrorModal('PRINT FAILED', errJson.error || 'Printer returned an error.', false);
        }
      } catch (e) {
        self._showErrorModal('PRINT FAILED', 'Could not reach print service - is it running?', false);
      } finally {
        m.printing = false;
      }
    },

    // ══════════════════════════════════════════════════════════════
    // v2.3.0 — Feature flags
    // ══════════════════════════════════════════════════════════════

    async _loadFlags() {
      // Fetches Django URL + token from server for report API calls.
      // enableReports flag removed — reports are always enabled.
      try {
        var res  = await fetch('/api/flags');
        var data = await res.json();
        // Store Django credentials for report calls
        if (data.djangoServerUrl) this._djangoServerUrl = data.djangoServerUrl;
        if (data.djangoToken)     this._djangoToken     = data.djangoToken;
      } catch (e) { /* ok — reports will use sync-service fallback */ }
    },

    // ══════════════════════════════════════════════════════════════
    // v2.3.0 — Reports date helpers
    // ══════════════════════════════════════════════════════════════

    // Returns array of { value: 'YYYY-MM-DD', label: 'Today · 27 Apr' | '26 Apr' }
    get reportDateOptions() {
      var opts = [];
      var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      for (var i = 0; i < 7; i++) {
        var d = new Date(); d.setDate(d.getDate() - i);
        var iso = d.toISOString().substring(0, 10);
        var label = d.getDate() + ' ' + MONTHS[d.getMonth()];
        if (i === 0) label = 'Today · ' + label;
        else if (i === 1) label = 'Yesterday · ' + label;
        opts.push({ value: iso, label: label });
      }
      return opts;
    },

    // ══════════════════════════════════════════════════════════════
    // v2.3.0 — All-workers report modal
    // ══════════════════════════════════════════════════════════════

    openReportsModal() {
      var today = new Date().toISOString().substring(0, 10);
      this.reportsModal = { show: true, loading: false, error: '', selectedDate: today, selectedShift: 'ALL' };
    },
    closeReportsModal() { this.reportsModal.show = false; },

    async printAllWorkersReport() {
      var m = this.reportsModal;
      m.loading = true; m.error = '';
      try {
        // Call LOCAL sync-service (item-wise, offline-safe — no Django needed)
        var params = '?date=' + m.selectedDate + '&shift=' + m.selectedShift;
        var rRes = await this._fetchWithTimeout(
          CONFIG.syncServiceUrl + '/bags/worker-summary' + params,
          {},
          8000,
        );
        if (!rRes.ok) {
          var errData = await rRes.json().catch(function() { return {}; });
          m.error = errData.error || ('Sync service error ' + rRes.status);
          return;
        }
        var report = await rRes.json();
        report.date  = m.selectedDate;
        report.shift = m.selectedShift;

        var pRes = await this._fetchWithTimeout(
          CONFIG.printServiceUrl + '/print/report-workers',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) },
          30000,
        );
        if (!pRes.ok) {
          var pe = await pRes.json().catch(function() { return {}; });
          m.error = pe.message || pe.error || 'Printer error';
          return;
        }
        var pr = await pRes.json();
        this._showPrintToast('Report printed (' + pr.labels_printed + ' labels)');
        var self = this;
        setTimeout(function () { self.closeReportsModal(); }, 2000);
      } catch (e) {
        m.error = 'Could not print report - check connection.';
      } finally {
        m.loading = false;
      }
    },

    // ══════════════════════════════════════════════════════════════
    // v2.3.0 — Worker-specific report modal
    // ══════════════════════════════════════════════════════════════

    openWorkerReportModal(workerCode, workerName) {
      var today = new Date().toISOString().substring(0, 10);
      this.workerReportModal = {
        show: true, loading: false, error: '',
        workerCode: workerCode, workerName: workerName, selectedDate: today,
      };
    },
    closeWorkerReportModal() { this.workerReportModal.show = false; },

    async printWorkerReport() {
      var m = this.workerReportModal;
      m.loading = true; m.error = '';
      try {
        // Collect this worker's items across ALL shifts for the selected date
        // (3 calls to local sync-service — offline-safe, item-wise)
        var allRows = [];
        var grandTotal = 0;
        for (var sh of ['A', 'B', 'C']) {
          try {
            var r = await this._fetchWithTimeout(
              CONFIG.syncServiceUrl + '/bags/worker-summary?date=' + m.selectedDate + '&shift=' + sh,
              {},
              5000,
            );
            if (r.ok) {
              var data = await r.json();
              var wRows = (data.rows || []).filter(function(row) { return row.worker_id === m.workerCode; });
              var wSub  = (data.worker_subtotals || []).find(function(w) { return w.worker_id === m.workerCode; });
              // Merge items: if same item appears in multiple shifts, sum them
              for (var row of wRows) {
                var existing = allRows.find(function(x) { return x.item === row.item; });
                if (existing) { existing.bags += row.bags; }
                else           { allRows.push({ item: row.item, bags: row.bags }); }
              }
              if (wSub) grandTotal += wSub.bags;
            }
          } catch (e2) { /* skip unreachable shift */ }
        }

        var report = {
          date:         m.selectedDate,
          worker_code:  m.workerCode,
          worker_name:  m.workerName,
          rows:         allRows,
          grand_total:  grandTotal,
        };

        var pRes = await this._fetchWithTimeout(
          CONFIG.printServiceUrl + '/print/report-worker',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) },
          15000,
        );
        if (!pRes.ok) {
          var pe = await pRes.json().catch(function() { return {}; });
          m.error = pe.message || pe.error || 'Printer error';
          return;
        }
        this._showPrintToast('Summary printed for ' + m.workerCode);
        var self = this;
        setTimeout(function () { self.closeWorkerReportModal(); }, 2000);
      } catch (e) {
        m.error = 'Could not print summary - check connection.';
      } finally {
        m.loading = false;
      }
    },

    // ══════════════════════════════════════════════════════════════
    // 1.1 — Pending sync badge modal (read-only, uses existing /sync/status)
    // ══════════════════════════════════════════════════════════════
    openSyncPendingModal() { this.syncPendingModal = true; },
    closeSyncPendingModal() { this.syncPendingModal = false; },

    // ══════════════════════════════════════════════════════════════
    // 3.1 — Hardware status modal (in-app overlay, auto-refresh 5s)
    // ══════════════════════════════════════════════════════════════
    async openHwModal() {
      this.hwModal = { show: true, loading: true, data: null };
      await this._fetchHwStatus();
      // Start 5s auto-refresh while open
      var self = this;
      this._hwRefreshTimerId = setInterval(function () {
        if (!self.hwModal.show) { clearInterval(self._hwRefreshTimerId); return; }
        self._fetchHwStatus();
      }, 5000);
    },

    closeHwModal() {
      this.hwModal.show = false;
      if (this._hwRefreshTimerId) { clearInterval(this._hwRefreshTimerId); this._hwRefreshTimerId = null; }
    },

    async _fetchHwStatus() {
      var self = this;
      try {
        var [systemRes, syncRes] = await Promise.allSettled([
          this._fetchWithTimeout(CONFIG.printServiceUrl + '/system/status', {}, 4000),
          this._fetchWithTimeout(CONFIG.syncServiceUrl + '/sync/status', {}, 4000),
        ]);
        var systemData = systemRes.status === 'fulfilled' ? await systemRes.value.json().catch(() => null) : null;
        var syncData   = syncRes.status   === 'fulfilled' ? await syncRes.value.json().catch(() => null)   : null;
        var now = new Date();
        self.hwModal.data = {
          checkedAt:  now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          scale: {
            state:        systemData?.scale?.state   ?? 'unknown',
            port:         systemData?.scale?.port    ?? CONFIG.syncServiceUrl.replace(':5002', ''),
            simulate:     systemData?.scale?.simulate ?? false,
          },
          printer: {
            state:        systemData?.printer?.state   ?? 'unknown',
            adapter:      systemData?.printer?.adapter ?? '',
          },
          sync: {
            health:       self.syncHealth,
            pending:      self.syncPendingCount,
            lastSyncAt:   syncData?.last_sync_at     ?? null,
            lastMasterAt: syncData?.last_master_sync_at ?? null,
            bagsToday:    syncData?.total_bags_today ?? 0,
            error:        syncData ? null : 'Sync service unreachable',
          },
          station: {
            id:         CONFIG.stationId,
            build:      (document.documentElement.innerHTML.match(/BUILD_(.+?) -->/) || ['','unknown'])[1],
            ua:         navigator.userAgent.substring(0, 80),
            screen:     screen.width + 'x' + screen.height,
            orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait',
          },
        };
      } catch (e) {
        if (self.hwModal.show) self.hwModal.data = { error: 'Failed to fetch hardware status: ' + e.message };
      } finally {
        self.hwModal.loading = false;
      }
    },

    // ══════════════════════════════════════════════════════════════
    // 5.1 — Client error logger
    // ══════════════════════════════════════════════════════════════
    logError(source, err, context) {
      var payload = {
        stationId: CONFIG.stationId,
        timestamp: new Date().toISOString(),
        level:     'error',
        source:    source,
        message:   err && err.message ? err.message : String(err),
        stack:     err && err.stack   ? err.stack   : '',
        context:   context || {},
      };
      var self = this;
      fetch('/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function () {
        // On success: flush any buffered errors
        if (self._errorBuffer.length > 0) {
          var buf = self._errorBuffer.splice(0);
          fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: buf }) })
            .catch(() => self._errorBuffer.unshift(...buf));   // re-queue on failure
        }
      }).catch(function () {
        // Buffer locally — flush on next success
        self._errorBuffer.push(payload);
        if (self._errorBuffer.length > 50) self._errorBuffer.shift();   // cap at 50
      });
    },

    // ══════════════════════════════════════════════════════════════
    // 2.1 — Audio toggle
    // ══════════════════════════════════════════════════════════════
    toggleSound() {
      this.soundEnabled = !this.soundEnabled;
      try { localStorage.setItem('soundEnabled', String(this.soundEnabled)); } catch (e) {}
      if (this.soundEnabled) this._playBeep('success');  // confirmation beep
    },

    // ══════════════════════════════════════════════════════════════
    // 2.2 — Worker shift bag counts
    // ══════════════════════════════════════════════════════════════
    // shiftKey format: "YYYY-MM-DD-A/B/C" — robust across reloads and date changes
    get currentShiftKey() {
      var h = new Date().getHours();
      var shift = h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'C';
      var d = new Date();
      if (h < 6) { d.setDate(d.getDate() - 1); }   // Shift C after midnight → yesterday's date
      return d.toISOString().substring(0, 10) + '-' + shift;
    },

    _restoreWorkerShiftCounts() {
      try {
        var raw = JSON.parse(localStorage.getItem('workerShiftData') || 'null');
        if (raw && raw.shiftKey === this.currentShiftKey) {
          this.workerShiftCounts = raw.counts || {};
        } else {
          // Shift changed (or fresh install) — start fresh
          this.workerShiftCounts = {};
          this._saveWorkerShiftCounts();
        }
      } catch (e) { this.workerShiftCounts = {}; }
    },

    _saveWorkerShiftCounts() {
      try {
        localStorage.setItem('workerShiftData', JSON.stringify({
          shiftKey: this.currentShiftKey,
          counts:   this.workerShiftCounts,
        }));
      } catch (e) {}
    },

    workerShiftCount(code) {
      return this.workerShiftCounts[code] || 0;
    },

    // ══════════════════════════════════════════════════════════════
    // 4.3 — Sync latency ticker (seconds since last successful push)
    // ══════════════════════════════════════════════════════════════
    _startSyncLatencyTicker() {
      var self = this;
      // Feed last_sync_at from /sync/status into _lastSyncPushAt
      this._syncLatencyTimerId = setInterval(function () {
        if (self._lastSyncPushAt) {
          self._syncLatencySec = Math.floor((Date.now() - self._lastSyncPushAt) / 1000);
        }
      }, 1000);
    },

    get syncLatencyClass() {
      var s = this._syncLatencySec;
      if (s === null || s < 5)  return 'latency-green';
      if (s < 15)               return 'latency-amber';
      return                           'latency-red';
    },

    get syncLatencyTooltip() {
      var s = this._syncLatencySec;
      return s === null ? 'Sync pending' : s + 's since last sync';
    },

    // ══════════════════════════════════════════════════════════════
    // 5.2 — Startup self-test
    // ══════════════════════════════════════════════════════════════
    async _runSelfTest() {
      var self = this;
      this.selfTest = { show: true, scale: 'checking', printer: 'checking', sync: 'checking', errors: {} };

      // Test scale — does weight service respond?
      this._fetchWithTimeout(CONFIG.weightServiceUrl + '/health', {}, 3000)
        .then(function (r) { self.selfTest.scale = r.ok ? 'pass' : 'fail'; })
        .catch(function () { self.selfTest.scale = 'fail'; self.selfTest.errors.scale = 'Weight service not reachable'; })
        .finally(function () { self._checkSelfTestDone(); });

      // Test printer — cached health
      this._fetchWithTimeout(CONFIG.printServiceUrl + '/print/health', {}, 3000)
        .then(function (r) { return r.json(); })
        .then(function (d) { self.selfTest.printer = (d.printer && d.printer.connected) ? 'pass' : 'fail'; if (self.selfTest.printer === 'fail') self.selfTest.errors.printer = 'Printer not connected'; })
        .catch(function () { self.selfTest.printer = 'fail'; self.selfTest.errors.printer = 'Print service not reachable'; })
        .finally(function () { self._checkSelfTestDone(); });

      // Test sync
      this._fetchWithTimeout(CONFIG.syncServiceUrl + '/health', {}, 3000)
        .then(function (r) { self.selfTest.sync = r.ok ? 'pass' : 'fail'; if (!r.ok) self.selfTest.errors.sync = 'Sync service error'; })
        .catch(function () { self.selfTest.sync = 'fail'; self.selfTest.errors.sync = 'Sync service not reachable'; })
        .finally(function () { self._checkSelfTestDone(); });
    },

    _checkSelfTestDone() {
      var t = this.selfTest;
      var done = ['pass','fail'].includes(t.scale) && ['pass','fail'].includes(t.printer) && ['pass','fail'].includes(t.sync);
      if (!done) return;
      var allPass = t.scale === 'pass' && t.printer === 'pass' && t.sync === 'pass';
      if (allPass) {
        // Auto-dismiss after 1 second
        var self = this;
        setTimeout(function () { self.selfTest.show = false; }, 1000);
      }
      // If any fail: keep visible, operator must tap "Continue"
    },

    dismissSelfTest() { this.selfTest.show = false; },

    _fetchWithTimeout(url, options, timeoutMs) {
      var ms = timeoutMs || CONFIG.fetchTimeoutMs;
      var controller = new AbortController();
      var timeoutId = setTimeout(function () { controller.abort(); }, ms);
      var opts = Object.assign({}, options || {}, { signal: controller.signal });
      return fetch(url, opts).finally(function () { clearTimeout(timeoutId); });
    },
  };
}
