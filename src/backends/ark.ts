import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import * as util from '../util';
import { extensionContext } from '../extension';
import * as selection from '../selection';
import * as sessionRegistry from '../ark/sessionRegistry';
import type { ArkConsoleDriver, ArkSessionEntry } from '../ark/sessionRegistry';
import type { IRConsoleBackend } from './types';
type ArkSessionMode = 'console' | 'notebook' | 'background';

const DEFAULT_SIGNATURE_SCHEME = 'hmac-sha256';
const DEFAULT_SESSION_MODE: ArkSessionMode = 'console';
const DEFAULT_ARK_PATH = 'ark';
const DEFAULT_TMUX_PATH = 'tmux';
const DEFAULT_SIDECAR_TIMEOUT_MS = 15000;

function nowIso(): string {
    return new Date().toISOString();
}

function normalizeSessionName(value: string): string {
    return value.trim().replace(/[\\/]/g, '-').replace(/\s+/g, '-');
}

function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rStringLiteral(value: string): string {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
        return values[key] ?? '';
    });
}

function renderShellTemplate(template: string, values: Record<string, string>): string {
    const escaped: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
        escaped[key] = shellEscape(value);
    }
    return renderTemplate(template, escaped);
}

export class ArkConsoleBackend implements IRConsoleBackend {
    readonly id = 'ark' as const;
    private readonly outputChannel = vscode.window.createOutputChannel('Ark Console');
    private readonly externalTerminals = new Map<string, vscode.Terminal>();

    getCommandHandlers(): Record<string, (...args: unknown[]) => unknown> {
        return {
            'r.createRTerm': () => this.createSession(),
            'r.ark.createSession': () => this.createSession(),
            'r.ark.attachSession': () => this.attachSession(),
            'r.ark.openConsole': () => this.openConsole(),
            'r.ark.stopSession': () => this.stopSession(),
            'r.nrow': () => this.runSelectionOrWord(['nrow']),
            'r.length': () => this.runSelectionOrWord(['length']),
            'r.head': () => this.runSelectionOrWord(['head']),
            'r.thead': () => this.runSelectionOrWord(['t', 'head']),
            'r.names': () => this.runSelectionOrWord(['names']),
            'r.view': () => this.runSelectionOrWord(['View']),
            'r.runSource': () => { void this.runSource(false); },
            'r.runSelection': () => { void this.runSelection(); },
            'r.runFromLineToEnd': () => { void this.runFromLineToEnd(); },
            'r.runFromBeginningToLine': () => { void this.runFromBeginningToLine(); },
            'r.runSelectionRetainCursor': () => { void this.runSelectionRetainCursor(); },
            'r.runCommandWithSelectionOrWord': (command: string) => { void this.runCommandWithSelectionOrWord(command); },
            'r.runCommandWithEditorPath': (command: string) => { void this.runCommandWithEditorPath(command); },
            'r.runCommand': (command: string) => { void this.runCommand(command); },
            'r.runSourcewithEcho': () => { void this.runSource(true); },
            'r.runChunks': (chunks: vscode.Range[]) => { void this.runChunks(chunks); },
        };
    }

    dispose(): void {
        this.outputChannel.dispose();
    }

    private setActiveSession(name: string): void {
        sessionRegistry.setActiveSessionName(name);
    }

    private async runSource(echo: boolean): Promise<void> {
        const wad = vscode.window.activeTextEditor?.document;
        if (!wad) {
            return;
        }
        const isSaved = await util.saveDocument(wad);
        if (!isSaved) {
            return;
        }
        let rPath: string = util.ToRStringLiteral(wad.fileName, '"');
        let encodingParam = util.config().get<string>('source.encoding');
        if (encodingParam === undefined) {
            return;
        }
        encodingParam = `encoding = "${encodingParam}"`;
        const echoParam = util.config().get<boolean>('source.echo');
        rPath = [rPath, encodingParam].join(', ');
        if (echoParam) {
            echo = true;
        }
        if (echo) {
            rPath = [rPath, 'echo = TRUE'].join(', ');
        }
        await this.runTextInArk(`source(${rPath})`);
    }

