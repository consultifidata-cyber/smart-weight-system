<#
.SYNOPSIS
    Install Smart Weight System as a Windows Service using NSSM.

.DESCRIPTION
    Registers the launcher (deploy\launcher.js) as a Windows Service named
    "SmartWeightSystem".  The service runs under LocalSystem, starts
    automatically on boot, and is restarted by NSSM if it crashes.

    Safe to run multiple times — stops and re-registers if service already exists.

.PARAMETER InstallDir
    Root folder of the Smart Weight System installation.
    Default: two levels above this script (repo root when run from installer\tools\).

.PARAMETER NssmPath
    Path to nssm.exe.
    Default: looks for nssm.exe in this script's directory, then in PATH.
    Download from https://nssm.cc/download  (place win64\nssm.exe here).

.PARAMETER NodePath
    Path to node.exe.
    Default: looks for node-runtime\node.exe in InstallDir, then in PATH.

.PARAMETER ServiceName
    Windows service name. Default: SmartWeightSystem.

.PARAMETER HealthPort
    Port where launcher exposes GET /health. Default: 5099.

.EXAMPLE
    # From repo root (dev testing):
    powershell -ExecutionPolicy Bypass -File installer\tools\install-service.ps1

    # From installer (with bundled paths):
    powershell -File install-service.ps1 -InstallDir "C:\SmartWeightSystem" `
               -NssmPath "C:\SmartWeightSystem\tools\nssm.exe" `
               -NodePath "C:\SmartWeightSystem\node-runtime\node.exe"
#>

#Requires -RunAsAdministrator

param(
    [string]$InstallDir  = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$NssmPath    = '',
    [string]$NodePath    = '',
    [string]$ServiceName = 'SmartWeightSystem',
    [int]   $HealthPort  = 5099
)

$ErrorActionPreference = 'Stop'

# ── Banner ────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host '  Smart Weight System — Service Installer'         -ForegroundColor Cyan
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host "  InstallDir  : $InstallDir"
Write-Host "  ServiceName : $ServiceName"
Write-Host "  HealthPort  : $HealthPort"
Write-Host ''

# ── Resolve NSSM ─────────────────────────────────────────────────────────────
if (-not $NssmPath) {
    # 1. Next to this script
    $candidate = Join-Path $PSScriptRoot 'nssm.exe'
    if (Test-Path $candidate) { $NssmPath = $candidate }
}
if (-not $NssmPath) {
    # 2. In PATH
    $found = Get-Command nssm -ErrorAction SilentlyContinue
    if ($found) { $NssmPath = $found.Source }
}
if (-not $NssmPath) {
    Write-Host '[ERROR] nssm.exe not found.' -ForegroundColor Red
    Write-Host '  Place nssm.exe (win64) in the same folder as this script:'
    Write-Host "  $PSScriptRoot\nssm.exe"
    Write-Host '  Download: https://nssm.cc/download'
    exit 1
}
Write-Host "[OK] NSSM     : $NssmPath" -ForegroundColor Green

# Fix 2 — Verify NSSM is executable (catches AV quarantine before install starts)
try {
    $nssmVer = (& $NssmPath version 2>&1 | Select-Object -First 1)
    Write-Host "[OK] NSSM ver : $nssmVer" -ForegroundColor Green
} catch {
    Write-Host '[ERROR] nssm.exe exists but cannot run — likely quarantined by antivirus.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  TO FIX:' -ForegroundColor Yellow
    Write-Host "  1. Open your antivirus / Windows Security"
    Write-Host "  2. Add exclusion for: $NssmPath"
    Write-Host "  3. Re-run this installer as Administrator"
    Write-Host ''
    Write-Host "  nssm.exe is a well-known Windows service manager (nssm.cc). It is safe."
    exit 1
}

# ── Resolve Node.js ───────────────────────────────────────────────────────────
if (-not $NodePath) {
    # 1. Bundled node-runtime (installer scenario)
    $candidate = Join-Path $InstallDir 'node-runtime\node.exe'
    if (Test-Path $candidate) { $NodePath = $candidate }
}
if (-not $NodePath) {
    # 2. System PATH (dev scenario)
    $found = Get-Command node -ErrorAction SilentlyContinue
    if ($found) { $NodePath = $found.Source }
}
if (-not $NodePath) {
    Write-Host '[ERROR] node.exe not found.' -ForegroundColor Red
    Write-Host '  Install Node.js v18+ from https://nodejs.org/'
    Write-Host '  Or provide -NodePath parameter.'
    exit 1
}
Write-Host "[OK] Node.js  : $NodePath" -ForegroundColor Green

