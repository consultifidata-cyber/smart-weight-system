var CONFIG = {
  stationId: 'ST01',
  weightServiceUrl: 'http://localhost:5000',
  printServiceUrl:  'http://localhost:5001',
  syncServiceUrl:   'http://localhost:5002',
  productApiUrl:    'http://localhost:5002/products',
  workerApiUrl:     'http://localhost:5002/workers',
  weightPollMs:     1000,
  healthPollMs:     10000,
  autoResetMs:      4000,    // Phase F: 4 s success display (was 2 s)
  fetchTimeoutMs:   3000,
  plantCode:        'BNJRS10',
  printFetchTimeoutMs:  1500,
  printRetryAttempts:   3,
  printRetryDelayMs:    500,
  printResetTimeoutMs:  20000,
  printLockMs:      2000,    // Phase F: double-click lock duration
  enableBeep:       true,    // Phase F: Web Audio beep on success/failure
  supervisorPin:    '1234',  // 4-digit PIN for gate override — change in .env / config.js
};


// var CONFIG = {
//   stationId: 'ST01',
//   weightServiceUrl: 'http://192.168.31.162:5000',
//   printServiceUrl: 'http://192.168.31.162:5001',
//   syncServiceUrl: 'http://192.168.31.162:5002',
//   productApiUrl: 'http://192.168.31.162:5002/products',
//   weightPollMs: 1000,
//   healthPollMs: 10000,
//   autoResetMs: 2000,
//   fetchTimeoutMs: 3000,
//   plantCode: 'BNJRS10',
//   printFetchTimeoutMs: 1500,
//   printRetryAttempts: 3,
//   printRetryDelayMs: 500,
//   printResetTimeoutMs: 20000,
// };
