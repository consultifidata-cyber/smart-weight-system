<#
.SYNOPSIS
    Query the status of the SmartWeightSystem service and health endpoint.

.DESCRIPTION
    Shows:
      - Windows Service status (from SCM)
      - Launcher health endpoint (http://localhost:<port>/health)
      - Per-service status, PIDs, restart counts, last errors
      - Tail of launcher.log if health endpoint is unreachable

.PARAMETER ServiceName
    Windows service name. Default: SmartWeightSystem.

.PARAMETER HealthPort
    Launcher health port. Default: 5099.

.PARAMETER LogLines
    Number of launcher.log tail lines to print on failure. Default: 20.

.PARAMETER InstallDir
    Install directory for log file lookup.
    Default: two levels above this script.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\service-status.ps1
#>

param(
    [string]$ServiceName = 'SmartWeightSystem',
    [int]   $HealthPort  = 5099,
    [int]   $LogLines    = 20,
    [string]$InstallDir  = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ''
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host "  Smart Weight System — Service Status"           -ForegroundColor Cyan
Write-Host '=================================================' -ForegroundColor Cyan

# ── Windows Service (SCM) ─────────────────────────────────────────────────────
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host ''
    Write-Host "  [NOT INSTALLED] Service '$ServiceName' is not registered." -ForegroundColor Red
    Write-Host "  Run install-service.ps1 to install."
    Write-Host ''
    exit 1
}

$svcColor = if ($svc.Status -eq 'Running') { 'Green' } else { 'Red' }
Write-Host ''
Write-Host "  Windows Service : $($svc.DisplayName)"
Write-Host "  SCM Status      : " -NoNewline
Write-Host $svc.Status -ForegroundColor $svcColor
Write-Host "  Start Type      : $($svc.StartType)"

# ── Health endpoint ───────────────────────────────────────────────────────────
Write-Host ''
Write-Host "  Health endpoint : http://localhost:$HealthPort/health"

$health = $null
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$HealthPort/health" -TimeoutSec 5 -ErrorAction Stop
} catch {
    Write-Host "  Health status   : " -NoNewline
    Write-Host "NOT RESPONDING" -ForegroundColor Red
}

if ($health) {
    $healthColor = if ($health.ok) { 'Green' } else { 'Yellow' }
    $healthLabel = if ($health.ok) { 'OK' } else { 'DEGRADED' }
    Write-Host "  Health status   : " -NoNewline
    Write-Host $healthLabel -ForegroundColor $healthColor
    Write-Host "  Launcher PID    : $($health.launcherPid)"
    Write-Host "  Launcher uptime : $($health.uptimeSec) seconds"

    Write-Host ''
    Write-Host '  Services:'
    Write-Host '  ' + ('Name'.PadRight(22)) + ('Status'.PadRight(16)) + ('PID'.PadRight(8)) + ('Restarts'.PadRight(10)) + 'LastExitCode'
    Write-Host '  ' + ('-' * 70)

    foreach ($s in $health.services) {
        $statusColor = switch ($s.status) {
            'running'      { 'Green'  }
            'restarting'   { 'Yellow' }
            'crashed'      { 'Red'    }
            'crash-looping'{ 'Red'    }
            default        { 'White'  }
        }
        $restarts    = [string]$s.restartCount
        $exitCode    = if ($null -ne $s.lastExitCode) { [string]$s.lastExitCode } else { '-' }
        $pid         = if ($null -ne $s.pid) { [string]$s.pid } else { '-' }

        Write-Host -NoNewline '  '
        Write-Host -NoNewline ($s.name.PadRight(22))
        Write-Host -NoNewline -ForegroundColor $statusColor ($s.status.PadRight(16))
        Write-Host -NoNewline ($pid.PadRight(8))
        Write-Host -NoNewline ($restarts.PadRight(10))
        Write-Host $exitCode
    }

    # Warn about any non-running services
    $problems = $health.services | Where-Object { $_.status -ne 'running' }
    if ($problems) {
        Write-Host ''
        Write-Host '  [WARN] Some services are not running:' -ForegroundColor Yellow
        foreach ($p in $problems) {
            Write-Host "    $($p.name): $($p.status)" -ForegroundColor Yellow
            if ($p.lastError) {
                Write-Host "      Last error: $($p.lastError)" -ForegroundColor Red
            }
            if ($null -ne $p.lastExitCode) {
                Write-Host "      Last exit code: $($p.lastExitCode)"
            }
        }
    }
}

# ── Log tail on failure ───────────────────────────────────────────────────────
$launcherLog = Join-Path $InstallDir 'logs\launcher.log'
if (-not $health -and (Test-Path $launcherLog)) {
    Write-Host ''
    Write-Host "  Last $LogLines lines of launcher.log:" -ForegroundColor Yellow
    Write-Host '  ' + ('-' * 60)
    Get-Content $launcherLog -Tail $LogLines | ForEach-Object { Write-Host "  $_" }
}

Write-Host ''
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host ''

# Return non-zero exit code if service is unhealthy (useful for scripts)
if (-not $health -or -not $health.ok) { exit 1 } else { exit 0 }
