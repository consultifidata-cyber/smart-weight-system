# ============================================================
# Smart Weight System -- Station Installer (PowerShell)
# ============================================================
# Run as Administrator:
#   Right-click PowerShell -> "Run as administrator"
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#   cd C:\smart-weight-system
#   .\deploy\install.ps1
#
# This script:
#   1. Validates prerequisites (Node.js, Git, npm)
#   2. Cleans up any previous installation (PM2, old shortcuts)
#   3. Prompts for station-specific configuration
#   4. Creates .env from template
#   5. Runs npm install
#   6. Creates logs directory
#   7. Starts services via launcher
#   8. Configures auto-start on Windows boot
#   9. Creates a desktop shortcut and opens the browser
# ============================================================

param(
    [switch]$SkipPrereqs,
    [switch]$SkipPrompts
)

$ErrorActionPreference = "Stop"

# -- Colours and helpers --------------------------------------

function Write-Step($num, $msg) {
    Write-Host ""
    Write-Host "  [$num] $msg" -ForegroundColor Cyan
    Write-Host "  $('-' * ($msg.Length + 4))" -ForegroundColor DarkGray
}

function Write-Ok($msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

# -- Banner ---------------------------------------------------

Write-Host ""
Write-Host "  ================================================" -ForegroundColor White
Write-Host "  Smart Weight System -- Station Installer" -ForegroundColor White
Write-Host "  ================================================" -ForegroundColor White
Write-Host ""

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }
Write-Host "  Repo root: $repoRoot" -ForegroundColor DarkGray

# -- Step 1: Prerequisite Check -------------------------------

if (-not $SkipPrereqs) {
    Write-Step "1/9" "Checking prerequisites"

    # Node.js
    if (Test-Command "node") {
        $nodeVersion = (node --version 2>$null)
        Write-Ok "Node.js $nodeVersion"

        # Check minimum version (v18+)
        $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
        if ($major -lt 18) {
            Write-Err "Node.js v18+ required. Current: $nodeVersion"
            Write-Host "  Download: https://nodejs.org/" -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Err "Node.js is not installed."
        Write-Host "  Download: https://nodejs.org/ (LTS version)" -ForegroundColor Yellow
        exit 1
    }

    # npm
    if (Test-Command "npm") {
        $npmVersion = (npm --version 2>$null)
        Write-Ok "npm $npmVersion"
    } else {
        Write-Err "npm not found. Reinstall Node.js from https://nodejs.org/"
        exit 1
    }

    # Git
    if (Test-Command "git") {
        $gitVersion = (git --version 2>$null)
        Write-Ok "$gitVersion"
    } else {
        Write-Err "Git is not installed."
        Write-Host "  Download: https://git-scm.com/download/win" -ForegroundColor Yellow
        exit 1
    }

    # curl (for health checks)
    if (Test-Command "curl") {
        Write-Ok "curl available"
    } else {
        Write-Warn "curl not found. Health checks will not work."
    }
} else {
    Write-Host "  Skipping prerequisite check (--SkipPrereqs)" -ForegroundColor DarkGray
}

# -- Step 2: Clean Up Previous Installation --------------------

Write-Step "2/9" "Cleaning up previous installation"

# Kill old launcher if running
$pidFile = Join-Path $repoRoot ".launcher.pid"
if (Test-Path $pidFile) {
    $oldPid = (Get-Content $pidFile -Raw).Trim()
    Write-Host "  Stopping old launcher (PID $oldPid)..." -ForegroundColor DarkGray
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    taskkill /pid $oldPid /t /f 2>&1 | Out-Null
    $ErrorActionPreference = $savedEAP
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# Kill PM2 daemon if running (upgrade from PM2-based install)
if (Test-Command "pm2") {
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    pm2 kill 2>&1 | Out-Null
    $ErrorActionPreference = $savedEAP
    Write-Host "  Stopped PM2 daemon (if any)." -ForegroundColor DarkGray
}

# Remove old PM2 Scheduled Task
Unregister-ScheduledTask -TaskName "SmartWeightPM2" -Confirm:$false -ErrorAction SilentlyContinue

# Remove old Startup shortcut (.lnk from PM2-based install)
$oldLnk = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("Startup"),
    "SmartWeightSystem.lnk"
)
if (Test-Path $oldLnk) {
    Remove-Item $oldLnk -Force
    Write-Host "  Removed old .lnk Startup shortcut." -ForegroundColor DarkGray
}

# Remove any previous Startup-folder fallback .vbs (re-created in Step 7c)
$oldVbs = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("Startup"),
    "SmartWeightLauncher.vbs"
)
if (Test-Path $oldVbs) {
    Remove-Item $oldVbs -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed old .vbs Startup fallback." -ForegroundColor DarkGray
}

