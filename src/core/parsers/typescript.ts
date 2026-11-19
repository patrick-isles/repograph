import ts from 'typescript';
import type { ImportSpec, ParsedFile, SymbolInfo } from '../types.js';

function getScriptKind(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function compactWhitespace(str: string, maxLen = 140): string {
  const cleaned = str.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

/**
 * Extracts imports, top-level symbols, and a clean AST-stripped skeleton
 * (preserving imports, types, interfaces, class headers & method signatures,
 * and function signatures while replacing implementation bodies with `{ /* ... *\/ }`).
 */
export function parseTypeScriptFile(fileName: string, content: string): ParsedFile {
  const sf = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(fileName),
  );

  const imports: ImportSpec[] = [];
  const symbols: SymbolInfo[] = [];
  const skeletonParts: string[] = [];

  function extractFunctionHeader(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration): string {
    if (node.body) {
      const header = content.slice(node.getStart(sf), node.body.getStart(sf)).trim();
      return `${header} { /* ... */ }`;
    }
    return node.getText(sf).trim();
  }

  function extractClassSkeleton(node: ts.ClassDeclaration): string {
    const start = node.getStart(sf);
    const openBraceIdx = content.indexOf('{', start);
    if (openBraceIdx === -1) return node.getText(sf).trim();

    const header = content.slice(start, openBraceIdx + 1).trim();
    const memberLines: string[] = [];

    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        memberLines.push(`  ${extractFunctionHeader(member)}`);
      } else if (ts.isPropertyDeclaration(member)) {
        const propText = member.getText(sf).trim();
        const firstLine = propText.split('\n')[0];
        memberLines.push(`  ${firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine}`);
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const hdr = member.body
          ? `${content.slice(member.getStart(sf), member.body.getStart(sf)).trim()} { /* ... */ }`
          : member.getText(sf).trim();
        memberLines.push(`  ${hdr}`);
      }
    }

    if (memberLines.length === 0) return `${header} }`;
    return `${header}\n${memberLines.join('\n')}\n}`;
  }

  // Walk top-level statements for imports, symbols, and skeleton
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const names: string[] = [];
      const clause = stmt.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            names.push(el.name.text);
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(`* as ${clause.namedBindings.name.text}`);
        }
      }
      imports.push({
        specifier: stmt.moduleSpecifier.text,
        isTypeOnly: Boolean(clause?.isTypeOnly),
        names,
      });
      skeletonParts.push(stmt.getText(sf).trim());
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      imports.push({
        specifier: stmt.moduleSpecifier.text,
        isTypeOnly: stmt.isTypeOnly,
      });
      skeletonParts.push(stmt.getText(sf).trim());
      continue;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const sig = extractFunctionHeader(stmt);
      symbols.push({
        name: stmt.name.text,
        kind: 'function',
        exported: hasExportModifier(stmt),
        line: lineOf(sf, stmt.getStart(sf)),
        signature: compactWhitespace(sig),
      });
      skeletonParts.push(sig);
      continue;
    }

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const skel = extractClassSkeleton(stmt);
      const firstLine = skel.split('\n')[0];
      symbols.push({
        name: stmt.name.text,
        kind: 'class',
        exported: hasExportModifier(stmt),
        line: lineOf(sf, stmt.getStart(sf)),
        signature: compactWhitespace(firstLine),
      });
      skeletonParts.push(skel);
      continue;
    }

    if (ts.isInterfaceDeclaration(stmt)) {
      const text = stmt.getText(sf).trim();
      symbols.push({
        name: stmt.name.text,
        kind: 'interface',
        exported: hasExportModifier(stmt),
        line: lineOf(sf, stmt.getStart(sf)),
        signature: compactWhitespace(text.split('\n')[0]),
      });
      skeletonParts.push(text);
      continue;
    }

    if (ts.isTypeAliasDeclaration(stmt)) {
      const text = stmt.getText(sf).trim();
      symbols.push({
        name: stmt.name.text,
        kind: 'type',
        exported: hasExportModifier(stmt),
        line: lineOf(sf, stmt.getStart(sf)),
        signature: compactWhitespace(text),
      });
      skeletonParts.push(text);
      continue;
    }

    if (ts.isEnumDeclaration(stmt)) {
      const text = stmt.getText(sf).trim();
      symbols.push({
        name: stmt.name.text,
        kind: 'enum',
        exported: hasExportModifier(stmt),
        line: lineOf(sf, stmt.getStart(sf)),
        signature: compactWhitespace(text.split('\n')[0]),
      });
      skeletonParts.push(text);
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));

        let sigText: string;
        if (isFn && ts.isBlock(init.body)) {
          const prefix = content.slice(stmt.getStart(sf), init.body.getStart(sf)).trim();
          sigText = `${prefix} { /* ... */ }`;
        } else {
          const raw = stmt.getText(sf).trim();
          sigText = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
        }

        symbols.push({
          name: decl.name.text,
          kind: isFn ? 'function' : 'variable',
          exported,
          line: lineOf(sf, decl.getStart(sf)),
          signature: compactWhitespace(sigText),
        });

        if (exported || isFn) {
          skeletonParts.push(sigText);
        }
      }
    }
  }

  // Also detect dynamic `import('...')` and CommonJS `require('...')`
  function visitDynamicImports(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const firstArg = node.arguments[0];
      if (ts.isStringLiteral(firstArg)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({ specifier: firstArg.text, isDynamic: true });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          imports.push({ specifier: firstArg.text, isDynamic: false });
        }
      }
    }
    ts.forEachChild(node, visitDynamicImports);
  }
  visitDynamicImports(sf);

  const skeleton = skeletonParts.join('\n\n').trim() || content.split('\n').slice(0, 15).join('\n');
  return { imports, symbols, skeleton };
}
