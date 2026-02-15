# VSC Toolbox - Build Script for Windows

$ErrorActionPreference = "Stop"

# Header
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  VSC Toolbox - Setup Script" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
Write-Host "Checking for Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = & node --version
    if ($?) {
        Write-Host "Node.js found: $nodeVersion" -ForegroundColor Green
    } else {
        throw "Node.js not found"
    }
} catch {
    Write-Host "ERROR: Node.js is not installed!" -ForegroundColor Red
    Write-Host "Please download from: https://nodejs.org/" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Check npm
Write-Host "Checking for npm..." -ForegroundColor Yellow
try {
    $npmVersion = & npm --version
    if ($?) {
        Write-Host "npm found: $npmVersion" -ForegroundColor Green
    } else {
        throw "npm not found"
    }
} catch {
    Write-Host "ERROR: npm is not installed!" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
& npm install
if ($LASTEXITCODE -eq 0) {
    Write-Host "Dependencies installed successfully" -ForegroundColor Green
} else {
    Write-Host "ERROR: Failed to install dependencies!" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Compile TypeScript
Write-Host "Compiling TypeScript..." -ForegroundColor Yellow
& npm run compile
if ($LASTEXITCODE -eq 0) {
    Write-Host "Compilation successful" -ForegroundColor Green
} else {
    Write-Host "ERROR: Failed to compile TypeScript!" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Download llama.cpp binaries if not present
$llamaDir = Join-Path $PSScriptRoot "bin\win_x64\llama.cpp"
$llamaServerExe = Join-Path $llamaDir "llama-server.exe"

if (Test-Path $llamaServerExe) {
    Write-Host "llama.cpp binaries already present" -ForegroundColor Green
} else {
    Write-Host "Downloading llama.cpp binaries..." -ForegroundColor Yellow

    $llamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b8054/llama-b8054-bin-win-cuda-12.4-x64.zip"
    $expectedHash = "21b25d2553ccd7c7abef334313e06ef202f22260a534b329a784ef343c072617"
    $zipPath = Join-Path $llamaDir "llama-b8054-bin-win-cuda-12.4-x64.zip"

    $llamaCudaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b8054/cudart-llama-bin-win-cuda-12.4-x64.zip"
    $expectedCudaHash = "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"
    $cudaZipPath = Join-Path $llamaDir "cudart-llama-bin-win-cuda-12.4-x64.zip"

    # Create directory if it doesn't exist
    if (!(Test-Path $llamaDir)) {
        New-Item -ItemType Directory -Path $llamaDir -Force | Out-Null
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # Download llama.cpp binaries
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

    # Download CUDA runtime
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

    # Extract llama.cpp binaries
    Write-Host "Extracting llama.cpp binaries..." -ForegroundColor Yellow
    try {
        Expand-Archive -Path $zipPath -DestinationPath $llamaDir -Force
        Write-Host "llama.cpp extraction complete" -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Failed to extract llama.cpp binaries!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    # Extract CUDA runtime
    Write-Host "Extracting CUDA runtime..." -ForegroundColor Yellow
    try {
        Expand-Archive -Path $cudaZipPath -DestinationPath $llamaDir -Force
        Write-Host "CUDA runtime extraction complete" -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Failed to extract CUDA runtime!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    # Clean up zip files
    Remove-Item $zipPath -Force
    Remove-Item $cudaZipPath -Force

    # Download llama.cpp LICENSE file
    Write-Host "Downloading llama.cpp LICENSE..." -ForegroundColor Yellow
    $licenseUrl = "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/LICENSE"
    $licensePath = Join-Path $llamaDir "LICENSE"
    try {
        Invoke-WebRequest -Uri $licenseUrl -OutFile $licensePath -UseBasicParsing
        Write-Host "LICENSE downloaded" -ForegroundColor Green
    } catch {
        Write-Host "WARNING: Failed to download llama.cpp LICENSE file" -ForegroundColor Yellow
        Write-Host $_.Exception.Message -ForegroundColor Yellow
    }
}
Write-Host ""

# Success
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Open this folder in VS Code"
Write-Host "2. Press F5 to launch Extension Development Host"
Write-Host "3. Open an existing project or create a new one."
Write-Host "4. The tools and commands will be available for testing."
Write-Host ""
Write-Host "For more information, see README.md" -ForegroundColor Gray
