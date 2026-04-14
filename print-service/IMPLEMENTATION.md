# Phase 2: Print Service - Complete Implementation

## Summary

Phase 2 is fully implemented and ready for testing with your TVS LP NEO 46 printer.

**What was built:**
- Multi-printer driver architecture (extensible for future: ZPL, ESCPOS, CUPS)
- TSPL driver for TVS LP NEO 46 and TSC printers
- Express API on port 5001 with print and health endpoints
- Built-in duplicate print prevention (2-second window)
- Full TypeScript implementation with types
- Comprehensive test suite (13 tests)
- Manual test script for hardware validation

---

## Project Structure

```
print-service/
├── package.json              # Dependencies: express, cors, dotenv, pino, supertest
├── tsconfig.json             # TypeScript config
├── .env                       # Configuration (populated)
├── .env.example               # Configuration template
├── src/
│   ├── index.ts              # Entry point - wires everything
│   ├── config.ts             # Load + validate .env
│   ├── types.ts              # Shared interfaces for Driver contract
│   ├── drivers/
│   │   ├── index.ts          # Driver factory
│   │   └── tspl.ts           # TSPL command builder + USB sender
│   ├── api/
│   │   ├── server.ts         # Express app with middleware
│   │   └── routes/
│   │       └── print.ts      # POST /print, GET /health
│   └── utils/
│       └── logger.ts         # Pino logger wrapper
├── test/
│   ├── tspl.test.ts          # 4 tests: TSPL command generation
│   └── api.test.ts           # 9 tests: API endpoints, validation, dedup
└── scripts/
    └── test-print.ts         # Manual script to send test label
```

---

## API Endpoints

### POST /print

**Request:**
```json
{
  "product": "FG-White-Cement-50kg",
  "weight": 25.45,
  "stationId": "ST01",
  "qrContent": "CUSTOM_CONTENT",        // Optional
  "labelWidth": 50,                      // Optional (mm)
  "labelHeight": 30                      // Optional (mm)
}
```

**Response (200 - Success):**
```json
{
  "status": "ok",
  "entryId": "ST01-20260413-143522",
  "printedAt": "2026-04-13T14:35:22.000Z"
}
```

**Response (503 - Printer Error):**
```json
{
  "status": "error",
  "error": "Printer error: Device not found"
}
```

**Response (429 - Duplicate Request):**
```json
{
  "status": "error",
  "error": "Duplicate print request. Please wait before printing again."
}
```

---

### GET /print/health

**Response (200 - Connected):**
```json
{
  "printer": {
    "driver": "tspl",
    "device": "/dev/usb/lp0",
    "connected": true
  },
  "service": "print-service",
  "stationId": "ST01",
  "status": "ok"
}
```

**Response (503 - Disconnected):**
```json
{
  "printer": {
    "driver": "tspl",
    "device": "/dev/usb/lp0",
    "connected": false
  },
  "service": "print-service",
  "stationId": "ST01",
  "status": "error"
}
```

---

### GET /health

Root-level health check (same as /print/health)

---

## Configuration (.env)

```env
STATION_ID=ST01                    # Factory station ID
PRINTER_DRIVER=tspl                # Driver type: tspl (TSPL/TSPL2), zpl (future)
PRINTER_DEVICE=/dev/usb/lp0        # Device path
PRINTER_LABEL_WIDTH=50             # Label width (mm)
PRINTER_LABEL_HEIGHT=30            # Label height (mm)
PRINTER_DPI=203                    # Printer resolution (TVS LP NEO 46 = 203 DPI)
PRINT_API_PORT=5001                # API port
LOG_LEVEL=info                     # Logging level
```

---

## TSPL Label Format

Generated TSPL commands for a 50x30mm label:

```
SIZE 50 mm, 30 mm
GAP 2 mm, 0 mm
CLS
QRCODE 30,20,H,6,A,0,"FG-White-Cement-50kg|25.45kg|ST01|2026-04-13T14:35:22"
TEXT 30,120,"3",0,1,1,"FG-White-Cement-50kg"
TEXT 30,155,"3",0,1,1,"25.45 kg | ST01 | 13-Apr-2026"
PRINT 1,1
```

