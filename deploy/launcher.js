/**
 * Smart Weight System -- Service Launcher
 *
 * Lightweight process manager that replaces PM2 on Windows.
 * Spawns all services with windowsHide:true to prevent the CMD
 * window flashing caused by PM2's internal wmic monitoring.
 *
 * Reads service definitions from ecosystem.config.js (same format).
 *
 * Features:
 *   - Infinite retry with exponential backoff (crash-loop safe)
 *   - Log throttling to prevent log spam on broken services
 *   - Status file (.launcher-status.json) updated every 10s
 *   - Graceful shutdown: SIGTERM drain → force-kill fallback
 *   - Launcher log file: logs/launcher.log (10MB rotation, keep 3)
 *   - HTTP health endpoint: http://127.0.0.1:5099/health
 *   - Extended state tracking: exitCode, exitSignal, lastError, timestamps
 *
 * Usage:
 *   node deploy/launcher.js   -- start all services (foreground)
 *
 * Health endpoint:
 *   curl http://localhost:5099/health
 */

'use strict';

const { spawn, execSync } = require('child_process');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');

// ── Paths ─────────────────────────────────────────────────────────────────────
const root       = path.resolve(__dirname, '..');
const pidFile    = path.join(root, '.launcher.pid');
const statusFile = path.join(root, '.launcher-status.json');
const logsDir    = path.join(root, 'logs');

// ── Tunables ──────────────────────────────────────────────────────────────────
const CRASH_LOOP_LOG_THRESHOLD  = 10;
const CRASH_LOOP_LOG_INTERVAL_MS = 5 * 60 * 1000;
const CRASH_CRITICAL_THRESHOLD  = 20;        // emit CRITICAL log at this streak
const STATUS_WRITE_INTERVAL_MS  = 10 * 1000;
const SHUTDOWN_DRAIN_MS         = 10_000;
const MIN_UPTIME_DEFAULT_MS     = 10 * 1000;

// Health endpoint — bind on 127.0.0.1 only (not exposed to network)
const HEALTH_PORT = parseInt(process.env.LAUNCHER_HEALTH_PORT || '5099', 10);

// ── Timestamps ────────────────────────────────────────────────────────────────
const launcherStartedAt = Date.now();

// ── Load service definitions ──────────────────────────────────────────────────
const ecosystem = require('./ecosystem.config.js');
const apps      = ecosystem.apps;

// ── Helpers ───────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function parseMinUptime(val) {
  if (!val) return MIN_UPTIME_DEFAULT_MS;
  if (typeof val === 'number') return val;
  const m = String(val).match(/^(\d+)\s*([smh])?$/i);
  if (!m) return MIN_UPTIME_DEFAULT_MS;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  return unit === 'h' ? n * 3600000 : unit === 'm' ? n * 60000 : n * 1000;
}

// ── Log rotation ──────────────────────────────────────────────────────────────
const MAX_LOG_SIZE      = 10 * 1024 * 1024;  // 10 MB
const MAX_LOG_ROTATIONS = 3;
const LOG_ROTATION_CHECK_MS = 60 * 1000;

function rotateLog(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_SIZE) return false;
  } catch { return false; }

  for (let i = MAX_LOG_ROTATIONS; i >= 1; i--) {
    const from = i === 1 ? logPath : `${logPath}.${i - 1}`;
    const to   = `${logPath}.${i}`;
    try { fs.renameSync(from, to); } catch { /* file may not exist */ }
  }
  return true;
}

// ── Launcher log file ─────────────────────────────────────────────────────────
// Written alongside stdout so the launcher has its own searchable log file.
// NSSM also captures stdout to launcher-svc.log; this is an additional copy.

const launcherLogPath = path.join(logsDir, 'launcher.log');
let   launcherLogStream = null;

function openLauncherLog() {
  rotateLog(launcherLogPath);
  try { if (launcherLogStream) launcherLogStream.end(); } catch { /* best-effort */ }
  launcherLogStream = fs.createWriteStream(launcherLogPath, { flags: 'a' });
  launcherLogStream.on('error', () => { launcherLogStream = null; }); // never crash on write error
}

