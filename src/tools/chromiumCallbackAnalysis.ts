// Copyright (c) 2025 Piet Hein Schouten
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';

interface CallbackAnalysisRequest {
    filePath: string;
    line: number;
}

interface CallbackAnalysisResult {
    success: boolean;
    callbackVariable?: string;
    boundFunction?: string;
    boundLocation?: string;
    invocationLocations?: string[];
    error?: string;
}

/**
 * Chromium Callback Analysis Tool for Language Models
 * Traces callback flow across files: finds where function was bound and where callback is invoked
 */
export class ChromiumCallbackAnalysisTool implements vscode.LanguageModelTool<CallbackAnalysisRequest> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CallbackAnalysisRequest>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const result = await this.analyzeCallback(options.input);

            return {
                content: [
                    new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
                ]
            };
        } catch (error) {
            const errorResult: CallbackAnalysisResult = {
                success: false,
                error: String(error)
            };

            return {
                content: [
                    new vscode.LanguageModelTextPart(JSON.stringify(errorResult, null, 2))
                ]
            };
        }
    }

    private async analyzeCallback(request: CallbackAnalysisRequest): Promise<CallbackAnalysisResult> {
        const uri = vscode.Uri.file(request.filePath);
        const document = await vscode.workspace.openTextDocument(uri);

        if (!document) {
            return { success: false, error: 'Could not open document' };
        }

        if (request.line < 0 || request.line >= document.lineCount) {
            return { success: false, error: 'Line number out of range' };
        }

        const targetLine = document.lineAt(request.line).text;
        const position = new vscode.Position(request.line, 0);

        // Strategy: Identify what we're looking at
        // 1. Direct bind call: base::BindOnce(&Function) - extract function, find invocations
        // 2. Function with callback parameter: void Func(..., callback) - find bindings and invocations
        // 3. Callback variable/invocation: callback.Run() or std::move(callback).Run()

        // Case 1: Direct bind call
        if (targetLine.includes('base::Bind')) {
            return await this.analyzeBindSite(document, request.line, targetLine);
        }

        // Case 2 & 3: Callback parameter or variable
        // Extract callback variable name from the line
        const callbackVar = this.extractCallbackVariable(targetLine);
        if (callbackVar) {
            return await this.traceCallbackAcrossFiles(document, request.line, callbackVar, position);
        }

        return {
            success: false,
            error: 'Could not identify callback pattern on this line'
        };
    }

    private extractCallbackVariable(line: string): string | undefined {
        // Try various patterns to extract callback variable name

        // Pattern 1: callback) or callback.Run( or std::move(callback).Run(
        let match = line.match(/\b(\w*[Cc]allback)\s*\)/);
        if (match) return match[1];

        match = line.match(/\b(\w*[Cc]allback)\.Run\(/);
        if (match) return match[1];

        match = line.match(/std::move\((\w*[Cc]allback)\)/);
        if (match) return match[1];

        // Pattern 2: Function parameter: Type callback
        match = line.match(/\b(\w*Callback)\s+(\w+)/);
        if (match) return match[2];

        return undefined;
    }

    private async analyzeBindSite(
        document: vscode.TextDocument,
        line: number,
        lineText: string
    ): Promise<CallbackAnalysisResult> {
        // Extract bound function from bind call
        const funcMatch = lineText.match(/base::Bind(?:Once|Repeating)\s*\(\s*(?:&)?([\w:]+)/);
        const boundFunction = funcMatch ? funcMatch[1] : '<unknown>';

        // Find invocations in current file
        const invocationLocations = await this.findRunCallsInFile(document);

        return {
            success: true,
            boundFunction,
            boundLocation: `${document.uri.fsPath}:${line + 1}`,
            invocationLocations
        };
    }

    private async traceCallbackAcrossFiles(
        document: vscode.TextDocument,
        line: number,
        callbackVar: string,
        position: vscode.Position
    ): Promise<CallbackAnalysisResult> {
        // First, find invocations in the current file
        const invocationLocations = await this.findRunCallsForVariable(document, callbackVar);

        // Find the function containing this line and its definition position
        const functionInfo = await this.findFunctionDefinition(document, line);

        if (!functionInfo) {
            return {
                success: true,
                callbackVariable: callbackVar,
                boundFunction: '<not found - could not determine containing function>',
                invocationLocations
            };
        }

        // Use call hierarchy from the function definition to find callers
        const boundFunctions = await this.findCallersWithBindings(
            functionInfo.name,
            document,
            functionInfo.position
        );

        if (boundFunctions.length > 0) {
            return {
                success: true,
                callbackVariable: callbackVar,
                boundFunction: boundFunctions[0].func,
                boundLocation: boundFunctions[0].loc,
                invocationLocations
            };
        }

        return {
            success: true,
            callbackVariable: callbackVar,
            boundFunction: '<not found - no callers with base::Bind found>',
            invocationLocations
        };
    }

    private async findFunctionDefinition(
        document: vscode.TextDocument,
        line: number
    ): Promise<{ name: string, position: vscode.Position } | undefined> {
        // Use document symbols to find the function containing this line
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (!symbols) return undefined;

            const position = new vscode.Position(line, 0);
            return this.findFunctionSymbolWithPosition(symbols, position);
        } catch {
            return undefined;
        }
    }

    private findFunctionSymbolWithPosition(
        symbols: vscode.DocumentSymbol[],
        position: vscode.Position
    ): { name: string, position: vscode.Position } | undefined {
        for (const symbol of symbols) {
            if (symbol.range.contains(position)) {
                if (symbol.kind === vscode.SymbolKind.Function ||
                    symbol.kind === vscode.SymbolKind.Method) {
                    // Return the function name and its selection range (definition location)
                    return {
                        name: symbol.name,
                        position: symbol.selectionRange.start
                    };
                }
                // Check children
                if (symbol.children) {
                    const child = this.findFunctionSymbolWithPosition(symbol.children, position);
                    if (child) return child;
                }
            }
        }
        return undefined;
    } private async findCallersWithBindings(
        functionName: string,
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<Array<{ func: string, loc: string }>> {
        const results: Array<{ func: string, loc: string }> = [];

        try {
            // Use VS Code's Call Hierarchy API to find incoming calls
            const callItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                'vscode.prepareCallHierarchy',
                document.uri,
                position
            );

            if (!callItems || callItems.length === 0) {
                return results;
            }

            // Get incoming calls (who calls this function)
            const incomingCalls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.provideIncomingCalls',
                callItems[0]
            );

            if (!incomingCalls) {
                return results;
            }

            // For each caller, check if it has a base::Bind in its implementation
            for (const call of incomingCalls) {
                const callerDoc = await vscode.workspace.openTextDocument(call.from.uri);
                const callerRange = call.from.selectionRange;

                // Read the caller function's body (expand range to capture full function)
                const startLine = Math.max(0, callerRange.start.line - 2);
                const endLine = Math.min(callerDoc.lineCount - 1, callerRange.end.line + 50);
                const functionBody = callerDoc.getText(
                    new vscode.Range(startLine, 0, endLine, 0)
                );

                // Check if this caller has a base::Bind
                const bindMatch = functionBody.match(/base::Bind(?:Once|Repeating)\s*\(\s*(?:&)?([\w:]+)/);
                if (bindMatch) {
                    results.push({
                        func: bindMatch[1],
                        loc: `${call.from.uri.fsPath}:${call.from.selectionRange.start.line + 1}`
                    });
                }
            }
        } catch (error) {
            console.error('Error using call hierarchy:', error);
        }

        return results;
    }

    private async findRunCallsForVariable(
        document: vscode.TextDocument,
        callbackVar: string
    ): Promise<string[]> {
        const locations: string[] = [];
        const text = document.getText();

        // Find where this specific callback variable is invoked
        const patterns = [
            new RegExp(`std::move\\s*\\(\\s*${callbackVar}\\s*\\)\\.Run\\s*\\(`, 'g'),
            new RegExp(`\\b${callbackVar}\\.Run\\s*\\(`, 'g'),
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const location = `${document.uri.fsPath}:${pos.line + 1}`;
                if (!locations.includes(location)) {
                    locations.push(location);
                }
            }
        }

        return locations;
    }

    private async analyzeInCurrentFile(
        document: vscode.TextDocument,
        line: number,
        callbackVar: string
    ): Promise<CallbackAnalysisResult> {
        const text = document.getText();
        let boundFunction: string | undefined;
        let boundLocation: string | undefined;

        // Search backwards for where this callback was created
        const bindPattern = new RegExp(
            `base::Bind(?:Once|Repeating)\\s*\\(\\s*(?:&)?([\\w:]+)[^)]*\\).*${callbackVar}`,
            'g'
        );

        let match;
        while ((match = bindPattern.exec(text)) !== null) {
            boundFunction = match[1];
            const pos = document.positionAt(match.index);
            boundLocation = `${document.uri.fsPath}:${pos.line + 1}`;
            break;
        }

        // Find invocation locations
        const invocationLocations = await this.findRunCallsInFile(document);

        return {
            success: true,
            callbackVariable: callbackVar,
            boundFunction: boundFunction || '<unknown>',
            boundLocation,
            invocationLocations
        };
    }

    private async findRunCallsInFile(document: vscode.TextDocument): Promise<string[]> {
        const locations: string[] = [];
        const text = document.getText();

        // Find all .Run( calls
        const runPattern = /(?:std::move\([^)]+\))?\.Run\s*\(/g;
        let match;

        while ((match = runPattern.exec(text)) !== null) {
            const pos = document.positionAt(match.index);
            locations.push(`${document.uri.fsPath}:${pos.line + 1}`);
        }

        return locations;
    }
}
