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
 *
 * Usage:
 *   node deploy/launcher.js   -- start all services (foreground)
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ----------------------------------------------------------------
// Paths
// ----------------------------------------------------------------
const root = path.resolve(__dirname, '..');
const pidFile = path.join(root, '.launcher.pid');
const statusFile = path.join(root, '.launcher-status.json');
const logsDir = path.join(root, 'logs');

// ----------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------
const CRASH_LOOP_LOG_THRESHOLD = 10;       // after N consecutive fast exits, throttle logs
const CRASH_LOOP_LOG_INTERVAL_MS = 5 * 60 * 1000; // one line every 5 min when throttled
const STATUS_WRITE_INTERVAL_MS = 10 * 1000;
const SHUTDOWN_DRAIN_MS = 5000;             // wait this long for services to exit cleanly
const MIN_UPTIME_DEFAULT_MS = 10 * 1000;    // "stable" threshold if not set on the app

// ----------------------------------------------------------------
// Load service definitions from ecosystem config
// ----------------------------------------------------------------
const ecosystem = require('./ecosystem.config.js');
const apps = ecosystem.apps;

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] [launcher] ${msg}`);
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

// ----------------------------------------------------------------
// State
// ----------------------------------------------------------------
let shuttingDown = false;
let statusTimer = null;
const children = new Map(); // name -> { pid, restarts, crashLoopStreak, process, def, startedAt, lastLogAt, state }

// ----------------------------------------------------------------
// Status file writer
// ----------------------------------------------------------------
function writeStatusFile() {
  const now = Date.now();
  const services = {};
  for (const [name, s] of children) {
    services[name] = {
      pid: s.pid,
      restarts: s.restarts,
      crash_loop_streak: s.crashLoopStreak,
      uptime_ms: s.startedAt ? now - s.startedAt : 0,
      state: s.state,
    };
  }
  const data = {
    updated_at: new Date().toISOString(),
    launcher_pid: process.pid,
    services,
  };
  const tmp = statusFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, statusFile);
  } catch (e) {
    // swallow — status file is best-effort
  }
}

// ----------------------------------------------------------------
// Spawn a single service
// ----------------------------------------------------------------
function startApp(appDef) {
  if (shuttingDown) return;

  // Build node arguments: interpreter_args (e.g. --import tsx) + script
  const args = [];
  if (appDef.interpreter_args) {
    args.push(...appDef.interpreter_args.split(/\s+/));
  }
  args.push(appDef.script);

  // Merge environment
  const env = { ...process.env, ...(appDef.env || {}) };

  const child = spawn('node', args, {
    cwd: appDef.cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe stdout/stderr to log files (append mode)
  const outStream = fs.createWriteStream(appDef.out_file, { flags: 'a' });
  const errStream = fs.createWriteStream(appDef.error_file, { flags: 'a' });
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);

  // Preserve prior counters across restarts
  const prev = children.get(appDef.name);
  const restarts = prev ? prev.restarts : 0;
  const crashLoopStreak = prev ? prev.crashLoopStreak : 0;

  children.set(appDef.name, {
    pid: child.pid,
    restarts,
    crashLoopStreak,
    process: child,
    def: appDef,
    startedAt: Date.now(),
    lastLogAt: prev ? prev.lastLogAt : 0,
    state: 'running',
  });

  log(`Started ${appDef.name} (PID ${child.pid}${restarts > 0 ? ', restart #' + restarts : ''})`);

  child.on('error', (err) => {
    log(`${appDef.name} spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    outStream.end();
    errStream.end();

    if (shuttingDown) return;

    const state = children.get(appDef.name);
    if (!state) return;

    const minUptimeMs = parseMinUptime(appDef.min_uptime);
    const ranFor = Date.now() - state.startedAt;
    const stable = ranFor >= minUptimeMs;

    // Determine backoff delay
    const baseDelay = appDef.restart_delay || 3000;
    const maxDelay = appDef.max_restart_delay || 60000;

    let delay;
    if (stable) {
      // Normal restart: reset crash-loop counter, use base delay
      state.crashLoopStreak = 0;
      state.state = 'restarting';
      delay = baseDelay;
      const human = ranFor > 3600000
        ? `${Math.floor(ranFor / 3600000)}h${Math.floor((ranFor % 3600000) / 60000)}m`
        : ranFor > 60000
        ? `${Math.floor(ranFor / 60000)}m${Math.floor((ranFor % 60000) / 1000)}s`
        : `${Math.floor(ranFor / 1000)}s`;
      log(`${appDef.name} exited after ${human} (code=${code}, signal=${signal}). Normal restart in ${delay}ms...`);
    } else {
      // Crash loop: exponential backoff, capped at maxDelay
      state.crashLoopStreak++;
      state.state = 'crash-looping';
      const exp = baseDelay * Math.pow(2, Math.min(state.crashLoopStreak - 1, 10));
      delay = Math.min(exp, maxDelay);

      // Log throttling: after N consecutive crashes, emit only every 5 min
      const now = Date.now();
      const shouldLog =
        state.crashLoopStreak < CRASH_LOOP_LOG_THRESHOLD ||
        now - state.lastLogAt >= CRASH_LOOP_LOG_INTERVAL_MS;

      if (shouldLog) {
        if (state.crashLoopStreak === CRASH_LOOP_LOG_THRESHOLD) {
          log(`${appDef.name} crash-looping: throttling restart logs to once every 5 min`);
        } else {
          log(`${appDef.name} crashed after ${Math.floor(ranFor / 1000)}s (crash-loop streak ${state.crashLoopStreak}, code=${code}, signal=${signal}). Next retry in ${Math.floor(delay / 1000)}s...`);
        }
        state.lastLogAt = now;
      }
    }

    state.restarts++;
    setTimeout(() => startApp(appDef), delay);
  });
}

