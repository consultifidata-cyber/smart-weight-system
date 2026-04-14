/**
 * Manual test script: send a sample print job to the print service.
 * Usage: npm run test-print
 */

import http from 'http';

const API_URL = 'http://localhost:5001/print';

const testData = {
  product: 'FG-White-Cement-50kg',
  weight: 25.45,
  stationId: 'ST01',
  // Optionally override label dimensions:
  // labelWidth: 50,
  // labelHeight: 30,
};

function post(url: string, data: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(data));
    req.end();
  });
}

async function main() {
  console.log('Sending test print request to', API_URL);
  console.log('Payload:', JSON.stringify(testData, null, 2));

  try {
    const result = await post(API_URL, testData);
    console.log('Response:', JSON.stringify(result, null, 2));

    if (result.status === 'ok') {
      console.log('✓ Print successful! Entry ID:', result.entryId);
    } else {
      console.error('✗ Print failed:', result.error);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('✗ Request failed:', error);
    console.error('Make sure the print service is running: npm run dev');
  }
}

main();
