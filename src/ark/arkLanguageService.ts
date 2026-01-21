import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as readline from 'readline';
import * as cp from 'child_process';
import { URL } from 'url';
import { Disposable, workspace, Uri, WorkspaceConfiguration, OutputChannel, window, WorkspaceFolder } from 'vscode';
import { LanguageClient, LanguageClientOptions, StreamInfo, DocumentFilter, ErrorAction, CloseAction, RevealOutputChannelOn } from 'vscode-languageclient/node';
import { createTempDir, spawn, spawnAsync, DisposableProcess, getRpath } from '../util';
import { extensionContext, tmpDir } from '../extension';

interface ConnectionInfo {
    shell_port: number;
    iopub_port: number;
    stdin_port: number;
    control_port: number;
    hb_port: number;
    ip: string;
    key: string;
    transport: string;
    signature_scheme: string;
}

interface SidecarMessage {
    event?: string;
    port?: number;
    message?: string;
}

const DEFAULT_IP_ADDRESS = '127.0.0.1';
const DEFAULT_SIGNATURE_SCHEME = 'hmac-sha256';
const DEFAULT_SESSION_MODE = 'notebook';
const DEFAULT_SIDECAR_TIMEOUT_MS = 15000;

export class ArkLanguageService implements Disposable {
    private client: LanguageClient | undefined;
    private readonly config: WorkspaceConfiguration;
    private readonly outputChannel: OutputChannel;
    private arkProcess: DisposableProcess | undefined;
    private sidecarProcess: cp.ChildProcessWithoutNullStreams | undefined;
    private connectionDir: string | undefined;
    private connectionFile: string | undefined;

    constructor() {
        this.outputChannel = window.createOutputChannel('Ark LSP');
        this.client = undefined;
        this.config = workspace.getConfiguration('r');
        void this.startLanguageService();
    }

    public async restartWithSessionPaths(_rPath?: string, _libPaths?: string[]): Promise<void> {
        await this.restart();
    }

    public async restart(): Promise<void> {
        this.outputChannel.appendLine('Restarting Ark LSP...');
        await this.stopLanguageService();
        this.client = undefined;
        await this.startLanguageService();
        this.outputChannel.appendLine('Ark LSP restarted.');
    }

    dispose(): Thenable<void> {
        return this.stopLanguageService();
    }

    private async startLanguageService(): Promise<void> {
        const multiServer = this.config.get<boolean>('lsp.multiServer');
        if (multiServer) {
            this.outputChannel.appendLine('Ark LSP backend ignores r.lsp.multiServer; using a single server.');
        }
        const documentSelector: DocumentFilter[] = [
            { language: 'r' },
            { language: 'rmd' },
        ];
        const workspaceFolder = workspace.workspaceFolders?.[0];
        const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : os.homedir();

        try {
            await this.startArkKernel(cwd);
            const port = await this.openArkLspComm();
            this.client = await this.createClient(port, documentSelector, workspaceFolder, this.outputChannel);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            this.outputChannel.appendLine(`Ark LSP failed to start: ${message}`);
            void window.showErrorMessage(`Ark LSP failed to start: ${message}`);
            this.outputChannel.show();
            await this.stopLanguageService();
        }
    }

    private async startArkKernel(cwd: string): Promise<void> {
        if (this.arkProcess) {
            return;
        }

        const connectionFile = await this.createConnectionFile();
        this.connectionFile = connectionFile;

        const arkPath = (this.config.get<string>('ark.path') || '').trim() || 'ark';
        const sessionMode = (this.config.get<string>('ark.sessionMode') || DEFAULT_SESSION_MODE).trim();
        const env = Object.assign({}, process.env, {
            ARK_CONNECTION_FILE: connectionFile,
        });
        const rHome = await this.resolveRHome();
        if (rHome) {
            env.R_HOME = rHome;
            this.outputChannel.appendLine(`Resolved R_HOME for Ark: ${rHome}`);
        }

        this.outputChannel.appendLine(`Starting Ark kernel with connection file ${connectionFile}`);
        this.arkProcess = spawn(arkPath, ['--connection_file', connectionFile, '--session-mode', sessionMode], { cwd, env });
        this.arkProcess.stdout?.on('data', (chunk: Buffer) => {
            this.outputChannel.appendLine(chunk.toString().trim());
        });
        this.arkProcess.stderr?.on('data', (chunk: Buffer) => {
            this.outputChannel.appendLine(chunk.toString().trim());
        });
        this.arkProcess.on('exit', (code, signal) => {
            this.outputChannel.appendLine(`Ark kernel exited ${signal ? `from signal ${signal}` : `with exit code ${code ?? 'null'}`}`);
        });
    }