# ── Validate install dir ──────────────────────────────────────────────────────
$launcherScript = Join-Path $InstallDir 'deploy\launcher.js'
if (-not (Test-Path $launcherScript)) {
    Write-Host "[ERROR] launcher.js not found at: $launcherScript" -ForegroundColor Red
    Write-Host '  Verify InstallDir points to the Smart Weight System root folder.'
    exit 1
}
Write-Host "[OK] Launcher : $launcherScript" -ForegroundColor Green

# Fix 1 — Port conflict pre-check (before we touch anything)
Write-Host '-- Checking port availability...'
$portChecks = @(
    @{ Port=3000;     Name='Web UI'          },
    @{ Port=5000;     Name='Weight Service'  },
    @{ Port=5001;     Name='Print Service'   },
    @{ Port=5002;     Name='Sync Service'    },
    @{ Port=$HealthPort; Name='Launcher Health' }
)
$portConflicts = @()
foreach ($check in $portChecks) {
    $conn = Get-NetTCPConnection -LocalPort $check.Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) {
        $pid  = $conn.OwningProcess
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $name = if ($proc) { $proc.Name } else { "PID $pid" }
        # Skip if it's already our own service (upgrade scenario)
        if ($name -notmatch 'node|SmartWeight') {
            $portConflicts += "  Port $($check.Port) ($($check.Name)) is used by '$name' (PID $pid)"
        }
    }
}
if ($portConflicts.Count -gt 0) {
    Write-Host '[ERROR] Port conflicts found — service will not start:' -ForegroundColor Red
    $portConflicts | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    Write-Host ''
    Write-Host '  TO FIX: Stop the conflicting processes, then re-run the installer.' -ForegroundColor Yellow
    Write-Host '  Run:  netstat -ano | findstr "3000 5000 5001 5002 5099"  to investigate.' -ForegroundColor Yellow
    exit 1
} else {
    Write-Host '   All ports available.' -ForegroundColor Green
}

# ── Ensure logs directory ─────────────────────────────────────────────────────
$logsDir = Join-Path $InstallDir 'logs'
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    Write-Host "[OK] Created  : $logsDir" -ForegroundColor Green
} else {
    Write-Host "[OK] Logs dir : $logsDir" -ForegroundColor Green
}

# ── Remove existing service (idempotent / upgrade path) ──────────────────────
Write-Host ''
Write-Host '-- Checking for existing service...'
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "   Found existing service (status: $($existing.Status)). Removing..."
    if ($existing.Status -ne 'Stopped') {
        & $NssmPath stop $ServiceName confirm 2>$null
        Start-Sleep -Seconds 3
    }
    & $NssmPath remove $ServiceName confirm 2>$null
    Start-Sleep -Seconds 1
    Write-Host '   Old service removed.' -ForegroundColor Yellow
} else {
    Write-Host '   No existing service found.'
}

# ── Install service ───────────────────────────────────────────────────────────
Write-Host ''
Write-Host "-- Installing service '$ServiceName'..."

& $NssmPath install $ServiceName $NodePath `
    (Join-Path 'deploy' 'launcher.js')

if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] nssm install failed.' -ForegroundColor Red
    exit 1
}

# ── Configure service ─────────────────────────────────────────────────────────
Write-Host '-- Configuring service parameters...'

# Working directory — launcher uses __dirname, but child services use cwd
& $NssmPath set $ServiceName AppDirectory       $InstallDir

# Identity — LocalSystem: can access COM ports, USB, write to install dir
& $NssmPath set $ServiceName ObjectName         'LocalSystem'

# Start type — boot auto-start
& $NssmPath set $ServiceName Start              'SERVICE_AUTO_START'
& $NssmPath set $ServiceName Type               'SERVICE_WIN32_OWN_PROCESS'

# Restart behaviour — restart on any exit (code or signal)
& $NssmPath set $ServiceName AppExit            'Default' 'Restart'
& $NssmPath set $ServiceName AppRestartDelay    3000   # ms before NSSM restarts launcher

# Throttle — if launcher exits within 60s, wait before next NSSM restart
# (launcher's own backoff handles service-level crashes)
& $NssmPath set $ServiceName AppThrottle        60000

# Environment — ensures NODE_ENV is production even if not in .env
& $NssmPath set $ServiceName AppEnvironmentExtra "NODE_ENV=production`nLAUNCHER_HEALTH_PORT=$HealthPort"

