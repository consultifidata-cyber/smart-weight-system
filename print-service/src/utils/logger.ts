import * as pinoModule from 'pino';
import config from '../config.js';

const pino = pinoModule.default || pinoModule;

const logger = pino({
  level: config.logLevel,
});

export default logger;
