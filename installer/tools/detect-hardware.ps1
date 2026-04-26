<#
.SYNOPSIS
    Detect label printers and scale COM ports for the installer wizard.
.DESCRIPTION
    Three printer paths:
      1. \\.\USBPRINxx  -- raw USB Printer Class (usbprint.sys, driverless)
      2. COM port       -- USB-CDC printers (GD32/WCH chip, usbser.sys)
      3. Get-Printer    -- Windows print spooler (installed driver)
    Two COM port paths:
      1. PnP FriendlyName match (BUG FIX: was checking Name, not FriendlyName)
      2. Registry HKLM\HARDWARE\DEVICEMAP\SERIALCOMM -- ALL ports, no VID filter
    Diagnostic log written to %TEMP%\smart-weight-setup.log
.PARAMETER OutputDir
    Directory to write sws_printers.txt and sws_scales.txt. Default: %TEMP%.
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

DiagLog 'Smart Weight System - Hardware Detection'
DiagLog "Timestamp : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
DiagLog "OS        : $([System.Environment]::OSVersion.VersionString)"
DiagLog ''

# ---- Known VID tables --------------------------------------------------------
$SCALE_VIDS = @{
    '1A86' = @{ Chip = 'WCH CH340/CH341';     Confidence = 'HIGH'   }
    '0403' = @{ Chip = 'FTDI FT232';          Confidence = 'HIGH'   }
    '10C4' = @{ Chip = 'Silicon Labs CP210x'; Confidence = 'HIGH'   }
    '067B' = @{ Chip = 'Prolific PL2303';     Confidence = 'HIGH'   }
    '04D8' = @{ Chip = 'Microchip MCP2200';   Confidence = 'HIGH'   }
    '0483' = @{ Chip = 'STMicro CDC';         Confidence = 'MEDIUM' }
    '2341' = @{ Chip = 'Arduino CDC';         Confidence = 'MEDIUM' }
}

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

$PRINTER_CDC_VIDS = @('28E9','0FE6','154F','1203','0A5F','1504','04B8','0519')

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
    } catch { return $false }
}

$printerLines = @()

# ==============================================================================
# PRINTER PATH 1 -- \\.\USBPRINxx raw device (driverless)
# ==============================================================================
DiagLog '--- Printer Path 1: USB Printer Class (\\.\USBPRINxx) ---'
$writablePaths = @()

for ($attempt = 1; $attempt -le 3; $attempt++) {
    $found = @()
    for ($i = 1; $i -le 20; $i++) {
        $p = '\\.\USBPRIN' + $i.ToString('00')
        if (Test-WriteAccess $p) { $found += $p; DiagLog "  Found: $p" }
        if ($i -gt 5 -and $found.Count -eq 0) { break }
    }
    if ($found.Count -gt 0) { $writablePaths = $found; break }
    if ($attempt -lt 3) {
        DiagLog "  No USBPRIN paths (attempt $attempt/3) - waiting 3s..."
        Start-Sleep -Seconds 3
    }
}

if ($writablePaths.Count -eq 0) {
    DiagLog '  No \\.\USBPRINxx paths - printer may use Windows spooler or USB-CDC.'
}

