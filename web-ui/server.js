const express = require('express');
const path = require('path');
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '..', '.env'),
});

const app = express();
const PORT = process.env.WEB_UI_PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`web-ui → http://localhost:${PORT}`);
});
