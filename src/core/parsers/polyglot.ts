import type { ImportSpec, ParsedFile, SymbolInfo } from '../types.js';

/**
 * Structural parser & skeletonizer for Python (.py) files.
 */
export function parsePythonFile(content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  const imports: ImportSpec[] = [];
  const symbols: SymbolInfo[] = [];
  const skeletonLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // `from pkg.mod import a, b`
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const names = fromMatch[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      imports.push({ specifier: fromMatch[1], names });
      skeletonLines.push(line);
      continue;
    }

    // `import pkg.mod`
    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0];
        if (mod) imports.push({ specifier: mod });
      }
      skeletonLines.push(line);
      continue;
    }

    // Top-level or class-level defs & classes
    const indent = line.length - line.trimStart().length;
    const classMatch = line.match(/^(\s*)class\s+([A-Za-z_]\w*)\s*(\([^)]*\))?\s*:/);
    if (classMatch && indent === 0) {
      symbols.push({
        name: classMatch[2],
        kind: 'class',
        exported: !classMatch[2].startsWith('_'),
        line: i + 1,
        signature: trimmed,
      });
      skeletonLines.push(line);
      continue;
    }

    const fnMatch = line.match(/^(\s*)(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)(\s*->\s*[^:]+)?\s*:/);
    if (fnMatch && indent <= 4) {
      const isMethod = indent > 0;
      symbols.push({
        name: fnMatch[3],
        kind: isMethod ? 'method' : 'function',
        exported: !fnMatch[3].startsWith('_'),
        line: i + 1,
        signature: trimmed,
      });
      skeletonLines.push(`${line}\n${' '.repeat(indent + 4)}...`);
    }
  }

  return {
    imports,
    symbols,
    skeleton: skeletonLines.join('\n').trim() || lines.slice(0, 15).join('\n'),
  };
}

/**
 * Structural parser & skeletonizer for Rust (.rs) files.
 */
export function parseRustFile(content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  const imports: ImportSpec[] = [];
  const symbols: SymbolInfo[] = [];
  const skeletonLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // `mod foo;`
    const modMatch = trimmed.match(/^(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/);
    if (modMatch) {
      imports.push({ specifier: `mod::${modMatch[1]}` });
      skeletonLines.push(line);
      continue;
    }

    // `use crate::foo::bar;`
    const useMatch = trimmed.match(/^(?:pub\s+)?use\s+([^;]+);/);
    if (useMatch) {
      imports.push({ specifier: useMatch[1].trim() });
      skeletonLines.push(line);
      continue;
    }

    const fnMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
    if (fnMatch) {
      const sig = trimmed.replace(/\{.*$/, '{ /* ... */ }');
      symbols.push({
        name: fnMatch[2],
        kind: 'function',
        exported: Boolean(fnMatch[1]),
        line: i + 1,
        signature: sig,
      });
      skeletonLines.push(sig);
      continue;
    }

    const typeMatch = trimmed.match(/^(pub(?:\([^)]+\))?\s+)?(struct|enum|trait|type)\s+([A-Za-z_]\w*)/);
    if (typeMatch) {
      const kind = typeMatch[2] === 'struct' ? 'struct' : typeMatch[2] === 'trait' ? 'trait' : typeMatch[2] === 'enum' ? 'enum' : 'type';
      symbols.push({
        name: typeMatch[3],
        kind,
        exported: Boolean(typeMatch[1]),
        line: i + 1,
        signature: trimmed,
      });
      skeletonLines.push(trimmed);
    }
  }

  return {
    imports,
    symbols,
    skeleton: skeletonLines.join('\n').trim() || lines.slice(0, 15).join('\n'),
  };
}

/**
 * Structural parser & skeletonizer for Go (.go) files.
 */
export function parseGoFile(content: string): ParsedFile {
  const lines = content.split(/\r?\n/);
  const imports: ImportSpec[] = [];
  const symbols: SymbolInfo[] = [];
  const skeletonLines: string[] = [];

  let inImportBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    if (trimmed.startsWith('package ')) {
      skeletonLines.push(line);
      continue;
    }

    if (trimmed.startsWith('import (')) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (trimmed === ')') {
        inImportBlock = false;
        continue;
      }
      const m = trimmed.match(/"([^"]+)"/);
      if (m) imports.push({ specifier: m[1] });
      continue;
    }

    const singleImport = trimmed.match(/^import\s+(?:[A-Za-z_.\w]*\s+)?"([^"]+)"/);
    if (singleImport) {
      imports.push({ specifier: singleImport[1] });
      skeletonLines.push(line);
      continue;
    }

    const fnMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(/);
    if (fnMatch) {
      const sig = trimmed.replace(/\{.*$/, '{ /* ... */ }');
      symbols.push({
        name: fnMatch[1],
        kind: 'function',
        exported: /^[A-Z]/.test(fnMatch[1]),
        line: i + 1,
        signature: sig,
      });
      skeletonLines.push(sig);
      continue;
    }

    const typeMatch = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)/);
    if (typeMatch) {
      symbols.push({
        name: typeMatch[1],
        kind: typeMatch[2] === 'struct' ? 'struct' : 'interface',
        exported: /^[A-Z]/.test(typeMatch[1]),
        line: i + 1,
        signature: trimmed,
      });
      skeletonLines.push(trimmed);
    }
  }

  return {
    imports,
    symbols,
    skeleton: skeletonLines.join('\n').trim() || lines.slice(0, 15).join('\n'),
  };
}
