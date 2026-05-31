# NextCross Print Queue Contract

Production print flow:

```text
PWA / Browser / Mobile / Desktop
  -> Backend API
  -> Print queue
  -> Cashier Electron Print App
  -> Thermal printer
```

The PWA must not print directly in production. It creates a backend print job. The Electron Print App installed at the cashier desk claims and prints jobs for its own branch/device.

## PrintJob Model

```ts
type PrintJob = {
  id: string;
  branchId: string;
  deviceId?: string | null;
  type: "entry-receipt" | "exit-receipt" | "test";
  status: "pending" | "printing" | "printed" | "failed";
  payload: unknown;
  raw?: string | null;
  attempts: number;
  errorMessage?: string | null;
  claimedByDeviceId?: string | null;
  claimedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  printedAt?: string | null;
};
```

For the current low-risk rollout, `raw` can be created by the existing frontend ESC/POS builder and stored on the job. Long term, keep receipt rendering in one shared backend/Electron package and store only `payload`.

## Endpoints

### `POST /api/print-jobs`

Frontend creates a job.

Request:

```json
{
  "branchId": "branch-1",
  "deviceId": "kassa-1",
  "type": "entry-receipt",
  "payload": {
    "registrationId": "A-001",
    "date": "2026-05-30 15:43",
    "driverName": "Elvin Mammadov",
    "phone": "+994 50 123 45 67",
    "vehicleType": "Nomreli",
    "plateNumber": "10-AA-123",
    "brand": "Mercedes-Benz Actros",
    "qrValue": "https://nextcross.az/qr/A-001"
  },
  "raw": "...ESC/POS string..."
}
```

Server sets:

```json
{
  "status": "pending",
  "attempts": 0,
  "createdAt": "server time",
  "updatedAt": "server time"
}
```

### `POST /api/print-jobs/claim`

Electron atomically claims one job. This endpoint is the important mutex.

Request:

```json
{
  "branchId": "branch-1",
  "deviceId": "kassa-1",
  "maxAttempts": 3,
  "stalePrintingMs": 120000
}
```

Matching rule:

- `branchId` must match.
- If a job has `deviceId`, it can only be claimed by that device.
- If a job has no `deviceId`, any device in the branch can claim it.
- Only `pending` jobs with `attempts < maxAttempts` are eligible.
- Optional retry: a `printing` job older than `stalePrintingMs` can be moved back into claim logic if `attempts < maxAttempts`.

Atomic behavior:

1. Select one eligible job ordered by `createdAt`.
2. In the same transaction/update, set:
   - `status = "printing"`
   - `attempts = attempts + 1`
   - `claimedByDeviceId = request.deviceId`
   - `claimedAt = now`
   - `updatedAt = now`
3. Return that job.

SQL-style shape:

```sql
UPDATE print_jobs
SET status = 'printing',
    attempts = attempts + 1,
    claimed_by_device_id = :deviceId,
    claimed_at = NOW(),
    updated_at = NOW()
WHERE id = (
  SELECT id
  FROM print_jobs
  WHERE branch_id = :branchId
    AND (device_id IS NULL OR device_id = :deviceId)
    AND attempts < :maxAttempts
    AND (
      status = 'pending'
      OR (status = 'printing' AND claimed_at < :staleBefore)
    )
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

If there is no job, return `204 No Content` or `{ "job": null }`.

### `POST /api/print-jobs/:id/printed`

Electron marks a physically printed job.

Request:

```json
{
  "deviceId": "kassa-1",
  "printedAt": "2026-05-30T12:00:00.000Z"
}
```

Only allow transition from `printing` to `printed` for the claiming device.

### `POST /api/print-jobs/:id/failed`

Electron marks a failed job.

Request:

```json
{
  "deviceId": "kassa-1",
  "errorMessage": "Printer not found"
}
```

Recommended server behavior:

- If `attempts < maxAttempts`, set `status = "pending"` and keep `errorMessage`.
- If attempts reached max, set `status = "failed"`.
- Always update `updatedAt`.

### `GET /api/print-jobs/status?branchId=...`

Optional monitor endpoint for dashboards/tray status. Return recent counts and latest failed jobs.

## Reliability Rules

- Claim must be atomic; never implement `GET pending` followed by a separate update.
- Electron prints one claimed job at a time.
- Backend owns retry limits and stale `printing` recovery.
- Electron should not crash when backend is unreachable; it should poll again.
- If a physical print succeeds but `printed` update fails, Electron should keep retrying the `printed` update before claiming another job.
- CORS for backend queue should allow only trusted frontend origins.

## Current Adapter Choices

- Frontend production mode creates a job at `/print-jobs` under `VITE_BASE_API`.
- Frontend development mode defaults to direct local bridge printing.
- Electron worker is disabled until `PRINT_API_BASE_URL` and `PRINT_BRANCH_ID` are configured.
- Electron worker prints `job.raw` through the embedded local `127.0.0.1:9191` bridge, preserving the existing Windows raw ESC/POS implementation.
