/**
 * PM2 Ecosystem Config — Smart Weight System
 *
 * All 4 services managed by PM2 for auto-restart, log rotation, and boot persistence.
 * Usage:
 *   pm2 start deploy/ecosystem.config.js
 *   pm2 save
 *
 * Env vars are loaded from ../.env by each service via dotenv.
 * The cwd for each service is set relative to this config file's location.
 */

const path = require('path');
const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'weight-service',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: path.join(root, 'weight-service'),
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: path.join(root, '.env'),
      },
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'weight-service-error.log'),
      out_file: path.join(root, 'logs', 'weight-service-out.log'),
      merge_logs: true,
      max_size: '10M',
    },
    {
      name: 'print-service',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: path.join(root, 'print-service'),
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: path.join(root, '.env'),
      },
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'print-service-error.log'),
      out_file: path.join(root, 'logs', 'print-service-out.log'),
      merge_logs: true,
      max_size: '10M',
    },
    {
      name: 'sync-service',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: path.join(root, 'sync-service'),
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: path.join(root, '.env'),
      },
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'sync-service-error.log'),
      out_file: path.join(root, 'logs', 'sync-service-out.log'),
      merge_logs: true,
      max_size: '10M',
    },
    {
      name: 'web-ui',
      script: 'server.js',
      cwd: path.join(root, 'web-ui'),
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        WEB_UI_PORT: 3000,
      },
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 3000,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(root, 'logs', 'web-ui-error.log'),
      out_file: path.join(root, 'logs', 'web-ui-out.log'),
      merge_logs: true,
      max_size: '10M',
    },
  ],
};
