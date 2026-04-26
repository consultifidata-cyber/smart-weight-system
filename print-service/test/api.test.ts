import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createServer } from '../src/api/server.js';
import { _resetForTest } from '../src/hardware/printerHealthCache.js';
import type { PrinterDriver, PrinterConfig } from '../src/types.js';

interface MockDriverOptions {
  healthy?: boolean;
  sendError?: string;
  resetError?: string;
}

class MockDriver implements PrinterDriver {
  private healthy: boolean;
  private sendError?: string;
  private resetError?: string;
  public lastBuiltLabel?: Buffer;
  public resetCalled = false;
  public lastSendTimeoutMs?: number;

  constructor(options: MockDriverOptions = {}) {
    this.healthy = options.healthy !== false;
    this.sendError = options.sendError;
    this.resetError = options.resetError;
  }

  buildLabel(data: Parameters<PrinterDriver['buildLabel']>[0]): Buffer {
    this.lastBuiltLabel = Buffer.from(JSON.stringify(data));
    return Buffer.from('MOCK_TSPL');
  }

  buildLabelLinux(data: Parameters<PrinterDriver['buildLabel']>[0]): Buffer { return this.buildLabel(data); }
  buildLabelWin(data: Parameters<PrinterDriver['buildLabel']>[0]): Buffer { return this.buildLabel(data); }

  async send(_commands: Buffer, timeoutMs?: number): Promise<void> {
    this.lastSendTimeoutMs = timeoutMs;
    if (this.sendError) throw new Error(this.sendError);
  }

  async sendLinux(_commands: Buffer, _timeoutMs?: number): Promise<void> { return this.send(_commands, _timeoutMs); }
  async sendWin(_commands: Buffer, _timeoutMs?: number): Promise<void> { return this.send(_commands, _timeoutMs); }

  async healthCheck(_timeoutMs?: number): Promise<boolean> { return this.healthy; }
  async healthCheckLinux(_timeoutMs?: number): Promise<boolean> { return this.healthy; }
  async healthCheckWin(_timeoutMs?: number): Promise<boolean> { return this.healthy; }

  async resetPrinter(): Promise<void> {
    this.resetCalled = true;
    if (this.resetError) throw new Error(this.resetError);
  }

  async resetPrinterLinux(): Promise<void> { return this.resetPrinter(); }
  async resetPrinterWin(): Promise<void> { return this.resetPrinter(); }
}

const mockConfig: PrinterConfig = {
  driver: 'tspl',
  device: '/dev/usb/lp0',
  printerName: 'SNBC TVSE LP 46 NEO BPLE',
  labelWidth: 50,
  labelHeight: 50,
  dpi: 203,
  stationId: 'ST01',
  apiPort: 5001,
  logLevel: 'info',
  sendTimeoutMs: 1000,
  healthPollMs: 30000,
};

