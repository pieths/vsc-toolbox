# VSC Toolbox - Tree-sitter WASM Download Script
#
# Downloads pre-built WASM grammar files from GitHub releases.
# No build tools required - just downloads the .wasm binaries.
#
# These WASM files are loaded at runtime by web-tree-sitter in worker threads.
# All grammars use ABI version 14-15, compatible with tree-sitter 0.25.x/0.26.x.
#
# Output directory: bin\tree-sitter\
#   languages\
#     cpp.wasm
#     javascript.wasm
#     typescript.wasm
#     tsx.wasm
#     python.wasm
#     markdown.wasm
#     markdown_inline.wasm
#
# Usage in TypeScript (worker thread):
#
#   import Parser from 'web-tree-sitter';
#
#   await Parser.init();
#   const parser = new Parser();
#   const lang = await Parser.Language.load('bin/tree-sitter/languages/cpp.wasm');
#   parser.setLanguage(lang);
#   const tree = parser.parse(sourceCode);
#   // tree.rootNode is the CST root - walk with .children, .type, .text, etc.

$ErrorActionPreference = "Stop"

# ============================================================================
# Configuration
# ============================================================================

# Each grammar entry:
#   Name     - identifier used for display
#   Files    - array of @{ Url; FileName; Hash } for each WASM file to download
$grammars = @(
    @{
        Name  = "cpp"
        Tag   = "v0.23.4"
        Files = @(
            @{
                Url      = "https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm"
                FileName = "cpp.wasm"
                Hash     = "174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf"
            }
        )
    },
    @{
        Name  = "javascript"
        Tag   = "v0.25.0"
        Files = @(
            @{
                Url      = "https://github.com/tree-sitter/tree-sitter-javascript/releases/download/v0.25.0/tree-sitter-javascript.wasm"
                FileName = "javascript.wasm"
                Hash     = "5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240"
            }
        )
    },
    @{
        Name  = "typescript"
        Tag   = "v0.23.2"
        Files = @(
            @{
                Url      = "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm"
                FileName = "typescript.wasm"
                Hash     = "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d"
            },
            @{
                Url      = "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm"
                FileName = "tsx.wasm"
                Hash     = "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8"
            }
        )
    },
    @{
        Name  = "python"
        Tag   = "v0.25.0"
        Files = @(
            @{
                Url      = "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.25.0/tree-sitter-python.wasm"
                FileName = "python.wasm"
                Hash     = "16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47"
            }
        )
    },
    @{
        Name  = "markdown"
        Tag   = "v0.5.2"
        Files = @(
            @{
                Url      = "https://github.com/tree-sitter-grammars/tree-sitter-markdown/releases/download/v0.5.2/tree-sitter-markdown.wasm"
                FileName = "markdown.wasm"
                Hash     = "8aa42143c798b8134effc495cf462dd3ac40775a8518e2f79524aef591f23ff6"
            },
            @{
                Url      = "https://github.com/tree-sitter-grammars/tree-sitter-markdown/releases/download/v0.5.2/tree-sitter-markdown_inline.wasm"
                FileName = "markdown_inline.wasm"
                Hash     = "2d193afbe6dade4e36f1eb63f0c61c687ca17b474e1dba12bccfe046166059d5"
            }
        )
    }
)

# Paths (script lives in scripts/, output goes to project root bin/)
$projectRoot = Split-Path $PSScriptRoot -Parent
$tsDir       = Join-Path $projectRoot "bin\tree-sitter"
$langDir     = Join-Path $tsDir "languages"

# ============================================================================
# Header
# ============================================================================

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Tree-sitter WASM Download Script" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# Step 1: Create output directories
# ============================================================================

if (!(Test-Path $langDir)) {
    New-Item -ItemType Directory -Path $langDir -Force | Out-Null
}

# ============================================================================
# Step 2: Download each grammar WASM file
# ============================================================================

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$downloadCount = 0
$skipCount = 0

foreach ($grammar in $grammars) {
    $name = $grammar.Name
    $tag  = $grammar.Tag

    Write-Host "--- $name grammar ($tag) ---" -ForegroundColor Cyan

    foreach ($file in $grammar.Files) {
        $outPath = Join-Path $langDir $file.FileName

        # Skip if already downloaded
        if (Test-Path $outPath) {
            # Verify hash if one is provided
            if ($file.Hash -ne "") {
                $actualHash = (Get-FileHash -Path $outPath -Algorithm SHA256).Hash.ToLower()
                if ($actualHash -ne $file.Hash) {
                    Write-Host "Hash mismatch for $($file.FileName), re-downloading..." -ForegroundColor Yellow
                    Remove-Item $outPath -Force
                } else {
                    Write-Host "Already downloaded: $($file.FileName)" -ForegroundColor Green
                    $skipCount++
                    continue
                }
            } else {
                Write-Host "Already downloaded: $($file.FileName)" -ForegroundColor Green
                $skipCount++
                continue
            }
        }

        Write-Host "Downloading $($file.FileName)..." -ForegroundColor Yellow

        try {
            Invoke-WebRequest -Uri $file.Url -OutFile $outPath -UseBasicParsing
        } catch {
            Write-Host "ERROR: Failed to download $($file.FileName)!" -ForegroundColor Red
            Write-Host "  URL: $($file.Url)" -ForegroundColor Red
            Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }

        # Verify hash if provided
        if ($file.Hash -ne "") {
            $actualHash = (Get-FileHash -Path $outPath -Algorithm SHA256).Hash.ToLower()
            if ($actualHash -ne $file.Hash) {
                Write-Host "ERROR: Checksum verification failed for $($file.FileName)!" -ForegroundColor Red
                Write-Host "  Expected: $($file.Hash)" -ForegroundColor Red
                Write-Host "  Actual:   $actualHash" -ForegroundColor Red
                Remove-Item $outPath -Force
                exit 1
            }
            Write-Host "Checksum verified" -ForegroundColor Green
        }

        Write-Host "Downloaded $($file.FileName)" -ForegroundColor Green
        $downloadCount++
    }

    Write-Host ""
}

# ============================================================================
# Summary
# ============================================================================

Write-Host "================================================" -ForegroundColor Green
Write-Host "  Tree-sitter WASM Download Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Downloaded: $downloadCount file(s), Skipped: $skipCount file(s)" -ForegroundColor Cyan
Write-Host "Output: $langDir" -ForegroundColor Cyan
Write-Host ""
Get-ChildItem $langDir -File | ForEach-Object {
    if ($_.Length -ge 1MB) {
        $size = "{0:N1} MB" -f ($_.Length / 1MB)
    } else {
        $size = "{0:N0} KB" -f ($_.Length / 1KB)
    }
    Write-Host "  $($_.Name) ($size)"
}
Write-Host ""
