/**
 * Lightweight prefixed logger for dispatch-service.
 * Writes to stdout/stderr — captured by NSSM into logs/dispatch-service-*.log
 */

const PREFIX = '[DISPATCH-SERVICE]';

function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  info(obj: Record<string, unknown> | string, msg?: string): void {
    const message = typeof obj === 'string' ? obj : msg || '';
    const meta    = typeof obj === 'object'  ? ' ' + JSON.stringify(obj) : '';
    console.log(`${ts()} INFO  ${PREFIX} ${message}${meta}`);
  },
  warn(obj: Record<string, unknown> | string, msg?: string): void {
    const message = typeof obj === 'string' ? obj : msg || '';
    const meta    = typeof obj === 'object'  ? ' ' + JSON.stringify(obj) : '';
    console.warn(`${ts()} WARN  ${PREFIX} ${message}${meta}`);
  },
  error(obj: Record<string, unknown> | string, msg?: string): void {
    const message = typeof obj === 'string' ? obj : msg || '';
    const meta    = typeof obj === 'object'  ? ' ' + JSON.stringify(obj) : '';
    console.error(`${ts()} ERROR ${PREFIX} ${message}${meta}`);
  },
  debug(obj: Record<string, unknown> | string, msg?: string): void {
    if (process.env.LOG_LEVEL !== 'debug') return;
    const message = typeof obj === 'string' ? obj : msg || '';
    const meta    = typeof obj === 'object'  ? ' ' + JSON.stringify(obj) : '';
    console.log(`${ts()} DEBUG ${PREFIX} ${message}${meta}`);
  },
};

export default logger;
