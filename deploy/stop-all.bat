@echo off
setlocal enabledelayedexpansion
:: ============================================================
:: Smart Weight System -- Stop All Services
:: ============================================================

title Smart Weight System -- Stopping...

cd /d "%~dp0.."

echo.
echo  Smart Weight System -- Stopping Services
echo  ========================================

if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    echo  Stopping launcher and all services ^(PID !LAUNCHER_PID!^)...
    taskkill /pid !LAUNCHER_PID! /t /f >nul 2>&1
    del .launcher.pid >nul 2>&1
    echo.
    echo  [OK] All services stopped.
) else (
    echo  [WARN] No launcher PID file found. Services may not be running.
)

echo.
pause