function log(msg) {
  const line = `[${ts()}] [launcher] ${msg}`;
  console.log(line);
  try {
    if (launcherLogStream && !launcherLogStream.destroyed) {
      launcherLogStream.write(line + '\n');
    }
  } catch { /* swallow — log file write errors must not crash launcher */ }
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let shuttingDown = false;
let statusTimer  = null;
let healthServer = null;

/**
 * Per-service state shape (stored in `children` Map):
 *
 *   pid           — current child process PID (null between restarts)
 *   restarts      — total restart count (monotonic)
 *   crashLoopStreak — consecutive fast-exit count (reset on stable run)
 *   process       — ChildProcess instance
 *   def           — ecosystem app definition
 *   startedAt     — epoch ms when current instance started (for uptime calc)
 *   lastLogAt     — epoch ms of last crash-loop log (for throttling)
 *   state         — one of: running | restarting | crashed | crash-looping | stopping | stopped
 *   lastStartedAt — ISO timestamp of most recent spawn
 *   lastExitedAt  — ISO timestamp of most recent exit (null if never exited)
 *   lastExitCode  — exit code of most recent exit (null if never exited)
 *   lastExitSignal — signal name of most recent exit (null if exited normally)
 *   lastError     — last spawn-level error message (null if none)
 */
const children = new Map();

// ── Status file writer ────────────────────────────────────────────────────────
function writeStatusFile() {
  const now = Date.now();
  const services = {};
  for (const [name, s] of children) {
    services[name] = {
      pid:               s.pid,
      restarts:          s.restarts,
      crash_loop_streak: s.crashLoopStreak,
      uptime_ms:         s.startedAt && s.state === 'running' ? now - s.startedAt : 0,
      state:             s.state,
      // Phase 5 additions
      last_started_at:   s.lastStartedAt  ?? null,
      last_exited_at:    s.lastExitedAt   ?? null,
      last_exit_code:    s.lastExitCode   ?? null,
      last_exit_signal:  s.lastExitSignal ?? null,
      last_error:        s.lastError      ?? null,
    };
  }
  const data = {
    updated_at:   new Date().toISOString(),
    launcher_pid: process.pid,
    services,
  };
  const tmp = statusFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, statusFile);
  } catch { /* swallow — status file is best-effort */ }
}

// ── HTTP health endpoint ──────────────────────────────────────────────────────
// Binds on 127.0.0.1 only (local access; not exposed on LAN).
// curl http://localhost:5099/health

function startHealthServer() {
  healthServer = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }

    if (req.url === '/health' || req.url === '/') {
      const now = Date.now();
      const services = [];

      for (const [name, s] of children) {
        services.push({
          name,
          status:          s.state,
          pid:             s.pid ?? null,
          restartCount:    s.restarts,
          lastExitCode:    s.lastExitCode   ?? null,
          lastExitSignal:  s.lastExitSignal ?? null,
          lastStartedAt:   s.lastStartedAt  ?? null,
          lastExitedAt:    s.lastExitedAt   ?? null,
          lastError:       s.lastError      ?? null,
          uptimeSec:       s.startedAt && s.state === 'running'
            ? Math.floor((now - s.startedAt) / 1000)
            : 0,
        });
      }

      const allRunning = services.length > 0 &&
        services.every(s => s.status === 'running');

      const body = JSON.stringify({
        ok:          !shuttingDown && allRunning,
        launcherPid: process.pid,
        uptimeSec:   Math.floor((now - launcherStartedAt) / 1000),
        services,
      }, null, 2);

      res.writeHead(allRunning ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);

    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found. Use GET /health' }));
    }
  });

  healthServer.on('error', (err) => {
    // Non-fatal: health endpoint failing must never crash the launcher
    log(`Health server error (port ${HEALTH_PORT}): ${err.message} — health endpoint unavailable`);
  });

  healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
    log(`Health endpoint → http://127.0.0.1:${HEALTH_PORT}/health`);
  });
}

