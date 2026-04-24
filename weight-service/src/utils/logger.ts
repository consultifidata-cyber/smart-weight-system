import { pino } from 'pino';
import config from '../config.js';

const logger = pino({
  level: config.logLevel,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export default logger;
