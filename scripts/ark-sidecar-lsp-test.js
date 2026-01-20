#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const cp = require('child_process');
const readline = require('readline');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_IP_ADDRESS = '127.0.0.1';

async function getFreePort(host) {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Failed to allocate port.')));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
    });
}

async function allocatePorts(host, count) {
    const ports = [];
    for (let i = 0; i < count; i += 1) {
        ports.push(await getFreePort(host));
    }
    return ports;
}

function resolveSidecarPath() {
    const configured = (process.env.ARK_SIDECAR_PATH || '').trim();
    if (configured) {
        return configured;
    }
    const exeName = process.platform === 'win32' ? 'vscode-r-ark-sidecar.exe' : 'vscode-r-ark-sidecar';
    const root = path.resolve(__dirname, '..');
    const releasePath = path.join(root, 'ark-sidecar', 'target', 'release', exeName);
    if (fs.existsSync(releasePath)) {
        return releasePath;
    }
    const debugPath = path.join(root, 'ark-sidecar', 'target', 'debug', exeName);
    if (fs.existsSync(debugPath)) {
        return debugPath;
    }
    return exeName;
}

function resolveArkPath() {
    return (process.env.ARK_PATH || '').trim() || 'ark';
}

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-ark-'));
}

function writeConnectionFile(dir, ipAddress, ports) {
    const connectionInfo = {
        shell_port: ports[0],
        iopub_port: ports[1],
        stdin_port: ports[2],
        control_port: ports[3],
        hb_port: ports[4],
        ip: ipAddress,
        key: '',
        transport: 'tcp',
        signature_scheme: 'hmac-sha256',
    };
    const filePath = path.join(dir, 'ark-connection.json');
    fs.writeFileSync(filePath, JSON.stringify(connectionInfo, null, 2));
    return filePath;
}

function filePathToUri(filePath) {
    let uriPath = path.resolve(filePath).replace(/\\/g, '/');
    if (!uriPath.startsWith('/')) {
        uriPath = `/${uriPath}`;
    }
    return `file://${encodeURI(uriPath)}`;
}

async function waitForSidecarPort(proc, timeoutMs) {
    return await new Promise((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                reject(new Error('Timed out waiting for sidecar port.'));
            }
        }, timeoutMs);

        const rl = readline.createInterface({ input: proc.stdout });
        const cleanup = () => {
            clearTimeout(timer);
            rl.close();
        };

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            let payload;
            try {
                payload = JSON.parse(trimmed);
            } catch (err) {
                return;
            }
            if (payload.event === 'lsp_port' && typeof payload.port === 'number') {
                resolved = true;
                cleanup();
                resolve(payload.port);
                return;
            }
            if (payload.event === 'error') {
                resolved = true;
                cleanup();
                reject(new Error(payload.message || 'Sidecar error'));
            }
        });

        proc.on('exit', (code) => {
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(new Error(`Sidecar exited with code ${code ?? 'null'}`));
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

function createLspClient(port, ipAddress) {
    const socket = net.connect({ host: ipAddress, port });
    let buffer = '';
    const listeners = [];

    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                break;
            }
            const header = buffer.slice(0, headerEnd);
            const match = header.match(/Content-Length: (\d+)/i);
            if (!match) {
                buffer = buffer.slice(headerEnd + 4);
                continue;
            }
            const length = Number.parseInt(match[1], 10);
            const messageEnd = headerEnd + 4 + length;
            if (buffer.length < messageEnd) {
                break;
            }
            const body = buffer.slice(headerEnd + 4, messageEnd);
            buffer = buffer.slice(messageEnd);
            try {
                const message = JSON.parse(body);
                listeners.forEach((listener) => listener(message));
            } catch (err) {
                // ignore malformed payloads
            }
        }
    });

    const send = (message) => {
        const json = JSON.stringify(message);
        const content = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
        socket.write(content);
    };

    const waitFor = (predicate, timeoutMs) => {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Timed out waiting for LSP response.'));
            }, timeoutMs);
            const listener = (message) => {
                if (predicate(message)) {
                    cleanup();
                    resolve(message);
                }
            };
            const cleanup = () => {
                clearTimeout(timer);
                const idx = listeners.indexOf(listener);
                if (idx >= 0) {
                    listeners.splice(idx, 1);
                }
            };
            listeners.push(listener);
        });
    };

    return { socket, send, waitFor };
}

async function main() {
    const timeoutMs = Number.parseInt(process.env.ARK_LSP_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
    const ipAddress = (process.env.ARK_IP_ADDRESS || DEFAULT_IP_ADDRESS).trim();
    const sessionMode = (process.env.ARK_SESSION_MODE || 'notebook').trim();
    const tempDir = createTempDir();
    const ports = await allocatePorts(ipAddress, 5);
    const connectionFile = writeConnectionFile(tempDir, ipAddress, ports);

    const rFilePath = path.join(tempDir, 'sidecar-test.R');
    const rFileContents = 'x <- 1\n';
    fs.writeFileSync(rFilePath, rFileContents);

    const arkPath = resolveArkPath();
    const sidecarPath = resolveSidecarPath();

    const arkProc = cp.spawn(arkPath, ['--connection_file', connectionFile, '--session-mode', sessionMode], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ARK_CONNECTION_FILE: connectionFile },
    });

    arkProc.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
    });

    const sidecarProc = cp.spawn(sidecarPath, [
        '--connection-file', connectionFile,
        '--ip-address', ipAddress,
        '--timeout-ms', String(timeoutMs),
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    sidecarProc.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
    });

    let lsp;
    let lspPort;
    const cleanup = () => {
        if (lsp?.socket) {
            lsp.socket.destroy();
        }
        if (!sidecarProc.killed) {
            sidecarProc.kill('SIGKILL');
        }
        if (!arkProc.killed) {
            arkProc.kill('SIGKILL');
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    };

    try {
        lspPort = await waitForSidecarPort(sidecarProc, timeoutMs);
        lsp = createLspClient(lspPort, ipAddress);
        const rootUri = filePathToUri(tempDir);
        const docUri = filePathToUri(rFilePath);

        lsp.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                processId: process.pid,
                rootUri,
                capabilities: {},
            }
        });

        await lsp.waitFor((msg) => msg.id === 1, timeoutMs);

        lsp.send({
            jsonrpc: '2.0',
            method: 'initialized',
            params: {},
        });

        lsp.send({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
                textDocument: {
                    uri: docUri,
                    languageId: 'r',
                    version: 1,
                    text: rFileContents,
                }
            }
        });

        lsp.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'shutdown',
            params: null,
        });

        await lsp.waitFor((msg) => msg.id === 2, timeoutMs);

        lsp.send({
            jsonrpc: '2.0',
            method: 'exit',
            params: null,
        });

        console.log(`Ark sidecar OK, LSP port ${lspPort}`);
    } finally {
        cleanup();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
