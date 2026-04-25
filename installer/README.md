# Smart Weight System — Installer

Builds `SmartWeightSetup.exe` using Inno Setup 6.

## Services

All five services run under a single Windows Service (`SmartWeightSystem`) managed by **NSSM**.
NSSM starts `deploy/launcher.js`, which in turn spawns and supervises all five child processes
with exponential-backoff crash recovery.

| Service | Port | Log files | Description |
|---------|------|-----------|-------------|
| web-ui | 3000 | `logs/web-ui-{out,error}.log` | Operator weighing UI; also serves Dispatch UI at `/dispatch/` |
| dispatch-service | 4000 | `logs/dispatch-service-{out,error}.log` | Truck loading scan API — binds `0.0.0.0` so Laptop B can reach it on the LAN |
| weight-service | 5000 | `logs/weight-service-{out,error}.log` | Reads the weighing scale over USB-serial |
| print-service | 5001 | `logs/print-service-{out,error}.log` | Sends TSPL label jobs to the USB label printer |
| sync-service | 5002 | `logs/sync-service-{out,error}.log` | Runs SQLite migrations on startup; syncs bags and dispatches to Django ERP |

Additional logs:
- `logs/launcher.log` — launcher's own log (restarts, crash counts, startup)
- `logs/launcher-svc.log` — NSSM capture of launcher stdout
- `logs/db-backups/` — daily SQLite backups (7 copies)

Log rotation: 10 MB per file, 3 rotations, rotated while running.

## Accessing the Dispatch UI from Laptop B

The Dispatch screen is opened on the **scanning laptop (Laptop B)**, not on Laptop A.

From Laptop B, navigate to:
```
http://<Laptop-A-IP>:3000/dispatch/
```

Find Laptop A's IP: on Laptop A, run `ipconfig` in Command Prompt and look for the
`IPv4 Address` on the active network adapter (e.g. `192.168.1.50`).

Port 4000 (dispatch-service) is the backend API used internally by that page.

## Build

```
iscc setup.iss /DAppVersion=1.1.0
```

CI builds automatically on `git push --tags v1.1.0`.

## Files layout

```
installer/
  setup.iss              Inno Setup script
  assets/
    node-runtime/        Portable Node.js — staged by CI before iscc runs
    tools/nssm.exe       NSSM — staged by CI
  tools/
    install-service.ps1  Registers SmartWeightSystem NSSM service
    remove-service.ps1   Stops + unregisters the service + removes firewall rules
    add-firewall-rules.ps1  Creates inbound TCP allow rules for all 6 ports
    detect-hardware.ps1  Detects printers and COM ports for the wizard
    generate-env.ps1     Writes .env from wizard inputs
    service-status.ps1   Prints NSSM + launcher health summary
    health-report.ps1    Bundles logs + DB stats into a zip for support
  Output/
    SmartWeightSetup.exe  Built by CI
```

## Version history

| Version | Changes |
|---------|---------|
| 1.1.0 | Dispatch module (Phases DA–DF): offline truck loading, barcode scanning, Django push, party master pull |
| 1.0.0 | Initial production release: weight + print + sync + web-ui |
