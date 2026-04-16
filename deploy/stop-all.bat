@echo off
:: ============================================================
:: Smart Weight System — Stop All Services
:: ============================================================

title Smart Weight System — Stopping...

cd /d "%~dp0.."

echo.
echo  Smart Weight System — Stopping Services
echo  ========================================

where pm2 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] PM2 is not installed or not in PATH.
    pause
    exit /b 1
)

pm2 stop all
pm2 save

echo.
echo  All services stopped.
pm2 status

echo.
pause
