# Hardware Detection Robustness Audit — v2.3.0-rc1

## VERDICT

**B) SHIP WITH CAVEATS**

Hardware detection is substantially more robust than a typical factory-floor
system. The scale has two independent auto-recovery layers. The printer is
transparent to USB port changes. The one meaningful caveat: if the SCALE's
COM port number changes (possible but unlikely for the user's specific FTDI
adapter), recovery is automatic but takes ~20 seconds and the .env is not
updated — so every subsequent restart goes through that same 20-second
recovery window. This should be communicated to the user so they understand
"briefly shows disconnected on reboot" is normal, not broken.

**Give workers the specific instructions in Section 4. Run the test plan in
Section 5 on each laptop before handing off.**

---

## Section 1 — Scale / Serial Port

### Q1.1 — How does weight-service determine which COM port to open?

**File:** `weight-service/src/config.ts:17`
```typescript
port: process.env.SERIAL_PORT || (process.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0'),
```

**File:** `weight-service/src/index.ts:30-67`

Three startup paths depending on env vars:

1. `SIMULATE_SERIAL=true` → uses a virtual port (dev only)
2. `SCALE_AUTO_DETECT=true` AND `SERIAL_PORT` is **not** set → calls `detectScales()` at startup, uses the port it finds
3. `SCALE_AUTO_DETECT=true` AND `SERIAL_PORT` IS set → uses configured port; logs detected candidates informational only
4. `SCALE_AUTO_DETECT=false` (production default) → uses `SERIAL_PORT` value directly

The user's `.env` has `SERIAL_PORT=COM5` and `SCALE_AUTO_DETECT=false`, so path 4.
`WeightReader` is constructed with `COM5` as the configured port.

### Q1.2 — What happens when USB-serial adapter moves to a different USB port?

**This depends critically on the adapter chipset.**

The user's adapter is `VID_0403/PID_6015` (FTDI FT230X series).

**FTDI official driver behaviour:** FTDI's Windows driver tracks adapters by
USB serial number (stamped in adapter EEPROM). When the adapter is plugged into
a different USB port, Windows matches the serial number to the existing COM port
assignment and **keeps the same COM number** (e.g., COM5 stays COM5). This is
reliable for genuine FTDI chips.

**Exception:** cheap FTDI clones (`VID_0403` but manufactured by a third party)
sometimes lack a serial number. In that case Windows assigns based on USB
location (physical port), and moving to a different port WILL get a new COM
number (e.g., COM5 → COM7).

**Practical answer for this deployment:** almost certainly COM5 will survive a
port move, but there is no guarantee. The code handles the fallback case (see Q1.3).

### Q1.3 — If COM port number changes, does weight-service detect it?

**Yes — automatically, two layers:**

**Layer 1 — Runtime auto-detect after 3 failures:**
`weight-service/src/serial/reader.ts:200-209`

```typescript
if (this.reconnectAttempts === AUTO_DETECT_AFTER_ATTEMPTS && !this.autoDetectDone && !this.binding) {
  this.autoDetectDone = true;
  const detected = await this._autoDetectPort();
  if (detected) { return; }
}
```

`AUTO_DETECT_AFTER_ATTEMPTS = 3` (line 12). After 3 consecutive failures to
open the configured port, `_autoDetectPort()` runs automatically regardless of
`SCALE_AUTO_DETECT` env value.

**Layer 2 — `_autoDetectPort()` scanning:**
`reader.ts:237-301`

Calls `SerialPort.list()`, filters candidates by known manufacturers:
```typescript
const KNOWN_MANUFACTURERS = ['ftdi', 'prolific', 'ch340', 'wch', 'silicon labs', 'qinheng'];
```

**FTDI (`VID_0403`) IS in this list.** So the auto-detect will find the adapter
on its new COM port, try opening it, and succeed. Log line:
`"Auto-detected serial port — connection successful"`

**Critical note:** `_autoDetectPort()` updates `this.serialConfig.port` in
memory but does **not** update the `.env` file. The next service restart still
reads COM5, tries 3 times, then auto-detects again. This is by design — the
service recovers automatically every time, but is slightly slower on each
restart (~20 seconds for 3 retries + detection) until the `.env` is manually
updated.

**What `SCALE_AUTO_DETECT=true` adds:**
It runs `detectScales()` at startup BEFORE the first connect attempt, using a
different higher-quality detection engine (`scaleDetect.ts`). This means on a
fresh start with the right port, it connects immediately rather than using the
3-failure-then-detect path. For the current setup with `SCALE_AUTO_DETECT=false`,
the 3-failure-then-detect path handles everything — just slightly more delay.