    private async runSelection(): Promise<void> {
        await this.runSelectionInArk(true);
    }

    private async runSelectionRetainCursor(): Promise<void> {
        await this.runSelectionInArk(false);
    }

    private async runSelectionOrWord(rFunctionName: string[]): Promise<void> {
        const text = selection.getWordOrSelection();
        if (!text) {
            return;
        }
        const wrappedText = selection.surroundSelection(text, rFunctionName);
        await this.runTextInArk(wrappedText);
    }

    private async runCommandWithSelectionOrWord(rCommand: string): Promise<void> {
        const text = selection.getWordOrSelection();
        if (!text) {
            return;
        }
        const call = rCommand.replace(/\$\$/g, text);
        await this.runTextInArk(call);
    }

    private async runCommandWithEditorPath(rCommand: string): Promise<void> {
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        const wad: vscode.TextDocument = textEditor.document;
        const isSaved = await util.saveDocument(wad);
        if (isSaved) {
            const rPath = util.ToRStringLiteral(wad.fileName, '');
            const call = rCommand.replace(/\$\$/g, rPath);
            await this.runTextInArk(call);
        }
    }

    private async runCommand(rCommand: string): Promise<void> {
        await this.runTextInArk(rCommand);
    }

    private async runFromBeginningToLine(): Promise<void> {
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        const endLine = textEditor.selection.end.line;
        const charactersOnLine = textEditor.document.lineAt(endLine).text.length;
        const endPos = new vscode.Position(endLine, charactersOnLine);
        const range = new vscode.Range(new vscode.Position(0, 0), endPos);
        const text = textEditor.document.getText(range);
        if (text === undefined) {
            return;
        }
        await this.runTextInArk(text);
    }

    private async runFromLineToEnd(): Promise<void> {
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        const startLine = textEditor.selection.start.line;
        const startPos = new vscode.Position(startLine, 0);
        const endLine = textEditor.document.lineCount;
        const range = new vscode.Range(startPos, new vscode.Position(endLine, 0));
        const text = textEditor.document.getText(range);
        await this.runTextInArk(text);
    }

