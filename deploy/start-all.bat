@echo off
:: ============================================================
:: Smart Weight System — Start All Services
:: ============================================================
:: Double-click or run from cmd to start all 4 services via PM2.
:: After starting, opens the web-ui in the default browser.
:: ============================================================

title Smart Weight System — Starting...

:: Navigate to repo root (one level up from deploy/)
cd /d "%~dp0.."

echo.
echo  Smart Weight System — Starting Services
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

:: Start all services
echo.
echo  Starting services...
pm2 start deploy\ecosystem.config.js
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Failed to start services.
    pause
    exit /b 1
)

:: Save PM2 process list (for auto-restart on reboot)
pm2 save

echo.
echo  All services started. Waiting 3 seconds for boot...
timeout /t 3 /nobreak >nul

:: Show status
pm2 status

:: Open browser to web-ui
echo.
echo  Opening web-ui in browser...
start http://localhost:3000

echo.
echo  Done. Close this window or press any key.
pause >nul
