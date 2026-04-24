<#
.SYNOPSIS
    Generate a support diagnostic bundle for Smart Weight System.

.DESCRIPTION
    Collects logs, service status, hardware info, and configuration
    into a single zip file on the Desktop for sending to support.

    SAFE: API token and sensitive values are masked before inclusion.

.PARAMETER InstallDir
    Installation folder. Default: C:\SmartWeightSystem.

.PARAMETER HealthPort
    Launcher health port. Default: 5099.

.EXAMPLE
    # Run from any command prompt (no admin needed):
    powershell -ExecutionPolicy Bypass -File "C:\SmartWeightSystem\tools\health-report.ps1"
#>
param(
    [string]$InstallDir = 'C:\SmartWeightSystem',
    [int]   $HealthPort = 5099
)

$ErrorActionPreference = 'SilentlyContinue'
$timestamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir  = "$env:TEMP\SWS-Report-$timestamp"
$zipDest    = "$env:USERPROFILE\Desktop\SWS-HealthReport-$timestamp.zip"
$logsDir    = Join-Path $InstallDir 'logs'

New-Item -ItemType Directory -Force $reportDir | Out-Null
Write-Host "Collecting diagnostics into $reportDir ..."

# ── 1. System info ─────────────────────────────────────────────────────────────
Write-Host '  system info...'
$sysInfo = @{
    ComputerName  = $env:COMPUTERNAME
    OSCaption     = (Get-WmiObject Win32_OperatingSystem).Caption
    OSVersion     = (Get-WmiObject Win32_OperatingSystem).Version
    OSBuild       = (Get-WmiObject Win32_OperatingSystem).BuildNumber
    TotalRAM_GB   = [math]::Round((Get-WmiObject Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
    PowerShellVer = $PSVersionTable.PSVersion.ToString()
    ReportTime    = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
}
$sysInfo | ConvertTo-Json | Set-Content "$reportDir\system-info.json" -Encoding UTF8

# ── 2. Windows Service status ─────────────────────────────────────────────────
Write-Host '  service status...'
$svc = Get-Service -Name 'SmartWeightSystem' -ErrorAction SilentlyContinue
$svcInfo = if ($svc) {
    @{ Name=$svc.Name; Status=[string]$svc.Status; StartType=[string]$svc.StartType }
} else {
    @{ Name='SmartWeightSystem'; Status='NOT INSTALLED'; StartType='N/A' }
}
$svcInfo | ConvertTo-Json | Set-Content "$reportDir\service-status.json" -Encoding UTF8

# ── 3. Launcher health endpoint ───────────────────────────────────────────────
Write-Host '  health endpoint...'
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$HealthPort/health" -TimeoutSec 5
    $health | ConvertTo-Json -Depth 5 | Set-Content "$reportDir\health-endpoint.json" -Encoding UTF8
    Write-Host "    health: ok=$($health.ok)"
} catch {
    "UNREACHABLE: $_" | Set-Content "$reportDir\health-endpoint.json" -Encoding UTF8
    Write-Host '    health: unreachable'
}

# ── 4. Hardware status (/hardware/status from print-service) ──────────────────
Write-Host '  hardware status...'
try {
    $hw = Invoke-RestMethod -Uri 'http://localhost:5001/hardware/status' -TimeoutSec 5
    $hw | ConvertTo-Json -Depth 6 | Set-Content "$reportDir\hardware-status.json" -Encoding UTF8
    Write-Host "    hardware: printer=$($hw.printer.detected) scale=$($hw.scale.connected)"
} catch {
    "UNREACHABLE: $_" | Set-Content "$reportDir\hardware-status.json" -Encoding UTF8
    Write-Host '    hardware: unreachable'
}

# ── 5. USB and COM devices ────────────────────────────────────────────────────
Write-Host '  USB/COM devices...'
$usbDevices = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match 'USB\\VID_' -and $_.Status -eq 'OK' } |
    Select-Object FriendlyName, Class, Status,
        @{N='VID'; E={([regex]::Match($_.InstanceId,'VID_([0-9A-Fa-f]{4})')).Groups[1].Value}},
        @{N='PID'; E={([regex]::Match($_.InstanceId,'PID_([0-9A-Fa-f]{4})')).Groups[1].Value}}
)
$usbDevices | ConvertTo-Json | Set-Content "$reportDir\usb-devices.json" -Encoding UTF8

$comPorts = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'COM\d' } |
    Select-Object FriendlyName, Class, Status
)
$comPorts | ConvertTo-Json | Set-Content "$reportDir\com-ports.json" -Encoding UTF8

# ── 6. Logs (last 200 lines each, with header) ────────────────────────────────
Write-Host '  log files...'
$logFiles = @(
    'launcher.log', 'launcher-svc.log', 'launcher-svc-err.log',
    'weight-service-out.log', 'weight-service-error.log',
    'print-service-out.log',  'print-service-error.log',
    'sync-service-out.log',   'sync-service-error.log',
    'web-ui-out.log',         'web-ui-error.log'
)
foreach ($lf in $logFiles) {
    $src = Join-Path $logsDir $lf
    $dst = Join-Path $reportDir $lf
    if (Test-Path $src) {
        $lines = Get-Content $src -Tail 200 -ErrorAction SilentlyContinue
        "=== Last 200 lines of $lf ===" | Set-Content $dst -Encoding UTF8
        if ($lines) { $lines | Add-Content $dst -Encoding UTF8 }
        else         { '(empty)' | Add-Content $dst -Encoding UTF8 }
    } else {
        "=== $lf - FILE NOT FOUND (service may not have started yet) ===" |
            Set-Content $dst -Encoding UTF8
    }
}

# ── 7. Configuration (.env with token masked) ──────────────────────────────────
Write-Host '  .env (masked)...'
$envPath = Join-Path $InstallDir '.env'
if (Test-Path $envPath) {
    (Get-Content $envPath) -replace '(?i)(DJANGO_API_TOKEN\s*=\s*).+', '$1[REDACTED]' |
        Set-Content "$reportDir\env-masked.txt" -Encoding UTF8
} else {
    '.env NOT FOUND - installer may not have completed' |
        Set-Content "$reportDir\env-masked.txt" -Encoding UTF8
}

# ── 8. Node.js runtime version ────────────────────────────────────────────────
$nodeExe = Join-Path $InstallDir 'node-runtime\node.exe'
if (Test-Path $nodeExe) {
    (& $nodeExe --version 2>&1) | Set-Content "$reportDir\node-version.txt" -Encoding UTF8
}

# ── 9. Zip and deliver to Desktop ─────────────────────────────────────────────
Write-Host '  compressing...'
Compress-Archive -Path "$reportDir\*" -DestinationPath $zipDest -Force

# Cleanup temp
Remove-Item $reportDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host "  Support report saved to Desktop:" -ForegroundColor Green
Write-Host "  $zipDest" -ForegroundColor White
Write-Host '  Send this file to support.' -ForegroundColor Green
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host ''

# Open the Desktop folder so the user can find the zip
Start-Process explorer.exe $env:USERPROFILE\Desktop
