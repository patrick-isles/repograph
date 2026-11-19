import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { Language } from './types.js';

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  'vendor',
  '.idea',
  '.vscode',
]);

const MAX_FILE_BYTES = 512 * 1024; // Skip generated/minified bundles > 512KB

const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
};

export interface ScannedFile {
  id: string;
  absPath: string;
  language: Language;
  group: string;
  content: string;
  bytes: number;
  lines: number;
}

export function detectLanguage(filePath: string): Language | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function loadGitignore(rootDir: string): Ignore {
  const ig = ignore();
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      ig.add(content);
    } catch {
      // Ignore unreadable .gitignore
    }
  }
  // Common minified/lockfile exclusions
  ig.add(['*.min.js', '*.min.css', '*.d.ts', '*.map', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
  return ig;
}

function computeGroup(relPosixPath: string): string {
  const parts = relPosixPath.split('/');
  if (parts.length === 1) return '(root)';
  if ((parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'packages' || parts[0] === 'app') && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

export function scanRepository(rootDir: string): ScannedFile[] {
  const absRoot = path.resolve(rootDir);
  const ig = loadGitignore(absRoot);
  const results: ScannedFile[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absPath = path.join(currentDir, entry.name);
      const relPosix = toPosixPath(path.relative(absRoot, absPath));

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        if (ig.ignores(`${relPosix}/`)) continue;
        walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (ig.ignores(relPosix)) continue;

      const language = detectLanguage(entry.name);
      if (!language) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }

      if (stat.size > MAX_FILE_BYTES) continue;

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      // Skip binary-looking files
      if (content.includes('\0')) continue;

      const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      results.push({
        id: relPosix,
        absPath,
        language,
        group: computeGroup(relPosix),
        content,
        bytes: stat.size,
        lines,
      });
    }
  }

  walk(absRoot);
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}
