@echo off
:: ============================================================
:: Smart Weight System -- Health Check
:: ============================================================
:: Checks all 5 services and reports status.
:: Use this to quickly diagnose issues.
:: ============================================================

title Smart Weight System -- Health Check

cd /d "%~dp0.."

echo.
echo  Smart Weight System -- Health Check
echo  ========================================
echo.

:: Launcher status
echo  [Launcher Status]
echo  -----------------
if exist .launcher.pid (
    set /p LAUNCHER_PID=<.launcher.pid
    tasklist /fi "PID eq %LAUNCHER_PID%" /nh 2>nul | findstr /i "node" >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        echo  Launcher running (PID %LAUNCHER_PID%)
    ) else (
        echo  [WARN] Launcher PID %LAUNCHER_PID% is stale -- process not found.
    )
) else (
    echo  [WARN] Launcher not running (no PID file).
)
echo.

:: Check each service HTTP endpoint
echo  [Service Health Endpoints]
echo  -------------------------

where curl >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [WARN] curl.exe not found -- cannot check HTTP endpoints.
    echo         Install curl or upgrade to a recent Windows 10/11 build.
    goto :skip_http
)

echo.
echo  Weight Service   (port 5000):
curl -s -o nul -w "  HTTP %%{http_code} -- %%{time_total}s" http://localhost:5000/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Print Service    (port 5001):
curl -s -o nul -w "  HTTP %%{http_code} -- %%{time_total}s" http://localhost:5001/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Sync Service     (port 5002):
curl -s -o nul -w "  HTTP %%{http_code} -- %%{time_total}s" http://localhost:5002/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Web UI           (port 3000):
curl -s -o nul -w "  HTTP %%{http_code} -- %%{time_total}s" http://localhost:3000/ 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

echo.
echo  Dispatch Service (port 4000):
curl -s -o nul -w "  HTTP %%{http_code} -- %%{time_total}s" http://localhost:4000/health 2>nul
if %ERRORLEVEL% neq 0 (echo   UNREACHABLE) else (echo.)

:skip_http

:: Sync status (bags today, pending sessions, dispatch stats)
echo.
echo.
echo  [Sync Status]
echo  -------------
curl -s http://localhost:5002/sync/status 2>nul
if %ERRORLEVEL% neq 0 (echo   Could not reach sync service.)
echo.

:: Recent errors from log files
echo.
echo  [Recent Errors -- last 5 lines per service]
echo  -------------------------------------------
for %%s in (weight-service print-service sync-service web-ui dispatch-service) do (
    echo.
    echo  --- %%s ---
    if exist "logs\%%s-error.log" (
        powershell -Command "Get-Content 'logs\%%s-error.log' -Tail 5 2>$null"
    ) else (
        echo   (no error log)
    )
)

echo.
echo  ========================================
echo  Health check complete.
echo.
pause
