import * as fs from 'fs';
import * as path from 'path';
import * as util from '../util';
import { extensionContext } from '../extension';

export type ArkConsoleDriver = 'tmux' | 'external';

export interface ArkSessionEntry {
    name: string;
    mode: ArkConsoleDriver;
    connectionFilePath: string;
    tmuxSessionName?: string;
    createdAt: string;
    lastAttachedAt?: string;
}

const ACTIVE_SESSION_KEY = 'ark.activeSessionName';

export function getSessionsDir(): string {
    const configured = util.substituteVariables((util.config().get<string>('ark.sessionsDir') || '').trim());
    const baseDir = configured || path.join(extensionContext.globalStorageUri.fsPath, 'ark-sessions');
    fs.mkdirSync(baseDir, { recursive: true });
    return baseDir;
}

export function getRegistryPath(): string {
    return path.join(getSessionsDir(), 'registry.json');
}

export function loadRegistry(): ArkSessionEntry[] {
    const registryPath = getRegistryPath();
    if (!fs.existsSync(registryPath)) {
        return [];
    }
    try {
        const content = fs.readFileSync(registryPath, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return parsed as ArkSessionEntry[];
        }
    } catch {
        return [];
    }
    return [];
}

export function saveRegistry(entries: ArkSessionEntry[]): void {
    const registryPath = getRegistryPath();
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(entries, null, 2));
}

export function upsertSession(entry: ArkSessionEntry): void {
    const registry = loadRegistry();
    const idx = registry.findIndex((item) => item.name === entry.name);
    if (idx >= 0) {
        registry[idx] = entry;
    } else {
        registry.push(entry);
    }
    saveRegistry(registry);
}

export function updateSessionAttachment(name: string, time: string): void {
    const registry = loadRegistry();
    const idx = registry.findIndex((item) => item.name === name);
    if (idx >= 0) {
        registry[idx].lastAttachedAt = time;
        saveRegistry(registry);
    }
}

export function setActiveSessionName(name: string | undefined): void {
    if (name) {
        void extensionContext.globalState.update(ACTIVE_SESSION_KEY, name);
    } else {
        void extensionContext.globalState.update(ACTIVE_SESSION_KEY, undefined);
    }
}

export function getActiveSessionName(): string | undefined {
    return extensionContext.globalState.get<string>(ACTIVE_SESSION_KEY);
}

export function getActiveSession(): ArkSessionEntry | undefined {
    const activeName = getActiveSessionName();
    if (!activeName) {
        return undefined;
    }
    return loadRegistry().find((entry) => entry.name === activeName);
}

export function findSession(name: string): ArkSessionEntry | undefined {
    return loadRegistry().find((entry) => entry.name === name);
}