**Recommendation for hardening:** change `.env` to `SCALE_AUTO_DETECT=true`
with `SERIAL_PORT=COM5`. This gets the best of both: tries COM5 first (instant
connect), logs all detected candidates for diagnostic clarity, and auto-detects
if COM5 fails.

### Q1.4 — Unplug and replug into SAME port — auto-recovery?

**Yes. Fully automatic. No user action needed.**

`reader.ts:318-330` — `_onClose()` handler:
```typescript
private _onClose(): void {
  this._stopNoDataWatchdog();
  logger.warn('Serial port closed');
  this.emit('close');
  if (!this.closing) {
    this.reconnectAttempts = 0;
    this.lastLogAt = 0;
    this.autoDetectDone = false;   // ← resets so auto-detect can run again
    logger.info('Attempting reconnection...');
    this.openWithRetry().catch(() => {});
  }
}
```

When the USB is pulled, the OS closes the port → `_onClose()` fires immediately →
`openWithRetry()` starts with infinite retry and exponential backoff (3s, 6s,
12s, max 30s per attempt).

When the USB is replugged into the same port, the next `openWithRetry()` attempt
succeeds → port opens → weights flow again. **Recovery is transparent to the
operator; the scale indicator turns green again within ~5 seconds of replug.**

**Also:** the no-data watchdog (`SCALE_NO_DATA_TIMEOUT_MS=15000`) catches the
case where the port stays "open" but data stops (e.g., USB Selective Suspend).
After 15 seconds of silence, it force-closes the port → triggers the same
reconnect path. `reader.ts:151-172`.

### Q1.5 — What does the UI show during unplug → replug?

The UI reads from `GET /system/status` (print-service, port 5001) every 3
seconds. That endpoint calls `GET weight-service/health` which reads
`weightReader.isConnected`. So:

- Unplug → `isConnected = false` → within 3s, UI scale pill turns RED
- Pill text: `"DISCONNECTED · 30s"` then counts down (rc1.1 `_startCountdown`)
- Print button shows `"⚠ Scale Not Connected"` and is disabled

When replugged and `openWithRetry` succeeds → `isConnected = true` → within 3s,
UI scale pill turns GREEN, countdown stops, print button re-enables.

**The 3s poll means worst-case 3s visual lag, best-case near-instant.
This is correct and matches what rc1.1 was designed to do.**

---

## Section 2 — Printer / Windows Spooler

### Q2.1 — How does print-service identify the printer?

`print-service/src/hardware/hardwareManager.ts:61-74`

```typescript
async function checkWindowsHealth(printerName: string): Promise<boolean> {
  const { stdout } = await execAsync(
    `powershell -Command "(Get-Printer -Name '${safeN}').PrinterStatus"`,
    { timeout: 3000 },
  );
  const s = stdout.trim();
  return s === 'Normal' || s === 'Idle' || s === 'Ready' || s === 'Printing';
}
```

The printer is identified by `PRINTER_NAME` from `.env` (currently `"SNBC TVSE LP 46 NEO BPLE"`).
Print jobs go via `PRINTER_DEVICE` (share name `"TVSLP46NEO"`) using `copy /b` to
`\\localhost\TVSLP46NEO`.

### Q2.2 — If user moves printer USB to different physical port?

**Windows keeps the same printer name. Transparent.**

Windows registers a printer in the spooler by name and share name. These are
stored in the registry (`HKLM\SYSTEM\CurrentControlSet\Control\Print\Printers`),
not tied to a USB physical port. Moving the USB cable to a different port
re-enumerates the USB device but the spooler entry is unchanged.

**Exception:** if the printer appears as a "new" device (rare — only if the USB
connection had previously corrupted the driver state), Windows might create
a duplicate `"SNBC TVSE LP 46 NEO BPLE (Copy 1)"`. In practice this almost
never happens for a stable USB spooler printer.

**Bottom line:** printer USB port changes are fully transparent. No code change,
no `.env` edit, no restart needed.

### Q2.3 — Does print-service detect printer-name mismatches?

If `PRINTER_NAME` in `.env` points to a printer that doesn't exist:

- `checkWindowsHealth("wrong name")` → PowerShell returns empty stdout or error → returns `false`
- Background probe every 5s → `getCachedHealth() = false` → `/system/status` returns `printer.state = "disconnected"`
- UI shows `"⚠ Printer Not Connected"` and print button disabled

