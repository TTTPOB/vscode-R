import * as util from '../util';
import * as languageService from '../languageService';
import * as arkLanguageService from '../ark/arkLanguageService';
import type { IRLanguageService } from './types';

export function createLanguageService(): IRLanguageService {
    const backend = util.config().get<string>('lsp.backend') || 'languageserver';
    if (backend === 'ark') {
        return new arkLanguageService.ArkLanguageService();
    }
    return new languageService.LanguageService();
}
