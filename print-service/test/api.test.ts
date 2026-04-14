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

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }
}

const mockConfig: PrinterConfig = {
  driver: 'tspl',
  device: '/dev/usb/lp0',
  labelWidth: 50,
  labelHeight: 30,
  dpi: 203,
  stationId: 'ST01',
  apiPort: 5001,
  logLevel: 'info',
};

describe('Print API', () => {
  it('POST /print returns 200 on success', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print')
      .send({
        product: 'FG-White-Cement-50kg',
        weight: 25.45,
        stationId: 'ST01',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.entryId);
    assert.ok(res.body.printedAt);
  });

  it('POST /print validates required fields', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print')
      .send({
        product: 'FG-White-Cement-50kg',
        // missing weight and stationId
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'error');
    assert.match(res.body.error, /required fields/i);
  });

  it('POST /print rejects duplicate requests within 2s', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const payload = {
      product: 'FG-White-Cement-50kg',
      weight: 25.45,
      stationId: 'ST01',
    };

    const res1 = await request(app).post('/print').send(payload);
    assert.equal(res1.status, 200);
    assert.equal(res1.body.status, 'ok');

    // Second request immediately after
    const res2 = await request(app).post('/print').send(payload);
    assert.equal(res2.status, 429);
    assert.equal(res2.body.status, 'error');
    assert.match(res2.body.error, /duplicate/i);
  });

  it('POST /print accepts custom QR content', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print')
      .send({
        product: 'FG-White-Cement-50kg',
        weight: 25.45,
        stationId: 'ST01',
        qrContent: 'CUSTOM_QR_CONTENT',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('POST /print accepts custom label dimensions', async () => {
    const driver = new MockDriver();
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print')
      .send({
        product: 'FG-White-Cement-50kg',
        weight: 25.45,
        stationId: 'ST01',
        labelWidth: 80,
        labelHeight: 50,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('POST /print returns 503 on printer error', async () => {
    const driver = new MockDriver({ sendError: 'Device not found' });
    const app = createServer(driver, mockConfig);

    const res = await request(app)
      .post('/print')
      .send({
        product: 'FG-White-Cement-50kg',
        weight: 25.45,
        stationId: 'ST01',
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
