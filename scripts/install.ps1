# =============================================================================
# Design Change Log v2 — One-step installer (Windows)
# =============================================================================
# Run from the project root in PowerShell:
#   .\scripts\install.ps1
#
# If you see an execution policy error, run this first:
#   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# =============================================================================

$ErrorActionPreference = "Stop"
$RequiredNode = 22
$ProjectDir   = Split-Path -Parent $PSScriptRoot

function Print-Step  { param($msg) Write-Host ""; Write-Host "▶  $msg" }
function Print-Ok    { param($msg) Write-Host "   ✔  $msg" -ForegroundColor Green }
function Print-Info  { param($msg) Write-Host "   ℹ  $msg" -ForegroundColor Cyan }
function Print-Warn  { param($msg) Write-Host "   ⚠  $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "============================================"
Write-Host "  Design Change Log v2 — Setup"
Write-Host "============================================"

# ── 1. Check / install Node ───────────────────────────────────────────────────
Print-Step "Checking Node.js version..."

function Get-NodeMajorVersion {
  try {
    $v = & node --version 2>$null
    if ($v -match 'v(\d+)') { return [int]$Matches[1] }
  } catch {}
  return 0
}

function Install-NodeViaWinget {
  Print-Info "Installing Node.js $RequiredNode LTS via winget..."
  winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  # Refresh PATH so node is available in this session
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}

function Assert-Winget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  winget is not available on this machine." -ForegroundColor Red
    Write-Host "  Open the Microsoft Store, search for 'App Installer', and update it."
    Write-Host "  Then re-run this script."
    Write-Host ""
    exit 1
  }
}

$currentNode = Get-NodeMajorVersion

if ($currentNode -ge $RequiredNode) {
  Print-Ok "Node v$currentNode is already installed."
} elseif ($currentNode -gt 0) {
  Print-Info "Node v$currentNode found — upgrading to $RequiredNode..."
  Assert-Winget
  Install-NodeViaWinget
  $newNode = Get-NodeMajorVersion
  Print-Ok "Node v$newNode installed."
} else {
  Print-Info "Node.js not found — installing..."
  Assert-Winget
  Install-NodeViaWinget
  $newNode = Get-NodeMajorVersion
  Print-Ok "Node v$newNode installed."
}

# ── 2. Install npm dependencies ───────────────────────────────────────────────
Print-Step "Installing dependencies..."
Set-Location $ProjectDir

if (Test-Path "node_modules") {
  Print-Ok "node_modules already present — skipping npm install."
} else {
  npm install --silent
  Print-Ok "Dependencies installed."
}

# ── 3. Done ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================"
Write-Host "  All done! Start the tool with:"
Write-Host ""
Write-Host "    npm start"
Write-Host ""
Write-Host "  Then open:  http://localhost:3000"
Write-Host "============================================"
Write-Host ""
