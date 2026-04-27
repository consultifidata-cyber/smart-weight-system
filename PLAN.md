# Plan — Multi-Station Dispatch

## Recommendation

**Use Plan A. Django is already the hub — no new infrastructure needed.**
Every bag packed on ST01 or ST02 is already pushed to Django by sync-service,
with QR code, weight, product, and worker code. The only broken thing is one
function in dispatch-service: `getBagByQr(qrCode)` queries the local SQLite
`fg_bag` table, which only contains bags packed on *this* machine. The fix is
to replace that one lookup with a Django HTTP call (with local SQLite as the
offline fallback). That is ~40 lines across 2 files, no migrations, no schema
changes, no new infrastructure. Plan B (shared SQLite over SMB) is unsafe for
concurrent writes. Plan C (Postgres) is days of work. Do Plan A.

---

## 1. Current state of sync-service

### What it does

sync-service runs on every station laptop. On every bag print:

1. A bag is inserted into local SQLite `fg_bag` with `synced = 0`.
2. Within ~1 second, `syncBagNow()` fires a cycle:
   - **Step A**: registers the session with Django via `POST /api/station/open-session/`
     → gets a `doc_id` back.
   - **Step B**: pushes the bag via `POST /api/station/add-bag/` with:
     - `doc_id`, `item_id`, `pack_config_id`, `qr_code`, `actual_weight_gm`
     - `worker_code_1`, `worker_code_2`, `idempotency_key`
   - On success: marks `fg_bag.synced = 1`, stores `fg_bag.line_id` (Django's PK).

3. **Background loop** (every 10s): any bags still at `synced = 0` are retried.

### Retry behaviour

- **No maximum retry limit** for individual bags — they retry forever until
  Django confirms.
- `sync_attempts` counter on each bag increments on every failure.
- High retry count logs a warning at attempt 5+.
- **Offline resilience**: if Django is unreachable, the bag stays `synced = 0`
  in local SQLite and is retried on the next 10-second cycle. Packing never
  stops — the operator can keep printing, and all bags sync automatically when
  connectivity returns.

### What Django actually receives

Every confirmed bag in Django has: `qr_code`, `actual_weight_gm`, `pack_config_id`,
`item_id`, `worker_code_1`, `worker_code_2`. The QR code is unique and
station-independent (format: `PACKNAME-DATE-DAYSEQ-BAGNUM`).

### The gap: no station_id filter on dispatch

`dispatch_doc` has `plant_id` but **no `station_id` column**. `dispatch_line`
has `qr_code` and `source` (LOCAL | EXTERNAL). There is no cross-station
bag ownership tracking in the dispatch tables.

---

## 2. Current state of dispatch-service

### The single broken function

`dispatch-service/src/api/routes/dispatch.ts`, **line 181**:

```typescript
const bag = queries.getBagByQr(qr);
```

This calls `dispatch-service/src/db/queries.ts`, line 261:

```typescript
getBagByQr(qrCode: string): FgBagRow | undefined {
  return this._getBagByQr.get(qrCode) as FgBagRow | undefined;
}
```

Which runs this SQL (lines 181–188):

```sql
SELECT b.bag_id, b.actual_weight_gm, b.pack_config_id, b.item_id, b.qr_code,
       p.pack_name
FROM   fg_bag         b
LEFT   JOIN fg_pack_config p ON p.pack_id = b.pack_config_id
WHERE  b.qr_code = ?
LIMIT  1
```

**This queries local SQLite only.** If the bag was packed on ST02 but the
dispatch laptop is pointing at ST01's dispatch-service, `getBagByQr()` returns
`undefined`.

### What happens on a cross-station scan today

When `getBagByQr()` returns `null` (lines 185–202 of dispatch.ts):

```
source = 'EXTERNAL'
color  = 'orange'
message = 'QR not in local records — may be from another station'
actual_weight_gm = 0   ← weight missing from dispatch totals
pack_name = null        ← no product name
```

The bag IS recorded in `dispatch_line`, but with zero weight and no product
info. The dispatch total weight is **understated**. The SKU summary shows
nothing for that bag.

### What the scan returns for a LOCAL bag (working case)

```json
{
  "result": "SUCCESS",
  "color": "green",
  "bag": {
    "pack_name": "Rice 5kg",
    "actual_weight_gm": 5020
  }
}
```

### The one caller

`getBagByQr()` is called in **exactly one place**:
`dispatch-service/src/api/routes/dispatch.ts`, line 181.
No other code in the dispatch-service touches this function.

---

## 3. Django: what it has, what it lacks

### What Django already has (after sync)

- Every bag from every station: QR code, weight, product, worker
- Available via `GET /api/station/add-bag/` records (bags are in Django's
  `FGProductionLine` model linked to `FGProductionDoc`)
- `qr_code` is unique across all stations

### What Django lacks right now

**There is no `GET /api/station/bag-by-qr/?qr=<code>` endpoint.**

The Django side was built to *receive* bags from stations, not to *serve*
bag lookups back. To implement Plan A, one lightweight Django view needs to
be added. It would:

- Accept `GET /api/station/bag-by-qr/?qr=<code>`
- Query `FGProductionLine` where `qr_code = code`
- Return: `{ qr_code, actual_weight_gm, pack_name, pack_config_id, item_id }`
- Require station token auth (same `@station_token_required` as existing endpoints)
- Return 404 if not found (bag not yet synced or invalid QR)

This is a ~20-line Django view — same pattern as the existing station endpoints.

---

## 4. Offline behaviour

### Current (packing)

When Django is unreachable:
- `bags/add` still works: bag goes into local SQLite immediately, response is
  instant, operator sees "Print Success"
- sync-service retries in background, no operator action needed
- Bags accumulate at `synced = 0` and flush automatically when Django returns

**Packing is fully offline-capable today. This does not change.**

### For the new dispatch Django lookup

Three fallback options when Django is unreachable during a scan:

**Option A — Fall back to local SQLite**
If Django times out, check local `fg_bag`. Works for bags from this station,
shows EXTERNAL/orange for bags from other stations. Same as today's behaviour.
Safe, no data loss, operator sees orange for cross-station bags.

**Option B — Queue as pending verification**
Accept the scan, mark it `pending_verification`, sync when Django returns.
Complex to implement, introduces a new state machine.

**Option C — Block the scan with an error**
Return an error message. Forces operator to wait. Unacceptable on a factory
floor.

**Recommendation: Option A.** It degrades gracefully to today's working
behaviour. During a Wi-Fi blip, cross-station bags show orange instead of
green. This is honest (the weight is genuinely unknown offline) and the operator
can keep working. When connectivity returns, nothing needs to be replayed.

---

## 5. Plan A / B / C — honest estimates

### Plan A — Django is the hub (RECOMMENDED)

**What changes:**
1. Add `GET /api/station/bag-by-qr/` to Django (~20 lines, 1 file)
2. Modify `dispatch-service/src/api/routes/dispatch.ts` (~30 lines):
   - Before calling `getBagByQr(qr)`, call the Django endpoint
   - If Django returns the bag: use it (GREEN)
   - If Django returns 404: bag not synced yet — try local SQLite, then EXTERNAL
   - If Django times out: fall back to local SQLite
3. No migrations, no new tables, no schema changes

**Files touched:** 2 (1 Django, 1 TypeScript)
**Lines of code:** ~50 total
**Hours:** 2–3 hours including manual testing
**Tests needed:** 3 test cases (Django found, Django 404, Django timeout)

**Risk:** The one risk is Django response latency adding ~100ms to each scan.
For a warehouse scanner, 100ms is imperceptible.

**Tomorrow-ready:** Yes. This is the smallest possible change. The rest of the
system is untouched.

**Rollback:** Revert the 30-line TypeScript change. Dispatch-service falls back
to local-only behaviour. ST01 bags work as before.

---

### Plan B — ST01 SQLite shared over SMB

**What changes:** Set `DB_PATH=\\ST01\smartweight\fg_production.db` on every
other station.

**Effort:** 30 minutes

**Risk:** **HIGH.** SQLite is a file-based database. Concurrent writes from
ST01 and ST02 over a network share cause database corruption under any realistic
packing load. Two stations printing bags simultaneously = two writers = possible
corruption. Microsoft explicitly warns against this. One corrupted database
means data loss for the entire shift.

**Tomorrow-ready:** Technically yes, practically no — the corruption risk is
unacceptable in production.

**Rollback:** Restore individual DB_PATH values. But if the DB is corrupted,
there is nothing to roll back to.

---

### Plan C — PostgreSQL on ST01

**What changes:** Migrate from SQLite to PostgreSQL. Rewrite all
`better-sqlite3` calls to `pg` (node-postgres). Create new schema. Export
existing data. Update all 5 services.

**Effort:** 3–5 days minimum, properly tested

**Risk:** HIGH. Every service changes. Every query changes. All tests need
rewriting.

**Tomorrow-ready:** No.

**Rollback:** Keep SQLite services running in parallel during transition.

---

## 6. Recommended implementation steps (Plan A, file by file)

**Step 1 — Django (Balaji-Foods-Live repo, ~20 lines)**

File: `station_api/views.py` (or wherever existing station endpoints live)

Add a new view:
```python
@station_token_required
def bag_by_qr(request):
    qr = request.GET.get('qr', '').strip().upper()
    if not qr:
        return JsonResponse({'error': 'qr required'}, status=400)
    try:
        line = FGProductionLine.objects.select_related('doc__pack_config').get(qr_code=qr)
        return JsonResponse({
            'qr_code':          line.qr_code,
            'actual_weight_gm': line.actual_weight_gm,
            'pack_name':        line.doc.pack_config.pack_name if line.doc.pack_config else None,
            'pack_config_id':   line.doc.pack_config_id,
            'item_id':          line.doc.item_id,
        })
    except FGProductionLine.DoesNotExist:
        return JsonResponse({'error': 'not_found'}, status=404)
```

Wire in `urls.py`:
```python
path('api/station/bag-by-qr/', views.bag_by_qr),
```

**Step 2 — dispatch-service client method (~15 lines)**

File: `dispatch-service/src/db/connection.ts` or a new
`dispatch-service/src/sync/djangoClient.ts`

Add one function:
```typescript
async function lookupBagByQr(
  djangoUrl: string, token: string, qrCode: string
): Promise<FgBagRow | null> {
  const url = `${djangoUrl}/api/station/bag-by-qr/?qr=${encodeURIComponent(qrCode)}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Token ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Django bag lookup failed: ${res.status}`);
  return await res.json() as FgBagRow;
}
```

**Step 3 — dispatch-service scan handler (~20 lines changed)**

File: `dispatch-service/src/api/routes/dispatch.ts`, around line 181

Replace:
```typescript
const bag = queries.getBagByQr(qr);
```

With:
```typescript
let bag: FgBagRow | undefined = undefined;
// 1. Try Django first (authoritative — sees all stations)
try {
  const djangoBag = await lookupBagByQr(config.djangoServerUrl, config.djangoApiToken, qr);
  if (djangoBag) bag = djangoBag;
} catch {
  // Django unreachable — fall back to local SQLite (offline mode)
  bag = queries.getBagByQr(qr);
}
// 2. If not in Django, check local SQLite (bag may not be synced yet)
if (!bag) {
  bag = queries.getBagByQr(qr);
}
```

The rest of the scan handler (GREEN/ORANGE logic) is **unchanged**.

---

## Risks and rollback plan

### What could go wrong

1. **Django endpoint missing** — Django 404 on lookup → dispatch falls back to
   local SQLite → cross-station bags show ORANGE. Degrades gracefully.
   Fix: deploy Django endpoint.

2. **Django slow** — timeout of 3s exceeded → falls back to local SQLite.
   Same graceful degradation.

3. **Bag not yet synced** — operator packs a bag, scans it immediately before
   the 10-second sync cycle runs → Django 404 → local SQLite has it → GREEN.
   Works correctly because the fallback chain covers this.

4. **QR format mismatch** — if Django normalises QR codes differently (case).
   Mitigation: both client and Django should `.toUpperCase()` before lookup.

### Rollback

If the Django endpoint breaks or causes issues: remove 20 lines from the
dispatch-service TypeScript. The function reverts to `getBagByQr(qr)` only —
local SQLite, cross-station bags show ORANGE. Factory can keep working.

The Django endpoint change is additive (new URL, no existing endpoint touched)
so it can stay deployed without harm even if dispatch-service reverts.

---

*Report generated: 2026-04-27. No code changes made.*