// ── Spawn a single service ────────────────────────────────────────────────────
function startApp(appDef) {
  if (shuttingDown) return;

  const args = [];
  if (appDef.interpreter_args) {
    args.push(...appDef.interpreter_args.split(/\s+/));
  }
  args.push(appDef.script);

  const env = { ...process.env, ...(appDef.env || {}) };

  const child = spawn('node', args, {
    cwd: appDef.cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  rotateLog(appDef.out_file);
  rotateLog(appDef.error_file);

  let outStream = fs.createWriteStream(appDef.out_file, { flags: 'a' });
  let errStream = fs.createWriteStream(appDef.error_file, { flags: 'a' });
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);

  const rotationTimer = setInterval(() => {
    if (rotateLog(appDef.out_file)) {
      child.stdout.unpipe(outStream);
      outStream.end();
      outStream = fs.createWriteStream(appDef.out_file, { flags: 'a' });
      child.stdout.pipe(outStream);
      log(`Rotated ${path.basename(appDef.out_file)} (>${MAX_LOG_SIZE / 1024 / 1024}MB)`);
    }
    if (rotateLog(appDef.error_file)) {
      child.stderr.unpipe(errStream);
      errStream.end();
      errStream = fs.createWriteStream(appDef.error_file, { flags: 'a' });
      child.stderr.pipe(errStream);
      log(`Rotated ${path.basename(appDef.error_file)} (>${MAX_LOG_SIZE / 1024 / 1024}MB)`);
    }
    // Rotate launcher log on same cadence
    if (rotateLog(launcherLogPath)) {
      openLauncherLog();
      log(`Rotated launcher.log (>${MAX_LOG_SIZE / 1024 / 1024}MB)`);
    }
  }, LOG_ROTATION_CHECK_MS);

  // Preserve counters across restarts
  const prev           = children.get(appDef.name);
  const restarts       = prev ? prev.restarts       : 0;
  const crashLoopStreak = prev ? prev.crashLoopStreak : 0;
  const now            = new Date().toISOString();

  children.set(appDef.name, {
    pid:             child.pid,
    restarts,
    crashLoopStreak,
    process:         child,
    def:             appDef,
    startedAt:       Date.now(),
    lastLogAt:       prev ? prev.lastLogAt : 0,
    state:           'running',
    // Phase 5 extended fields
    lastStartedAt:   now,
    lastExitedAt:    prev ? prev.lastExitedAt   ?? null : null,
    lastExitCode:    prev ? prev.lastExitCode   ?? null : null,
    lastExitSignal:  prev ? prev.lastExitSignal ?? null : null,
    lastError:       prev ? prev.lastError      ?? null : null,
  });

  log(`Started ${appDef.name} (PID ${child.pid}${restarts > 0 ? ', restart #' + restarts : ''})`);

  // ── Spawn-level errors (e.g. node not found) ────────────────────────────────
  child.on('error', (err) => {
    log(`${appDef.name} spawn error: ${err.message}`);
    const s = children.get(appDef.name);
    if (s) {
      s.lastError = err.message;
      s.state     = 'crashed';
    }
  });

  // ── Process exit ─────────────────────────────────────────────────────────────
  child.on('exit', (code, signal) => {
    clearInterval(rotationTimer);
    outStream.end();
    errStream.end();

    if (shuttingDown) return;

    const s = children.get(appDef.name);
    if (!s) return;

    // Record exit metadata
    s.lastExitCode   = code;
    s.lastExitSignal = signal ?? null;
    s.lastExitedAt   = new Date().toISOString();

    const minUptimeMs = parseMinUptime(appDef.min_uptime);
    const ranFor      = Date.now() - s.startedAt;
    const stable      = ranFor >= minUptimeMs;

    const baseDelay = appDef.restart_delay      || 3000;
    const maxDelay  = appDef.max_restart_delay  || 60000;
    let   delay;

    if (stable) {
      // Normal exit after stable run — reset crash streak, short restart delay
      s.crashLoopStreak = 0;
      s.state           = 'restarting';
      delay             = baseDelay;
      const human = ranFor > 3600000
        ? `${Math.floor(ranFor / 3600000)}h${Math.floor((ranFor % 3600000) / 60000)}m`
        : ranFor > 60000
        ? `${Math.floor(ranFor / 60000)}m${Math.floor((ranFor % 60000) / 1000)}s`
        : `${Math.floor(ranFor / 1000)}s`;
      log(`${appDef.name} exited after ${human} (code=${code}, signal=${signal}). Restarting in ${delay}ms...`);

    } else {
      // Fast exit — crash-loop backoff
      s.crashLoopStreak++;
      // Distinguish first crash from ongoing crash loop
      s.state = s.crashLoopStreak === 1 ? 'crashed' : 'crash-looping';

      const exp = baseDelay * Math.pow(2, Math.min(s.crashLoopStreak - 1, 10));
      delay = Math.min(exp, maxDelay);

      const nowMs    = Date.now();
      const shouldLog =
        s.crashLoopStreak < CRASH_LOOP_LOG_THRESHOLD ||
        nowMs - s.lastLogAt >= CRASH_LOOP_LOG_INTERVAL_MS;

      if (shouldLog) {
        if (s.crashLoopStreak === CRASH_LOOP_LOG_THRESHOLD) {
          log(`${appDef.name} crash-looping: throttling logs to once per 5 min`);
        } else {
          log(
            `${appDef.name} crashed after ${Math.floor(ranFor / 1000)}s ` +
            `(streak ${s.crashLoopStreak}, code=${code}, signal=${signal}). ` +
            `Next retry in ${Math.floor(delay / 1000)}s...`,
          );
        }
        s.lastLogAt = nowMs;
      }

      // Critical threshold — escalate log level; continue restarting
      if (s.crashLoopStreak === CRASH_CRITICAL_THRESHOLD) {
        log(
          `CRITICAL: ${appDef.name} has crashed ${s.crashLoopStreak} times. ` +
          `Service will keep retrying every ${Math.floor(maxDelay / 1000)}s. ` +
          `Manual investigation recommended. Check logs/${path.basename(appDef.error_file)}.`,
        );
      }
    }

    s.restarts++;
    setTimeout(() => startApp(appDef), delay);
  });
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down all services (graceful)...');

  if (statusTimer) clearInterval(statusTimer);

  // Phase 1: ask everyone to exit cleanly
  for (const [name, state] of children) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${state.pid} /t`, { stdio: 'ignore' });
      } else {
        state.process.kill('SIGTERM');
      }
      state.state = 'stopping';
      log(`Sent graceful stop to ${name} (PID ${state.pid})`);
    } catch { /* process may already be gone */ }
  }

  // Phase 2: wait SHUTDOWN_DRAIN_MS, then force-kill stragglers
  setTimeout(() => {
    for (const [name, state] of children) {
      try {
        process.kill(state.pid, 0); // throws if already dead
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${state.pid} /t /f`, { stdio: 'ignore' });
        } else {
          state.process.kill('SIGKILL');
        }
        log(`Force-killed ${name} (PID ${state.pid}) after ${SHUTDOWN_DRAIN_MS}ms drain`);
      } catch { /* already exited — good */ }
    }

    // Close health server before exit
    try { if (healthServer) healthServer.close(); } catch { /* best-effort */ }

    // Flush launcher log
    try { if (launcherLogStream && !launcherLogStream.destroyed) launcherLogStream.end(); } catch { /* best-effort */ }

    try { fs.unlinkSync(pidFile);    } catch { /* ok if missing */ }
    try { fs.unlinkSync(statusFile); } catch { /* ok if missing */ }

    log('All services stopped.');
    process.exit(0);
  }, SHUTDOWN_DRAIN_MS);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP',  shutdown);