**The log line** `hardwareManager.ts:86`:
```
"Windows printer "SNBC TVSE LP 46 NEO BPLE" not found or not responding."
```

This is clear and actionable.

**No auto-discovery for printers.** Print-service does not scan the spooler for
a printer matching a pattern. It requires the exact `PRINTER_NAME` in `.env`.
If the name ever changes (e.g., duplicate printer entry created), the operator
must update `.env` manually.

### Q2.4 — Heartbeat verification

`printerHealthCache.ts:26-28` (set in v2.1.5):
```typescript
const PROBE_INTERVAL_MS = 5_000;   // every 5 seconds
const FAIL_THRESHOLD    = 1;        // single failure = immediate disconnect
const PROBE_TIMEOUT_MS  = 4_000;   // probe timeout < interval
```

The probe calls `driver.healthCheck(4000)` → `healthCheckWin(4000)` → PowerShell
`Get-Printer` with 4s timeout. `getCachedHealth()` is the O(1) read used by
`/system/status` and `/print/print`. The response shape is:

```json
{"healthy": true, "printer": {"state": "connected"}, "scale": {"state": "connected"}}
```

Verified: `systemStatus.ts` reads `getCachedHealth()` directly.

### Q2.5 — Print-during-disconnect: is the check live or cached?

`print.ts:155-161` (H1.2 from rc1.1):
```typescript
if (!getCachedHealth()) {
  res.status(503).json({
    status: 'error',
    error: 'printer_disconnected',
    message: 'Printer is not connected. Check USB cable.',
  });
  return;
}
```

`getCachedHealth()` reads `_healthy` which is updated by the background probe
every 5 seconds. So the check is "live within 5 seconds" — not instantaneous
but not stale-cached-forever. **Worst case: operator unplugs printer, immediately
tries to print, and the first attempt gets through before the probe detects the
disconnect (0–5s window). The print command will then fail at `driver.send()` and
return 503 from the catch block. So the user sees an error either way — just
from a different code path in that rare window.**

---

## Section 3 — Power / Reboot / Sleep

### Q3.1 — Service auto-start

`installer/tools/install-service.ps1:252`:
```powershell
& $NssmPath set $ServiceName Start 'SERVICE_AUTO_START'
```

NSSM registers `SmartWeightSystem` as **Automatic start**. No delay configured.
On Windows boot, the service starts in the boot phase (before user login).

**NSSM restart policy** (install-service.ps1):
- `AppExit Default Restart` — restarts on any exit
- `AppRestartDelay 3000` — 3s before NSSM restarts the launcher
- `AppThrottle 60000` — if launcher exits within 60s, wait before next restart

### Q3.2 — Boot ordering: hardware vs. service start

Windows USB enumeration takes 10–30 seconds after power-on. The NSSM service
starts immediately — well before USB devices appear. This is handled correctly:

- **weight-service**: `openWithRetry()` is an infinite retry loop. On boot,
  COM5 doesn't exist yet → first few attempts fail → scale appears a few seconds
  later → next attempt succeeds. **No manual action needed.**

- **print-service**: background probe starts with `_healthy = true` (optimistic
  default). First real probe fires 5s after startup. On boot the printer may not
  yet be registered with the spooler → probe returns false → `_healthy = false`.
  When spooler finishes (usually 5–15s), next probe succeeds. **Print button
  shows "Printer Not Connected" for ~10-20s after boot, then turns green.**

- **sync-service**: connects to Django over internet. On boot, network interface
  takes ~5-10s to initialize. sync-service retries with backoff. No user action.

**User-visible boot sequence (approximate):**
```
0s:   Power on
15s:  Windows shows login screen / desktop
20s:  SmartWeightSystem service starts (NSSM)
25s:  Weight service opens port → scale reading appears
30s:  Print service probe → printer shows green
60s:  Sync service connects Django → products/workers load
```

**The system is fully operational within 60-90 seconds of power-on.**
No manual intervention needed.

### Q3.3 — Sleep / hibernate

When Windows wakes from sleep:
- USB devices re-enumerate (takes 5–15 seconds)
- COM port for scale: re-appears at same number → weight-service watchdog
  fires within 15s if no data → force-close → reconnect → back online in ~20s
- Printer: spooler re-registers the printer → print-service probe detects within 5s
- Network: re-connects automatically → sync resumes

