@echo off
setlocal enabledelayedexpansion
:: ============================================================
:: Smart Weight System -- Stop All Services (graceful)
:: ============================================================
:: Stops all 5 services gracefully via the launcher.
:: Phase 1: send graceful stop (taskkill without /F).
::          Launcher catches it and asks all 5 services to drain.
:: Phase 2: wait 7s, then force-kill any stragglers.
:: ============================================================

title Smart Weight System -- Stopping...

cd /d "%~dp0.."

echo.
echo  Smart Weight System -- Stopping Services
echo  ========================================

if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    echo  Sending graceful stop to launcher ^(PID !LAUNCHER_PID!^)...
    taskkill /pid !LAUNCHER_PID! /t >nul 2>&1

    echo  Waiting up to 7s for services to drain...
    :: The launcher drains for 5s then force-kills its children.
    :: We wait a bit longer before checking for stragglers.
    timeout /t 7 /nobreak >nul 2>&1

    :: If launcher is still alive, force-kill it now.
    tasklist /fi "PID eq !LAUNCHER_PID!" 2>nul | find "!LAUNCHER_PID!" >nul
    if not errorlevel 1 (
        echo  Launcher still alive, force-killing...
        taskkill /pid !LAUNCHER_PID! /t /f >nul 2>&1
    )

    del .launcher.pid >nul 2>&1
    del .launcher-status.json >nul 2>&1
    echo.
    echo  [OK] All services stopped.
) else (
    echo  [WARN] No launcher PID file found. Services may not be running.
)

echo.
pause
