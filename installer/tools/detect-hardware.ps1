<#
.SYNOPSIS
    Detect label printers (USB/USB-CDC) and scale COM ports for the installer wizard.

.DESCRIPTION
    Pure PowerShell reimplementation of printerDetect.ts + scaleDetect.ts.
    Runs DURING the Inno Setup wizard (before file extraction) — no Node.js required.

    COMPLETELY DRIVERLESS — does not require any printer driver installation.

    Printer detection covers three paths:
      1. \\.\USBPRINxx  — Windows auto-loaded usbprint.sys (USB Printer Class devices).
                          Needs NO user action. usbprint.sys ships inside Windows.
      2. COM port       — USB-CDC mode printers (e.g. TVS LP 46 NEO with WCH/GD32 chip).
                          Windows auto-loads usbser.sys. Also needs NO user action.
      3. libusb         — Handled at runtime by UsbDirectAdapter; not detectable here.

    Output format (pipe-delimited text files for Inno Setup Pascal):

    sws_printers.txt
      Format : "Display Name|\\.\USBPRINxx|VID|PROTOCOL|USB"   ← USB Printer Class
               "Display Name|COMx|VID|PROTOCOL|COM"            ← USB-CDC mode printer
    sws_scales.txt
      Format : "Display Name|COMx|VID|CONFIDENCE"

.PARAMETER OutputDir
    Directory to write output files. Default: %TEMP%.

.EXAMPLE
    powershell -File detect-hardware.ps1 -OutputDir C:\Temp
#>
param(
    [string]$OutputDir = $env:TEMP
)

$ErrorActionPreference = 'SilentlyContinue'

# ── Known USB-serial VIDs (mirrors scaleDetect.ts VID_TABLE) ─────────────────
$SCALE_VIDS = @{
    '1A86' = @{ Chip = 'WCH CH340/CH341';     Confidence = 'HIGH'   }
    '0403' = @{ Chip = 'FTDI FT232';          Confidence = 'HIGH'   }
    '10C4' = @{ Chip = 'Silicon Labs CP210x'; Confidence = 'HIGH'   }
    '067B' = @{ Chip = 'Prolific PL2303';     Confidence = 'HIGH'   }
    '04D8' = @{ Chip = 'Microchip MCP2200';   Confidence = 'HIGH'   }
    '0483' = @{ Chip = 'STMicro CDC';         Confidence = 'MEDIUM' }
    '2341' = @{ Chip = 'Arduino CDC';         Confidence = 'MEDIUM' }
}

# ── Known USB printer VIDs (mirrors printerDetect.ts VID_MAP) ────────────────
$PRINTER_VIDS = @{
    '1203' = @{ Protocol = 'TSPL'; Mfr = 'TSC Auto-ID Technology'      }
    '0FE6' = @{ Protocol = 'TSPL'; Mfr = 'IDS / TVS Electronics'       }
    '154F' = @{ Protocol = 'TSPL'; Mfr = 'SNBC'                        }
    '28E9' = @{ Protocol = 'TSPL'; Mfr = 'GD32 / WCH (TVS LP 46 NEO)' }
    '067B' = @{ Protocol = 'TSPL'; Mfr = 'Prolific (TVS bridge chip)'  }
    '0A5F' = @{ Protocol = 'ZPL';  Mfr = 'Zebra Technologies'          }
    '0C2E' = @{ Protocol = 'ZPL';  Mfr = 'Honeywell'                   }
    '1504' = @{ Protocol = 'ZPL';  Mfr = 'Bixolon'                     }
    '04B8' = @{ Protocol = 'ESC_POS'; Mfr = 'Epson'                    }
    '0519' = @{ Protocol = 'ESC_POS'; Mfr = 'Star Micronics'           }
}

# ── Helper: open a file for writing (tests USB printer path access) ───────────
function Test-WriteAccess([string]$Path) {
    try {
        $fs = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
        $fs.Close()
        return $true
    } catch {
        return $false
    }
}

# ── Step 1: Probe USB printer device paths (\\.\USBPRINxx) ───────────────────
Write-Host 'Detecting USB printer paths...'
$writablePaths = @()
for ($i = 1; $i -le 20; $i++) {
    $pad  = $i.ToString('00')
    $path = "\\.\USBPRIN$pad"
    if (Test-WriteAccess $path) {
        $writablePaths += $path
        Write-Host "  Found: $path"
        if ($i -gt 5 -and $writablePaths.Count -eq 0) { break }  # early exit
    }
}

