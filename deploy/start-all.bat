@echo off
setlocal enabledelayedexpansion
:: ============================================================
:: Smart Weight System -- Start All Services
:: ============================================================
:: Double-click or run from cmd to start all 5 services.
:: After starting, opens the web-ui in the default browser.
:: ============================================================

title Smart Weight System -- Starting...

:: Navigate to repo root (one level up from deploy/)
cd /d "%~dp0.."

echo.
echo  Smart Weight System -- Starting Services
echo  ========================================

:: Check if Node.js is available
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo  Download: https://nodejs.org/
    pause
    exit /b 1
)

:: Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

:: Kill existing launcher if running
if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    echo  Stopping existing launcher ^(PID !LAUNCHER_PID!^)...
    taskkill /pid !LAUNCHER_PID! /t /f >nul 2>&1
    del .launcher.pid >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: Start launcher hidden via PowerShell (no visible window)
echo.
echo  Starting services...
powershell -Command "Start-Process node -ArgumentList '\"deploy\launcher.js\"' -WorkingDirectory '%CD%' -WindowStyle Hidden"

echo.
echo  Waiting 5 seconds for services to boot...
timeout /t 5 /nobreak >nul

:: Verify launcher is running
if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    echo  [OK] Launcher running ^(PID !LAUNCHER_PID!^)
) else (
    echo  [WARN] Launcher PID file not found. Check logs for errors.
)

:: Open browser to web-ui
echo.
echo  Opening web-ui in browser...
start http://localhost:3000

echo.
echo  Done. Close this window or press any key.
pause >nul