process.on('SIGBREAK', shutdown); // Windows Ctrl+C in some terminals

// ── Phase H: Daily SQLite auto-backup ────────────────────────────────────────
// Backs up fg_production.db daily at midnight, keeps last 7 copies.

const DB_BACKUP_DIR       = path.join(root, 'logs', 'db-backups');
const DB_BACKUP_KEEP      = 7;
const DB_SOURCE           = path.join(root, 'sync-service', 'data', 'fg_production.db');

function backupDatabase() {
  if (!fs.existsSync(DB_SOURCE)) return;
  try {
    if (!fs.existsSync(DB_BACKUP_DIR)) fs.mkdirSync(DB_BACKUP_DIR, { recursive: true });
    const ts  = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const dst = path.join(DB_BACKUP_DIR, `fg_production_${ts}.db`);
    fs.copyFileSync(DB_SOURCE, dst);
    log(`[backup] Database backed up → ${path.basename(dst)}`);

    // Prune: keep only the last N backups
    const files = fs.readdirSync(DB_BACKUP_DIR)
      .filter(f => f.startsWith('fg_production_') && f.endsWith('.db'))
      .sort();
    if (files.length > DB_BACKUP_KEEP) {
      files.slice(0, files.length - DB_BACKUP_KEEP).forEach(f => {
        try { fs.unlinkSync(path.join(DB_BACKUP_DIR, f)); } catch { /* ignore */ }
      });
    }
  } catch (e) {
    log(`[backup] Database backup failed: ${e.message}`);
  }
}

