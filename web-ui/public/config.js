var CONFIG = {
  stationId: 'ST01',
  weightServiceUrl: 'http://localhost:5000',
  printServiceUrl: 'http://localhost:5001',
  productApiUrl: null, // Set when backend product API exists
  weightPollMs: 1000,
  healthPollMs: 10000,
  autoResetMs: 2000,
  fetchTimeoutMs: 3000,
  plantCode: 'BNJRS10',

  // Fallback product list (used when server API unavailable and no localStorage cache)
  products: [
    { name: 'kasturi rs5' },
    { name: 'ch lite chura rs10' },
    { name: 'premium cement 50kg' },
    { name: 'wall putty 40kg' },
  ],
};
