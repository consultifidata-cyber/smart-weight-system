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

:: Reload services from ecosystem config (picks up any config changes)
echo.
echo  [3/4] Restarting services...
for %%s in (weight-service print-service sync-service web-ui) do (
    pm2 delete %%s >nul 2>&1
)
pm2 start deploy\ecosystem.config.js
pm2 save

:: Wait and show status
echo.
echo  [4/4] Verifying...
timeout /t 3 /nobreak >nul
pm2 status

echo.
echo  Update complete.
pause