# NSSM-level stdout/stderr logs (separate from launcher.log and per-service logs)
# These capture output before launcher opens its own log file.
& $NssmPath set $ServiceName AppStdout          (Join-Path $logsDir 'launcher-svc.log')
& $NssmPath set $ServiceName AppStderr          (Join-Path $logsDir 'launcher-svc-err.log')

# Log rotation: rotate when file exceeds 10 MB; rotate while running
& $NssmPath set $ServiceName AppRotateFiles     1
& $NssmPath set $ServiceName AppRotateBytes     10485760
& $NssmPath set $ServiceName AppRotateOnline    1

# Display name and description (visible in services.msc)
& $NssmPath set $ServiceName DisplayName        'Smart Weight System'
& $NssmPath set $ServiceName Description        'Weighing station manager: weight reader, label printer, ERP sync, web UI'

Write-Host '   All parameters set.' -ForegroundColor Green

# ── Firewall rules ────────────────────────────────────────────────────────────
Write-Host '-- Adding Windows Firewall inbound rules...'

$fwRules = @(
    @{ Name='SWS-WebUI';     Port=3000; Desc='Smart Weight System — Web UI'         },
    @{ Name='SWS-WeightSvc'; Port=5000; Desc='Smart Weight System — Weight Service' },
    @{ Name='SWS-PrintSvc';  Port=5001; Desc='Smart Weight System — Print Service'  },
    @{ Name='SWS-SyncSvc';   Port=5002; Desc='Smart Weight System — Sync Service'   },
    @{ Name='SWS-Launcher';  Port=$HealthPort; Desc='Smart Weight System — Launcher Health' }
)

foreach ($rule in $fwRules) {
    Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction   Inbound `
        -Protocol    TCP `
        -LocalPort   $rule.Port `
        -Action      Allow `
        -Profile     Any `
        -Description $rule.Desc | Out-Null
    Write-Host "   [FW] $($rule.Name) → port $($rule.Port)" -ForegroundColor Green
}

# ── Start service ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "-- Starting service '$ServiceName'..."
& $NssmPath start $ServiceName

if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] Service failed to start. Check Windows Event Log.' -ForegroundColor Red
    Write-Host "  Run: Get-EventLog -LogName System -Source 'Service Control Manager' -Newest 10"
    exit 1
}

# ── Health check ──────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "-- Waiting for health endpoint (http://localhost:$HealthPort/health)..."

$maxWaitSec = 60   # Fix 3: 60s for first boot — slow laptops / AV scan delay
$elapsed    = 0
$healthy    = $false
$health     = $null

while ($elapsed -lt $maxWaitSec) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    try {
        $health  = Invoke-RestMethod -Uri "http://localhost:$HealthPort/health" -TimeoutSec 3
        $healthy = $true
        break
    } catch {
        Write-Host "   ...still starting ($elapsed/${maxWaitSec}s)"
    }
}

# ── Result ────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '=================================================' -ForegroundColor Cyan

if ($healthy) {
    Write-Host "  [INSTALLED]  Service '$ServiceName' is running." -ForegroundColor Green
    Write-Host "  Uptime     : $($health.uptimeSec) seconds"
    Write-Host "  Launcher   : PID $($health.launcherPid)"
    Write-Host ''
    Write-Host '  Service status:'
    foreach ($svc in $health.services) {
        $icon = if ($svc.status -eq 'running') { '[OK]' } else { '[!!]' }
        Write-Host "    $icon $($svc.name.PadRight(20)) $($svc.status)  (PID $($svc.pid))"
    }
    Write-Host ''
    Write-Host "  Web UI  → http://localhost:3000"
    Write-Host "  Health  → http://localhost:$HealthPort/health"
} else {
    Write-Host "  [INSTALLED]  Service '$ServiceName' registered." -ForegroundColor Yellow
    Write-Host '  [WARN]  Health endpoint did not respond within 30s.' -ForegroundColor Yellow
    Write-Host '  This is normal if services take longer to start on first boot.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  To diagnose:' -ForegroundColor Cyan
    Write-Host "    1. Check logs:  $logsDir\launcher.log"
    Write-Host "    2. Run support report:"
    Write-Host "       powershell -File `"$InstallDir\tools\health-report.ps1`""
    Write-Host "    3. Check service: sc query $ServiceName"
    Write-Host "    4. Health API:    curl http://localhost:$HealthPort/health"
}

Write-Host '=================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Useful commands:'
Write-Host "  sc query $ServiceName          — check service status"
Write-Host "  net stop  $ServiceName         — stop service"
Write-Host "  net start $ServiceName         — start service"
Write-Host "  curl http://localhost:$HealthPort/health  — check health"