Write-Ok "Cleanup complete"

# -- Step 3: Station Configuration ----------------------------

Write-Step "3/9" "Station configuration"

$envFile = Join-Path $repoRoot ".env"
$templateFile = Join-Path $repoRoot "deploy\config-template.env"

if (-not (Test-Path $templateFile)) {
    Write-Err "Template file not found: $templateFile"
    Write-Host "  Re-clone the repository or restore deploy\config-template.env." -ForegroundColor Yellow
    exit 1
}

if (Test-Path $envFile) {
    Write-Warn ".env already exists. Skipping configuration."
    Write-Host "  To reconfigure, delete .env and re-run this script." -ForegroundColor DarkGray
} else {
    if (-not $SkipPrompts) {
        Write-Host ""
        Write-Host "  Enter station-specific values (press Enter for defaults):" -ForegroundColor White
        Write-Host ""

        $stationId   = Read-Host "  Station ID (e.g. ST01, ST02)"
        $plantId     = Read-Host "  Plant ID (e.g. A1)"
        $comPort     = Read-Host "  Serial port for scale (e.g. COM3)"
        $printerShare = Read-Host "  Printer share name (e.g. TVSLP46NEO)"
        $printerFull = Read-Host "  Printer full name (e.g. SNBC TVSE LP 46 NEO BPLE)"
        $djangoUrl   = Read-Host "  Django server URL (e.g. http://192.168.1.100:8000)"
        $djangoToken = Read-Host "  Django API token (from WeighStation table)"

        # Apply defaults
        if (-not $stationId)    { $stationId = "ST01" }
        if (-not $plantId)      { $plantId = "A1" }
        if (-not $comPort)      { $comPort = "COM3" }
        if (-not $printerShare) { $printerShare = "TVSLP46NEO" }
        if (-not $printerFull)  { $printerFull = "SNBC TVSE LP 46 NEO BPLE" }
        if (-not $djangoUrl)    { $djangoUrl = "http://127.0.0.1:8000" }
        if (-not $djangoToken)  { $djangoToken = "CHANGE_ME" }

        # Read template and replace placeholders.
        # Escape '$' in user values -- PowerShell -replace treats '$' in the
        # replacement string as a regex back-reference ($1, $&, etc.), which
        # silently mangles tokens or URLs that contain '$'.
        function Safe-Replace($content, $placeholder, $value) {
            $escapedValue = $value -replace '\$', '$$$$'
            return $content -replace $placeholder, $escapedValue
        }

        $envContent = Get-Content $templateFile -Raw
        $envContent = Safe-Replace $envContent '__STATION_ID__' $stationId
        $envContent = Safe-Replace $envContent '__PLANT_ID__' $plantId
        $envContent = Safe-Replace $envContent '__COM_PORT__' $comPort
        $envContent = Safe-Replace $envContent '__PRINTER_SHARE_NAME__' $printerShare
        $envContent = Safe-Replace $envContent '__PRINTER_FULL_NAME__' $printerFull
        $envContent = Safe-Replace $envContent '__DJANGO_URL__' $djangoUrl
        $envContent = Safe-Replace $envContent '__DJANGO_TOKEN__' $djangoToken

        Set-Content -Path $envFile -Value $envContent -Encoding UTF8
        Write-Ok ".env created with station config"
    } else {
        # Non-interactive: copy template as-is
        Copy-Item $templateFile $envFile
        Write-Warn ".env created from template. Edit placeholders manually."
    }
}