DiagLog 'Querying PnP USB devices...'
$usbDevices = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match 'USB\\VID_' -and $_.Status -eq 'OK' } |
    ForEach-Object {
        $vid = ([regex]::Match($_.InstanceId, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        if (-not $vid) { return }
        [PSCustomObject]@{
            Name  = if ($_.FriendlyName) { $_.FriendlyName } else { $_.Description }
            VID   = $vid
            Class = $_.Class
        }
    }
)
DiagLog "  PnP USB devices: $($usbDevices.Count)"

foreach ($usbPath in $writablePaths) {
    $idx     = [int]($usbPath -replace '[^\d]','') - 1
    $pnpDev  = if ($idx -lt $usbDevices.Count) { $usbDevices[$idx] } else { $null }
    $vid     = if ($pnpDev) { $pnpDev.VID } else { '' }
    $devName = if ($pnpDev -and $pnpDev.Name) { $pnpDev.Name } else { '' }

    $protocol = 'UNKNOWN'
    $mfrNote  = ''
    if ($vid -and $PRINTER_VIDS.ContainsKey($vid)) {
        $protocol = $PRINTER_VIDS[$vid].Protocol
        $mfrNote  = $PRINTER_VIDS[$vid].Mfr
    } elseif ($devName -match 'TVS|TSC|SNBC|LP46') { $protocol = 'TSPL' }
    elseif ($devName -match 'Zebra')                { $protocol = 'ZPL' }
    elseif ($devName -match 'Epson|Star|ESC')       { $protocol = 'ESC_POS' }

    $dn = ''
    if ($mfrNote) { $dn = $mfrNote + ' (' + $usbPath + ')' }
    elseif ($devName) { $dn = $devName + ' (' + $usbPath + ')' }
    else { $dn = 'USB Printer (' + $usbPath + ')' }
    $dn = $dn -replace '\|', '-'

    $printerLines += $dn + '|' + $usbPath + '|' + $vid + '|' + $protocol + '|USB'
    DiagLog ('  Added USB printer: ' + $dn)
}

# ==============================================================================
# PRINTER PATH 2 -- USB-CDC COM port mode (usbser.sys)
# ==============================================================================
DiagLog ''
DiagLog '--- Printer Path 2: USB-CDC printers (COM port) ---'

$comDevicesFull = @(
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.FriendlyName -match 'COM\d' -or $_.Name -match 'COM\d' -or $_.Description -match 'COM\d') -and
        $_.InstanceId -match 'USB\\VID_'
    } |
    ForEach-Object {
        $src      = [string]$_.FriendlyName + ' ' + [string]$_.Name + ' ' + [string]$_.Description
        $comMatch = [regex]::Match($src, '(COM\d+)')
        if (-not $comMatch.Success) { return }
        $vid      = ([regex]::Match($_.InstanceId, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
        $friendly = if ($_.FriendlyName) { $_.FriendlyName } else { [string]$_.Description }
        [PSCustomObject]@{ COM = $comMatch.Groups[1].Value; Name = $friendly; VID = $vid }
    }
)

foreach ($comDev in $comDevicesFull) {
    if ($PRINTER_CDC_VIDS -notcontains $comDev.VID) { continue }
    $protocol = 'UNKNOWN'
    $mfrNote  = ''
    if ($PRINTER_VIDS.ContainsKey($comDev.VID)) {
        $protocol = $PRINTER_VIDS[$comDev.VID].Protocol
        $mfrNote  = $PRINTER_VIDS[$comDev.VID].Mfr
    }
    $dn = ''
    if ($mfrNote) { $dn = $mfrNote + ' [USB-CDC] (' + $comDev.COM + ')' }
    else          { $dn = $comDev.Name + ' [USB-CDC]' }
    $dn = $dn -replace '\|', '-'
    $printerLines += $dn + '|' + $comDev.COM + '|' + $comDev.VID + '|' + $protocol + '|COM'
    DiagLog ('  Added CDC printer: ' + $dn)
}

# ==============================================================================
# PRINTER PATH 3 -- Windows print spooler (Get-Printer)
# Catches any printer installed via a Windows driver, e.g. SNBC TVSE LP 46 NEO
# ==============================================================================
DiagLog ''
DiagLog '--- Printer Path 3: Windows print spooler (Get-Printer) ---'

try {
    $spoolerPrinters = @(Get-Printer -ErrorAction Stop)
    DiagLog "  Get-Printer found: $($spoolerPrinters.Count)"
} catch {
    $spoolerPrinters = @()
    DiagLog ('  Get-Printer failed: ' + $_.Exception.Message)
}

foreach ($p in $spoolerPrinters) {
    $pName = [string]$p.Name
    if (-not $pName) { continue }

    # Skip virtual / system printers
    if ($pName -match 'PDF|XPS|Fax|OneNote|Microsoft Print|Print to|Send to|CutePDF|Snagit') { continue }

    DiagLog ("  Spooler: '" + $pName + "'  Share:'" + [string]$p.ShareName + "'  Port:'" + [string]$p.PortName + "'")

    # Skip if already found via USBPRIN or CDC
    $dup = $printerLines | Where-Object { $_ -match [regex]::Escape($pName) }
    if ($dup) { DiagLog '  -> already listed, skipping'; continue }

    # Share name for copy /b; fall back to printer name if not shared
    $shareName = ''
    if ($p.ShareName -and [string]$p.ShareName -ne '') { $shareName = [string]$p.ShareName }
    else { $shareName = $pName }

    $protocol = 'TSPL'
    if ($pName -match 'Zebra|ZPL')           { $protocol = 'ZPL' }
    elseif ($pName -match 'Epson|Star|ESC')  { $protocol = 'ESC_POS' }

    # Encode "FullName::ShareName" so generate-env.ps1 can write both
    # PRINTER_NAME (full, for health check) and PRINTER_DEVICE (share, for copy /b)
    $pathField  = ($pName + '::' + $shareName) -replace '\|', '-'
    $displayStr = ($pName + ' [Windows]')      -replace '\|', '-'

    $printerLines += $displayStr + '|' + $pathField + '|NA|' + $protocol + '|WINDOWS'
    DiagLog ('  Added Windows printer: ' + $displayStr + ' (share: ' + $shareName + ')')
}

# Sort: driverless TSPL first, then Windows-installed, then others
$printerLines = @(
    @($printerLines | Where-Object { $_ -match '\|TSPL\|' -and $_ -notmatch '\|WINDOWS$' }) +
    @($printerLines | Where-Object { $_ -match '\|ZPL\|'  -and $_ -notmatch '\|WINDOWS$' }) +
    @($printerLines | Where-Object { $_ -match '\|ESC_POS\|' -and $_ -notmatch '\|WINDOWS$' }) +
    @($printerLines | Where-Object { $_ -match '\|WINDOWS$' }) +
    @($printerLines | Where-Object { $_ -notmatch '\|(TSPL|ZPL|ESC_POS)\|' -and $_ -notmatch '\|WINDOWS$' })
)

$printerFile = Join-Path $OutputDir 'sws_printers.txt'
if ($printerLines.Count -gt 0) { $printerLines | Set-Content $printerFile -Encoding UTF8 }
else { '' | Set-Content $printerFile -Encoding UTF8 }

DiagLog ''
DiagLog ('=== PRINTERS: ' + $printerLines.Count + ' ===')
$printerLines | ForEach-Object { DiagLog ('  ' + $_) }

# ==============================================================================
# COM PORT PATH 1 -- PnP VID match (known chips)
# BUG FIX: was checking $_.Name; USB Serial Port COMx number is in FriendlyName
# ==============================================================================
DiagLog ''
DiagLog '--- COM Path 1: PnP VID match (checks FriendlyName) ---'

$scaleVidLines  = @()
$scaleLowLines  = @()
$scaleSeenPorts = [System.Collections.Generic.HashSet[string]]::new()
$pnpComDevices  = @()

for ($attempt = 1; $attempt -le 3; $attempt++) {
    $found = @(
        Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.FriendlyName -match 'COM\d' -or $_.Name -match 'COM\d' -or $_.Description -match 'COM\d') -and
            $_.InstanceId -match 'USB\\VID_'
        }
    )
    if ($found.Count -gt 0) { $pnpComDevices = $found; break }
    if ($attempt -lt 3) {
        DiagLog "  No PnP USB-serial found (attempt $attempt/3) - waiting 3s..."
        Start-Sleep -Seconds 3
    }
}