**Sleep behaviour is handled entirely by existing watchdogs and retry loops.**
No user action required. The "DISCONNECTED · countdown" in the UI will appear
briefly after wake, then clear.

### Q3.4 — Recommended Windows power settings for factory production

Tell the user to check each laptop before handing to workers:

**Critical settings (Settings → System → Power & sleep):**

| Setting | Recommended value | Why |
|---------|-------------------|-----|
| Screen timeout (battery) | 15–30 min or Never | Operators glance at screen |
| Screen timeout (plugged in) | Never | Station is always plugged in |
| Sleep (plugged in) | **Never** | Sleep causes 20-30s recovery on wake |
| Sleep (battery) | 5–10 min | Acceptable if unplugged briefly |
| Fast startup | **Disabled** | Fast startup uses hibernate, can confuse USB drivers |
| USB selective suspend | **Disabled** | Already patched by installer via registry, but verify |

**To disable Fast Startup:**
```
Control Panel → Power Options → Choose what the power buttons do
→ Turn on fast startup → UNCHECK → Save changes
```

**To verify USB Selective Suspend is disabled** (installer already sets this):
```powershell
# Should return 0 for all adapters
Get-PnpDevice | Where-Object {$_.InstanceId -match 'VID_0403'} | ForEach-Object {
    Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Enum\$($_.InstanceId)\Device Parameters" -Name SelectiveSuspend -EA SilentlyContinue
}
```

---

## Section 4 — Defensive Fallbacks Assessment

### Q4.1 — Scale auto-discovery: exists and works

**Two-layer system already exists:**

**Layer A (startup):** `SCALE_AUTO_DETECT=true` without `SERIAL_PORT` →
`detectScales()` in `scaleDetect.ts` runs, returns ranked candidates by VID
match, picks highest-confidence. Used before first connect attempt.

**Layer B (runtime):** After 3 consecutive port-open failures, `_autoDetectPort()`
in `reader.ts` runs automatically regardless of env settings. Scans `SerialPort.list()`,
filters by known manufacturer list (includes FTDI/Prolific/CH340), tries each.
Resets on every disconnect so it always gets another chance.

**Cost to improve:** The one gap is that successful auto-detection doesn't update
the `.env`. Fixing this would require the weight-service to write back to the
`.env` file — which is an unusual pattern and carries risk (concurrent writes,
encoding issues). The current "detect and hold in memory until restart" approach
is safer. **No code change recommended.**

### Q4.2 — Printer auto-discovery: does NOT exist

