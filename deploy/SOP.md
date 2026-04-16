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

### 3.2 Git

1. Download from https://git-scm.com/download/win
2. Run the installer with default options
3. Verify: open Command Prompt and run:
   ```
   git --version
   ```

### 3.3 Restart the Computer

After installing Node.js and Git, **restart the computer** to ensure PATH updates take effect.

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
   - Install PM2 globally
   - Create the `.env` file
   - Install all npm dependencies
   - Start all 4 services
   - Configure auto-start on Windows boot
   - Create a desktop shortcut
   - Open the web-ui in the browser

6. You should see the Smart Weight System UI in the browser.

---

## 7. Verify the Setup

After installation, run through this checklist:

### 7.1 Services Running

Open Command Prompt and run:
```
pm2 status
```

You should see 4 services, all with status **online**:

```
┌──────────────────┬────┬──────┬────────┐
│ name             │ id │ mode │ status │
├──────────────────┼────┼──────┼────────┤
│ weight-service   │ 0  │ fork │ online │
│ print-service    │ 1  │ fork │ online │
│ sync-service     │ 2  │ fork │ online │
│ web-ui           │ 3  │ fork │ online │
└──────────────────┴────┴──────┴────────┘
```

### 7.2 Health Check

Double-click `deploy\health-check.bat` or run:
```
deploy\health-check.bat
```

All 4 endpoints should return **HTTP 200**.

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

### 7.6 Reboot Test

1. Restart the computer
2. After Windows loads, wait 30 seconds
3. Open http://localhost:3000 — the web-ui should load automatically
4. Check `pm2 status` — all services should be online

---

## 8. Troubleshooting

### Service won't start

```bash
# Check logs for the failing service
pm2 logs weight-service --lines 50

# Restart a single service
pm2 restart weight-service

# Restart all services
pm2 restart all
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

1. Check the startup shortcut exists:
   - Press `Win + R` → type `shell:startup` → Enter
   - You should see `SmartWeightSystem.lnk`
2. If missing, run the installer again or manually create a shortcut:
   - Right-click on desktop → New → Shortcut
   - Target: `C:\smart-weight-system\deploy\start-all.bat`
   - Move the shortcut to the Startup folder

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

Normally auto-starts on boot. If not running:
- Double-click **deploy\start-all.bat**, or
- Double-click the **Smart Weight System** desktop shortcut

### Checking Status

- Double-click **deploy\health-check.bat** for a full diagnostics report
- Or run `pm2 status` in Command Prompt

### Viewing Logs

```bash
# Live logs (all services)
pm2 logs

# Specific service logs
pm2 logs sync-service

# Last 100 lines
pm2 logs --lines 100
```

### Stopping the System

- Double-click **deploy\stop-all.bat**, or
- Run `pm2 stop all` in Command Prompt

---

## 10. Updating to a New Version

When a new version is pushed to GitHub:

1. Double-click **deploy\update.bat**, or run manually:
   ```
   cd C:\smart-weight-system
   git pull origin main
   npm install
   pm2 restart all
   ```

2. Verify with `deploy\health-check.bat`

**Note:** The `.env` file is in `.gitignore` — your station config is preserved during updates.

---

## Quick Reference Card

Print this and stick it near the station.

| Action | How |
|--------|-----|
| Open web-ui | Double-click **Smart Weight System** on desktop |
| Start services | Double-click **deploy\start-all.bat** |
| Stop services | Double-click **deploy\stop-all.bat** |
| Health check | Double-click **deploy\health-check.bat** |
| Update code | Double-click **deploy\update.bat** |
| View logs | Command Prompt → `pm2 logs` |
| Restart one service | Command Prompt → `pm2 restart weight-service` |
| Check sync status | Browser → http://localhost:5002/sync/status |
