import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import * as util from '../util';
import { extensionContext } from '../extension';
import type { IRConsoleBackend } from './types';

type ArkConsoleDriver = 'tmux' | 'external';
type ArkSessionMode = 'console' | 'notebook' | 'background';

interface ArkSessionEntry {
    name: string;
    mode: ArkConsoleDriver;
    connectionFilePath: string;
    tmuxSessionName?: string;
    createdAt: string;
    lastAttachedAt?: string;
}

const DEFAULT_SIGNATURE_SCHEME = 'hmac-sha256';
const DEFAULT_SESSION_MODE: ArkSessionMode = 'console';
const DEFAULT_ARK_PATH = 'ark';
const DEFAULT_TMUX_PATH = 'tmux';

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

    getCommandHandlers(): Record<string, (...args: unknown[]) => unknown> {
        return {
            'r.createRTerm': () => this.createSession(),
            'r.ark.createSession': () => this.createSession(),
            'r.ark.attachSession': () => this.attachSession(),
            'r.ark.openConsole': () => this.openConsole(),
            'r.ark.stopSession': () => this.stopSession(),
            'r.nrow': () => this.showNotReady('r.nrow'),
            'r.length': () => this.showNotReady('r.length'),
            'r.head': () => this.showNotReady('r.head'),
            'r.thead': () => this.showNotReady('r.thead'),
            'r.names': () => this.showNotReady('r.names'),
            'r.view': () => this.showNotReady('r.view'),
            'r.runSource': () => this.showNotReady('r.runSource'),
            'r.runSelection': () => this.showNotReady('r.runSelection'),
            'r.runFromLineToEnd': () => this.showNotReady('r.runFromLineToEnd'),
            'r.runFromBeginningToLine': () => this.showNotReady('r.runFromBeginningToLine'),
            'r.runSelectionRetainCursor': () => this.showNotReady('r.runSelectionRetainCursor'),
            'r.runCommandWithSelectionOrWord': () => this.showNotReady('r.runCommandWithSelectionOrWord'),
            'r.runCommandWithEditorPath': () => this.showNotReady('r.runCommandWithEditorPath'),
            'r.runCommand': () => this.showNotReady('r.runCommand'),
            'r.runSourcewithEcho': () => this.showNotReady('r.runSourcewithEcho'),
            'r.runChunks': () => this.showNotReady('r.runChunks'),
        };
    }

    dispose(): void {
        this.outputChannel.dispose();
    }

    private showNotReady(command: string): void {
        void vscode.window.showWarningMessage(`Ark console backend 未实现命令 ${command}。请先通过 Ark 会话命令创建/附加会话。`);
    }

    private getSessionsDir(): string {
        const configured = util.substituteVariables((util.config().get<string>('ark.sessionsDir') || '').trim());
        const baseDir = configured || path.join(extensionContext.globalStorageUri.fsPath, 'ark-sessions');
        fs.mkdirSync(baseDir, { recursive: true });
        return baseDir;
    }

    private getRegistryPath(): string {
        return path.join(this.getSessionsDir(), 'registry.json');
    }

    private loadRegistry(): ArkSessionEntry[] {
        const registryPath = this.getRegistryPath();
        if (!fs.existsSync(registryPath)) {
            return [];
        }
        try {
            const content = fs.readFileSync(registryPath, 'utf8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                return parsed as ArkSessionEntry[];
            }
        } catch (err) {
            this.outputChannel.appendLine(`Failed to read registry: ${String(err)}`);
        }
        return [];
    }

    private saveRegistry(entries: ArkSessionEntry[]): void {
        const registryPath = this.getRegistryPath();
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(registryPath, JSON.stringify(entries, null, 2));
    }

    private upsertRegistry(entry: ArkSessionEntry): void {
        const registry = this.loadRegistry();
        const idx = registry.findIndex((item) => item.name === entry.name);
        if (idx >= 0) {
            registry[idx] = entry;
        } else {
            registry.push(entry);
        }
        this.saveRegistry(registry);
    }

    private updateRegistryAttachment(name: string): void {
        const registry = this.loadRegistry();
        const idx = registry.findIndex((item) => item.name === name);
        if (idx >= 0) {
            registry[idx].lastAttachedAt = nowIso();
            this.saveRegistry(registry);
        }
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
        const sessionsDir = this.getSessionsDir();
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

        this.upsertRegistry({
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
        }
    }

    private async attachSession(): Promise<void> {
        const registry = this.loadRegistry();
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
        const registry = this.loadRegistry();
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
        const registry = this.loadRegistry();
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
        this.saveRegistry(nextRegistry);
        void vscode.window.showInformationMessage(`Stopped Ark session "${entry.name}".`);
    }

    private async openConsoleByName(name: string): Promise<void> {
        const registry = this.loadRegistry();
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

        this.updateRegistryAttachment(name);
    }

    private async openExternalConsole(connectionFile: string, name: string): Promise<void> {
        const consoleTemplate = this.getConsoleCommandTemplate();
        const command = renderTemplate(consoleTemplate, { connectionFile });
        const terminal = vscode.window.createTerminal({ name: `Ark Console: ${name}` });
        terminal.show(true);
        terminal.sendText(command, true);
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