# ── Step 2: Query PnP USB devices for VID/PID/name (parallel with path probe) ─
Write-Host 'Querying PnP USB devices...'
$usbDevices = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match 'USB\\VID_' -and $_.Status -eq 'OK' } |
    ForEach-Object {
        $vid = ([regex]::Match($_.InstanceId, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        $pid = ([regex]::Match($_.InstanceId, 'PID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        if (-not $vid) { return }
        [PSCustomObject]@{
            Name = if ($_.FriendlyName) { $_.FriendlyName } else { $_.Description }
            VID  = $vid
            PID  = $pid
            Class = $_.Class
        }
    }
)

# ── Step 3: Build printer list ────────────────────────────────────────────────
Write-Host 'Building printer list...'
$printerLines = @()

foreach ($usbPath in $writablePaths) {
    $idx     = [int]($usbPath -replace '[^\d]','') - 1
    if ($idx -lt $usbDevices.Count) { $pnpDev = $usbDevices[$idx] } else { $pnpDev = $null }
    if ($pnpDev)                    { $vid = $pnpDev.VID }         else { $vid = '' }
    if ($pnpDev -and $pnpDev.Name)  { $devName = $pnpDev.Name }   else { $devName = '' }

    # Classify protocol
    $protocol = 'UNKNOWN'
    $mfrNote  = ''
    if ($vid -and $PRINTER_VIDS.ContainsKey($vid)) {
        $protocol = $PRINTER_VIDS[$vid].Protocol
        $mfrNote  = $PRINTER_VIDS[$vid].Mfr
    } elseif ($devName -match 'TVS|TSC|SNBC|LP46') {
        $protocol = 'TSPL'
    } elseif ($devName -match 'Zebra') {
        $protocol = 'ZPL'
    } elseif ($devName -match 'Epson|Star|ESC') {
        $protocol = 'ESC_POS'
    }

    # Build display string (avoid inline-if expressions for PS 5.1 compat)
    if ($mfrNote) {
        $displayName = $mfrNote + ' (' + $usbPath + ')'
    } elseif ($devName) {
        $displayName = $devName + ' (' + $usbPath + ')'
    } else {
        $displayName = 'USB Printer (' + $usbPath + ')'
    }

    # Sanitise: remove pipe characters from display name
    $displayName = $displayName -replace '\|', '-'

    # Append interface type (USB = USBPRIN path)
    $printerLines += $displayName + '|' + $usbPath + '|' + $vid + '|' + $protocol + '|USB'
}

# ── Step 3b: Also detect USB-CDC mode printers (com port appears instead of USBPRIN)
# Some printers (e.g. TVS LP 46 NEO with WCH/GD32 chip) enumerate as USB-CDC.
# Windows auto-loads usbser.sys — a COM port appears. No user driver install needed.
# Detect these by checking if any known printer VID appears on a COM port.

Write-Host 'Detecting USB-CDC mode printers (COM port)...'
$printerCdcVids = @('28E9','0FE6','154F','1203','0A5F','1504','04B8','0519')

$comDevicesFull = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { ($_.Name -match 'COM\d' -or $_.Description -match 'COM\d') -and $_.InstanceId -match 'USB\\VID_' } |
    ForEach-Object {
        $comMatch = [regex]::Match($_.Name + ' ' + $_.Description, '(COM\d+)')
        if (-not $comMatch.Success) { return }
        $vid = ([regex]::Match($_.InstanceId, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        $devFriendly = if ($_.FriendlyName) { $_.FriendlyName } else { [string]$_.Description }
        [PSCustomObject]@{
            COM  = $comMatch.Groups[1].Value
            Name = $devFriendly
            VID  = $vid
        }
    }
)

foreach ($comDev in $comDevicesFull) {
    if (-not $printerCdcVids -contains $comDev.VID) { continue }

    $protocol  = 'UNKNOWN'
    $mfrNote   = ''
    if ($PRINTER_VIDS.ContainsKey($comDev.VID)) {
        $protocol = $PRINTER_VIDS[$comDev.VID].Protocol
        $mfrNote  = $PRINTER_VIDS[$comDev.VID].Mfr
    }

    if ($mfrNote) {
        $displayName = $mfrNote + ' [USB-CDC] (' + $comDev.COM + ')'
    } else {
        $displayName = $comDev.Name + ' [USB-CDC]'
    }
    $displayName = $displayName -replace '\|', '-'

    Write-Host '  Found CDC printer: ' + $displayName
    # Append interface type (COM = USB-CDC serial mode)
    $printerLines += $displayName + '|' + $comDev.COM + '|' + $comDev.VID + '|' + $protocol + '|COM'
}

# Sort: TSPL first, then ZPL, then others; USB before COM within same protocol
$printerLines = @(
    @($printerLines | Where-Object { $_ -match '\|TSPL\|' }) +
    @($printerLines | Where-Object { $_ -match '\|ZPL\|'  }) +
    @($printerLines | Where-Object { $_ -match '\|ESC_POS\|' }) +
    @($printerLines | Where-Object { $_ -notmatch '\|(TSPL|ZPL|ESC_POS)\|' })
)

# Write output
$printerFile = Join-Path $OutputDir 'sws_printers.txt'
if ($printerLines.Count -gt 0) {
    $printerLines | Set-Content $printerFile -Encoding UTF8
} else {
    '' | Set-Content $printerFile -Encoding UTF8
}
Write-Host "Printers written: $($printerLines.Count) → $printerFile"

# ── Step 4: Build scale (COM port) list ──────────────────────────────────────
Write-Host 'Detecting USB-serial COM ports...'
$scaleLines    = @()
$scaleVidLines = @()  # HIGH confidence first
$scaleLowLines = @()  # LOW confidence last

$comDevices = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'COM\d' -or $_.Description -match 'COM\d' } |
    ForEach-Object {
        $comMatch = [regex]::Match("$($_.Name) $($_.Description)", '(COM\d+)')
        if (-not $comMatch.Success) { return }
        $vid = ([regex]::Match($_.InstanceId, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        $pid = ([regex]::Match($_.InstanceId, 'PID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        $devFriendly = if ($_.FriendlyName) { $_.FriendlyName } else { [string]$_.Description }
        [PSCustomObject]@{
            COM         = $comMatch.Groups[1].Value
            Name        = $devFriendly
            VID         = $vid
            PID         = $pid
            IsUsbSerial = ($_.InstanceId -match 'USB\\VID_')
        }
    }
)

foreach ($dev in $comDevices) {
    $confidence = 'LOW'
    $chipNote   = ''

    if ($dev.VID -and $SCALE_VIDS.ContainsKey($dev.VID)) {
        $confidence = $SCALE_VIDS[$dev.VID].Confidence
        $chipNote   = $SCALE_VIDS[$dev.VID].Chip
    } elseif ($dev.Name -match 'CH340|CH341|FTDI|CP210|Prolific|Silicon') {
        $confidence = 'HIGH'
        $chipNote   = 'USB-Serial'
    } elseif ($dev.IsUsbSerial) {
        $confidence = 'MEDIUM'
    }

    # Only include USB devices (filter out built-in COM ports)
    if (-not $dev.IsUsbSerial -and -not $dev.VID) { continue }

    if ($chipNote) {
        $displayName = $chipNote + ' - ' + $dev.COM
    } elseif ($dev.Name) {
        $displayName = $dev.Name
    } else {
        $displayName = 'Serial Port (' + $dev.COM + ')'
    }
    $displayName = $displayName -replace '\|', '-'

    $line = $displayName + '|' + $dev.COM + '|' + $dev.VID + '|' + $confidence

    if ($confidence -eq 'HIGH')   { $scaleVidLines += $line }
    else                          { $scaleLowLines  += $line }
}

$scaleLines = @($scaleVidLines) + @($scaleLowLines)

$scaleFile = Join-Path $OutputDir 'sws_scales.txt'
if ($scaleLines.Count -gt 0) {
    $scaleLines | Set-Content $scaleFile -Encoding UTF8
} else {
    '' | Set-Content $scaleFile -Encoding UTF8
}
Write-Host "Scales written: $($scaleLines.Count) → $scaleFile"

Write-Host 'Detection complete.'
