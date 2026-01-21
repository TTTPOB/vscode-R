import type * as vscode from 'vscode';

export type RConsoleBackendId = 'terminal' | 'ark';

export interface IRConsoleBackend extends vscode.Disposable {
    readonly id: RConsoleBackendId;
    getCommandHandlers(): Record<string, (...args: unknown[]) => unknown>;
    onDidCloseTerminal?(terminal: vscode.Terminal): void;
    getTerminalProfileProvider?(): vscode.TerminalProfileProvider | undefined;
}

export interface IRLanguageService extends vscode.Disposable {
    restart(): Promise<void>;
    restartWithSessionPaths(rPath?: string, libPaths?: string[]): Promise<void>;
}
