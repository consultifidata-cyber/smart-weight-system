/* global Alpine */
/* Dispatch SPA — Phase DC
 * Auto-detects dispatch-service URL from window.location.hostname:4000
 * Works from Laptop A (localhost:4000) or Laptop B (192.168.x.x:4000)
 */

function dispatchApp() {
  return {

    // ── API base ────────────────────────────────────────────────────────────
    // Auto-detects: same hostname the user opened this page from, port 4000
    API: `http://${window.location.hostname}:4000/api/dispatch`,
    serverOk: true,    // false when dispatch-service unreachable

    // ── Navigation ──────────────────────────────────────────────────────────
    // 'list' | 'new' | 'scan'
    page: 'list',

    // ══════════════════════════════════════════════════════════════════════
    // SCREEN 1 — Dispatch List
    // ══════════════════════════════════════════════════════════════════════
    docs:          [],
    docsLoading:   false,
    _listRefreshId: null,

    // ══════════════════════════════════════════════════════════════════════
    // SCREEN 2 — New Dispatch Form
    // ══════════════════════════════════════════════════════════════════════
    parties:           [],
    partySearch:       '',
    partyDropdownOpen: false,
    formSubmitting:    false,
    form: {
      entry_date:    '',
      shift:         'A',
      truck_no:      '',
      truck_no_2:    '',        // second truck (two-lane mode)
      customer_id:   null,
      customer_name: '',
      customer_id_2:   null,
      customer_name_2: '',
      location:      '',
      delay_reason:  '',
    },

    // ══════════════════════════════════════════════════════════════════════
    // SCREEN 3 — Scanning
    // ══════════════════════════════════════════════════════════════════════
    // lanes[n] = { doc, scans[], skuSummary[], inputValue, closing, closingConfirm }
    lanes:      [],
    activeLane: 0,     // which lane has scanner focus (only one at a time)

    // Debounce: prevent double-fires from scanners
    _lastScanKey:  {},  // { `${docId}:${qr}`: timestamp }

    // Retry queue for transient network errors
    _retryQueue:   {},  // { key: { docId, qr_code, laneIdx, attempt } }
    _retryTimerId: null,

    // ──────────────────────────────────────────────────────────────────────
    // INIT
    // ──────────────────────────────────────────────────────────────────────
    init() {
      this.form.entry_date = new Date().toISOString().substring(0, 10);
      this.loadDocs();
      this.loadParties();
      this._startListRefresh();
    },

    destroy() {
      clearInterval(this._listRefreshId);
      clearInterval(this._retryTimerId);
    },

    // ──────────────────────────────────────────────────────────────────────
    // SERVER CONNECTIVITY
    // ──────────────────────────────────────────────────────────────────────
    async checkServer() {
      try {
        const r = await fetch(this.API.replace('/api/dispatch', '/health'), { signal: AbortSignal.timeout(3000) });
        this.serverOk = r.ok;
      } catch { this.serverOk = false; }
    },

    async retryServer() {
      await this.checkServer();
      if (this.serverOk) this.loadDocs();
    },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 1 — LIST
    // ──────────────────────────────────────────────────────────────────────
    async loadDocs() {
      if (this.docsLoading) return;
      this.docsLoading = true;
      try {
        const r = await fetch(`${this.API}/docs`, { signal: AbortSignal.timeout(4000) });
        const d = await r.json();
        if (d.ok) { this.docs = d.docs; this.serverOk = true; }
      } catch { this.serverOk = false; }
      finally  { this.docsLoading = false; }
    },

    _startListRefresh() {
      clearInterval(this._listRefreshId);
      this._listRefreshId = setInterval(() => {
        if (this.page === 'list') this.loadDocs();
      }, 5000);
    },

    openDoc(doc) {
      if (doc.status === 'DRAFT') {
        this._openScanScreen([doc.doc_id]);
      } else {
        this._openScanScreen([doc.doc_id]);  // read-only view uses same screen
      }
    },

    goNew() {
      this.form.entry_date    = new Date().toISOString().substring(0, 10);
      this.form.shift         = 'A';
      this.form.truck_no      = '';
      this.form.truck_no_2    = '';
      this.form.customer_id   = null;
      this.form.customer_name = '';
      this.form.customer_id_2   = null;
      this.form.customer_name_2 = '';
      this.form.location      = '';
      this.form.delay_reason  = '';
      this.partySearch        = '';
      this.page               = 'new';
    },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 2 — PARTIES DROPDOWN
    // ──────────────────────────────────────────────────────────────────────
    async loadParties() {
      try {
        const r = await fetch(`${this.API}/parties`, { signal: AbortSignal.timeout(4000) });
        const d = await r.json();
        if (d.ok) this.parties = d.parties;
      } catch { /* keep empty — fall back to manual entry */ }
    },

    get filteredParties() {
      const q = this.partySearch.toLowerCase();
      if (!q) return this.parties.slice(0, 20);
      return this.parties.filter(p =>
        p.party_name.toLowerCase().includes(q) ||
        (p.party_code || '').toLowerCase().includes(q)
      ).slice(0, 20);
    },

    selectParty(p, lane) {
      if (lane === 2) {
        this.form.customer_id_2   = p.party_id;
        this.form.customer_name_2 = p.party_name;
      } else {
        this.form.customer_id   = p.party_id;
        this.form.customer_name = p.party_name;
        this.partySearch        = p.party_name;
      }
      this.partyDropdownOpen = false;
    },

    useManualName(lane) {
      if (lane === 2) {
        this.form.customer_name_2 = this.partySearch;
        this.form.customer_id_2   = null;
      } else {
        this.form.customer_name = this.partySearch;
        this.form.customer_id   = null;
      }
      this.partyDropdownOpen = false;
    },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 2 — FORM SUBMIT
    // ──────────────────────────────────────────────────────────────────────
    async startDispatch(twoLanes) {
      if (this.formSubmitting) return;
      if (!this.form.truck_no.trim()) { alert('Truck No is required'); return; }
      if (!this.form.customer_name.trim()) { alert('Customer is required'); return; }
      if (twoLanes && !this.form.truck_no_2.trim()) { alert('Truck No 2 is required'); return; }

      this.formSubmitting = true;
      try {
        const docIds = [];

        // Create first dispatch doc
        const r1 = await fetch(`${this.API}/docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entry_date:    this.form.entry_date,
            truck_no:      this.form.truck_no.toUpperCase(),
            customer_id:   this.form.customer_id,
            customer_name: this.form.customer_name,
            location:      this.form.location || null,
            shift_id:      this.form.shift,
            delay_reason:  this.form.delay_reason || null,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const d1 = await r1.json();
        if (!d1.ok) throw new Error(d1.error || 'Failed to create dispatch');
        docIds.push(d1.doc_id);

        // Create second doc if two-lane
        if (twoLanes) {
          const r2 = await fetch(`${this.API}/docs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              entry_date:    this.form.entry_date,
              truck_no:      this.form.truck_no_2.toUpperCase(),
              customer_id:   this.form.customer_id_2,
              customer_name: this.form.customer_name_2 || this.form.customer_name,
              location:      this.form.location || null,
              shift_id:      this.form.shift,
              delay_reason:  this.form.delay_reason || null,
            }),
            signal: AbortSignal.timeout(8000),
          });
          const d2 = await r2.json();
          if (!d2.ok) throw new Error(d2.error || 'Failed to create second dispatch');
          docIds.push(d2.doc_id);
        }

        await this._openScanScreen(docIds);

      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        this.formSubmitting = false;
      }
    },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 3 — SCAN SCREEN SETUP
    // ──────────────────────────────────────────────────────────────────────
    async _openScanScreen(docIds) {
      this.lanes = [];
      for (const id of docIds) {
        const r = await fetch(`${this.API}/docs/${id}`, { signal: AbortSignal.timeout(4000) });
        const d = await r.json();
        if (d.ok) {
          this.lanes.push({
            doc:            d.doc,
            scans:          d.lines || [],
            skuSummary:     d.summary || [],
            inputValue:     '',
            closing:        false,
            closingConfirm: false,
          });
        }
      }
      this.activeLane = 0;
      this.page       = 'scan';

      // Auto-focus first lane input after render
      setTimeout(() => { this._focusLane(0); }, 100);

      // Start scan-screen refresh
      clearInterval(this._scanListRefreshId);
      this._scanListRefreshId = setInterval(() => this._refreshScanDocs(), 8000);
    },

    async _refreshScanDocs() {
      for (let i = 0; i < this.lanes.length; i++) {
        try {
          const r = await fetch(`${this.API}/docs/${this.lanes[i].doc.doc_id}`, { signal: AbortSignal.timeout(3000) });
          const d = await r.json();
          if (d.ok) {
            this.lanes[i].doc        = d.doc;
            this.lanes[i].skuSummary = d.summary;
            // Only update scans if we have no local pending items
            if (!Object.values(this._retryQueue).some(item => item.laneIdx === i)) {
              this.lanes[i].scans = d.lines;
            }
          }
        } catch { /* best effort */ }
      }
    },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 3 — FOCUS MANAGEMENT
    // ──────────────────────────────────────────────────────────────────────
    _focusLane(idx) {
      this.activeLane = idx;
      const el = document.getElementById(`scan-input-${idx}`);
      if (el) el.focus();
    },

    tapToFocus(idx) { this._focusLane(idx); },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 3 — SCANNER INPUT HANDLER
    // ──────────────────────────────────────────────────────────────────────
    onScanKey(event, laneIdx) {
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const qr = (this.lanes[laneIdx]?.inputValue || '').trim().toUpperCase();
        this.lanes[laneIdx].inputValue = '';
        if (qr.length > 2) this._processScan(qr, laneIdx);
        // Keep focus in this lane
        setTimeout(() => { this._focusLane(laneIdx); }, 30);
      }
    },

    async _processScan(qrCode, laneIdx) {
      const lane = this.lanes[laneIdx];
      if (!lane) return;

      // Debounce — ignore if same QR scanned within 200ms (scanner double-fire)
      const key = `${lane.doc.doc_id}:${qrCode}`;
      const now = Date.now();
      if (now - (this._lastScanKey[key] || 0) < 200) return;
      this._lastScanKey[key] = now;

      // Add optimistic "scanning" item to top of list
      const tempId = `temp-${Date.now()}`;
      lane.scans.unshift({ _tempId: tempId, qr_code: qrCode, status: 'SCANNING', color: 'scanning', scanned_at: new Date().toISOString() });

      try {
        const r = await fetch(`${this.API}/docs/${lane.doc.doc_id}/scan`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ qr_code: qrCode }),
          signal:  AbortSignal.timeout(5000),
        });
        const d = await r.json();

        // Replace temp item with real result
        const idx = lane.scans.findIndex(s => s._tempId === tempId);
        if (idx >= 0) {
          lane.scans[idx] = {
            qr_code:          qrCode,
            pack_name:        d.bag?.pack_name || null,
            actual_weight_gm: d.bag?.actual_weight_gm || null,
            color:            d.color,
            result:           d.result,
            message:          d.message,
            scanned_at:       new Date().toISOString(),
          };
        }

        // Update live totals
        if (d.result === 'SUCCESS' || d.result === 'EXTERNAL') {
          lane.doc.total_bags      = (lane.doc.total_bags || 0) + 1;
          lane.doc.total_weight_gm = (lane.doc.total_weight_gm || 0) + (d.bag?.actual_weight_gm || 0);
          this._updateSkuSummary(lane, d.bag?.pack_name || 'Unknown', d.bag?.actual_weight_gm || 0);
        }

        this._playBeep(d.color);

      } catch (err) {
        // Network error — update temp item + add to retry queue
        const idx = lane.scans.findIndex(s => s._tempId === tempId);
        if (idx >= 0) {
          lane.scans[idx] = { qr_code: qrCode, color: 'retry', message: 'Network error — retrying...', scanned_at: new Date().toISOString() };
        }
        this._retryQueue[key] = { docId: lane.doc.doc_id, qr_code: qrCode, laneIdx, attempt: 0, tempId };
        this._startRetryLoop();
      }
    },

    _updateSkuSummary(lane, packName, weightGm) {
      const existing = lane.skuSummary.find(s => s.pack_name === packName);
      if (existing) {
        existing.bag_count++;
        existing.total_weight_gm = (existing.total_weight_gm || 0) + weightGm;
      } else {
        lane.skuSummary.push({ pack_name: packName, bag_count: 1, total_weight_gm: weightGm });
      }
    },

    // ──────────────────────────────────────────────────────────────────────
    // RETRY QUEUE
    // ──────────────────────────────────────────────────────────────────────
    _startRetryLoop() {
      if (this._retryTimerId) return;
      this._retryTimerId = setInterval(async () => {
        const keys = Object.keys(this._retryQueue);
        if (keys.length === 0) {
          clearInterval(this._retryTimerId);
          this._retryTimerId = null;
          return;
        }
        for (const key of keys) {
          const item = this._retryQueue[key];
          item.attempt++;
          try {
            const r = await fetch(`${this.API}/docs/${item.docId}/scan`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ qr_code: item.qr_code }),
              signal:  AbortSignal.timeout(4000),
            });
            const d = await r.json();
            // Success — update scan item and remove from queue
            const lane = this.lanes[item.laneIdx];
            if (lane) {
              const idx = lane.scans.findIndex(s => s.qr_code === item.qr_code && s.color === 'retry');
              if (idx >= 0) {
                lane.scans[idx] = { qr_code: item.qr_code, pack_name: d.bag?.pack_name, color: d.color, result: d.result, message: d.message, scanned_at: new Date().toISOString() };
                if (d.result === 'SUCCESS' || d.result === 'EXTERNAL') {
                  lane.doc.total_bags = (lane.doc.total_bags || 0) + 1;
                  lane.doc.total_weight_gm = (lane.doc.total_weight_gm || 0) + (d.bag?.actual_weight_gm || 0);
                }
              }
            }
            delete this._retryQueue[key];
          } catch { /* keep retrying */ }
        }
      }, 3000);
    },

    get pendingRetryCount() {
      return Object.keys(this._retryQueue).length;
    },

    // ──────────────────────────────────────────────────────────────────────
    // SCREEN 3 — CLOSE DISPATCH
    // ──────────────────────────────────────────────────────────────────────
    confirmClose(laneIdx) {
      this.lanes[laneIdx].closingConfirm = true;
    },

    cancelClose(laneIdx) {
      this.lanes[laneIdx].closingConfirm = false;
    },

    async closeDispatch(laneIdx) {
      const lane = this.lanes[laneIdx];
      if (!lane) return;
      lane.closing = true;
      lane.closingConfirm = false;

      try {
        const r = await fetch(`${this.API}/docs/${lane.doc.doc_id}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
        const d = await r.json();
        if (!d.ok) { alert(d.error || 'Could not close dispatch'); lane.closing = false; return; }

        // Remove closed lane; if both lanes closed, go back to list
        this.lanes.splice(laneIdx, 1);
        if (this.lanes.length === 0) {
          clearInterval(this._scanListRefreshId);
          await this.loadDocs();
          this.page = 'list';
          this._toast = `Dispatch closed — queued for sync`;
          setTimeout(() => { this._toast = ''; }, 4000);
        } else {
          this.activeLane = 0;
          setTimeout(() => { this._focusLane(0); }, 100);
        }
      } catch (e) {
        alert('Network error: ' + e.message);
        lane.closing = false;
      }
    },

    goBackToList() {
      if (this.pendingRetryCount > 0) {
        if (!confirm(`You have ${this.pendingRetryCount} pending scan(s) that haven't reached the server yet. Leave anyway?`)) return;
      }
      clearInterval(this._scanListRefreshId);
      this.loadDocs();
      this.page = 'list';
    },

    // ──────────────────────────────────────────────────────────────────────
    // DISPLAY HELPERS
    // ──────────────────────────────────────────────────────────────────────
    _toast: '',

    statusBadgeClass(status) {
      return {
        'badge-draft':    status === 'DRAFT',
        'badge-closed':   status === 'CLOSED',
        'badge-declined': status === 'DECLINED',
      };
    },

    syncBadgeClass(sync_status) {
      return {
        'sync-local':    sync_status === 'LOCAL',
        'sync-pending':  sync_status === 'PENDING',
        'sync-synced':   sync_status === 'SYNCED',
        'sync-failed':   sync_status === 'FAILED',
      };
    },

    formatWeight(gm) {
      if (!gm) return '0.0 kg';
      return (gm / 1000).toFixed(2) + ' kg';
    },

    formatDate(iso) {
      if (!iso) return '';
      return iso.substring(0, 10);
    },

    formatTime(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    },

    scanResultIcon(color) {
      return { green: '✓', yellow: '⚠', red: '✗', orange: '⚡', retry: '↻', scanning: '…' }[color] || '?';
    },

    get filteredPartiesForDropdown() {
      return this.filteredParties;
    },

    // ──────────────────────────────────────────────────────────────────────
    // AUDIO FEEDBACK
    // ──────────────────────────────────────────────────────────────────────
    _playBeep(color) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx  = new AudioCtx();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (color === 'green') {
          osc.frequency.setValueAtTime(880,  ctx.currentTime);
          osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.08);
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
          osc.start(); osc.stop(ctx.currentTime + 0.25);
        } else if (color === 'red') {
          osc.frequency.setValueAtTime(300,  ctx.currentTime);
          osc.frequency.setValueAtTime(180,  ctx.currentTime + 0.15);
          gain.gain.setValueAtTime(0.3, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          osc.start(); osc.stop(ctx.currentTime + 0.5);
        } else {
          // yellow / orange — soft tick
          osc.frequency.value = 440;
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
          osc.start(); osc.stop(ctx.currentTime + 0.1);
        }
      } catch { /* audio blocked or unavailable */ }
    },
  };
}