    private async runChunks(chunks: vscode.Range[]): Promise<void> {
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            return;
        }
        const text = chunks
            .map((chunk) => textEditor.document.getText(chunk).trim())
            .filter((chunk) => chunk.length > 0)
            .join('\n');
        if (text.length > 0) {
            await this.runTextInArk(text);
        }
    }

    private async runSelectionInArk(moveCursor: boolean): Promise<void> {
        const selectionInfo = selection.getSelection();
        if (!selectionInfo) {
            return;
        }
        if (moveCursor && selectionInfo.linesDownToMoveCursor > 0) {
            const textEditor = vscode.window.activeTextEditor;
            if (!textEditor) {
                return;
            }
            const lineCount = textEditor.document.lineCount;
            if (selectionInfo.linesDownToMoveCursor + textEditor.selection.end.line === lineCount) {
                const endPos = new vscode.Position(lineCount, textEditor.document.lineAt(lineCount - 1).text.length);
                await textEditor.edit(e => e.insert(endPos, '\n'));
            }
            await vscode.commands.executeCommand('cursorMove', { to: 'down', value: selectionInfo.linesDownToMoveCursor });
            await vscode.commands.executeCommand('cursorMove', { to: 'wrappedLineFirstNonWhitespaceCharacter' });
        }
        await this.runTextInArk(selectionInfo.selectedText);
    }

    private async runTextInArk(text: string, execute: boolean = true): Promise<void> {
        const entry = await this.pickSessionForExecution();
        if (!entry) {
            return;
        }

        if (entry.mode === 'tmux' && entry.tmuxSessionName) {
            const exists = await this.tmuxHasSession(entry.tmuxSessionName);
            if (!exists) {
                void vscode.window.showErrorMessage(`tmux session "${entry.tmuxSessionName}" 不存在。`);
                return;
            }
            await this.ensureConsoleWindow(entry);
            await this.sendTextToTmux(entry.tmuxSessionName, text, execute);
        } else {
            const terminal = this.externalTerminals.get(entry.name);
            if (!terminal) {
                const choice = await vscode.window.showWarningMessage(
                    '未找到可用的 Ark console 终端。是否先打开一个？',
                    'Open Console',
                    'Cancel'
                );
                if (choice === 'Open Console') {
                    await this.openExternalConsole(entry.connectionFilePath, entry.name);
                }
            }
            const resolved = this.externalTerminals.get(entry.name);
            if (!resolved) {
                return;
            }
            resolved.sendText(text, execute);
        }

        sessionRegistry.updateSessionAttachment(entry.name, nowIso());
        this.setActiveSession(entry.name);
    }

    private resolveSidecarPath(): string {
        const configured = (util.config().get<string>('ark.sidecarPath') || '').trim();
        if (configured) {
            return configured;
        }

        const exeName = process.platform === 'win32' ? 'vscode-r-ark-sidecar.exe' : 'vscode-r-ark-sidecar';
        const releasePath = extensionContext.asAbsolutePath(path.join('ark-sidecar', 'target', 'release', exeName));
        if (fs.existsSync(releasePath)) {
            return releasePath;
        }

        const debugPath = extensionContext.asAbsolutePath(path.join('ark-sidecar', 'target', 'debug', exeName));
        if (fs.existsSync(debugPath)) {
            return debugPath;
        }

        return exeName;
    }

    private async tryExecuteViaSidecar(connectionFile: string, code: string): Promise<boolean> {
        const sidecarPath = this.resolveSidecarPath();
        const encoded = Buffer.from(code, 'utf8').toString('base64');
        const timeoutMs = util.config().get<number>('ark.lspTimeoutMs') ?? DEFAULT_SIDECAR_TIMEOUT_MS;
        const args = [
            '--execute',
            '--connection-file',
            connectionFile,
            '--code',
            encoded,
            '--code-base64',
            '--timeout-ms',
            String(timeoutMs),
        ];
        const result = await util.spawnAsync(sidecarPath, args, { env: process.env });
        if (result.error || result.status !== 0) {
            const message = result.stderr || result.stdout || result.error?.message || 'Unknown error';
            this.outputChannel.appendLine(`Sidecar execute failed: ${message}`);
            return false;
        }
        return true;
    }

    private getArkPath(): string {
        return (util.config().get<string>('ark.path') || '').trim() || DEFAULT_ARK_PATH;
    }

    private getSessionMode(): ArkSessionMode {
        const configured = (util.config().get<string>('ark.sessionMode') || DEFAULT_SESSION_MODE).trim() as ArkSessionMode;
        if (configured !== 'console') {
            void vscode.window.showWarningMessage('Ark console backend 仅支持 console 模式，已强制使用 console。');
            return 'console';
        }
        return configured;
    }

    private getConsoleDriver(): ArkConsoleDriver {
        const configured = (util.config().get<string>('ark.console.driver') || 'tmux').trim();
        if (configured === 'external') {
            return 'external';
        }
        return 'tmux';
    }

    private getConsoleCommandTemplate(): string {
        return util.config().get<string>('ark.console.commandTemplate')
            || 'jupyter console --existing {connectionFile}';
    }

    private getKernelCommandTemplate(): string {
        return util.config().get<string>('ark.kernel.commandTemplate')
            || '{arkPath} --connection_file {connectionFile} --session-mode {sessionMode} --startup-file {startupFile}';
    }

    private getStartupFileTemplate(): string {
        return util.config().get<string>('ark.kernel.startupFileTemplate')
            || '{sessionsDir}/{name}/init-ark.R';
    }

    private getTmuxPath(): string {
        const configured = util.substituteVariables((util.config().get<string>('ark.tmux.path') || '').trim());
        return configured || DEFAULT_TMUX_PATH;
    }

    private getTmuxSessionName(template: string, name: string): string {
        const normalized = normalizeSessionName(name);
        const resolved = renderTemplate(template, { name: normalized });
        return resolved || `vscode-ark-${normalized}`;
    }

    private getTmuxSessionNameTemplate(): string {
        return util.config().get<string>('ark.tmux.sessionNameTemplate') || 'vscode-ark-{name}';
    }

    private getManageKernel(): boolean {
        return util.config().get<boolean>('ark.tmux.manageKernel') ?? true;
    }

    private async createSession(): Promise<void> {
        if (process.platform === 'win32') {
            void vscode.window.showErrorMessage('Ark console backend 暂不支持 Windows。');
            return;
        }

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Ark session name',
            placeHolder: 'analysis',
            ignoreFocusOut: true,
            validateInput: (value) => value.trim().length === 0 ? 'Name is required.' : undefined
        });
        if (!nameInput) {
            return;
        }

        const sessionName = normalizeSessionName(nameInput);
        const sessionsDir = sessionRegistry.getSessionsDir();
        const sessionDir = path.join(sessionsDir, sessionName);
        if (fs.existsSync(sessionDir)) {
            const choice = await vscode.window.showWarningMessage(
                `Session "${sessionName}" already exists. Attach instead?`,
                'Attach',
                'Cancel'
            );
            if (choice === 'Attach') {
                await this.openConsoleByName(sessionName);
            }
            return;
        }
        fs.mkdirSync(sessionDir, { recursive: true });

        const connectionFile = path.join(sessionDir, 'connection.json');
        await this.writeConnectionFile(connectionFile);

        const announceFile = path.join(sessionDir, 'announce.json');
        const startupFile = this.resolveStartupFile(sessionName, sessionsDir);
        this.writeStartupFile(startupFile, sessionName, announceFile);

        const driver = this.getConsoleDriver();
        let tmuxSessionName: string | undefined;

        if (driver === 'tmux') {
            const created = await this.createTmuxSession(sessionName, connectionFile, startupFile);
            if (!created) {
                return;
            }
            tmuxSessionName = created;
        }

        sessionRegistry.upsertSession({
            name: sessionName,
            mode: driver,
            connectionFilePath: connectionFile,
            tmuxSessionName,
            createdAt: nowIso(),
            lastAttachedAt: nowIso(),
        });

        if (driver === 'tmux') {
            await this.openConsoleByName(sessionName);
        } else {
            void vscode.window.showInformationMessage('已生成 Ark connection file，请手动启动 Ark kernel 与 console。');
            this.setActiveSession(sessionName);
        }
    }

    private async attachSession(): Promise<void> {
        const registry = sessionRegistry.loadRegistry();
        const pickItems = registry.map((entry) => ({
            label: entry.name,
            description: entry.mode === 'tmux' ? entry.tmuxSessionName : 'external',
            detail: entry.connectionFilePath,
        }));
        if (pickItems.length === 0) {
            void vscode.window.showInformationMessage('No Ark sessions found. Use "Create Ark session" first.');
            return;
        }

        const selected = await vscode.window.showQuickPick(pickItems, { placeHolder: 'Select an Ark session to attach' });
        if (!selected) {
            return;
        }

        await this.openConsoleByName(selected.label);
    }

    private async openConsole(): Promise<void> {
        const registry = sessionRegistry.loadRegistry();
        if (registry.length === 0) {
            void vscode.window.showInformationMessage('No Ark sessions found. Use "Create Ark session" first.');
            return;
        }
        const selected = await vscode.window.showQuickPick(
            registry.map((entry) => ({ label: entry.name })),
            { placeHolder: 'Select an Ark session' }
        );
        if (!selected) {
            return;
        }
        await this.openConsoleByName(selected.label);
    }

    private async stopSession(): Promise<void> {
        const registry = sessionRegistry.loadRegistry();
        if (registry.length === 0) {
            void vscode.window.showInformationMessage('No Ark sessions found.');
            return;
        }
        const selected = await vscode.window.showQuickPick(
            registry.map((entry) => ({ label: entry.name, description: entry.tmuxSessionName ?? entry.mode })),
            { placeHolder: 'Select an Ark session to stop' }
        );
        if (!selected) {
            return;
        }

        const entry = registry.find((item) => item.name === selected.label);
        if (!entry) {
            return;
        }

        if (entry.mode === 'tmux' && entry.tmuxSessionName) {
            await this.killTmuxSession(entry.tmuxSessionName);
        }

        const nextRegistry = registry.filter((item) => item.name !== entry.name);
        sessionRegistry.saveRegistry(nextRegistry);
        if (sessionRegistry.getActiveSessionName() === entry.name) {
            sessionRegistry.setActiveSessionName(undefined);
        }
        void vscode.window.showInformationMessage(`Stopped Ark session "${entry.name}".`);
    }

    private async openConsoleByName(name: string): Promise<void> {
        const registry = sessionRegistry.loadRegistry();
        const entry = registry.find((item) => item.name === name);
        if (!entry) {
            void vscode.window.showErrorMessage(`Ark session "${name}" not found in registry.`);
            return;
        }

        if (entry.mode === 'tmux' && entry.tmuxSessionName) {
            const exists = await this.tmuxHasSession(entry.tmuxSessionName);
            if (!exists) {
                void vscode.window.showErrorMessage(`tmux session "${entry.tmuxSessionName}" 不存在。`);
                return;
            }
            const tmuxPath = this.getTmuxPath();
            const terminal = vscode.window.createTerminal({ name: `Ark Console: ${name}` });
            terminal.show(true);
            terminal.sendText(`${tmuxPath} attach -t ${entry.tmuxSessionName}`, true);
        } else {
            await this.openExternalConsole(entry.connectionFilePath, name);
        }

        sessionRegistry.updateSessionAttachment(name, nowIso());
        this.setActiveSession(name);
    }

    private async openExternalConsole(connectionFile: string, name: string): Promise<void> {
        const consoleTemplate = this.getConsoleCommandTemplate();
        const command = renderTemplate(consoleTemplate, { connectionFile });
        const terminal = vscode.window.createTerminal({ name: `Ark Console: ${name}` });
        terminal.show(true);
        terminal.sendText(command, true);
        this.externalTerminals.set(name, terminal);
    }

    private resolveStartupFile(name: string, sessionsDir: string): string {
        const template = this.getStartupFileTemplate();
        return renderTemplate(template, { name, sessionsDir });
    }

    private writeStartupFile(startupFile: string, sessionName: string, announceFile: string): void {
        fs.mkdirSync(path.dirname(startupFile), { recursive: true });
        const content = [
            `announce_path <- ${rStringLiteral(announceFile)}`,
            `session_name <- ${rStringLiteral(sessionName)}`,
            `connection_file <- Sys.getenv("ARK_CONNECTION_FILE")`,
            `json_escape <- function(x) {`,
            `  x <- gsub("\\\\", "\\\\\\\\", x)`,
            `  x <- gsub("\"", "\\\\\"", x)`,
            `  x <- gsub("\\n", "\\\\n", x)`,
            `  x <- gsub("\\r", "\\\\r", x)`,
            `  x <- gsub("\\t", "\\\\t", x)`,
            `  paste0("\"", x, "\"")`,
            `}`,
            `payload <- paste0(`,
            `  "{",`,
            `  "\\"sessionName\\":", json_escape(session_name), ",",`,
            `  "\\"connectionFilePath\\":", json_escape(connection_file), ",",`,
            `  "\\"pid\\":", Sys.getpid(), ",",`,
            `  "\\"startedAt\\":", json_escape(format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")),`,
            `  "}"`,
            `)`,
            `writeLines(payload, announce_path)`,
        ];
        fs.writeFileSync(startupFile, content.join('\n'));
    }

    private async createTmuxSession(name: string, connectionFile: string, startupFile: string): Promise<string | undefined> {
        const tmuxPath = this.getTmuxPath();
        const tmuxSessionName = this.getTmuxSessionName(this.getTmuxSessionNameTemplate(), name);

        const exists = await this.tmuxHasSession(tmuxSessionName);
        if (exists) {
            const choice = await vscode.window.showWarningMessage(
                `tmux session "${tmuxSessionName}" already exists. Attach instead?`,
                'Attach',
                'Cancel'
            );
            if (choice === 'Attach') {
                await this.openConsoleByName(name);
            }
            return undefined;
        }

        const arkPath = this.getArkPath();
        const sessionMode = this.getSessionMode();
        const kernelTemplate = this.getKernelCommandTemplate();
        const kernelCommand = renderShellTemplate(kernelTemplate, {
            arkPath,
            connectionFile,
            sessionMode,
            startupFile,
        });

        const envParts: string[] = [`ARK_CONNECTION_FILE=${shellEscape(connectionFile)}`];
        const rHome = await this.resolveRHome();
        if (rHome) {
            envParts.push(`R_HOME=${shellEscape(rHome)}`);
        }

        const manageKernel = this.getManageKernel();
        const kernelCommandWithEnv = `${envParts.join(' ')} ${kernelCommand}`;
        const newSessionArgs = manageKernel
            ? ['new-session', '-d', '-s', tmuxSessionName, '-n', 'ark', 'sh', '-lc', kernelCommandWithEnv]
            : ['new-session', '-d', '-s', tmuxSessionName, '-n', 'ark'];
        const createResult = await this.runTmux(tmuxPath, newSessionArgs);
        if (createResult.status !== 0) {
            const message = createResult.stderr || createResult.stdout || createResult.error?.message || 'Unknown error';
            void vscode.window.showErrorMessage(`Failed to create tmux session: ${message}`);
            return undefined;
        }

        if (!manageKernel) {
            void vscode.window.showWarningMessage('ark.tmux.manageKernel=false: 请手动启动 Ark kernel，再使用 Open Ark Console。');
        } else {
            const consoleTemplate = this.getConsoleCommandTemplate();
            const consoleCommand = renderShellTemplate(consoleTemplate, { connectionFile });
            const consoleArgs = ['new-window', '-t', tmuxSessionName, '-n', 'console', 'sh', '-lc', consoleCommand];
            const consoleResult = await this.runTmux(tmuxPath, consoleArgs);
            if (consoleResult.status !== 0) {
                const message = consoleResult.stderr || consoleResult.stdout || consoleResult.error?.message || 'Unknown error';
                void vscode.window.showWarningMessage(`Failed to start console in tmux: ${message}`);
            }
        }

        return tmuxSessionName;
    }

    private async tmuxHasSession(sessionName: string): Promise<boolean> {
        const result = await this.runTmux(this.getTmuxPath(), ['has-session', '-t', sessionName]);
        return result.status === 0;
    }

    private async killTmuxSession(sessionName: string): Promise<void> {
        const result = await this.runTmux(this.getTmuxPath(), ['kill-session', '-t', sessionName]);
        if (result.status !== 0) {
            const message = result.stderr || result.stdout || result.error?.message || 'Unknown error';
            void vscode.window.showWarningMessage(`Failed to kill tmux session ${sessionName}: ${message}`);
        }
    }

    private async runTmux(command: string, args: string[]): Promise<cp.SpawnSyncReturns<string>> {
        const result = await util.spawnAsync(command, args, { env: process.env });
        if (result.error) {
            this.outputChannel.appendLine(`tmux error: ${String(result.error)}`);
        }
        return result;
    }

    private async pickSessionForExecution(): Promise<ArkSessionEntry | undefined> {
        const registry = sessionRegistry.loadRegistry();
        if (registry.length === 0) {
            const choice = await vscode.window.showInformationMessage(
                'No Ark sessions found. Create one now?',
                'Create',
                'Cancel'
            );
            if (choice === 'Create') {
                await this.createSession();
            }
            return undefined;
        }

        const activeName = sessionRegistry.getActiveSessionName();
        if (activeName) {
            const entry = registry.find((item) => item.name === activeName);
            if (entry) {
                return entry;
            }
        }

        if (registry.length === 1) {
            return registry[0];
        }

        const selected = await vscode.window.showQuickPick(
            registry.map((entry) => ({
                label: entry.name,
                description: entry.tmuxSessionName ?? entry.mode,
            })),
            { placeHolder: 'Select Ark session to run code' }
        );
        if (!selected) {
            return undefined;
        }
        return registry.find((entry) => entry.name === selected.label);
    }

    private async listTmuxWindows(sessionName: string): Promise<string[]> {
        const result = await this.runTmux(this.getTmuxPath(), ['list-windows', '-t', sessionName, '-F', '#{window_name}']);
        if (result.status !== 0) {
            return [];
        }
        return (result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    }

    private async ensureConsoleWindow(entry: ArkSessionEntry): Promise<void> {
        if (!entry.tmuxSessionName) {
            return;
        }
        const windows = await this.listTmuxWindows(entry.tmuxSessionName);
        if (windows.includes('console')) {
            return;
        }
        const consoleTemplate = this.getConsoleCommandTemplate();
        const consoleCommand = renderShellTemplate(consoleTemplate, { connectionFile: entry.connectionFilePath });
        await this.runTmux(this.getTmuxPath(), ['new-window', '-t', entry.tmuxSessionName, '-n', 'console', 'sh', '-lc', consoleCommand]);
    }

    private async sendTextToTmux(sessionName: string, text: string, execute: boolean): Promise<void> {
        const target = `${sessionName}:console`;
        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        const delayMs = util.config().get<number>('rtermSendDelay') || 8;
        const lastIndex = lines.length - 1;
        for (const [index, line] of lines.entries()) {
            if (line.length > 0) {
                await this.runTmux(this.getTmuxPath(), ['send-keys', '-t', target, '-l', '--', line]);
            }
            const shouldExecute = execute || index < lastIndex;
            if (shouldExecute) {
                await this.runTmux(this.getTmuxPath(), ['send-keys', '-t', target, 'Enter']);
            }
            if (index < lastIndex) {
                await util.delay(delayMs);
            }
        }
    }

    private async resolveRHome(): Promise<string | undefined> {
        const rPath = await util.getRpath();
        if (!rPath) {
            return undefined;
        }

        const result = await util.spawnAsync(rPath, ['RHOME'], { env: process.env });
        const lines = (result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (lines.length > 0) {
            return lines[lines.length - 1];
        }
        return path.resolve(path.dirname(rPath), '..');
    }

    private async writeConnectionFile(connectionFile: string): Promise<void> {
        const ipAddress = (util.config().get<string>('ark.ipAddress') || '127.0.0.1').trim();
        const ports = await this.allocatePorts(ipAddress, 5);
        const payload = {
            shell_port: ports[0],
            iopub_port: ports[1],
            stdin_port: ports[2],
            control_port: ports[3],
            hb_port: ports[4],
            ip: ipAddress,
            key: '',
            transport: 'tcp',
            signature_scheme: DEFAULT_SIGNATURE_SCHEME,
        };
        fs.writeFileSync(connectionFile, JSON.stringify(payload, null, 2));
    }

    private async allocatePorts(host: string, count: number): Promise<number[]> {
        const ports: number[] = [];
        for (let i = 0; i < count; i += 1) {
            ports.push(await this.getAvailablePort(host));
        }
        return ports;
    }

    private async getAvailablePort(host: string): Promise<number> {
        return await new Promise((resolve, reject) => {
            const server = net.createServer();
            server.once('error', (err) => {
                reject(err);
            });
            server.listen(0, host, () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    server.close(() => reject(new Error('Failed to allocate port.')));
                    return;
                }
                const port = address.port;
                server.close(() => resolve(port));
            });
        });
    }
}
