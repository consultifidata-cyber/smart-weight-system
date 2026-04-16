@echo off
:: ============================================================
:: Smart Weight System — Health Check
:: ============================================================
:: Checks all 4 services and reports status.
:: Use this to quickly diagnose issues.
:: ============================================================

title Smart Weight System — Health Check

cd /d "%~dp0.."

echo.
echo  Smart Weight System — Health Check
echo  ========================================
echo.

:: PM2 process status
echo  [PM2 Process Status]
echo  --------------------
where pm2 >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  PM2 not found. Services are not managed by PM2.
    echo.
) else (
    pm2 status
    echo.
)

:: Check each service HTTP endpoint
echo  [Service Health Endpoints]
echo  -------------------------

where curl >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [WARN] curl.exe not found — cannot check HTTP endpoints.
    echo         Install curl or upgrade to a recent Windows 10/11 build.
    goto :skip_http
)

echo.
echo  Weight Service (port 5000):
curl -s -o nul -w "  HTTP %%{http_code} — %%{time_total}s" http://localhost:5000/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Print Service (port 5001):
curl -s -o nul -w "  HTTP %%{http_code} — %%{time_total}s" http://localhost:5001/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Sync Service (port 5002):
curl -s -o nul -w "  HTTP %%{http_code} — %%{time_total}s" http://localhost:5002/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Web UI (port 3000):
curl -s -o nul -w "  HTTP %%{http_code} — %%{time_total}s" http://localhost:3000/ 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

:skip_http

:: Sync status (bags today, pending sessions)
echo.
echo.
echo  [Sync Status]
echo  -------------
curl -s http://localhost:5002/sync/status 2>nul
if %ERRORLEVEL% neq 0 (echo   Could not reach sync service.)
echo.

:: Recent PM2 logs (last 10 lines per service)
echo.
echo  [Recent Errors — last 5 lines per service]
echo  -------------------------------------------
where pm2 >nul 2>&1
if %ERRORLEVEL% equ 0 (
    for %%s in (weight-service print-service sync-service web-ui) do (
        echo.
        echo  --- %%s ---
        pm2 logs %%s --nostream --lines 5 --err 2>nul
    )
)

echo.
echo  ========================================
echo  Health check complete.
echo.
pause
