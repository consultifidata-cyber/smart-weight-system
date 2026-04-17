const express = require('express');
const path = require('path');
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '..', '.env'),
});

const app = express();
const PORT = process.env.WEB_UI_PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
  console.log(`web-ui → http://localhost:${PORT}`);
});

// Graceful shutdown: let in-flight static-file requests finish before exit.
function shutdown(signal) {
  console.log(`[web-ui] ${signal} received, shutting down`);
  server.close(() => {
    console.log('[web-ui] stopped');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[web-ui] graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 4000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