# -- Step 4: Install npm Dependencies -------------------------

Write-Step "4/9" "Installing npm dependencies"

Push-Location $repoRoot
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Err "npm install failed. Check network and try again."
    Pop-Location
    exit 1
}
Pop-Location
Write-Ok "Dependencies installed"

# -- Step 5: Create Logs Directory -----------------------------

Write-Step "5/9" "Creating logs directory"

$logsDir = Join-Path $repoRoot "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
    Write-Ok "Created $logsDir"
} else {
    Write-Ok "Logs directory already exists"
}

# -- Step 6: Start Services ------------------------------------

Write-Step "6/9" "Starting services"

$launcherFile = Join-Path $repoRoot "deploy\launcher.js"
$nodePath = (Get-Command node).Source

# Start the launcher hidden (no visible window)
Start-Process -FilePath $nodePath -ArgumentList "`"$launcherFile`"" `
    -WorkingDirectory $repoRoot -WindowStyle Hidden

Write-Host "  Waiting 5 seconds for services to initialize..."
Start-Sleep -Seconds 5

# Verify services started by checking the PID file
$pidFile = Join-Path $repoRoot ".launcher.pid"
if (Test-Path $pidFile) {
    $launcherPid = (Get-Content $pidFile -Raw).Trim()
    Write-Ok "Launcher running (PID $launcherPid)"
} else {
    Write-Warn "Launcher PID file not found. Check logs for errors."
}

# -- Step 7: Configure Auto-Start on Boot ---------------------

Write-Step "7/9" "Configuring auto-start on Windows boot"

