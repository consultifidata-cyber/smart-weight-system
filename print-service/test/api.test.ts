import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createServer } from '../src/api/server.js';
import type { PrinterDriver, PrinterConfig } from '../src/types.js';

interface MockDriverOptions {
  healthy?: boolean;
  sendError?: string;
}

class MockDriver implements PrinterDriver {
  private healthy: boolean;
  private sendError?: string;
  public lastBuiltLabel?: Buffer;

  constructor(options: MockDriverOptions = {}) {
    this.healthy = options.healthy !== false;
    this.sendError = options.sendError;
  }

  buildLabel(data: Parameters<PrinterDriver['buildLabel']>[0]): Buffer {
    this.lastBuiltLabel = Buffer.from(JSON.stringify(data));
    return Buffer.from('MOCK_TSPL');
  }

  async send(commands: Buffer): Promise<void> {
    if (this.sendError) {
      throw new Error(this.sendError);
    }
  }

  async sendWin(commands: Buffer): Promise<void> {
    if (this.sendError) {
      throw new Error(this.sendError);
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  async healthCheckWin(): Promise<boolean> {
    return this.healthy;
  }
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
};

describe('Print API', () => {
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
});
