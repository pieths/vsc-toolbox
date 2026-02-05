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

    $llamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b7951/llama-b7951-bin-win-cpu-x64.zip"
    $expectedHash = "9fea08a50204e406121172be4c49760a0876e0fbacb6c0f64a51166e1812e52c"
    $zipPath = Join-Path $llamaDir "llama-b7951-bin-win-cpu-x64.zip"

    # Create directory if it doesn't exist
    if (!(Test-Path $llamaDir)) {
        New-Item -ItemType Directory -Path $llamaDir -Force | Out-Null
    }

    # Download
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $llamaUrl -OutFile $zipPath -UseBasicParsing
        Write-Host "Download complete" -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Failed to download llama.cpp binaries!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    # Verify checksum
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

    # Extract
    Write-Host "Extracting llama.cpp binaries..." -ForegroundColor Yellow
    try {
        Expand-Archive -Path $zipPath -DestinationPath $llamaDir -Force
        Write-Host "Extraction complete" -ForegroundColor Green
    } catch {
        Write-Host "ERROR: Failed to extract llama.cpp binaries!" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    # Clean up zip
    Remove-Item $zipPath -Force

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
