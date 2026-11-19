import type { Language, ParsedFile } from '../types.js';
import { parseTypeScriptFile } from './typescript.js';
import { parseGoFile, parsePythonFile, parseRustFile } from './polyglot.js';

export function parseFile(fileId: string, language: Language, content: string): ParsedFile {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return parseTypeScriptFile(fileId, content);
    case 'python':
      return parsePythonFile(content);
    case 'rust':
      return parseRustFile(content);
    case 'go':
      return parseGoFile(content);
    default:
      return {
        imports: [],
        symbols: [],
        skeleton: content.split('\n').slice(0, 20).join('\n'),
      };
  }
}
