/**
 * PM2 Ecosystem Config -- Smart Weight System
 *
 * All 4 services managed by PM2 for auto-restart, log rotation, and boot persistence.
 * Usage:
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save
 *
 * Each service loads env vars from the root .env via dotenv.
 * PM2 passes the absolute path as DOTENV_PATH so services don't need
 * to guess the .env location from import.meta.url (which is unreliable
 * under tsx.cmd on Windows).
 *
 * tsx is hoisted to root node_modules by npm workspaces, so we use an absolute
 * path as the interpreter. On Windows we need tsx.cmd (batch wrapper), on
 * Linux/macOS the extensionless tsx symlink.
 */

const path = require('path');
const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const tsxBin = path.join(root, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
const dotenvPath = path.join(root, '.env');

// Shared env block -- every service gets the absolute .env path
const sharedEnv = {
  NODE_ENV: 'production',
  DOTENV_PATH: dotenvPath,
};

module.exports = {
  apps: [
    {
      name: 'weight-service',
      script: 'src/index.ts',
      cwd: path.join(root, 'weight-service'),
      interpreter: tsxBin,
      env: sharedEnv,
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'weight-service-error.log'),
      out_file: path.join(root, 'logs', 'weight-service-out.log'),
      merge_logs: true,
      // Note: log rotation requires `pm2 install pm2-logrotate` (optional).
    },
    {
      name: 'print-service',
      script: 'src/index.ts',
      cwd: path.join(root, 'print-service'),
      interpreter: tsxBin,
      env: sharedEnv,
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'print-service-error.log'),
      out_file: path.join(root, 'logs', 'print-service-out.log'),
      merge_logs: true,
      // Note: log rotation requires `pm2 install pm2-logrotate` (optional).
    },
    {
      name: 'sync-service',
      script: 'src/index.ts',
      cwd: path.join(root, 'sync-service'),
      interpreter: tsxBin,
      env: sharedEnv,
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'sync-service-error.log'),
      out_file: path.join(root, 'logs', 'sync-service-out.log'),
      merge_logs: true,
      // Note: log rotation requires `pm2 install pm2-logrotate` (optional).
    },
    {
      name: 'web-ui',
      script: 'server.js',
      cwd: path.join(root, 'web-ui'),
      interpreter: 'node',
      env: sharedEnv,
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'web-ui-error.log'),
      out_file: path.join(root, 'logs', 'web-ui-out.log'),
      merge_logs: true,
      // Note: log rotation requires `pm2 install pm2-logrotate` (optional).
    },
  ],
};