function scheduleDaily(fn, label) {
  // Run immediately on startup, then every 24 hours
  fn();

  // Schedule next run at the next midnight
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
  const msToMidnight = next - now;

  setTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000);
    log(`[scheduler] ${label} running on 24h schedule`);
  }, msToMidnight);

  log(`[scheduler] ${label} next run in ${Math.round(msToMidnight / 60000)} min`);
}

// ── Phase H: Auto health report every 4 hours ────────────────────────────────

const HEALTH_REPORT_INTERVAL_MS = 4 * 60 * 60 * 1000;  // 4 hours
const HEALTH_REPORT_AUTO_DIR    = path.join(root, 'logs', 'health-reports');
const HEALTH_REPORT_SCRIPT      = path.join(root, 'tools', 'health-report.ps1');
const HEALTH_REPORT_KEEP        = 5;

function runAutoHealthReport() {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(HEALTH_REPORT_SCRIPT)) return;

  try {
    if (!fs.existsSync(HEALTH_REPORT_AUTO_DIR)) {
      fs.mkdirSync(HEALTH_REPORT_AUTO_DIR, { recursive: true });
    }
  } catch { return; }

  const { execSync } = require('child_process');
  try {
    execSync(
      `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${HEALTH_REPORT_SCRIPT}" -AutoReport -OutputDir "${HEALTH_REPORT_AUTO_DIR}"`,
      { timeout: 45000, stdio: 'ignore', windowsHide: true }
    );

    // Prune old auto-reports
    const files = fs.readdirSync(HEALTH_REPORT_AUTO_DIR)
      .filter(f => f.endsWith('.zip'))
      .sort();
    if (files.length > HEALTH_REPORT_KEEP) {
      files.slice(0, files.length - HEALTH_REPORT_KEEP).forEach(f => {
        try { fs.unlinkSync(path.join(HEALTH_REPORT_AUTO_DIR, f)); } catch { /* ignore */ }
      });
    }
    log(`[health-report] Auto report saved to ${HEALTH_REPORT_AUTO_DIR}`);
  } catch (e) {
    log(`[health-report] Auto report failed (non-fatal): ${e.message}`);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

// Ensure logs directory exists (before openLauncherLog)
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Open launcher log file (after logs dir is guaranteed to exist)
openLauncherLog();

// Idempotency: exit quietly if another launcher is already running
if (fs.existsSync(pidFile)) {
  try {
    const prevPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (prevPid > 0) {
      process.kill(prevPid, 0); // throws if process is gone
      log(`Already running as PID ${prevPid}. Exiting duplicate.`);
      process.exit(0);
    }
  } catch {
    // ESRCH = stale PID file — overwrite it below
  }
}

fs.writeFileSync(pidFile, String(process.pid));

log('========================================');
log(`Smart Weight System Launcher (PID ${process.pid})`);
log(`Root: ${root}`);
log(`Node: ${process.version}  Platform: ${process.platform}`);
log(`Starting ${apps.length} services (infinite retry enabled)...`);
log('========================================');

// Start HTTP health endpoint
startHealthServer();

// Phase H: daily auto-backup of SQLite database
scheduleDaily(backupDatabase, 'DB backup');

// Phase H: auto health report every 4 hours (Windows only, non-fatal)
runAutoHealthReport();
setInterval(runAutoHealthReport, HEALTH_REPORT_INTERVAL_MS);

// Start all services
apps.forEach(startApp);

// Periodic status file refresh
statusTimer = setInterval(writeStatusFile, STATUS_WRITE_INTERVAL_MS);
writeStatusFile();
