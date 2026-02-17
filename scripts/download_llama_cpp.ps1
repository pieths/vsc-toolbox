# VSC Toolbox - llama.cpp Download Script
#
# Downloads pre-built llama.cpp server binaries and CUDA runtime from GitHub releases.
# No build tools required - just downloads and extracts the binaries.
#
# Output directory: bin\win_x64\llama.cpp\
#   llama-server.exe
#   ... (other llama.cpp binaries)
#   ... (CUDA runtime DLLs)
#   LICENSE

$ErrorActionPreference = "Stop"

# ============================================================================
# Configuration
# ============================================================================

$release = "b8054"

$llamaUrl          = "https://github.com/ggml-org/llama.cpp/releases/download/$release/llama-$release-bin-win-cuda-12.4-x64.zip"
$expectedHash      = "21b25d2553ccd7c7abef334313e06ef202f22260a534b329a784ef343c072617"

$llamaCudaUrl      = "https://github.com/ggml-org/llama.cpp/releases/download/$release/cudart-llama-bin-win-cuda-12.4-x64.zip"
$expectedCudaHash  = "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"

$licenseUrl        = "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/LICENSE"

# Paths (script lives in scripts/, output goes to project root bin/)
$projectRoot       = Split-Path $PSScriptRoot -Parent
$llamaDir          = Join-Path $projectRoot "bin\win_x64\llama.cpp"
$llamaServerExe    = Join-Path $llamaDir "llama-server.exe"

$zipPath           = Join-Path $llamaDir "llama-$release-bin-win-cuda-12.4-x64.zip"
$cudaZipPath       = Join-Path $llamaDir "cudart-llama-bin-win-cuda-12.4-x64.zip"

# ============================================================================
# Header
# ============================================================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  llama.cpp Download Script ($release)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# Check if already present
# ============================================================================

if (Test-Path $llamaServerExe) {
    Write-Host "llama.cpp binaries already present" -ForegroundColor Green
    Write-Host "Output: $llamaDir" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

# ============================================================================
# Step 1: Create output directory
# ============================================================================

if (!(Test-Path $llamaDir)) {
    New-Item -ItemType Directory -Path $llamaDir -Force | Out-Null
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ============================================================================
# Step 2: Download llama.cpp binaries
# ============================================================================

Write-Host "Downloading llama.cpp binaries..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $llamaUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "llama.cpp download complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to download llama.cpp binaries!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# Verify llama.cpp checksum
Write-Host "Verifying llama.cpp SHA256 checksum..." -ForegroundColor Yellow
$actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $expectedHash) {
    Write-Host "ERROR: llama.cpp checksum verification failed!" -ForegroundColor Red
    Write-Host "  Expected: $expectedHash" -ForegroundColor Red
    Write-Host "  Actual:   $actualHash" -ForegroundColor Red
    Remove-Item $zipPath -Force
    exit 1
}
Write-Host "llama.cpp checksum verified" -ForegroundColor Green

# ============================================================================
# Step 3: Download CUDA runtime
# ============================================================================

Write-Host "Downloading CUDA runtime..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $llamaCudaUrl -OutFile $cudaZipPath -UseBasicParsing
    Write-Host "CUDA runtime download complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to download CUDA runtime!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Remove-Item $zipPath -Force
    exit 1
}

# Verify CUDA runtime checksum
Write-Host "Verifying CUDA runtime SHA256 checksum..." -ForegroundColor Yellow
$actualCudaHash = (Get-FileHash -Path $cudaZipPath -Algorithm SHA256).Hash.ToLower()
if ($actualCudaHash -ne $expectedCudaHash) {
    Write-Host "ERROR: CUDA runtime checksum verification failed!" -ForegroundColor Red
    Write-Host "  Expected: $expectedCudaHash" -ForegroundColor Red
    Write-Host "  Actual:   $actualCudaHash" -ForegroundColor Red
    Remove-Item $zipPath -Force
    Remove-Item $cudaZipPath -Force
    exit 1
}
Write-Host "CUDA runtime checksum verified" -ForegroundColor Green

# ============================================================================
# Step 4: Extract archives
# ============================================================================

Write-Host "Extracting llama.cpp binaries..." -ForegroundColor Yellow
try {
    Expand-Archive -Path $zipPath -DestinationPath $llamaDir -Force
    Write-Host "llama.cpp extraction complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to extract llama.cpp binaries!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host "Extracting CUDA runtime..." -ForegroundColor Yellow
try {
    Expand-Archive -Path $cudaZipPath -DestinationPath $llamaDir -Force
    Write-Host "CUDA runtime extraction complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to extract CUDA runtime!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# ============================================================================
# Step 5: Clean up zip files
# ============================================================================

Remove-Item $zipPath -Force
Remove-Item $cudaZipPath -Force

# ============================================================================
# Step 6: Download LICENSE
# ============================================================================

Write-Host "Downloading llama.cpp LICENSE..." -ForegroundColor Yellow
$licensePath = Join-Path $llamaDir "LICENSE"
try {
    Invoke-WebRequest -Uri $licenseUrl -OutFile $licensePath -UseBasicParsing
    Write-Host "LICENSE downloaded" -ForegroundColor Green
} catch {
    Write-Host "WARNING: Failed to download llama.cpp LICENSE file" -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Yellow
}

# ============================================================================
# Summary
# ============================================================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  llama.cpp Download Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Output: $llamaDir" -ForegroundColor Cyan
Write-Host ""
