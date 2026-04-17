/**
 * Smart Weight System -- Service Launcher
 *
 * Lightweight process manager that replaces PM2 on Windows.
 * Spawns all services with windowsHide:true to prevent the CMD
 * window flashing caused by PM2's internal wmic monitoring.
 *
 * Reads service definitions from ecosystem.config.js (same format).
 *
 * Usage:
 *   node deploy/launcher.js   -- start all services (foreground)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ----------------------------------------------------------------
// Paths
// ----------------------------------------------------------------
const root = path.resolve(__dirname, '..');
const pidFile = path.join(root, '.launcher.pid');
const logsDir = path.join(root, 'logs');

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

// ----------------------------------------------------------------
// State
// ----------------------------------------------------------------
let shuttingDown = false;
const children = new Map(); // name -> { pid, restarts, process, def }

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

  // Track state
  const prev = children.get(appDef.name);
  const restarts = prev ? prev.restarts : 0;

  children.set(appDef.name, {
    pid: child.pid,
    restarts,
    process: child,
    def: appDef,
  });

  log(`Started ${appDef.name} (PID ${child.pid}${restarts > 0 ? ', restart #' + restarts : ''})`);

  child.on('error', (err) => {
    log(`${appDef.name} spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    outStream.end();
    errStream.end();

    if (shuttingDown) return;

    const maxRestarts = appDef.max_restarts || 50;
    const delay = appDef.restart_delay || 3000;
    const state = children.get(appDef.name);

    if (state && state.restarts >= maxRestarts) {
      log(`${appDef.name} reached max restarts (${maxRestarts}). Giving up.`);
      return;
    }

    if (state) state.restarts++;
    log(`${appDef.name} exited (code=${code}, signal=${signal}). Restarting in ${delay}ms...`);

    setTimeout(() => startApp(appDef), delay);
  });
}

// ----------------------------------------------------------------
// Graceful shutdown
// ----------------------------------------------------------------
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down all services...');

  for (const [name, state] of children) {
    try {
      state.process.kill();
      log(`Stopped ${name} (PID ${state.pid})`);
    } catch (e) {
      // already exited
    }
  }

  try { fs.unlinkSync(pidFile); } catch (e) {}
  log('All services stopped.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Write PID file so stop/start scripts can find us
fs.writeFileSync(pidFile, String(process.pid));

log('========================================');
log(`Smart Weight System Launcher (PID ${process.pid})`);
log(`Root: ${root}`);
log(`Starting ${apps.length} services...`);
log('========================================');

apps.forEach(startApp);
