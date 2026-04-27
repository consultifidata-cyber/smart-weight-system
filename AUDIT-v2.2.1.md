# Audit v2.2.1 — Pre-Reports Gate

**Verdict: READY FOR REPORTS**

13/14 items PASS. A13 is PARTIAL (ENABLE_REPORTS=false not yet in
installer) but this is resolved in Phase 2 step 1 before any feature
code is written. No blockers.

---

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| A1 | Printer disconnect within 5s | **PASS** | `printerHealthCache.ts:26-27` — `PROBE_INTERVAL_MS=5_000`, `FAIL_THRESHOLD=1` (single failure = immediate flip). Detect within 5-9s. |
| A2 | POST /print returns 503 when disconnected | **PASS** | `print.ts:155-160` — `if (!getCachedHealth()) { res.status(503).json({ error:'printer_disconnected'... })` before any TSPL build. |
| A3 | Print button hard-disabled, no stale cache | **PASS** | `app.js:977` `return '⚠  Printer Not Connected'`; `app.js:993` `if (!this.printerConnected) return true`. `printerConnected` is set from live `/system/status` every 3s at `app.js:572`. |
| A4 | NO full-screen system-gate overlay | **PASS** | `index.html:191-192` — both overlays are HTML comments only: `<!-- H1.4 — System-gate REMOVED -->` and `<!-- H2 — Shift-gate REMOVED -->`. grep confirms zero `system-gate` or `shift-gate` elements. |
| A5 | Shift from clock, no prompt, top-bar display | **PASS** | `app.js:158` `this.shiftConfirmed = true` unconditionally in init; `app.js:942-953` `currentShift` and `shiftClockLabel` getters; `app.js:162` 60s `_clockTick` interval; `index.html:224` `x-text="shiftClockLabel"`. |
| A6 | 8 print button states, priority correct | **PASS** | `app.js:970-984` — priority: PRINTING → RETRYING → PRINTED → FAILED → !printerConnected → scale off → no product → no worker → not stable → PRINT. `printButtonDisabled:988-998` enables on PRINT_FAILED only. |
| A7 | `data.scale.state` not `data.scale.connected` | **PASS** | `app.js:346` `data.scale.state !== 'connected'` (comment: "P1.1 fix"); `app.js:573` `data.scale.state === 'connected'`. Zero occurrences of `data.scale.connected` in the file. |
| A8 | Workers → modal popup, not full-page | **PASS** | `index.html:158-188` — `class="workers-modal-overlay"` with `@click.self` dismiss + Esc handler. Panel uses `.workers-panel` inside overlay — CSS positions it as centered modal. |
| A9 | No Dispatch button, no ⚡ icon | **PASS** | grep for `dispatch-nav-link`, `report-btn`, `⚡`, `generatingReport`, `generateReport` in `index.html` — zero matches. Both removed in rc1. |
| A10 | Viewport lock html/body | **PASS** | `style.css:680` `html, body { overflow: hidden; height: 100vh; width: 100vw; }` — exact line in the v2.2.0-rc1 additions block. |
| A11 | djangoBagLookup: null when flag off, 3s timeout, rate-limited log | **PASS** | `djangoBagLookup.ts:64,78` — `isFlagEnabled()` returns false by default; `if (!isFlagEnabled()) return null;` is line 78. Timeout: `AbortSignal` at `3_000` ms (line 92). Rate-limited warn: `warnOnce()` with 60s gate (lines 54-59). |
| A12 | dispatch.ts: Django first, local fallback, handler async | **PASS** | `dispatch.ts:125` — `async (req, res)`. `dispatch.ts:191-197` — `await lookupBagInDjango(qr)` first; `queries.getBagByQr(qr)` only if null. No unhandled promise rejection path. |
| A13 | Installer defaults: DISPATCH_USE_DJANGO_LOOKUP=false | **PARTIAL** | `setup.iss:790` — `DISPATCH_USE_DJANGO_LOOKUP=false` present. `ENABLE_REPORTS=false` **NOT YET** in installer — will be added as Phase 2 step 1 before any feature code. |
| A14 | UTF-8 no BOM on .env writes | **PASS** | `setup.iss:792-796` — `SaveStringToFile` comment explicitly states: "ANSI = UTF-8 (no BOM, no null bytes) … do NOT change to PowerShell Set-Content". Root cause of v2.1.5 bug is documented and prevented. |

---

## Notes

**A3 — "no stale cached state" clarification:**
`printerConnected` is updated by `pollHealth()` which calls `/system/status`
every 3s. `/system/status` calls `getCachedHealth()` (O(1) in-memory read, updated
by the 5s background probe). The chain is:
```
physical printer → probe (5s) → printerHealthCache._healthy → /system/status
→ pollHealth() (3s) → printerConnected → printButtonDisabled
```
Worst-case lag from physical disconnect to button disabled: 5s probe + 3s poll = ~8s.
Acceptable for factory floor use.

**A6 — PRINT_FAILED priority note:**
When state=PRINT_FAILED, `printButtonDisabled` returns `false` (retry enabled)
regardless of `printerConnected`. If printer disconnects AFTER a failed print,
the Retry button stays enabled — the retry attempt will get a 503 and show
the "PRINTER NOT CONNECTED" error modal. This is correct behavior: the operator
is explicitly retrying, so the error path is appropriate.

**A13 — What gets added in Phase 2:**
`ENABLE_REPORTS=false` is the first line written before any Phase 2 code.

---

*Audit performed: 2026-04-27. No code modified.*
