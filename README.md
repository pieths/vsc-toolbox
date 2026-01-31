# VSC Toolbox

A Visual Studio Code extension that provides both Language Model Tools for AI
agents and developer commands.

## Table of Contents

- [What is this?](#what-is-this)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Installation & Setup](#installation--setup)
- [Commands](#commands)
- [Language Model Tools](#language-model-tools)
- [Configuration](#configuration)
- [Development](#development)
- [Extensibility](#extensibility)

## What is this?

VSC Toolbox is a collection of productivity tools for VS Code that includes:

1. **Language Model Tools** - Provides additional tools that AI agents can use
   to get extra context about the code base.

2. **Developer Commands** - Utility commands for common development tasks

## Features

### Commands (Available in Command Palette)

- **Copy File Name** - Copy the current file's name to clipboard without any path
- **Search Remote Code** - Search selected text or word under cursor in
  configurable remote code search engines (Chromium Source, GitHub, etc.)
- **Get WinDbg Breakpoint Location** - Generate WinDbg breakpoint strings for
  methods or source lines
- **Get GN Targets For File** - Find which GN build targets (executables,
  libraries, etc.) a source file belongs to
- **Filter Lines By Pattern** - Filter lines in the current file using glob
  patterns and open matching lines in a new editor tab
- **Test Language Model Tool** - Test any registered Language Model Tool directly
  from the Command Palette without needing an AI agent

### Language Model Tools (For AI Agents)

- **getWorkspaceSymbol** - Search for symbols (classes, functions, variables)
  across your entire codebase with fuzzy matching
- **getDocumentSymbolReferences** - Find all references to a symbol at a
  specific location
- **contentSearch** - Content search across indexed files
  using worker threads, with glob pattern support

## Prerequisites

✅ **Visual Studio Code** (version 1.85.0 or higher)

✅ **Node.js** (version 24.x or higher) - [Download here](https://nodejs.org/)

✅ **ctags** See "Content Index Settings" below for more details.

> **Note:** Node.js is only required to build the extension. End users
> installing a packaged `.vsix` file do not need Node.js.

### Installing Node.js Locally (No System-Wide Installation)

If you prefer not to install Node.js system-wide, you can use it locally in a
single PowerShell session. With this option, you'll need to run the PATH command
each time you open a new PowerShell window, or add it to your PowerShell profile
for persistence in your user account only.

```powershell
# Download Node.js portable (Windows 64-bit) - Latest LTS version
Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-x64.zip" -OutFile "node.zip"

# Extract to a local folder and rename
Expand-Archive -Path "node.zip" -DestinationPath "."
Rename-Item "node-v24.11.0-win-x64" "node_local"

# Add to PATH for current session only
$env:Path = "$PWD\node_local;$env:Path"

# Verify installation
node --version
npm --version
```

## Quick Start

### Windows (PowerShell)

#### Option 1: Automated Setup and Building
```powershell
.\build.ps1
```

#### Option 2: Manual Setup
```powershell
# Install dependencies
npm install

# Compile the extension
npm run compile

# Press F5 in VS Code to launch Extension Development Host
```

## Installation & Setup

### Building from Source

1. **Clone this repository:**
   ```bash
   git clone https://github.com/pieths/vsc-toolbox.git
   cd vsc-toolbox
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

   This installs:
   - **Development:** `@types/vscode`, `@types/node`, `typescript`, `eslint`

3. **Compile the extension:**
   ```bash
   npm run compile
   ```

   This creates the `out/` directory with compiled JavaScript files.

4. **Test the extension:**
   - Open the project in VS Code (if not already open)
   - Press `F5` to launch Extension Development Host
   - Open any project or workspace preferrably one that has a language server configured
   - Test the commands in the Command Palette to verify the extension is working

### Packaging for Distribution

To create a `.vsix` file for distribution:

```bash
npx @vscode/vsce package
```

Then install it:
- Press `F1` in VS Code
- Select `Extensions: Install from VSIX...`
- Select the generated `.vsix` file

## Commands

VSC Toolbox provides the following commands accessible from the Command Palette
(`Ctrl+Shift+P` or `Cmd+Shift+P`):

### Copy File Name

**Command:** `VSC Toolbox: Copy File Name`

Copies the current file's name (without path) to the clipboard.

**Usage:**
1. Open any file
2. Run the command
3. File name is copied to clipboard

### Search Remote Code

**Command:** `VSC Toolbox: Search Remote Code`

Search for selected text or word under cursor in configurable remote code search
engines.

**Features:**
- If text is selected, uses the selection
- If no selection, uses the word under cursor
- Supports multiple search engines (configurable)
- Remembers last-used search engine per workspace

**Usage:**
1. Select text or place cursor on a word/symbol
2. Run the command
3. Choose search engine (if multiple configured)
4. Opens search results in browser

**Configuration:**
```json
{
  "vscToolbox.searchUrls": [
    {
      "name": "Chromium Source",
      "url": "https://source.chromium.org/search?q=\"{query}\""
    },
    {
      "name": "GitHub Code Search",
      "url": "https://github.com/search?q={query}&type=code"
    }
  ]
}
```

### Get WinDbg Breakpoint Location

**Command:** `VSC Toolbox: Get WinDbg Breakpoint Location`

Generate WinDbg-formatted breakpoint strings for the current code location.

**Features:**
- **Method breakpoint**: Creates breakpoint for current method with full namespace/class qualification
  - Example: `chrome!media::MediaFoundationCdmModule::GetInstance`
- **Source line breakpoint**: Creates breakpoint for current file and line
  - Example: `` `chrome!D:\\cs\\src\\file.cc:323` ``

**Usage:**
1. Place cursor in a method or on a line
2. Run the command
3. Choose "Method" or "SourceLine"
4. Breakpoint string is copied to clipboard

**Configuration:**
```json
{
  "vscToolbox.windbgModuleName": "chrome"
}
```

Change `"chrome"` to your module name (e.g., `"myapp"`).

### Get GN Targets For File

**Command:** `VSC Toolbox: Get GN Targets For File`

Find which GN build targets a source file belongs to by querying the GN build system.

**Features:**
- Automatically detects available output directories in the `out/` folder
- Remembers your last-used output directory
- Supports filtering by target type (executable, shared_library, static_library, etc.)
- Displays results in a new editor window, sorted alphabetically
- For single results, automatically copies the target name to clipboard
- Shows the exact GN command that was executed

**Usage:**
1. Open any source file in your workspace
2. Run the command
3. Select an output directory (e.g., `release_x64`, `debug_x64`)
4. Choose target type
5. View results in the opened editor window

**Requirements:**
- GN build system must be available in your PATH
- An `out/` directory with at least one build configuration
- The file must be part of the GN build graph

### Filter Lines By Pattern

**Command:** `VSC Toolbox: Filter Lines By Pattern`

Filter lines in the current file using glob patterns and display matching lines
in a new editor tab.

**Features:**
- Multi-select from previously used patterns
- Add new patterns via the `+` button or by typing and pressing Enter
- Delete patterns from history via the trash button on each item
- Patterns are stored per workspace
- Supports glob wildcards: `*` (any characters) and `?` (single character)
- Non-destructive: opens filtered results in a new untitled tab
- Preserves original line order
- Case insensitive matching
- Keyboard-friendly: use arrows, Space to select/deselect, Enter to apply

**Usage:**
1. Open any file
2. Run the command
3. Type a pattern (e.g., `error`, `media*service`) and/or select from history
4. Press Enter to apply
5. View matching lines in the new editor tab

### Test Language Model Tool

**Command:** `VSC Toolbox: Test Language Model Tool`

Test any registered Language Model Tool directly from the Command Palette. This
is useful for verifying tool output and debugging tools without needing to invoke
them through an AI agent.

**Features:**
- Select from all registered Language Model Tools
- Provides appropriate input prompts based on the selected tool
- Displays tool output as formatted JSON in a new editor window
- Useful for development and debugging of new tools

**Usage:**
1. Run the command
2. Select which tool to test from the list
3. Provide the required inputs (varies by tool)
4. View the JSON results in the opened editor window

## Language Model Tools

These tools are automatically available to AI agents like GitHub Copilot when the extension is active.

### Using with GitHub Copilot or other AI agents

Once the extension is active, AI agents can use the following tools:

#### getWorkspaceSymbol

Search for symbols across the entire codebase.

**Request Format:**
```json
{
  "tool": "getWorkspaceSymbol",
  "arguments": {
    "query": "HttpRequest",
    "filter": ["/src/net/", "/include/"]
  }
}
```

**Parameters:**
- `query` (string, required): Symbol name to search for (supports fuzzy matching)
- `filter` (array of strings, optional): Path patterns to filter results

**Response Format:**
```json
{
  "query": "HttpRequest",
  "totalResults": 15,
  "filteredResults": 8,
  "symbols": [
    {
      "name": "HttpRequest",
      "kind": "Class",
      "location": {
        "uri": "file:///d:/cs/src/net/http/http_request.h",
        "line": 23,
        "character": 6
      },
      "containerName": "net::http"
    }
  ]
}
```

#### getDocumentSymbolReferences

Find all references to a symbol at a specific location.

**Request Format:**
```json
{
  "tool": "getDocumentSymbolReferences",
  "arguments": {
    "uri": "file:///path/to/file.cpp",
    "position": {
      "line": 10,
      "character": 5
    }
  }
}
```

**Parameters:**
- `uri` (string, required): File URI
- `position` (object, required): Position object with `line` and `character` (both zero-based)

**Response Format:**
```json
{
  "uri": "file:///d:/cs/src/net/http/http_request.cc",
  "position": {
    "line": 42,
    "character": 10
  },
  "totalReferences": 5,
  "references": [
    {
      "uri": "file:///d:/cs/src/net/http/http_client.cc",
      "range": {
        "start": { "line": 15, "character": 8 },
        "end": { "line": 15, "character": 19 }
      }
    }
  ]
}
```

#### contentSearch

Content search.

**Request Format:**
```json
{
  "tool": "contentSearch",
  "arguments": {
    "query": "HttpRequest GetHeaders"
  }
}
```

**Parameters:**
- `query` (string, required): Search query. Space-separated terms are OR'd
  together. Supports `*` (match any) and `?` (match single char) wildcards.

**Response Format (Markdown):**
```text
## Search Results for `HttpRequest GetHeaders`

Found **42** matches in **8** files.

### src/net/http/http_request.cc

- 156: `void HttpRequest::GetHeaders() {`
- 203: `// GetHeaders implementation`

### src/net/http/http_client.cc

- 89: `request.GetHeaders();`
```

**Features:**
- Parallel searching using worker threads (configurable count)
- Line-index caching for fast line number lookup
- File system watcher for automatic cache invalidation
- Configurable include paths and file extensions

## Configuration

VSC Toolbox can be configured through VS Code settings. Access settings via `File > Preferences > Settings` or by editing `.vscode/settings.json` in your workspace.

### Available Settings

#### Enable/Disable Extension

```json
{
  "vscToolbox.enable": true
}
```

Set to `false` to disable the extension.

#### Search URLs

Configure code search engines for the "Search Remote Code" command:

```json
{
  "vscToolbox.searchUrls": [
    {
      "name": "Chromium Source",
      "url": "https://source.chromium.org/search?q=\"{query}\""
    },
    {
      "name": "GitHub Code Search",
      "url": "https://github.com/search?q={query}&type=code"
    }
  ]
}
```

The `{query}` placeholder is replaced with the selected text (URL-encoded).

#### WinDbg Module Name

Set the module name prefix for WinDbg breakpoints:

```json
{
  "vscToolbox.windbgModuleName": "chrome"
}
```

Change to match your module (`"myapp"`, etc.).

#### Content Index Settings

```json
{
  "vscToolbox.contentIndex.workerThreads": 0,
  "vscToolbox.contentIndex.includePaths": ["/path/to/src"],
  "vscToolbox.contentIndex.fileExtensions": [".cc", ".h"],
  "vscToolbox.contentIndex.ctagsPath": "ctags"
}
```

- `workerThreads`: Number of worker threads (0 = auto-detect based on CPU cores)
- `includePaths`: Directories to index (empty = all workspace folders)
- `fileExtensions`: File extensions to include in search
- `ctagsPath`: Path to the ctags executable (default: `"ctags"`)

##### Installing Universal Ctags (Windows)

The content index uses a custom version of
[Universal Ctags](https://github.com/universal-ctags/ctags)
for symbol extraction.

- Download from https://github.com/pieths/ctags/releases/tag/v6.2.0-custom
- Extract the `ctags_v6.2.0-custom.zip` and add to PATH,
  or set `ctagsPath` in the VSCode settings to the full path.

**Verify installation:**
```powershell
ctags --version
# Should show: Universal Ctags 6.x.x
```

## Development

### Development Commands

```bash
npm run compile    # Compile once
npm run watch      # Watch mode (auto-compile on change)
npm run lint       # Run ESLint
```

### Debugging in Custom Environments

If you need to debug the extension in a VS Code instance launched from a
specific command-line environment (e.g., with custom environment variables),
follow these steps:

**One-time setup:** Create a symbolic link for the extension directory (may
require administrator PowerShell):

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.vscode\extensions\vsc-toolbox-dev" -Target "d:\tools\vsc-toolbox"
```

**Each time you debug:** Launch VS Code from the command line with inspection enabled:

```powershell
code --inspect-extensions=5870 .
```

**Attach the debugger:** In the VS Code instance with the vsc-toolbox workspace
open, select the `Attach to VS Code with Environment` debug configuration and
press F5 to start debugging.

When finished with debugging and testing the changes, the symbolic link can be
removed with:

```
Remove-Item "$env:USERPROFILE\.vscode\extensions\vsc-toolbox-dev"
```

### Project Structure

```
vsc-toolbox/
├── .vscode/
│   ├── launch.json          # Debug configuration (F5)
│   ├── tasks.json           # Build tasks
│   └── settings.json        # Workspace settings
├── src/
│   ├── extension.ts         # Extension entry point (activate/deactivate)
│   ├── commands/            # Command Palette commands
│   │   ├── index.ts         # Command registry
│   │   ├── getFileName.ts   # Copy file name command
│   │   ├── searchRemoteCode.ts  # Code search command
│   │   └── getWinDbgBreakpointLocation.ts  # WinDbg breakpoint command
│   ├── common/              # Shared utilities and infrastructure
│   │   ├── documentUtils.ts # Document/editor helper functions
│   │   ├── logger.ts        # Shared logging utility
│   │   ├── markdownUtils.ts # Markdown formatting helpers
│   │   └── index/           # Content indexing infrastructure
│   │       ├── index.ts           # Barrel export (public API)
│   │       ├── contentIndex.ts    # Main singleton interface
│   │       ├── cacheManager.ts    # File content cache management
│   │       ├── threadPool.ts      # Worker thread pool
│   │       ├── workerThread.ts    # Worker thread script
│   │       ├── fileWatcher.ts     # File system monitoring
│   │       ├── fileIndex.ts       # Per-file content index
│   │       ├── queryParser.ts     # Glob to regex conversion
│   │       └── types.ts           # Shared interfaces
│   └── tools/               # Language Model Tools (for AI)
│       ├── index.ts         # Tool registry
│       ├── getWorkspaceSymbol.ts      # Workspace symbol tool
│       ├── getDocumentSymbolReferences.ts  # References tool
│       └── contentSearch.ts   # Content search tool
├── out/                     # Compiled JavaScript (generated)
├── node_modules/            # Dependencies (generated)
├── package.json             # Extension manifest and dependencies
├── tsconfig.json            # TypeScript configuration
├── .vscodeignore            # Files to exclude from .vsix package
└── .gitignore               # Git ignore patterns
```

## Extensibility

### Adding New Commands

Commands appear in the Command Palette and can be invoked by users.

#### Step 1: Create Your Command Class

Create a new file in `src/commands/` (e.g., `src/commands/myCommand.ts`):

```typescript
// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

export class MyCommand {
    public readonly id = 'vscToolbox.myCommand';
    public readonly title = 'VSC Toolbox: My Command';

    constructor(private context: vscode.ExtensionContext) {}

    async execute(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        // Your command logic here
        vscode.window.showInformationMessage('Command executed!');
    }
}
```

#### Step 2: Register in the Command Registry

Add your command to `src/commands/index.ts`:

```typescript
import { GetFileNameCommand } from './getFileName';
import { SearchRemoteCodeCommand } from './searchRemoteCode';
import { GetWinDbgBreakpointLocationCommand } from './getWinDbgBreakpointLocation';
import { MyCommand } from './myCommand';  // Add import

export const COMMAND_REGISTRY = [
    GetFileNameCommand,
    SearchRemoteCodeCommand,
    GetWinDbgBreakpointLocationCommand,
    MyCommand,  // Add to registry
] as const;
```

#### Step 3: Add Command to package.json

```json
{
  "contributes": {
    "commands": [
      {
        "command": "vscToolbox.myCommand",
        "title": "My Command",
        "category": "VSC Toolbox"
      }
    ]
  }
}
```

**That's it!** The command will be automatically registered and available in the
Command Palette.

### Adding New Language Model Tools

Tools are used by AI agents like GitHub Copilot to query your codebase and
perform other actions.

#### Step 1: Create Your Tool Class

Create a new file in `src/tools/` (e.g., `src/tools/myNewTool.ts`):

```typescript
import * as vscode from 'vscode';

export interface IMyNewToolParams {
  // Define your tool's input parameters
  someParam: string;
}

export class MyNewTool implements vscode.LanguageModelTool<IMyNewToolParams> {
  constructor() { }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IMyNewToolParams>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Running my new tool...`,
      confirmationMessages: {
        title: 'My New Tool',
        message: new vscode.MarkdownString(`Execute my new tool?`),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IMyNewToolParams>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const { someParam } = options.input;

    // Use VS Code commands to interact with language servers
    // Example: vscode.commands.executeCommand('vscode.executeDefinitionProvider', ...)

    const result = { /* your result data */ };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
    ]);
  }
}
```

#### Step 2: Register in the Tool Registry

Add your tool to `src/tools/index.ts`:

```typescript
import { GetWorkspaceSymbolTool } from './getWorkspaceSymbol';
import { GetDocumentSymbolReferencesTool } from './getDocumentSymbolReferences';
import { MyNewTool } from './myNewTool';  // Add import

export const TOOL_REGISTRY = [
  { name: 'getWorkspaceSymbol', class: GetWorkspaceSymbolTool },
  { name: 'getDocumentSymbolReferences', class: GetDocumentSymbolReferencesTool },
  { name: 'my_new_tool', class: MyNewTool },  // Add to registry
] as const;
```

#### Step 3: Add Tool Metadata to package.json

Add your tool's configuration to the `languageModelTools` array in `package.json`:

```json
{
  "name": "my_new_tool",
  "displayName": "My New Tool",
  "canBeReferencedInPrompt": true,
  "toolReferenceName": "my-new-tool",
  "userDescription": "Brief description for users",
  "modelDescription": "Detailed description for AI models about what the tool does and when to use it",
  "inputSchema": {
    "type": "object",
    "properties": {
      "someParam": {
        "type": "string",
        "description": "Description of the parameter"
      }
    },
    "required": ["someParam"]
  }
}
```

**That's it!** The tool will be automatically registered when the extension activates.

### Available VS Code Commands

See the [VS Code Commands API](https://code.visualstudio.com/api/references/commands)
for available commands.

---

**Quick Links:**
- [Report an Issue](https://github.com/pieths/vsc-toolbox/issues)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model Tools API](https://code.visualstudio.com/api/extension-guides/ai/tools)
