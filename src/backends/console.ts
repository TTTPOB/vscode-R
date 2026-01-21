import * as util from '../util';
import { ArkConsoleBackend } from './ark';
import { TerminalBackend } from './terminal';
import type { IRConsoleBackend, RConsoleBackendId } from './types';

export function createConsoleBackend(): IRConsoleBackend {
    const configured = (util.config().get<string>('backend') || '').trim();
    const backend = (configured || 'terminal') as RConsoleBackendId;

    if (backend === 'ark') {
        return new ArkConsoleBackend();
    }

    return new TerminalBackend();
}