**Layout:**
- QR Code: 50x50 dots (~12mm at 203 DPI), positioned at (30, 20)
- Text Line 1: Product name, y=120
- Text Line 2: Weight | Station | Date, y=155
- Print: 1 copy, 1 set

---

## How to Run

### Development Mode
```bash
npm run dev --workspace=print-service
```
Watches for file changes and auto-restarts.

### Production Mode
```bash
npm start --workspace=print-service
```

### Run Tests
```bash
npm test --workspace=print-service
```
Expected: 13 tests pass (4 TSPL, 9 API)

### Manual Test Print
```bash
npm run test-print --workspace=print-service
```
Sends a test label to the printer. Requires print-service running on localhost:5001.

---

## Multi-Printer Architecture

The driver pattern allows easy support for multiple printer types:

```typescript
interface PrinterDriver {
  buildLabel(data: LabelData): Buffer;
  send(commands: Buffer): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

Currently implemented:
- **TSPLDriver**: TVS LP NEO 46, TSC printers

Future drivers can be added to `src/drivers/`:
- **ZPLDriver**: Zebra printers
- **ESCPOSDriver**: Receipt printers
- **CUPSDriver**: Network printers (OS integration)

---

## Safety Features

1. **Request Validation**: product, weight, stationId are required
2. **Duplicate Prevention**: Same request rejected within 2 seconds
3. **Entry ID Uniqueness**: Generated as `STATION_ID-DATE-TIME` (e.g., ST01-20260413-143522)
4. **Error Handling**: Printer errors return 503 with clear messages
5. **Health Checks**: On startup and via /health endpoint

---

## Integration with Weight Service & Frontend

**Flow from weight service:**
1. Weight Service (port 5000) captures weight from scale
2. Frontend displays live weight + stable weight
3. User selects product and clicks PRINT
4. Frontend calls `POST http://localhost:5001/print` with product, weight, stationId
5. Print Service generates QR, sends TSPL, returns entryId
6. Frontend confirms success to user

**Status codes for frontend:**
- 200: Print successful → show "Printed! ✓"
- 429: Duplicate → show "Already printing, please wait"
- 503: Printer error → show "Printer disconnected. Check connection."

---

## Testing

### Unit Tests (4 tests)
- TSPL command structure validation
- Multiple text lines handling
- Custom label dimensions

### API Tests (9 tests)
- POST /print success case
- Field validation (product, weight, stationId required)
- Duplicate request rejection
- Custom QR content override
- Custom label dimensions override
- Printer error handling (503)
- GET /health with connected printer
- GET /health with disconnected printer
- Health endpoint includes driver info

All tests use mock driver (no real printer required).

---

## Next Steps

1. **Verify hardware**: Connect TPV LP NEO 46 to `/dev/usb/lp0`
2. **Run service**: `npm run dev --workspace=print-service`
3. **Test print**: `npm run test-print --workspace=print-service`
4. **Verify label**: Check physical output on printer
5. **Adjust TSPL** if needed: Modify positioning (x, y) or font size in `src/drivers/tspl.ts`

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| "Printer not connected" | Is `/dev/usb/lp0` accessible? Run `ls -l /dev/usb/lp0` |
| TSPL commands sent but no print | Wrong baud rate or printer settings (usually 9600) |
| Label position off-center | Adjust QR position (30, 20) and text positions (x, y) in tspl.ts |
| QR not readable | Increase qrSize (currently 6) or verify format in buildLabel() |

---

## Files Created

- `src/types.ts` — LabelData, PrintRequest/Response, PrinterDriver interface
- `src/config.ts` — Load and validate .env
- `src/utils/logger.ts` — Pino logger
- `src/drivers/index.ts` — Driver factory
- `src/drivers/tspl.ts` — TSPL command generator + USB sender
- `src/api/server.ts` — Express app setup
- `src/api/routes/print.ts` — POST /print, GET /health handlers
- `src/index.ts` — Entry point
- `test/tspl.test.ts` — 4 TSPL tests
- `test/api.test.ts` — 9 API tests
- `scripts/test-print.ts` — Manual test script
- `package.json`, `tsconfig.json`, `.env`, `.env.example`
