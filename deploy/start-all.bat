@echo off
:: ============================================================
:: Smart Weight System -- Start All Services
:: ============================================================
:: Double-click or run from cmd to start all 4 services via PM2.
:: After starting, opens the web-ui in the default browser.
:: ============================================================

title Smart Weight System -- Starting...

:: Navigate to repo root (one level up from deploy/)
cd /d "%~dp0.."

echo.
echo  Smart Weight System -- Starting Services
echo  ========================================

:: Check if PM2 is available
where pm2 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] PM2 is not installed or not in PATH.
    echo  Run: npm install -g pm2
    pause
    exit /b 1
)

:: Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

:: Kill existing PM2 daemon (may be in interactive or Session 0)
echo.
echo  Stopping existing PM2 daemon...
pm2 kill >nul 2>&1

:: Restart PM2 via the Scheduled Task so the daemon runs in Session 0
:: (non-interactive) -- this prevents CMD window flashing from PM2's
:: internal wmic monitoring calls.
echo  Starting services via Scheduled Task (Session 0)...
schtasks /run /tn "SmartWeightPM2" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [WARN] Scheduled Task not found. Starting directly...
    echo         Run deploy\install.ps1 to set up the task.
    pm2 start deploy\ecosystem.config.js
    pm2 save
)

echo.
echo  Waiting 5 seconds for services to boot...
timeout /t 5 /nobreak >nul

:: Show status
pm2 status

:: Open browser to web-ui
echo.
echo  Opening web-ui in browser...
start http://localhost:3000

echo.
echo  Done. Close this window or press any key.
pause >nul