    private async resolveRHome(): Promise<string | undefined> {
        const rPath = await getRpath();
        if (!rPath) {
            return undefined;
        }

        const result = await spawnAsync(rPath, ['RHOME'], { env: process.env });
        const lines = (result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (lines.length > 0) {
            return lines[lines.length - 1];
        }

        return path.resolve(path.dirname(rPath), '..');
    }

    private async openArkLspComm(): Promise<number> {
        if (!this.connectionFile) {
            throw new Error('Missing Ark connection file.');
        }

        const ipAddress = (this.config.get<string>('ark.ipAddress') || DEFAULT_IP_ADDRESS).trim();
        const timeoutMs = this.config.get<number>('ark.lspTimeoutMs') ?? DEFAULT_SIDECAR_TIMEOUT_MS;
        const sidecarPath = this.resolveSidecarPath();
        const args = ['--connection-file', this.connectionFile, '--ip-address', ipAddress, '--timeout-ms', String(timeoutMs)];

        this.outputChannel.appendLine(`Starting Ark sidecar: ${sidecarPath}`);
        const sidecar = cp.spawn(sidecarPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.sidecarProcess = sidecar;
        sidecar.stderr?.on('data', (chunk: Buffer) => {
            this.outputChannel.appendLine(`[sidecar] ${chunk.toString().trim()}`);
        });

        return await this.waitForSidecarPort(sidecar, timeoutMs);
    }

    private async waitForSidecarPort(proc: cp.ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number> {
        return await new Promise((resolve, reject) => {
            let resolved = false;
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Timed out waiting for Ark LSP port.'));
                }
            }, timeoutMs);

            const rl = readline.createInterface({ input: proc.stdout });
            const cleanup = () => {
                clearTimeout(timer);
                rl.close();
            };
            rl.on('line', (line) => {
                if (!line.trim()) {
                    return;
                }
                let msg: SidecarMessage | undefined;
                try {
                    msg = JSON.parse(line) as SidecarMessage;
                } catch {
                    this.outputChannel.appendLine(`[sidecar] ${line}`);
                    return;
                }

                if (msg?.event === 'lsp_port' && typeof msg.port === 'number') {
                    resolved = true;
                    cleanup();
                    resolve(msg.port);
                    return;
                }

                if (msg?.event === 'error') {
                    resolved = true;
                    cleanup();
                    reject(new Error(msg.message || 'Ark sidecar error'));
                }
            });

            proc.on('exit', (code) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(new Error(`Ark sidecar exited with code ${code ?? 'null'}`));
                }
            });

            proc.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    reject(err);
                }
            });
        });
    }

    private async createConnectionFile(): Promise<string> {
        const tempRoot = tmpDir();
        const connectionDir = createTempDir(tempRoot, true);
        this.connectionDir = connectionDir;
        const connectionFile = path.join(connectionDir, 'ark-connection.json');
        const ipAddress = (this.config.get<string>('ark.ipAddress') || DEFAULT_IP_ADDRESS).trim();
        const ports = await this.allocatePorts(ipAddress, 5);

        const connectionInfo: ConnectionInfo = {
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

        fs.writeFileSync(connectionFile, JSON.stringify(connectionInfo, null, 2));
        return connectionFile;
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

    private resolveSidecarPath(): string {
        const configured = (this.config.get<string>('ark.sidecarPath') || '').trim();
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

    private async createClient(port: number, selector: DocumentFilter[], workspaceFolder: WorkspaceFolder | undefined,
        outputChannel: OutputChannel): Promise<LanguageClient> {

        const ipAddress = (this.config.get<string>('ark.ipAddress') || DEFAULT_IP_ADDRESS).trim();

        const tcpServerOptions = () => new Promise<StreamInfo>((resolve, reject) => {
            const socket = net.connect({ host: ipAddress, port }, () => {
                resolve({ reader: socket, writer: socket });
            });
            socket.on('error', (e: Error) => {
                reject(e);
            });
        });

        const clientOptions: LanguageClientOptions = {
            documentSelector: selector,
            uriConverters: {
                code2Protocol: uri => new URL(uri.toString(true)).toString(),
                protocol2Code: str => Uri.parse(str)
            },
            workspaceFolder: workspaceFolder,
            outputChannel: outputChannel,
            synchronize: {
                configurationSection: 'r.lsp',
                fileEvents: workspace.createFileSystemWatcher('**/*.{R,r}'),
            },
            revealOutputChannelOn: RevealOutputChannelOn.Never,
            errorHandler: {
                error: () =>    {
                    return {
                        action: ErrorAction.Continue
                    };
                },
                closed: () => {
                    return {
                        action: CloseAction.DoNotRestart
                    };
                },
            },
        };

        const client = new LanguageClient('r', 'Ark Language Server', tcpServerOptions, clientOptions);
        extensionContext.subscriptions.push(client);
        await client.start();
        return client;
    }

    private async stopLanguageService(): Promise<void> {
        const promises: Promise<void>[] = [];
        if (this.client) {
            promises.push(this.client.stop());
            this.client = undefined;
        }

        if (this.sidecarProcess && !this.sidecarProcess.killed) {
            this.sidecarProcess.kill('SIGKILL');
        }
        this.sidecarProcess = undefined;

        if (this.arkProcess) {
            this.arkProcess.dispose();
            this.arkProcess = undefined;
        }

        if (this.connectionDir) {
            try {
                fs.rmSync(this.connectionDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors.
            }
            this.connectionDir = undefined;
            this.connectionFile = undefined;
        }

        await Promise.allSettled(promises);
    }
}
