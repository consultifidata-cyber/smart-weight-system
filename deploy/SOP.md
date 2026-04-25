# Smart Weight System — Station Setup SOP

Standard Operating Procedure for setting up a new FG weighing station on Windows 10/11.

**Time required:** ~30 minutes per station  
**Skill level:** Basic IT (install software, plug cables, run commands)

---

## Table of Contents

1. [Hardware Checklist](#1-hardware-checklist)
2. [Hardware Setup](#2-hardware-setup)
3. [Software Prerequisites](#3-software-prerequisites)
4. [Django Admin — Register the Station](#4-django-admin--register-the-station)
5. [Clone the Code](#5-clone-the-code)
6. [Run the Installer](#6-run-the-installer)
7. [Verify the Setup](#7-verify-the-setup)
8. [Troubleshooting](#8-troubleshooting)
9. [Daily Operations](#9-daily-operations)
10. [Updating to a New Version](#10-updating-to-a-new-version)

---

## 1. Hardware Checklist

Before starting, gather these items:

| Item | Specification | Notes |
|------|--------------|-------|
| Computer | Intel i3 or better, 4GB+ RAM | Windows 10/11 |
| Touch Display | Any USB/HDMI display | Set to primary display |
| Weighing Scale | RS232 serial output | Need USB-to-Serial adapter if no COM port |
| USB-to-Serial Adapter | FTDI or CH340 chipset | Install driver first |
| Label Printer | TVS LP 46 NEO (or TSC compatible) | USB connected, TSPL protocol |
| USB Cables | As needed | For scale adapter + printer |
| Network | Ethernet or WiFi to ERP server | Static IP recommended |

---

## 2. Hardware Setup

### 2.1 Connect the Weighing Scale

1. Plug the USB-to-Serial adapter into the computer
2. Connect the serial cable from the scale to the adapter
3. Open **Device Manager** → **Ports (COM & LPT)**
4. Note the COM port number (e.g., **COM3**)
5. If the adapter doesn't appear, install its driver:
   - FTDI: https://ftdichip.com/drivers/
   - CH340: search "CH340 driver Windows"

### 2.2 Connect the Label Printer

1. Connect the printer via USB
2. Windows should auto-detect it. If not, install the driver from the manufacturer's CD/website
3. Go to **Settings → Bluetooth & devices → Printers & scanners**
4. Find the printer and note two names:
   - **Share name**: Short name (e.g., `TVSLP46NEO`) — used in Settings → Sharing
   - **Full name**: Displayed name (e.g., `SNBC TVSE LP 46 NEO BPLE`) — shown in printer list
5. **Share the printer**:
   - Right-click the printer → **Printer properties** → **Sharing** tab
   - Check **Share this printer**
   - Set a short share name (e.g., `TVSLP46NEO`)
   - Click OK

### 2.3 Test Print (Optional)

Print a test page from printer properties to confirm the printer works.

### 2.4 Network

- Connect to the same network as the Django ERP server
- Verify connectivity: open a browser and navigate to `http://<ERP_SERVER_IP>:8000/admin/`
- If you see the Django admin login, the network is working

---

## 3. Software Prerequisites

Install these on the station computer. Download links below.

### 3.1 Node.js (v18 or later)

1. Download from https://nodejs.org/ (LTS version)
2. Run the installer with default options
3. **Important**: Check the box "Automatically install necessary tools" if prompted
4. Verify: open Command Prompt and run:
   ```
   node --version
   npm --version
   ```
   Both commands should print version numbers.

### 3.2 Python (3.11 or 3.12)

Required for compiling the `better-sqlite3` native addon on Windows.

1. Download from https://www.python.org/downloads/ (3.11 or 3.12 recommended)
2. Run the installer
3. **Important**: Check the box **"Add python.exe to PATH"** on the first screen -- this is critical
4. Verify: open a **new** Command Prompt and run:
   ```
   python --version
   ```
   Should print `Python 3.11.x` or `Python 3.12.x`.

> **Note:** If `python --version` opens the Microsoft Store instead of printing a version, Python is not actually installed -- the Windows Store stub is intercepting the command. Install Python from the link above.

### 3.3 Visual Studio Build Tools (C++ compiler)

Required for compiling native Node.js addons (`better-sqlite3`, `serialport`).

1. Download **"Build Tools for Visual Studio 2022"** from https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. In the Visual Studio Installer, select the **"Desktop development with C++"** workload
3. Click Install (this downloads ~2 GB and takes a few minutes)
4. No restart is required, but close and reopen any open terminals after installation

### 3.4 Git

1. Download from https://git-scm.com/download/win
2. Run the installer with default options
3. Verify: open Command Prompt and run:
   ```
   git --version
   ```

### 3.5 Restart the Computer

After installing all prerequisites, **restart the computer** to ensure PATH updates take effect.

---

## 4. Django Admin — Register the Station

Before setting up the station software, register it in the Django ERP system.

1. Open the Django admin panel: `http://<ERP_SERVER_IP>/admin/`
2. Log in with admin credentials
3. Navigate to **Station API → Weigh Stations**
4. Click **Add Weigh Station**
5. Fill in:
   - **Station ID**: Unique ID like `ST01`, `ST02`, etc. (must match what you'll use in .env)
   - **Name**: Descriptive name (e.g., "Packing Line 1")
   - **Plant**: Select the plant
   - **Is Active**: Check this box
6. **Save** — the system will generate a **Token**
7. **Copy the Token** — you'll need it during installation

---

## 5. Clone the Code

1. Open **Command Prompt** (not PowerShell yet)
2. Navigate to where you want the code:
   ```
   cd C:\
   ```
3. Clone the repository:
   ```
   git clone https://github.com/YourOrg/smart-weight-system.git
   cd smart-weight-system
   ```

---

## 6. Run the Installer

1. Open **PowerShell as Administrator**:
   - Press `Win` key → type "PowerShell"
   - Right-click → **Run as administrator**

2. Allow script execution (one-time):
   ```powershell
   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```
   Type `Y` when prompted.

   > **Edge case (some Windows 10 builds):** If you get an error like
   > `Cannot bind parameter 'Scope'. Cannot convert value "CurrentUser"`,
   > the `-Scope CurrentUser` flag is failing to parse. Use one of these workarounds:
   >
   > **Option A** — Scope to the current process only (no admin required):
   > ```powershell
   > Set-ExecutionPolicy RemoteSigned -Scope Process
   > ```
   > This lasts only for the current PowerShell window — enough to run the installer.
   >
   > **Option B** — Run as Administrator without `-Scope`:
   > ```powershell
   > Set-ExecutionPolicy RemoteSigned
   > ```
   > This sets the machine-wide policy. Requires the PowerShell window to be running as Administrator (step 1).

3. Navigate to the repo and run the installer:
   ```powershell
   cd C:\smart-weight-system
   .\deploy\install.ps1
   ```

4. The installer will prompt for these values:

   | Prompt | What to enter | Where to find it |
   |--------|--------------|-----------------|
   | Station ID | `ST01`, `ST02`, etc. | From step 4 (Django admin) |
   | Plant ID | `A1` (or your plant code) | Django admin → Plant Master |
   | Serial port | `COM3`, `COM4`, etc. | Device Manager → Ports |
   | Printer share name | `TVSLP46NEO` | Printer sharing settings (step 2.2) |
   | Printer full name | `SNBC TVSE LP 46 NEO BPLE` | Printer properties (step 2.2) |
   | Django server URL | `http://192.168.1.100:8000` | Your ERP server IP + port |
   | Django API token | (64-char hex string) | From step 4 (Django admin) |

5. The installer will:
   - Create the `.env` file with your station settings
   - Register the `SmartWeightSystem` Windows Service (NSSM, auto-start on boot)
   - Open Windows Firewall for ports 3000, 4000, 5000, 5001, 5002
   - Start all 5 services automatically
   - Create desktop shortcuts
   - Open the web-ui in the browser

6. You should see the Smart Weight System UI in the browser.

---

## 7. Verify the Setup

After installation, run through this checklist:

### 7.1 Services Running

Open Command Prompt and run:
```
curl http://localhost:5099/health
```

All 5 services should show `"status": "running"` in the JSON response.

You can also check the Windows Service Manager: `services.msc` → look for **Smart Weight System** (should be Running, Automatic).

### 7.2 Health Check

Double-click `deploy\health-check.bat` or run:
```
deploy\health-check.bat
```

All 5 endpoints should return **HTTP 200**:

| Service | Port | URL |
|---------|------|-----|
| web-ui | 3000 | http://localhost:3000 |
| dispatch-service | 4000 | http://localhost:4000/health |
| weight-service | 5000 | http://localhost:5000/health |
| print-service | 5001 | http://localhost:5001/health |
| sync-service | 5002 | http://localhost:5002/health |

### 7.3 Scale Test

1. Open the web-ui at http://localhost:3000
2. Place a known weight on the scale
3. The weight should display on screen within 2 seconds
4. The weight indicator should turn green when stable

### 7.4 Print Test

1. Select a product from the dropdown
2. Place weight on the scale
3. Press the Print button
4. A label should print with QR code, product info, and weight

### 7.5 Sync Test

1. After printing a bag, check the sync status:
   - Open http://localhost:5002/sync/status in a browser
   - `synced_today` should increment after each session is closed
2. Verify in Django admin that the FG Production entry was created

### 7.6 Dispatch Test (Laptop B)

1. On **Laptop B**, open a browser and navigate to:
   ```
   http://<Laptop-A-IP>:3000/dispatch/
   ```
   Replace `<Laptop-A-IP>` with the IP shown by `ipconfig` on Laptop A.
2. You should see the **Truck Loading** screen.
3. Click **+ New Dispatch**, fill in truck number and customer, click **Start**.
4. Scan a bag label — it should appear green in the scan list.

### 7.7 Reboot Test

1. Restart the computer
2. After Windows loads, wait 60 seconds (first-boot AV scan may slow startup)
3. Open http://localhost:3000 — the web-ui should load automatically
4. Run `deploy\health-check.bat` — all 5 services should be healthy

---

## 8. Troubleshooting

### Service won't start

```
# Check the launcher health endpoint
curl http://localhost:5099/health

# Check service logs (replace with the failing service name)
type C:\SmartWeightSystem\logs\sync-service-error.log

# Restart all services via Windows
net stop SmartWeightSystem
net start SmartWeightSystem

# Or double-click deploy\stop-all.bat then deploy\start-all.bat
```

### Scale not reading

1. Check COM port in Device Manager
2. Verify the COM port in `.env` matches
3. Try unplugging and replugging the USB-to-Serial adapter
4. Check baud rate matches the scale setting (default: 9600)
5. Restart weight-service: `pm2 restart weight-service`

### Printer not printing

1. Print a Windows test page first (Printer Properties → Print Test Page)
2. If test page works but labels don't:
   - Verify the share name in `.env` matches the actual printer share name
   - Check: `net view \\localhost` should show the shared printer
3. Restart print-service: `pm2 restart print-service`

### Sync failing (bags not reaching Django)

1. Check sync-service logs: `pm2 logs sync-service --lines 50`
2. Common causes:
   - **Network**: Can you reach the Django server? `curl http://<ERP_IP>:8000/api/station/health/`
   - **Token**: Is the token in `.env` correct? Check Django admin → Weigh Stations
   - **Station inactive**: Is the station marked active in Django admin?
3. Sync will auto-retry. Pending sessions sync when connectivity resumes.

### Services don't auto-start after reboot

The system uses a Windows Service (NSSM), not a startup shortcut.

1. Open `services.msc` → check **Smart Weight System** is Present and set to **Automatic**
2. If the service is missing, re-run the installer (`SmartWeightSetup.exe`) — it will re-register it
3. If the service is Stopped, start it: `net start SmartWeightSystem`
4. Check `C:\SmartWeightSystem\logs\launcher-svc.log` for startup errors

### Dispatch service not reachable from Laptop B

1. Confirm Laptop A's firewall allows port 4000:
   ```
   powershell -File "C:\SmartWeightSystem\tools\add-firewall-rules.ps1"
   ```
2. From Laptop A, verify dispatch-service is running:
   ```
   curl http://localhost:4000/health
   ```
3. From Laptop B, try pinging Laptop A first: `ping <Laptop-A-IP>`
4. Both laptops must be on the same network (same WiFi or Ethernet switch)

### `npm install` fails with `gyp ERR! find Python`

This means `better-sqlite3` (a native C++ addon) could not find Python or the C++ compiler to build from source.

1. Verify Python is installed and on PATH: `python --version`
   - If it opens the Microsoft Store, Python is **not** installed (see Section 3.2)
2. Verify VS Build Tools are installed:
   - Open "Visual Studio Installer" from the Start menu
   - Confirm the "Desktop development with C++" workload is checked
3. After installing both, **close and reopen** the terminal, then re-run:
   ```
   npm install
   ```

### Port already in use

If another application is using port 5000, 5001, 5002, or 3000:
```bash
# Find what's using the port (replace 5000 with the port number)
netstat -ano | findstr :5000
```
Either close the conflicting application or change the port in `.env`.

---

## 9. Daily Operations

### Starting the System

Normally auto-starts on boot via the `SmartWeightSystem` Windows Service. If not running:
- Double-click **deploy\start-all.bat** (starts via launcher), or
- `net start SmartWeightSystem` in an Administrator command prompt

### Checking Status

- Double-click **deploy\health-check.bat** for a full diagnostics report (checks all 5 services)
- Or: `curl http://localhost:5099/health` for the launcher health JSON

### Viewing Logs

```
# View recent errors for any service (replace service name as needed)
type C:\SmartWeightSystem\logs\sync-service-error.log

# Sync/dispatch status
curl http://localhost:5002/sync/status
```

### Stopping the System

- Double-click **deploy\stop-all.bat**, or
- `net stop SmartWeightSystem` in an Administrator command prompt

---

## 10. Updating to a New Version

When a new installer is released:

**Option A — Installer upgrade (recommended for major updates)**
1. Download the new `SmartWeightSetup.exe`
2. Run as Administrator — it detects the existing install, stops the service, replaces files, and restarts
3. Your `.env`, database (`fg_production.db`), and logs are **never deleted** by the installer
4. Verify with `deploy\health-check.bat`

**Option B — Git pull (for minor updates / dev environment)**
1. Double-click **deploy\update.bat**, or run manually:
   ```
   cd C:\SmartWeightSystem
   git pull origin main
   npm install
   ```
2. Then restart the service: `net stop SmartWeightSystem && net start SmartWeightSystem`
3. Verify with `deploy\health-check.bat`

**Note:** The `.env` file is in `.gitignore` — your station config is always preserved.

---

## Quick Reference Card

Print this and stick it near the station.

| Action | How |
|--------|-----|
| Open weight station UI | Double-click **Smart Weight System** on desktop, or http://localhost:3000 |
| Open dispatch UI (Laptop B) | Browser → `http://<Laptop-A-IP>:3000/dispatch/` |
| Start services | Double-click **deploy\start-all.bat** |
| Stop services | Double-click **deploy\stop-all.bat** |
| Health check | Double-click **deploy\health-check.bat** |
| Update code | Double-click **deploy\update.bat** |
| View logs | `type C:\SmartWeightSystem\logs\<service>-error.log` |
| Restart all services | `net stop SmartWeightSystem` then `net start SmartWeightSystem` |
| Check sync status | Browser → http://localhost:5002/sync/status |
| Check dispatch sync | `curl http://localhost:5002/health` → see `dispatch` block |
