<#
.SYNOPSIS
    Stop and remove the SmartWeightSystem Windows Service.

.DESCRIPTION
    Gracefully stops all child services (via the launcher's SIGTERM drain),
    waits for them to exit, then removes the Windows Service registration.

    Safe to run even if service is not installed.

.PARAMETER NssmPath
    Path to nssm.exe.
    Default: looks in this script's directory, then in PATH.

.PARAMETER ServiceName
    Windows service name to remove. Default: SmartWeightSystem.

.PARAMETER Force
    Skip confirmation prompt.

.EXAMPLE
    # Interactive (asks for confirmation)
    powershell -ExecutionPolicy Bypass -File installer\tools\remove-service.ps1

    # Silent (for installer uninstall sequence)
    powershell -File remove-service.ps1 -Force
#>

#Requires -RunAsAdministrator

param(
    [string]$NssmPath    = '',
    [string]$ServiceName = 'SmartWeightSystem',
    [switch]$Force
)

$ErrorActionPreference = 'Continue'  # don't abort on non-critical errors

# ── Resolve NSSM ─────────────────────────────────────────────────────────────
if (-not $NssmPath) {
    $candidate = Join-Path $PSScriptRoot 'nssm.exe'
    if (Test-Path $candidate) { $NssmPath = $candidate }
}
if (-not $NssmPath) {
    $found = Get-Command nssm -ErrorAction SilentlyContinue
    if ($found) { $NssmPath = $found.Source }
}
if (-not $NssmPath) {
    Write-Host '[ERROR] nssm.exe not found.' -ForegroundColor Red
    Write-Host '  Place nssm.exe in the same folder as this script, or add to PATH.'
    exit 1
}

# ── Check service exists ──────────────────────────────────────────────────────
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[INFO] Service '$ServiceName' is not installed. Nothing to remove." -ForegroundColor Yellow
    exit 0
}

Write-Host ''
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host "  Smart Weight System — Remove Service"           -ForegroundColor Cyan
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host "  ServiceName  : $ServiceName"
Write-Host "  Current state: $($existing.Status)"
Write-Host ''

# ── Confirm unless -Force ─────────────────────────────────────────────────────
if (-not $Force) {
    $answer = Read-Host "Remove service '$ServiceName'? (y/N)"
    if ($answer -notmatch '^[yY]') {
        Write-Host 'Aborted.' -ForegroundColor Yellow
        exit 0
    }
}

# ── Stop the service (graceful) ───────────────────────────────────────────────
Write-Host "-- Stopping service '$ServiceName'..."

if ($existing.Status -ne 'Stopped') {
    # NSSM stop sends SIGTERM to the launcher, which drains child services
    & $NssmPath stop $ServiceName 2>$null

    # Wait up to 15s for graceful stop
    $waited = 0
    while ($waited -lt 15) {
        Start-Sleep -Seconds 1
        $waited++
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Stopped') { break }
        Write-Host "   ...waiting for stop ($waited/15s)"
    }

    # Force stop if still running
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') {
        Write-Host '   Graceful stop timed out — forcing...' -ForegroundColor Yellow
        & $NssmPath stop $ServiceName confirm 2>$null
        Start-Sleep -Seconds 2
    }
}

Write-Host '   Service stopped.' -ForegroundColor Green

# ── Remove service registration ───────────────────────────────────────────────
Write-Host "-- Removing service registration..."
& $NssmPath remove $ServiceName confirm 2>$null
Start-Sleep -Seconds 1

# ── Remove firewall rules ─────────────────────────────────────────────────────
Write-Host '-- Removing Windows Firewall rules...'
$fwRuleNames = @('SWS-WebUI','SWS-WeightSvc','SWS-PrintSvc','SWS-SyncSvc','SWS-Launcher')
foreach ($name in $fwRuleNames) {
    Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    Write-Host "   Removed firewall rule: $name"
}

# ── Verify removal ────────────────────────────────────────────────────────────
$check = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($check) {
    Write-Host "[WARN] Service '$ServiceName' still appears in SCM." -ForegroundColor Yellow
    Write-Host '  Reboot may be required to complete removal.'
} else {
    Write-Host ''
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "  [REMOVED]  Service '$ServiceName' unregistered." -ForegroundColor Green
    Write-Host "=================================================" -ForegroundColor Cyan
}

Write-Host ''
Write-Host 'Note: Application files and logs have NOT been deleted.'
Write-Host 'To delete them, remove the installation folder manually.'