describe('Print API', () => {
  // Reset the health cache before each test so tests are isolated.
  // /print/health now reads from the module-level cache (getCachedHealth)
  // rather than calling driver.healthCheck() directly.
  beforeEach(() => _resetForTest(true));

  it('POST /print/print returns 200 on success', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-White-Cement-50kg',
        weight: 25.45,
        stationId: 'ST01',
        line1: 'FG-WC-150426-01-001',
        line2: 'FG-White-Cement-50kg | 25.45 kg',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.entryId);
    assert.ok(res.body.printedAt);
  });

  it('POST /print/print validates required fields', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-White-Cement-50kg',
        // missing weight, stationId, line1, line2
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
    assert.match(res.body.error, /required fields/i);
  });

  it('POST /print/print rejects duplicate requests within 2s', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const payload = {
      product: 'FG-Dedup-Test',
      weight: 99.99,
      stationId: 'ST01',
      line1: 'DEDUP-150426-01-001',
      line2: 'FG-Dedup-Test | 99.99 kg',
    };

    const res1 = await request(app).post('/print/print').send(payload);
    assert.equal(res1.status, 200);
    assert.equal(res1.body.status, 'ok');

    // Second request immediately after
    const res2 = await request(app).post('/print/print').send(payload);
    assert.equal(res2.status, 429);
    assert.equal(res2.body.status, 'error');
    assert.match(res2.body.error, /duplicate/i);
  });

  it('POST /print/print accepts custom QR content', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Custom-QR',
        weight: 30.00,
        stationId: 'ST01',
        line1: 'CQRT-150426-01-001',
        line2: 'FG-Custom-QR | 30.00 kg',
        qrContent: 'CUSTOM_QR_CONTENT',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('POST /print/print accepts custom label dimensions', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Custom-Label',
        weight: 40.00,
        stationId: 'ST01',
        line1: 'CLBL-150426-01-001',
        line2: 'FG-Custom-Label | 40.00 kg',
        labelWidth: 80,
        labelHeight: 50,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('POST /print/print returns 503 on printer error', async () => {
    const driver = new MockDriver({ sendError: 'Device not found' });
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Printer-Error',
        weight: 50.00,
        stationId: 'ST01',
        line1: 'PERR-150426-01-001',
        line2: 'FG-Printer-Error | 50.00 kg',
      });

    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'error');
    assert.match(res.body.error, /printer error/i);
  });

  it('GET /health returns 200 when printer connected', async () => {
    const driver = new MockDriver({ healthy: true });
    const app = createServer(driver, mockConfig);

    const res = await request(app).get('/print/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.printer.connected, true);
  });

  it('GET /health returns 503 when printer disconnected', async () => {
    // Seed the cache as unhealthy — the endpoint reads from cache, not driver
    _resetForTest(false);
    const driver = new MockDriver({ healthy: false });
    const app = createServer(driver, mockConfig);

    const res = await request(app).get('/print/health');

    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.printer.connected, false);
  });

  it('GET /health includes driver info', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app).get('/print/health');

    assert.equal(res.body.printer.driver, 'tspl');
    assert.equal(res.body.printer.device, '/dev/usb/lp0');
    assert.equal(res.body.service, 'print-service');
    assert.equal(res.body.stationId, 'ST01');
  });

  it('GET /health endpoint exists at root level too', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app).get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'print-service');
  });

  it('POST /print/reset returns 200 on success', async () => {
    const driver = new MockDriver({ healthy: true });
    const app = createServer(driver, mockConfig);

    const res = await request(app).post('/print/reset');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.connected, true);
    assert.equal(driver.resetCalled, true);
  });

  it('POST /print/reset returns 503 on failure', async () => {
    const driver = new MockDriver({ resetError: 'Spooler failed' });
    const app = createServer(driver, mockConfig);

    const res = await request(app).post('/print/reset');

    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'error');
    assert.match(res.body.error, /spooler/i);
  });

  it('POST /print/reset returns connected=false when printer still offline after reset', async () => {
    const driver = new MockDriver({ healthy: false });
    const app = createServer(driver, mockConfig);

    const res = await request(app).post('/print/reset');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.connected, false);
    assert.equal(driver.resetCalled, true);
  });

  it('POST /print/print rejects zero weight', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Zero-Weight',
        weight: 0,
        stationId: 'ST01',
        line1: 'ZERO-150426-01-001',
        line2: 'FG-Zero-Weight | 0.00 kg',
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
    assert.match(res.body.error, /required fields/i);
  });

  it('POST /print/print rejects negative weight', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Neg-Weight',
        weight: -5.0,
        stationId: 'ST01',
        line1: 'NEG-150426-01-001',
        line2: 'FG-Neg-Weight | -5.00 kg',
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
  });

  it('POST /print/print rejects NaN weight', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-NaN-Weight',
        weight: 'not-a-number',
        stationId: 'ST01',
        line1: 'NAN-150426-01-001',
        line2: 'FG-NaN-Weight',
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
  });

  it('POST /print/print rejects Infinity weight', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Inf-Weight',
        weight: Infinity,
        stationId: 'ST01',
        line1: 'INF-150426-01-001',
        line2: 'FG-Inf-Weight',
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
  });

  it('POST /print/print passes sendTimeoutMs from config to driver.send()', async () => {
    const driver = new MockDriver();
    const customConfig = { ...mockConfig, sendTimeoutMs: 2500 };
    const app = createServer(driver, customConfig);

    await request(app)
      .post('/print/print')
      .send({
        product: 'FG-Timeout-Test',
        weight: 10.0,
        stationId: 'ST01',
        line1: 'TMO-150426-01-001',
        line2: 'FG-Timeout-Test | 10.00 kg',
      });

    assert.equal(driver.lastSendTimeoutMs, 2500);
  });
});
