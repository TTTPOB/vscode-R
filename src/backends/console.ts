import * as util from '../util';
import { TerminalBackend } from './terminal';
import type { IRConsoleBackend, RConsoleBackendId } from './types';

export function createConsoleBackend(): IRConsoleBackend {
    const configured = (util.config().get<string>('backend') || '').trim();
    const backend = (configured || 'terminal') as RConsoleBackendId;

    if (backend === 'terminal') {
        return new TerminalBackend();
    }

    return new TerminalBackend();
}