Print-service has `PRINTER_AUTO_DETECT` env var and `printerAutoDetect` config
flag, but in WINDOWS mode (the user's setup) it is not used. The health check
always queries by the exact `PRINTER_NAME` string.

**What would it cost to add:**
Modify `checkWindowsHealth()` to:
1. If `Get-Printer -Name 'exact_name'` fails
2. Try `Get-Printer | Where-Object { $_.Name -match 'SNBC|TVSE' } | Select-Object -First 1`
3. If found, use that name and log a warning

**Estimate:** ~20 lines in `hardwareManager.ts`. Low risk. But given that
Windows printer names survive port changes, the current setup is already robust.
The only scenario this would help is if someone accidentally installs a second
copy of the printer. **Not recommended for tonight — add if that situation arises.**

### Q4.3 — Self-healing log visibility

The following log lines give a clear post-shift audit trail:

| Event | Log level | Message |
|-------|-----------|---------|
| Scale disconnects | warn | `"Serial port closed"` |
| Scale reconnects | info | `"Serial port opened"` |
| Scale port changes | info | `"Auto-detected serial port — connection successful"` |
| Scale data freeze (watchdog) | warn | `"[watchdog] No scale data received — forcing port reconnect"` |
| Printer goes offline | warn (1x/60s) | background probe silently updates cache |
| Printer recovers | info | `"Printer recovered"` |
| Print rejected (disconnected) | warn | `"Pre-flight: printer_disconnected → 503"` |

**To check post-shift:**
```powershell
Get-Content C:\SmartWeightSystem\logs\weight-service-out.log | Select-String "Auto-detected|reconnect|watchdog|closed|opened"
Get-Content C:\SmartWeightSystem\logs\print-service-out.log | Select-String "recovered|unavailable|disconnected"
```

---

## Section 5 — Pre-Production Test Plan

Run this on each laptop immediately after installing v2.3.0-rc1 and before
handing to workers. Paste into PowerShell as Administrator.

```powershell
# ============================================================
# Smart Weight System — Pre-Production Hardware Test
# Run on each laptop after install. Takes ~15 minutes.
# ============================================================

$BASE = "http://localhost"
function Check($url, $label) {
    try {
        $r = Invoke-RestMethod "$url" -TimeoutSec 5
        Write-Host "  [OK] $label" -ForegroundColor Green
        return $r
    } catch {
        Write-Host "  [FAIL] $label — $_" -ForegroundColor Red
        return $null
    }
}

Write-Host ""
Write-Host "T1 — FRESH BOOT: Wait 60s then check all 5 services" -ForegroundColor Cyan
Write-Host "  (Run this test after a fresh reboot, waited 60 seconds)"
Start-Sleep -Seconds 5

$health = Check "$BASE:5099/health" "Launcher health"
if ($health) {
    $health.services | ForEach-Object {
        $icon = if ($_.status -eq 'running') { "[OK]" } else { "[!!]" }
        $color = if ($_.status -eq 'running') { "Green" } else { "Red" }
        Write-Host "  $icon $($_.name.PadRight(20)) $($_.status)" -ForegroundColor $color
    }
}
Check "$BASE:5000/health"  "Weight service"
Check "$BASE:5001/health"  "Print service"
Check "$BASE:5002/health"  "Sync service"
Check "$BASE:3000"         "Web UI"
Check "$BASE:4000/health"  "Dispatch service"

Write-Host ""
Write-Host "T2 — SCALE UNPLUG/REPLUG SAME PORT" -ForegroundColor Cyan
Write-Host "  >>> MANUALLY: Unplug scale USB cable now"
Read-Host "  Press Enter when unplugged..."
Start-Sleep -Seconds 3
$s = Check "$BASE:5000/health" "Scale status after unplug"
if ($s.serial.connected -eq $false) { Write-Host "  [OK] Scale correctly shows disconnected" -ForegroundColor Green }
Write-Host "  >>> MANUALLY: Replug scale USB into SAME port"
Read-Host "  Press Enter when replugged..."
Start-Sleep -Seconds 8
$s = Check "$BASE:5000/health" "Scale recovery"
if ($s.serial.connected) { Write-Host "  [PASS] Scale auto-recovered" -ForegroundColor Green }
else { Write-Host "  [FAIL] Scale did not recover — check COM port" -ForegroundColor Red }

Write-Host ""
Write-Host "T3 — SCALE USB MOVED TO DIFFERENT PORT" -ForegroundColor Cyan
Write-Host "  >>> MANUALLY: Move scale USB to a DIFFERENT USB port on this laptop"
Read-Host "  Press Enter after moving..."
Write-Host "  Waiting up to 30s for auto-detection..."
$recovered = $false
for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Seconds 5
    $s = (Invoke-RestMethod "$BASE:5000/health" -TimeoutSec 3 -EA SilentlyContinue)
    if ($s.serial.connected) { $recovered = $true; break }
    Write-Host "  ...waiting ($($i*5+5)s)"
}
if ($recovered) {
    Write-Host "  [PASS] Scale auto-detected on new port" -ForegroundColor Green
    $newPort = (Invoke-RestMethod "$BASE:5000/health").serial.port
    Write-Host "  New COM port: $newPort (update .env SERIAL_PORT if different from COM5)"
} else {
    Write-Host "  [CAVEAT] Scale not auto-detected in 30s" -ForegroundColor Yellow
    Write-Host "  Check Device Manager for new COM port, update .env SERIAL_PORT" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "T4 — PRINTER UNPLUG/REPLUG SAME PORT" -ForegroundColor Cyan
Write-Host "  >>> MANUALLY: Unplug printer USB"
Read-Host "  Press Enter when unplugged..."
Start-Sleep -Seconds 8
$sys = Check "$BASE:5001/system/status" "System status after printer unplug"
if ($sys.printer.state -ne 'connected') { Write-Host "  [OK] Printer correctly disconnected" -ForegroundColor Green }
Write-Host "  Verify: NO black full-screen overlay in browser (only pill turns RED)"
Write-Host "  >>> MANUALLY: Replug printer USB into SAME port"
Read-Host "  Press Enter when replugged..."
Start-Sleep -Seconds 8
$sys = Check "$BASE:5001/system/status" "Printer recovery"
if ($sys.printer.state -eq 'connected') { Write-Host "  [PASS] Printer recovered" -ForegroundColor Green }
else { Write-Host "  [FAIL] Printer still disconnected" -ForegroundColor Red }

Write-Host ""
Write-Host "T5 — PRINTER USB TO DIFFERENT PORT" -ForegroundColor Cyan
Write-Host "  >>> MANUALLY: Move printer USB to different port"
Read-Host "  Press Enter after moving..."
Start-Sleep -Seconds 8
$sys = Check "$BASE:5001/system/status" "Printer on new USB port"
if ($sys.printer.state -eq 'connected') { Write-Host "  [PASS] Windows spooler transparent to port change" -ForegroundColor Green }
else { Write-Host "  [CAVEAT] Printer not found — check printer name in .env" -ForegroundColor Yellow }

Write-Host ""
Write-Host "T6 — PRINT 5 LABELS" -ForegroundColor Cyan
Write-Host "  (Open http://localhost:3000, select product+worker, print 5 bags)"
Read-Host "  Press Enter after printing 5 labels..."
Write-Host "  Check thermal output manually — all 5 labels should look correct" -ForegroundColor Cyan

Write-Host ""
Write-Host "T7 — CROSS-STATION SCAN (only if ST02 is also installed)" -ForegroundColor Cyan
Write-Host "  Pack a bag on ST02, scan its QR from dispatch laptop."
Write-Host "  Expected: GREEN scan result (if DISPATCH_USE_DJANGO_LOOKUP=true)"
Write-Host "  Expected: ORANGE scan (if flag=false) — not a failure, just a caveat"

Write-Host ""
Write-Host "T10 — WIFI DISCONNECT (30 seconds)" -ForegroundColor Cyan
Write-Host "  >>> MANUALLY: Disconnect Wi-Fi adapter now"
Read-Host "  Press Enter when Wi-Fi is disconnected..."
Start-Sleep -Seconds 5
Write-Host "  Try printing a bag — should succeed (offline mode)"
Read-Host "  Press Enter after printing..."
Write-Host "  >>> MANUALLY: Reconnect Wi-Fi"
Read-Host "  Press Enter when Wi-Fi is back..."
Start-Sleep -Seconds 15
$sync = Check "$BASE:5002/sync/status" "Sync draining queued bags"
Write-Host "  Pending bags: $($sync.pending_dispatches + $sync.pending_sessions)"

Write-Host ""
Write-Host "T12 — REBOOT TEST" -ForegroundColor Cyan
Write-Host "  >>> MANUALLY: Restart computer"
Write-Host "  After reboot, wait 90 seconds, then open http://localhost:3000"
Write-Host "  Expected: weight showing, printer green, no intervention needed"
Read-Host "  Press Enter after verifying post-reboot state..."
$final = Check "$BASE:5099/health" "Post-reboot health"
if ($final.ok) { Write-Host "  [PASS] System healthy after reboot" -ForegroundColor Green }
else { Write-Host "  [WARN] Some service not yet running — wait another 30s" -ForegroundColor Yellow }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Test complete. Review any [FAIL] or [CAVEAT] items above." -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
```

---

## Appendix — Recommended Hardening (optional, not blocking for tomorrow)

### H1 — SCALE_AUTO_DETECT=true (low effort, good insurance)

Change default in installer `WriteEnvFile` from:
```
SCALE_AUTO_DETECT=false
```
to:
```
SCALE_AUTO_DETECT=true
```

Effect: On startup with `SERIAL_PORT=COM5` set, weight-service still tries COM5
first (portExplicit=true path in index.ts:53-67). If it fails, it immediately
falls back to the 3-failure-then-autodetect loop. The practical benefit is richer
startup logging (shows all detected candidates even when COM5 works fine).

### H2 — Update .env after auto-detection (medium effort, 30-min fix)

When `_autoDetectPort()` successfully opens a new port, emit a log warning that
instructs the operator: `"Scale found on COM7 but .env says COM5. Run: notepad C:\SmartWeightSystem\.env and update SERIAL_PORT=COM7 for faster restarts."`

This does NOT require auto-writing the .env (risky). It just makes the gap visible.

### H3 — Pin USB ports with a label (zero-effort operational fix)

Stick physical labels on each laptop's USB ports: "SCALE HERE" and "PRINTER HERE".
This eliminates the port-change scenario entirely for a factory floor context where
cables are rarely moved. The simplest and most reliable fix.

---

*Audit performed: 2026-04-27. No code changes made.*