# -- 7a: Scheduled Task to start launcher at system startup --
# Uses node.exe directly (not cmd.exe) so no CMD window appears.
try {
    Unregister-ScheduledTask -TaskName "SmartWeightLauncher" -Confirm:$false -ErrorAction SilentlyContinue

    $action   = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$launcherFile`"" -WorkingDirectory $repoRoot
    $trigger  = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 0)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest -LogonType S4U

    Register-ScheduledTask -TaskName "SmartWeightLauncher" `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description "Smart Weight System -- auto-start services at boot" | Out-Null

    Write-Ok "Scheduled Task 'SmartWeightLauncher' registered"
    Write-Host "  Services will auto-start when Windows boots." -ForegroundColor DarkGray
} catch {
    Write-Warn "Could not create Scheduled Task: $_"
    Write-Host "  Manual alternative: Open Task Scheduler and create a task that runs:" -ForegroundColor Yellow
    Write-Host "    node `"$launcherFile`"" -ForegroundColor Yellow
    Write-Host "  Trigger: At startup | Run whether user is logged on or not" -ForegroundColor Yellow
}

# -- 7b: Browser auto-open at user login --
# The Scheduled Task runs at system startup (before login), so it
# cannot open a browser. A .url shortcut in the Startup folder opens
# the web-ui when the user logs in -- by then services are running.
$startupUrl = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("Startup"),
    "SmartWeightSystem.url"
)
try {
    $urlContent = @"
[InternetShortcut]
URL=http://localhost:3000
"@
    Set-Content -Path $startupUrl -Value $urlContent -Encoding ASCII
    Write-Ok "Startup browser shortcut created (opens web-ui at login)"
} catch {
    Write-Warn "Could not create Startup .url shortcut: $_"
}

# -- 7c: Fallback launcher via Startup folder (belt-and-braces) --
# The Scheduled Task above works on Windows Pro / domain accounts, but
# Windows Home often denies S4U logon, silently preventing the task from
# firing at boot. This .vbs runs at user login with no visible window
# and starts the launcher. If the Scheduled Task already started it,
# launcher.js detects the live PID and exits -- no double-start.
$startupVbs = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("Startup"),
    "SmartWeightLauncher.vbs"
)
try {
    $vbsContent = @"
' Smart Weight System -- hidden launcher fallback
' Fires at user login, starts node launcher with no CMD window.
' launcher.js is idempotent: if already running (from Scheduled Task),
' it exits without starting a duplicate.
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$repoRoot"
WshShell.Run """$nodePath"" ""$launcherFile""", 0, False
"@
    Set-Content -Path $startupVbs -Value $vbsContent -Encoding ASCII
    Write-Ok "Startup launcher fallback created (runs at user login)"
    Write-Host "  Safety net if Scheduled Task can't run on this Windows edition." -ForegroundColor DarkGray
} catch {
    Write-Warn "Could not create Startup launcher fallback: $_"
}

# -- Step 8: Create Desktop Shortcuts -------------------------

Write-Step "8/9" "Creating desktop shortcuts"

$desktopPath = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktopPath "Smart Weight System.url"

try {
    $urlContent = @"
[InternetShortcut]
URL=http://localhost:3000
IconIndex=0
"@
    Set-Content -Path $desktopShortcut -Value $urlContent -Encoding ASCII
    Write-Ok "Desktop shortcut created: Smart Weight System.url"
} catch {
    Write-Warn "Could not create desktop shortcut: $_"
}

# -- 8b: "Restart Services" .lnk shortcut --------------------
# One-click restart for workers. Points to start-all.bat which
# stops the current launcher (graceful drain) and starts it again.
# No confirm prompt by design -- workers click to self-service.
$startAllBat = Join-Path $repoRoot "deploy\start-all.bat"
$restartLnk = Join-Path $desktopPath "Smart Weight - Restart Services.lnk"

try {
    $wshShell = New-Object -ComObject WScript.Shell
    $lnk = $wshShell.CreateShortcut($restartLnk)
    $lnk.TargetPath       = "$env:ComSpec"                    # cmd.exe
    $lnk.Arguments        = "/c `"`"$startAllBat`"`""          # /c "start-all.bat"
    $lnk.WorkingDirectory = Join-Path $repoRoot "deploy"
    $lnk.IconLocation     = "shell32.dll,238"                  # circular-arrow refresh icon
    $lnk.WindowStyle      = 7                                  # minimised
    $lnk.Description      = "Restart all Smart Weight System services"
    $lnk.Save()
    Write-Ok "Desktop shortcut created: Smart Weight - Restart Services.lnk"
} catch {
    Write-Warn "Could not create restart shortcut: $_"
}

# -- Step 9: Open Browser -------------------------------------

Write-Step "9/9" "Opening web-ui in browser"

Start-Process "http://localhost:3000"
Write-Ok "Browser launched"

# -- Summary --------------------------------------------------

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "  ================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Web UI:         http://localhost:3000" -ForegroundColor White
Write-Host "  Dispatch UI:    http://localhost:3000/dispatch/" -ForegroundColor White
Write-Host "  Dispatch API:   http://localhost:4000/health" -ForegroundColor White
Write-Host "  Weight API:     http://localhost:5000/health" -ForegroundColor White
Write-Host "  Print API:      http://localhost:5001/health" -ForegroundColor White
Write-Host "  Sync API:       http://localhost:5002/health" -ForegroundColor White
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor DarkGray
Write-Host "    deploy\health-check.bat -- Full health check" -ForegroundColor DarkGray
Write-Host "    deploy\start-all.bat    -- Start all services" -ForegroundColor DarkGray
Write-Host "    deploy\stop-all.bat     -- Stop all services" -ForegroundColor DarkGray
Write-Host "    deploy\update.bat       -- Pull latest + restart" -ForegroundColor DarkGray
Write-Host "    type logs\*.log         -- View service logs" -ForegroundColor DarkGray
Write-Host ""