DiagLog "  PnP USB-serial candidates: $($pnpComDevices.Count)"

foreach ($dev in $pnpComDevices) {
    $nameStr  = [string]$dev.FriendlyName + ' ' + [string]$dev.Name + ' ' + [string]$dev.Description
    $comMatch = [regex]::Match($nameStr, '(COM\d+)')
    if (-not $comMatch.Success) { continue }
    $comPort  = $comMatch.Groups[1].Value

    $vid      = ([regex]::Match($dev.InstanceId, 'VID_([0-9A-Fa-f]{4})')).Groups[1].Value.ToUpper()
    $friendly = if ($dev.FriendlyName) { $dev.FriendlyName } else { [string]$dev.Description }

    $confidence = 'MEDIUM'
    $chipNote   = ''
    if ($vid -and $SCALE_VIDS.ContainsKey($vid)) {
        $confidence = $SCALE_VIDS[$vid].Confidence
        $chipNote   = $SCALE_VIDS[$vid].Chip
    } elseif ($friendly -match 'CH340|CH341|FTDI|CP210|Prolific|Silicon') {
        $confidence = 'HIGH'
        $chipNote   = 'USB-Serial'
    }

    $dn = ''
    if ($chipNote) { $dn = $chipNote + ' - ' + $comPort }
    else           { $dn = $friendly }
    $dn = $dn -replace '\|', '-'

    $line = $dn + '|' + $comPort + '|' + $vid + '|' + $confidence
    DiagLog ('  PnP COM: ' + $line)
    $null = $scaleSeenPorts.Add($comPort)
    if ($confidence -eq 'HIGH') { $scaleVidLines += $line }
    else                        { $scaleLowLines  += $line }
}

