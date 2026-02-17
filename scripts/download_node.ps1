# VSC Toolbox - Node.js Portable Download Script
#
# Downloads a portable (zip) build of Node.js for Windows x64 from nodejs.org.
# No installer required - just downloads, extracts, and renames.
#
# Output directory: node_local\
#   node.exe
#   npm, npm.cmd, npx, npx.cmd
#   corepack, corepack.cmd
#   node_modules\
#   LICENSE, README.md, CHANGELOG.md
#
# After running this script, add node_local to your PATH:
#   $env:Path = "$PSScriptRoot\..\node_local;$env:Path"

$ErrorActionPreference = "Stop"

# ============================================================================
# Configuration
# ============================================================================

$nodeVersion   = "v24.11.0"
$nodeDirName   = "node-$nodeVersion-win-x64"

$nodeUrl       = "https://nodejs.org/dist/$nodeVersion/$nodeDirName.zip"
$expectedHash  = "1054540bce22b54ec7e50ebc078ec5d090700a77657607a58f6a64df21f49fdd"

# Paths (script lives in scripts/, output for local dev environment goes to project root)
$projectRoot   = Split-Path $PSScriptRoot -Parent
$nodeLocalDir  = Join-Path $projectRoot "node_local"
$nodeExe       = Join-Path $nodeLocalDir "node.exe"
$zipPath       = Join-Path $projectRoot "$nodeDirName.zip"

# Runtime binary path (used by the extension at runtime)
$nodeBinDir    = Join-Path $projectRoot "bin\win_x64\node"
$nodeBinExe    = Join-Path $nodeBinDir "node.exe"

# ============================================================================
# Header
# ============================================================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Node.js Portable Download Script ($nodeVersion)" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# Check if already present
# ============================================================================

if (Test-Path $nodeExe) {
    $currentVersion = & $nodeExe --version 2>$null
    if ($currentVersion -eq $nodeVersion) {
        # Ensure runtime binary is also in place
        if (!(Test-Path $nodeBinExe)) {
            Write-Host "Copying node.exe to bin\win_x64\node\..." -ForegroundColor Yellow
            New-Item -ItemType Directory -Path $nodeBinDir -Force | Out-Null
            Copy-Item (Join-Path $nodeLocalDir "node.exe") $nodeBinExe
            Copy-Item (Join-Path $nodeLocalDir "LICENSE") (Join-Path $nodeBinDir "LICENSE")
        }
        Write-Host "Node.js $nodeVersion already present" -ForegroundColor Green
        Write-Host "Output: $nodeLocalDir" -ForegroundColor Cyan
        Write-Host ""
        exit 0
    } else {
        Write-Host "Found Node.js $currentVersion, switching to $nodeVersion..." -ForegroundColor Yellow
        Remove-Item $nodeLocalDir -Recurse -Force
    }
}

# ============================================================================
# Step 1: Download Node.js zip
# ============================================================================

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "Downloading Node.js $nodeVersion (win-x64)..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $nodeUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "Download complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to download Node.js!" -ForegroundColor Red
    Write-Host "  URL: $nodeUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# ============================================================================
# Step 2: Verify checksum
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
# Step 3: Extract archive
# ============================================================================

Write-Host "Extracting Node.js..." -ForegroundColor Yellow
try {
    Expand-Archive -Path $zipPath -DestinationPath $projectRoot -Force
    Write-Host "Extraction complete" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to extract Node.js!" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Remove-Item $zipPath -Force
    exit 1
}

# ============================================================================
# Step 4: Rename extracted directory to node_local
# ============================================================================

$extractedDir = Join-Path $projectRoot $nodeDirName
if (Test-Path $extractedDir) {
    Write-Host "Renaming $nodeDirName -> node_local" -ForegroundColor Yellow
    Rename-Item -Path $extractedDir -NewName "node_local" -Force
    Write-Host "Rename complete" -ForegroundColor Green
} else {
    Write-Host "ERROR: Expected extracted directory not found: $extractedDir" -ForegroundColor Red
    Remove-Item $zipPath -Force
    exit 1
}

# ============================================================================
# Step 5: Clean up zip file
# ============================================================================

Remove-Item $zipPath -Force

# ============================================================================
# Step 6: Copy runtime binary to bin\win_x64\node\
# ============================================================================

Write-Host "Copying node.exe to bin\win_x64\node\..." -ForegroundColor Yellow
if (!(Test-Path $nodeBinDir)) {
    New-Item -ItemType Directory -Path $nodeBinDir -Force | Out-Null
}
Copy-Item (Join-Path $nodeLocalDir "node.exe") $nodeBinExe -Force
Copy-Item (Join-Path $nodeLocalDir "LICENSE") (Join-Path $nodeBinDir "LICENSE") -Force
Write-Host "Runtime binary copied" -ForegroundColor Green

# ============================================================================
# Summary
# ============================================================================

# Verify the installation
$installedVersion = & $nodeExe --version 2>$null
$npmCmd = Join-Path $nodeLocalDir "npm.cmd"
$npmVersion = & $npmCmd --version 2>$null

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  Node.js Portable Download Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Node.js: $installedVersion" -ForegroundColor Cyan
Write-Host "npm:     $npmVersion" -ForegroundColor Cyan
Write-Host "Output:  $nodeLocalDir" -ForegroundColor Cyan
Write-Host ""
