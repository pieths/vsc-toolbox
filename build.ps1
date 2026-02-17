# VSC Toolbox - Build Script for Windows

$ErrorActionPreference = "Stop"

# Header
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  VSC Toolbox - Build Script" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Download Node.js portable if not present
$nodeScript = Join-Path $PSScriptRoot "scripts\download_node.ps1"
& $nodeScript
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to download Node.js!" -ForegroundColor Red
    exit 1
}

# Add local Node.js to PATH for this session (avoid duplicating on repeated runs)
$nodeLocalDir = Join-Path $PSScriptRoot "node_local"
if ($env:Path -notlike "*$nodeLocalDir*") {
    $env:Path = "$nodeLocalDir;$env:Path"
}

# Verify Node.js
Write-Host "Checking for Node.js..." -ForegroundColor Yellow
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Node.js is not working!" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js found: $nodeVersion" -ForegroundColor Green

$npmVersion = & npm --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm is not working!" -ForegroundColor Red
    exit 1
}
Write-Host "npm found: $npmVersion" -ForegroundColor Green
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

# Download tree-sitter WASM grammars
Write-Host "Downloading tree-sitter WASM grammars..." -ForegroundColor Yellow
$tsWasmScript = Join-Path $PSScriptRoot "scripts\download_tree_sitter_wasm.ps1"
& $tsWasmScript
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to download tree-sitter WASM grammars!" -ForegroundColor Red
    exit 1
}

# Download llama.cpp binaries
Write-Host "Downloading llama.cpp binaries..." -ForegroundColor Yellow
$llamaCppScript = Join-Path $PSScriptRoot "scripts\download_llama_cpp.ps1"
& $llamaCppScript
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to download llama.cpp binaries!" -ForegroundColor Red
    exit 1
}

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
