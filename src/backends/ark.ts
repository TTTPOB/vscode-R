import * as vscode from 'vscode';
import type { IRConsoleBackend } from './types';

function showArkNotReady(): void {
    void vscode.window.showWarningMessage('Ark console backend is not implemented yet. Set "r.backend" to "terminal" for now.');
}

export class ArkConsoleBackend implements IRConsoleBackend {
    readonly id = 'ark' as const;

    getCommandHandlers(): Record<string, (...args: unknown[]) => unknown> {
        return {
            'r.createRTerm': showArkNotReady,
            'r.nrow': showArkNotReady,
            'r.length': showArkNotReady,
            'r.head': showArkNotReady,
            'r.thead': showArkNotReady,
            'r.names': showArkNotReady,
            'r.view': showArkNotReady,
            'r.runSource': showArkNotReady,
            'r.runSelection': showArkNotReady,
            'r.runFromLineToEnd': showArkNotReady,
            'r.runFromBeginningToLine': showArkNotReady,
            'r.runSelectionRetainCursor': showArkNotReady,
            'r.runCommandWithSelectionOrWord': showArkNotReady,
            'r.runCommandWithEditorPath': showArkNotReady,
            'r.runCommand': showArkNotReady,
            'r.runSourcewithEcho': showArkNotReady,
            'r.runChunks': showArkNotReady,
        };
    }

    dispose(): void {
        // No resources to clean up yet.
    }
}
