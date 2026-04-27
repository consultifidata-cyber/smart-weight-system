const express = require('express');
const path    = require('path');
const { exec } = require('child_process');
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '..', '.env'),
});

const app  = express();
const PORT = process.env.WEB_UI_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Feature flags — read from .env, served to frontend on demand
app.get('/api/flags', (_req, res) => {
  res.json({
    enableReports:           process.env.ENABLE_REPORTS            === 'true',
    dispatchUseDjangoLookup: process.env.DISPATCH_USE_DJANGO_LOOKUP === 'true',
    // Expose Django base URL + token so the browser can call report endpoints.
    // Token is already known to operators; this is a factory-floor app, not public web.
    djangoServerUrl:         process.env.DJANGO_SERVER_URL  || '',
    djangoToken:             process.env.DJANGO_API_TOKEN   || '',
  });
});

// ── 5.1 Client error log endpoint ────────────────────────────────────────────
// Accepts single {stationId,timestamp,level,source,message,stack,context}
// or a batch {batch: [...]} for buffered errors flushed on reconnect.
// Writes to logs/client-errors.log (fire-and-forget, never blocks response).
app.post('/log', (req, res) => {
  const fs = require('fs');
  const logDir  = path.join(__dirname, '..', 'logs');
  const logFile = path.join(logDir, 'client-errors.log');
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const entries = req.body.batch || [req.body];
    const lines   = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFile(logFile, lines, () => {});
  } catch (e) { /* swallow — log failures must never block the UI */ }
  res.json({ ok: true });
});

// Serve dispatch SPA for any /dispatch/* path not matched by static files
app.get('/dispatch', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dispatch', 'index.html'));
});
app.get('/dispatch/*path', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dispatch', 'index.html'));
});

// ── Phase H: /ops/report — panic button triggers health-report.ps1 ──────────
// Runs the diagnostic bundle script and returns the Desktop zip path.
// Only works on Windows (production environment).
app.post('/ops/report', (req, res) => {
  if (process.platform !== 'win32') {
    res.json({
      status: 'ok',
      path: 'N/A (Linux dev environment)',
      message: 'Run manually: powershell -File tools/health-report.ps1',
    });
    return;
  }

  // Resolve install dir: two levels above web-ui/
  const installDir = path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(installDir, 'tools', 'health-report.ps1');
  const cmd = `powershell -NonInteractive -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;

  exec(cmd, { timeout: 45000, windowsHide: true }, (err, stdout) => {
    if (err && !stdout) {
      res.status(500).json({ status: 'error', error: err.message });
      return;
    }
    // Extract Desktop zip path from script output
    const match = stdout.match(/SWS-HealthReport[^\n]+\.zip/);
    const zipPath = match
      ? (process.env.USERPROFILE || 'C:\\Users\\User') + '\\Desktop\\' + match[0].trim()
      : 'Desktop (check manually)';
    res.json({ status: 'ok', path: zipPath });
  });
});

// ── Phase H: /ops/backup — trigger immediate SQLite backup ───────────────────
app.post('/ops/backup', (req, res) => {
  if (process.platform !== 'win32') {
    res.json({ status: 'ok', message: 'Linux: backup handled by launcher' });
    return;
  }
  const installDir = path.resolve(__dirname, '..', '..');
  const src  = path.join(installDir, 'sync-service', 'data', 'fg_production.db');
  const bdir = path.join(installDir, 'logs', 'db-backups');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const dst  = path.join(bdir, `fg_production_${timestamp}.db`);

  const fs = require('fs');
  try {
    if (!fs.existsSync(src)) { res.status(404).json({ status: 'error', error: 'DB not found' }); return; }
    if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(src, dst);
    res.json({ status: 'ok', path: dst });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`web-ui → http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`[web-ui] ${signal} received, shutting down`);
  server.close(() => { console.log('[web-ui] stopped'); process.exit(0); });
  setTimeout(() => { console.warn('[web-ui] graceful shutdown timed out, forcing'); process.exit(1); }, 4000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
