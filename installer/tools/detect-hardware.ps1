<#
.SYNOPSIS
    Enumerate all Windows-installed printers and all COM ports.

.DESCRIPTION
    Driver-first model: the user installs printer and USB-serial drivers
    before running this installer. This script shows EVERYTHING Windows
    already knows about — no VID/PID filtering, no chip vendor checks.

    Printers  : Get-Printer  (Windows print spooler, all installed printers)
    COM ports : HKLM\HARDWARE\DEVICEMAP\SERIALCOMM (every active COM port)

    Output files written to OutputDir:
      sws_printers.txt  --  pipe-delimited, read by Inno Setup Pascal
      sws_scales.txt    --  pipe-delimited, read by Inno Setup Pascal
      smart-weight-setup.log  --  full diagnostic transcript

.PARAMETER OutputDir
    Directory to write output files. Default: %TEMP%.
#>
param(
    [string]$OutputDir = $env:TEMP
)

$ErrorActionPreference = 'SilentlyContinue'

# ---- Diagnostic log ----------------------------------------------------------
$diagLog   = Join-Path $OutputDir 'smart-weight-setup.log'
$diagLines = [System.Collections.Generic.List[string]]::new()

function DiagLog([string]$msg) {
    $diagLines.Add($msg)
    Write-Host $msg
}

DiagLog 'Smart Weight System - Device Check'
DiagLog "Timestamp : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
DiagLog "OS        : $([System.Environment]::OSVersion.VersionString)"
DiagLog "User      : $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
DiagLog ''

# ==============================================================================
# PRINTERS -- Get-Printer (Windows print spooler)
# Returns every printer Windows has installed. No filtering whatsoever.
# ==============================================================================
DiagLog '=== PRINTERS (Get-Printer) ==='
$printerLines = @()

try {
    # Import module explicitly -- needed when running as SYSTEM under Inno Setup
    Import-Module PrintManagement -ErrorAction SilentlyContinue

    $allPrinters = @(Get-Printer -ErrorAction Stop)
    DiagLog "  Found: $($allPrinters.Count) printer(s)"

    foreach ($p in $allPrinters) {
        $pName  = [string]$p.Name
        $pShare = if ($p.ShareName -and [string]$p.ShareName -ne '') { [string]$p.ShareName } else { $pName }
        $pPort  = [string]$p.PortName
        $pType  = [string]$p.Type

        DiagLog ("  [" + $pType + "] Name:'" + $pName + "'  Share:'" + $pShare + "'  Port:'" + $pPort + "'")

        # Path field encodes FullName::ShareName so generate-env.ps1 can split them
        $pathField  = ($pName + '::' + $pShare) -replace '\|', '-'
        $displayStr = $pName -replace '\|', '-'

        $printerLines += $displayStr + '|' + $pathField + '|NA|TSPL|WINDOWS'
    }
} catch {
    DiagLog ('  Get-Printer ERROR: ' + $_.Exception.Message)
    DiagLog '  Falling back to WMI Win32_Printer...'
    try {
        $wmiPrinters = @(Get-WmiObject Win32_Printer -ErrorAction Stop)
        DiagLog "  WMI found: $($wmiPrinters.Count) printer(s)"
        foreach ($p in $wmiPrinters) {
            $pName  = [string]$p.Name
            $pShare = if ($p.ShareName) { [string]$p.ShareName } else { $pName }
            DiagLog ("  WMI: Name:'" + $pName + "'  Share:'" + $pShare + "'")
            $pathField  = ($pName + '::' + $pShare) -replace '\|', '-'
            $displayStr = $pName -replace '\|', '-'
            $printerLines += $displayStr + '|' + $pathField + '|NA|TSPL|WINDOWS'
        }
    } catch {
        DiagLog ('  WMI Win32_Printer ERROR: ' + $_.Exception.Message)
    }
}

$printerFile = Join-Path $OutputDir 'sws_printers.txt'
if ($printerLines.Count -gt 0) { $printerLines | Set-Content $printerFile -Encoding UTF8 }
else { '' | Set-Content $printerFile -Encoding UTF8 }
DiagLog "  Written $($printerLines.Count) printer(s) to $printerFile"

# ==============================================================================
# COM PORTS -- Registry HKLM\HARDWARE\DEVICEMAP\SERIALCOMM
# Lists every active COM port Windows exposes. No driver, no VID filtering.
# Works for FTDI, CH340, Prolific, CP210x, built-in UART -- everything.
# ==============================================================================
DiagLog ''
DiagLog '=== COM PORTS (Registry SERIALCOMM) ==='
$scaleLines = @()

try {
    $serialComm = Get-ItemProperty 'HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM' -ErrorAction Stop

    $ports = @(
        $serialComm.PSObject.Properties |
        Where-Object { $_.Name -notmatch '^PS' -and $_.Value -match '^COM\d+$' } |
        Select-Object Name, Value |
        Sort-Object { [int]($_.Value -replace 'COM', '') }
    )

    DiagLog "  Registry entries: $($ports.Count)"
    foreach ($entry in $ports) {
        DiagLog ('  Device: ' + $entry.Name + ' = ' + $entry.Value)
        $comPort = $entry.Value
        $dn      = 'Serial Port - ' + $comPort
        $scaleLines += $dn + '|' + $comPort + '|NA|HIGH'
    }
} catch {
    DiagLog ('  Registry SERIALCOMM ERROR: ' + $_.Exception.Message)
}

# Fallback: WMI Win32_SerialPort (catches some devices missed by registry)
if ($scaleLines.Count -eq 0) {
    DiagLog '  Registry empty -- trying WMI Win32_SerialPort...'
    try {
        $wmiPorts = @(Get-WmiObject Win32_SerialPort -ErrorAction Stop)
        DiagLog "  WMI found: $($wmiPorts.Count) port(s)"
        foreach ($sp in $wmiPorts) {
            $comPort = [string]$sp.DeviceID
            DiagLog ('  WMI: ' + $comPort + ' Name: ' + [string]$sp.Name)
            $dn = (if ($sp.Name) { [string]$sp.Name } else { 'Serial Port - ' + $comPort }) -replace '\|', '-'
            $scaleLines += $dn + '|' + $comPort + '|NA|HIGH'
        }
    } catch {
        DiagLog ('  WMI Win32_SerialPort ERROR: ' + $_.Exception.Message)
    }
}

$scaleFile = Join-Path $OutputDir 'sws_scales.txt'
if ($scaleLines.Count -gt 0) { $scaleLines | Set-Content $scaleFile -Encoding UTF8 }
else { '' | Set-Content $scaleFile -Encoding UTF8 }
DiagLog "  Written $($scaleLines.Count) COM port(s) to $scaleFile"

# ---- Write diagnostic log ----------------------------------------------------
DiagLog ''
DiagLog ('Detection complete. Printers: ' + $printerLines.Count + '  COM ports: ' + $scaleLines.Count)
$diagLines | Set-Content $diagLog -Encoding UTF8
Write-Host ('Diagnostic log: ' + $diagLog)

# ---- Exit with counts in stdout so Pascal can read them ----------------------
# Format:  RESULT:<printers>:<comports>
Write-Output ('RESULT:' + $printerLines.Count + ':' + $scaleLines.Count)
