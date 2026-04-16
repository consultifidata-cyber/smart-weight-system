# ============================================================
# Smart Weight System — Station Installer (PowerShell)
# ============================================================
# Run as Administrator:
#   Right-click PowerShell → "Run as administrator"
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#   cd C:\smart-weight-system
#   .\deploy\install.ps1
#
# This script:
#   1. Validates prerequisites (Node.js, Git, npm)
#   2. Installs PM2 globally
#   3. Prompts for station-specific configuration
#   4. Creates .env from template
#   5. Runs npm install
#   6. Starts services via PM2
#   7. Configures auto-start on Windows boot
#   8. Creates a desktop shortcut
#   9. Opens the web-ui in the browser
# ============================================================

param(
    [switch]$SkipPrereqs,
    [switch]$SkipPrompts
)

$ErrorActionPreference = "Stop"

# ── Colours and helpers ──────────────────────────────────────

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

# ── Banner ───────────────────────────────────────────────────

Write-Host ""
Write-Host "  ================================================" -ForegroundColor White
Write-Host "  Smart Weight System — Station Installer" -ForegroundColor White
Write-Host "  ================================================" -ForegroundColor White
Write-Host ""

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }
Write-Host "  Repo root: $repoRoot" -ForegroundColor DarkGray

# ── Step 1: Prerequisite Check ───────────────────────────────

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

# ── Step 2: Install PM2 Globally ─────────────────────────────

Write-Step "2/9" "Installing PM2 globally"

if (Test-Command "pm2") {
    $pm2Version = (pm2 --version 2>$null)
    Write-Ok "PM2 $pm2Version already installed"
} else {
    Write-Host "  Installing pm2..."
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to install PM2. Try: npm install -g pm2"
        exit 1
    }
    Write-Ok "PM2 installed"
}

# ── Step 3: Station Configuration ────────────────────────────

Write-Step "3/9" "Station configuration"

$envFile = Join-Path $repoRoot ".env"
$templateFile = Join-Path $repoRoot "deploy\config-template.env"

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

        # Read template and replace placeholders
        $envContent = Get-Content $templateFile -Raw
        $envContent = $envContent -replace '__STATION_ID__', $stationId
        $envContent = $envContent -replace '__PLANT_ID__', $plantId
        $envContent = $envContent -replace '__COM_PORT__', $comPort
        $envContent = $envContent -replace '__PRINTER_SHARE_NAME__', $printerShare
        $envContent = $envContent -replace '__PRINTER_FULL_NAME__', $printerFull
        $envContent = $envContent -replace '__DJANGO_URL__', $djangoUrl
        $envContent = $envContent -replace '__DJANGO_TOKEN__', $djangoToken

        Set-Content -Path $envFile -Value $envContent -Encoding UTF8
        Write-Ok ".env created with station config"
    } else {
        # Non-interactive: copy template as-is
        Copy-Item $templateFile $envFile
        Write-Warn ".env created from template. Edit placeholders manually."
    }
}

# ── Step 4: Install npm Dependencies ─────────────────────────

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

# ── Step 5: Create Logs Directory ─────────────────────────────

Write-Step "5/9" "Creating logs directory"

$logsDir = Join-Path $repoRoot "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
    Write-Ok "Created $logsDir"
} else {
    Write-Ok "Logs directory already exists"
}

# ── Step 6: Start Services via PM2 ───────────────────────────

Write-Step "6/9" "Starting services via PM2"

$ecosystemFile = Join-Path $repoRoot "deploy\ecosystem.config.js"

# Kill any existing PM2 processes for this project
pm2 delete all 2>$null

pm2 start $ecosystemFile
if ($LASTEXITCODE -ne 0) {
    Write-Err "PM2 failed to start services."
    exit 1
}

pm2 save
Write-Ok "All 4 services started"

# Wait for services to boot
Write-Host "  Waiting 5 seconds for services to initialize..."
Start-Sleep -Seconds 5

pm2 status

# ── Step 7: Configure Auto-Start on Boot ─────────────────────

Write-Step "7/9" "Configuring auto-start on Windows boot"

# Method: Create a startup shortcut that runs start-all.bat
$startupFolder = [System.IO.Path]::Combine(
    [Environment]::GetFolderPath("Startup"),
    "SmartWeightSystem.lnk"
)

$startAllBat = Join-Path $repoRoot "deploy\start-all.bat"

try {
    $WshShell = New-Object -ComObject WScript.Shell
    $shortcut = $WshShell.CreateShortcut($startupFolder)
    $shortcut.TargetPath = $startAllBat
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = "Smart Weight System — Auto Start"
    $shortcut.WindowStyle = 7  # Minimized
    $shortcut.Save()
    Write-Ok "Startup shortcut created at: $startupFolder"
    Write-Host "  Services will auto-start when Windows boots." -ForegroundColor DarkGray
} catch {
    Write-Warn "Could not create startup shortcut: $_"
    Write-Host "  Manual alternative: Place a shortcut to deploy\start-all.bat in:" -ForegroundColor Yellow
    Write-Host "  shell:startup (Win+R → shell:startup)" -ForegroundColor Yellow
}

# ── Step 8: Create Desktop Shortcut ──────────────────────────

Write-Step "8/9" "Creating desktop shortcut"

$desktopPath = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktopPath "Smart Weight System.lnk"

try {
    $WshShell2 = New-Object -ComObject WScript.Shell
    $shortcut2 = $WshShell2.CreateShortcut($desktopShortcut)
    $shortcut2.TargetPath = "http://localhost:3000"
    $shortcut2.Description = "Smart Weight System — Web UI"
    $shortcut2.Save()
    Write-Ok "Desktop shortcut created: Smart Weight System"
} catch {
    Write-Warn "Could not create desktop shortcut."
}

# ── Step 9: Open Browser ─────────────────────────────────────

Write-Step "9/9" "Opening web-ui in browser"

Start-Process "http://localhost:3000"
Write-Ok "Browser launched"

# ── Summary ──────────────────────────────────────────────────

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Green
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "  ================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Web UI:       http://localhost:3000" -ForegroundColor White
Write-Host "  Weight API:   http://localhost:5000/health" -ForegroundColor White
Write-Host "  Print API:    http://localhost:5001/health" -ForegroundColor White
Write-Host "  Sync API:     http://localhost:5002/health" -ForegroundColor White
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor DarkGray
Write-Host "    pm2 status           — Check service status" -ForegroundColor DarkGray
Write-Host "    pm2 logs             — View live logs" -ForegroundColor DarkGray
Write-Host "    pm2 restart all      — Restart all services" -ForegroundColor DarkGray
Write-Host "    deploy\health-check.bat — Full health check" -ForegroundColor DarkGray
Write-Host "    deploy\update.bat    — Pull latest + restart" -ForegroundColor DarkGray
Write-Host ""
