@echo off
setlocal enabledelayedexpansion
:: ============================================================
:: Smart Weight System -- Pull Latest Code and Restart
:: ============================================================
:: Pulls latest from GitHub, installs dependencies, restarts.
:: Run this when a new version is available.
:: ============================================================

title Smart Weight System -- Updating...

cd /d "%~dp0.."

echo.
echo  Smart Weight System -- Update
echo  ========================================

:: Check prerequisites
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Git is not installed or not in PATH.
    pause
    exit /b 1
)
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

:: Pull latest code
echo.
echo  [1/4] Pulling latest code from GitHub...
git pull origin main
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Git pull failed. Check network or resolve conflicts.
    pause
    exit /b 1
)

:: Install dependencies
echo.
echo  [2/4] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo  [WARNING] npm install had issues. Services may still work.
)

:: Stop existing services
echo.
echo  [3/4] Restarting services...
if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    taskkill /pid !LAUNCHER_PID! /t /f >nul 2>&1
    del .launcher.pid >nul 2>&1
    timeout /t 2 /nobreak >nul
)

:: Start launcher hidden
powershell -Command "Start-Process node -ArgumentList '\"deploy\launcher.js\"' -WorkingDirectory '%CD%' -WindowStyle Hidden"

:: Wait and verify
echo.
echo  [4/4] Verifying...
timeout /t 5 /nobreak >nul

if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    echo  [OK] Launcher running ^(PID !LAUNCHER_PID!^)
) else (
    echo  [WARN] Launcher PID file not found. Check logs for errors.
)

echo.
echo  Update complete.
pause
