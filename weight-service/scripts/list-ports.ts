import { SerialPort } from 'serialport';

async function main(): Promise<void> {
  const ports = await SerialPort.list();

  if (ports.length === 0) {
    console.log('No serial ports found.');
    return;
  }

  console.log('Available serial ports:\n');
  for (const port of ports) {
    const parts: string[] = [`  ${port.path}`];
    if (port.manufacturer) parts.push(`manufacturer: ${port.manufacturer}`);
    if (port.serialNumber) parts.push(`serial: ${port.serialNumber}`);
    if (port.vendorId) parts.push(`vendorId: ${port.vendorId}`);
    if (port.productId) parts.push(`productId: ${port.productId}`);
    console.log(parts.join(' | '));
  }
}

main().catch(console.error);
