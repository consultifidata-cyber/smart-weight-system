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
 * TypeScript services use `node --import tsx` instead of the tsx.cmd wrapper.
 * PM2 uses child_process.spawn() which cannot execute .cmd/.bat files on
 * Windows (EINVAL). Using node as the interpreter with --import tsx registers
 * tsx's TypeScript loader hooks -- same result, no .cmd involved.
 */

const path = require('path');
const root = path.resolve(__dirname, '..');
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
      interpreter: 'node',
      interpreter_args: '--import tsx',
      env: sharedEnv,
      max_restarts: Infinity,
      min_uptime: '10s',
      restart_delay: 3000,
      max_restart_delay: 60000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'weight-service-error.log'),
      out_file: path.join(root, 'logs', 'weight-service-out.log'),
      merge_logs: true,
    },
    {
      name: 'print-service',
      script: 'src/index.ts',
      cwd: path.join(root, 'print-service'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      env: sharedEnv,
      max_restarts: Infinity,
      min_uptime: '10s',
      restart_delay: 3000,
      max_restart_delay: 60000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'print-service-error.log'),
      out_file: path.join(root, 'logs', 'print-service-out.log'),
      merge_logs: true,
    },
    {
      name: 'sync-service',
      script: 'src/index.ts',
      cwd: path.join(root, 'sync-service'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      env: sharedEnv,
      max_restarts: Infinity,
      min_uptime: '10s',
      restart_delay: 3000,
      max_restart_delay: 60000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'sync-service-error.log'),
      out_file: path.join(root, 'logs', 'sync-service-out.log'),
      merge_logs: true,
    },
    {
      name: 'web-ui',
      script: 'server.js',
      cwd: path.join(root, 'web-ui'),
      interpreter: 'node',
      env: sharedEnv,
      max_restarts: Infinity,
      min_uptime: '10s',
      restart_delay: 3000,
      max_restart_delay: 60000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'web-ui-error.log'),
      out_file: path.join(root, 'logs', 'web-ui-out.log'),
      merge_logs: true,
    },
    {
      name: 'dispatch-service',
      script: 'src/index.ts',
      cwd: path.join(root, 'dispatch-service'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      env: sharedEnv,
      max_restarts: Infinity,
      min_uptime: '10s',
      restart_delay: 3000,
      max_restart_delay: 60000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'dispatch-service-error.log'),
      out_file: path.join(root, 'logs', 'dispatch-service-out.log'),
      merge_logs: true,
    },
  ],
};
