# VSC Toolbox - runo-search Download Script
#
# Downloads pre-built runo-search native addon from GitHub releases.
# This is a Rust-based Node.js native addon (napi-rs) that provides fast,
# regex-based file searching using memory-mapped files and SIMD-accelerated
# regex matching.
#
# Output directory: bin\win_x64\runo-search\
#   index.js                              (napi-rs loader)
#   index.d.ts                            (TypeScript type declarations)
#   runo-search.win32-x64-msvc.node       (native addon binary)
#   LICENSE

$ErrorActionPreference = "Stop"

# ============================================================================
# Configuration
# ============================================================================

$release = "v0.1.0"

$runoSearchUrl     = "https://github.com/pieths/runo-search/releases/download/$release/runo-search_${release}_win-x64.zip"
$expectedHash      = "6f53d70af75d8cc2fc709c9e663f5ca330f5e14bbe9e8e458a073182b9b04453"

# Paths (script lives in scripts/, output goes to project root bin/)
$projectRoot       = Split-Path $PSScriptRoot -Parent
$runoSearchDir     = Join-Path $projectRoot "bin\win_x64\runo-search"
$runoSearchNode    = Join-Path $runoSearchDir "runo-search.win32-x64-msvc.node"

$zipPath           = Join-Path $runoSearchDir "runo-search_${release}_win-x64.zip"

# ============================================================================
# Header
# ============================================================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  runo-search Download Script ($release)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# Check if already present
# ============================================================================

if (Test-Path $runoSearchNode) {
    Write-Host "runo-search native addon already present" -ForegroundColor Green
    Write-Host "Output: $runoSearchDir" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

# ============================================================================
# Step 1: Create output directory
# ============================================================================

if (!(Test-Path $runoSearchDir)) {
    New-Item -ItemType Directory -Path $runoSearchDir -Force | Out-Null
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ============================================================================
# Step 2: Download runo-search
# ============================================================================

Write-Host "Downloading runo-search native addon..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $runoSearchUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "Download complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to download runo-search!" -ForegroundColor Red
    Write-Host "  URL: $runoSearchUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# ============================================================================
# Step 3: Verify checksum
# ============================================================================

Write-Host "Verifying SHA256 checksum..." -ForegroundColor Yellow
$actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $expectedHash) {
    Write-Host "ERROR: Checksum verification failed!" -ForegroundColor Red
    Write-Host "  Expected: $expectedHash" -ForegroundColor Red
    Write-Host "  Actual:   $actualHash" -ForegroundColor Red
    Remove-Item $zipPath -Force
    exit 1
}
Write-Host "Checksum verified" -ForegroundColor Green

# ============================================================================
# Step 4: Extract archive
# ============================================================================

Write-Host "Extracting runo-search..." -ForegroundColor Yellow
try {
    Expand-Archive -Path $zipPath -DestinationPath $runoSearchDir -Force
    Write-Host "Extraction complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to extract runo-search!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# ============================================================================
# Step 5: Clean up zip file
# ============================================================================

Remove-Item $zipPath -Force

# ============================================================================
# Summary
# ============================================================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  runo-search Download Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Output: $runoSearchDir" -ForegroundColor Cyan
Write-Host ""
