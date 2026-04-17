@echo off
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
where pm2 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] PM2 is not installed or not in PATH.
    echo  Run: npm install -g pm2
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

:: Reload services -- kill daemon and restart via Scheduled Task so
:: PM2 runs in Session 0 (no CMD window flashing from wmic monitoring).
echo.
echo  [3/4] Restarting services...
pm2 kill >nul 2>&1
schtasks /run /tn "SmartWeightPM2" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [WARN] Scheduled Task not found. Starting directly...
    echo         Run deploy\install.ps1 to set up the task.
    pm2 start deploy\ecosystem.config.js
    pm2 save
)

:: Wait and show status
echo.
echo  [4/4] Verifying...
timeout /t 5 /nobreak >nul
pm2 status

echo.
echo  Update complete.
pause