# ==============================================================================
# COM PORT PATH 2 -- Registry SERIALCOMM (ALL ports regardless of VID/driver)
# This catches COM5 (USB Serial Port) even when VID is unknown or generic.
# ==============================================================================
DiagLog ''
DiagLog '--- COM Path 2: Registry SERIALCOMM (all ports) ---'
$scaleRegLines = @()

try {
    $serialComm = Get-ItemProperty 'HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM' -ErrorAction Stop
    $regPorts = @(
        $serialComm.PSObject.Properties |
        Where-Object { $_.Name -notmatch '^PS' -and $_.Value -match '^COM\d+$' } |
        Select-Object -ExpandProperty Value |
        Sort-Object { [int]($_ -replace 'COM', '') }
    )
    DiagLog ('  Registry COM ports: ' + ($regPorts -join ', '))
} catch {
    $regPorts = @()
    DiagLog ('  Registry read failed: ' + $_.Exception.Message)
}

foreach ($regPort in $regPorts) {
    if ($scaleSeenPorts.Contains($regPort)) { continue }
    $dn = 'Serial Port - ' + $regPort
    $scaleRegLines += $dn + '|' + $regPort + '|UNKNOWN|MEDIUM'
    $null = $scaleSeenPorts.Add($regPort)
    DiagLog ('  Registry COM: ' + $regPort)
}

# Merge: HIGH VID first, then MEDIUM/LOW, then registry-only
$scaleLines = @($scaleVidLines) + @($scaleLowLines) + @($scaleRegLines)

$scaleFile = Join-Path $OutputDir 'sws_scales.txt'
if ($scaleLines.Count -gt 0) { $scaleLines | Set-Content $scaleFile -Encoding UTF8 }
else { '' | Set-Content $scaleFile -Encoding UTF8 }

DiagLog ''
DiagLog ('=== COM PORTS: ' + $scaleLines.Count + ' ===')
$scaleLines | ForEach-Object { DiagLog ('  ' + $_) }

# ---- Write diagnostic log ----------------------------------------------------
DiagLog ''
DiagLog ('Detection complete. OutputDir: ' + $OutputDir)
$diagLines | Set-Content $diagLog -Encoding UTF8
Write-Host ('Diagnostic log: ' + $diagLog)