// ----------------------------------------------------------------
// Graceful shutdown
// ----------------------------------------------------------------
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down all services (graceful)...');

  if (statusTimer) clearInterval(statusTimer);

  // Phase 1: ask everyone to exit cleanly
  // On Windows, child.kill() TerminateProcess-es (hard kill). Use taskkill
  // without /F to deliver a WM_CLOSE that Node services translate to SIGTERM.
  for (const [name, state] of children) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${state.pid} /t`, { stdio: 'ignore' });
      } else {
        state.process.kill('SIGTERM');
      }
      state.state = 'stopping';
      log(`Sent graceful stop to ${name} (PID ${state.pid})`);
    } catch (e) {
      // process may already be gone
    }
  }

  // Phase 2: wait up to SHUTDOWN_DRAIN_MS, then force-kill stragglers
  setTimeout(() => {
    for (const [name, state] of children) {
      try {
        // Probe: send signal 0 to check if still alive
        process.kill(state.pid, 0);
        // Still alive — force kill
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${state.pid} /t /f`, { stdio: 'ignore' });
        } else {
          state.process.kill('SIGKILL');
        }
        log(`Force-killed ${name} (PID ${state.pid}) after ${SHUTDOWN_DRAIN_MS}ms drain`);
      } catch (e) {
        // already exited — good
      }
    }

    try { fs.unlinkSync(pidFile); } catch (e) {}
    try { fs.unlinkSync(statusFile); } catch (e) {}
    log('All services stopped.');
    process.exit(0);
  }, SHUTDOWN_DRAIN_MS);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
// Windows: Ctrl+C comes as SIGBREAK under some terminals
process.on('SIGBREAK', shutdown);

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Idempotency: if another launcher is already running (e.g. Scheduled
// Task started it at boot, now the Startup-folder .vbs fallback is
// firing at login), exit quietly so we don't start a second instance.
if (fs.existsSync(pidFile)) {
  try {
    const prevPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (prevPid > 0) {
      process.kill(prevPid, 0); // throws if process is gone
      log(`Already running as PID ${prevPid}. Exiting this duplicate.`);
      process.exit(0);
    }
  } catch (e) {
    // ESRCH = stale PID file (process gone) or unreadable PID — overwrite it.
  }
}

// Write PID file so stop/start scripts can find us
fs.writeFileSync(pidFile, String(process.pid));

log('========================================');
log(`Smart Weight System Launcher (PID ${process.pid})`);
log(`Root: ${root}`);
log(`Starting ${apps.length} services (infinite retry enabled)...`);
log('========================================');

apps.forEach(startApp);

// Start periodic status file updates
statusTimer = setInterval(writeStatusFile, STATUS_WRITE_INTERVAL_MS);
writeStatusFile(); // write once immediately
