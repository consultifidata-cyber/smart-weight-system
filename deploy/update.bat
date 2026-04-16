@echo off
:: ============================================================
:: Smart Weight System — Pull Latest Code and Restart
:: ============================================================
:: Pulls latest from GitHub, installs dependencies, restarts.
:: Run this when a new version is available.
:: ============================================================

title Smart Weight System — Updating...

cd /d "%~dp0.."

echo.
echo  Smart Weight System — Update
echo  ========================================

:: Check git is available
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Git is not installed or not in PATH.
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

:: Restart all services
echo.
echo  [3/4] Restarting services...
pm2 restart all
pm2 save

:: Wait and show status
echo.
echo  [4/4] Verifying...
timeout /t 3 /nobreak >nul
pm2 status

echo.
echo  Update complete.
pause
