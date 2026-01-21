import type * as vscode from 'vscode';
import * as rTerminal from '../rTerminal';
import type { IRConsoleBackend } from './types';

export class TerminalBackend implements IRConsoleBackend {
    readonly id = 'terminal' as const;

    getCommandHandlers(): Record<string, (...args: unknown[]) => unknown> {
        return {
            'r.createRTerm': rTerminal.createRTerm,
            'r.nrow': () => rTerminal.runSelectionOrWord(['nrow']),
            'r.length': () => rTerminal.runSelectionOrWord(['length']),
            'r.head': () => rTerminal.runSelectionOrWord(['head']),
            'r.thead': () => rTerminal.runSelectionOrWord(['t', 'head']),
            'r.names': () => rTerminal.runSelectionOrWord(['names']),
            'r.view': () => rTerminal.runSelectionOrWord(['View']),
            'r.runSource': () => { void rTerminal.runSource(false); },
            'r.runSelection': (code?: string) => { code ? void rTerminal.runTextInTerm(code) : void rTerminal.runSelection(); },
            'r.runFromLineToEnd': rTerminal.runFromLineToEnd,
            'r.runFromBeginningToLine': rTerminal.runFromBeginningToLine,
            'r.runSelectionRetainCursor': rTerminal.runSelectionRetainCursor,
            'r.runCommandWithSelectionOrWord': rTerminal.runCommandWithSelectionOrWord,
            'r.runCommandWithEditorPath': rTerminal.runCommandWithEditorPath,
            'r.runCommand': rTerminal.runCommand,
            'r.runSourcewithEcho': () => { void rTerminal.runSource(true); },
            'r.runChunks': rTerminal.runChunksInTerm,
        };
    }

    onDidCloseTerminal(terminal: vscode.Terminal): void {
        rTerminal.deleteTerminal(terminal);
    }

    getTerminalProfileProvider(): vscode.TerminalProfileProvider {
        return {
            async provideTerminalProfile() {
                return {
                    options: await rTerminal.makeTerminalOptions()
                };
            }
        };
    }

    dispose(): void {
        // No resources to clean up yet.
    }
}
