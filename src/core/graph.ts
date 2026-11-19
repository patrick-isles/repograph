import fs from 'node:fs';
import path from 'node:path';
import type {
  BlastRadiusResult,
  FileNode,
  GraphEdge,
  ImportSpec,
  RepoGraph,
  RepoStats,
} from './types.js';
import { scanRepository, toPosixPath } from './scanner.js';
import { parseFile } from './parsers/index.js';
import { estimateTokens } from './tokens.js';

interface TsConfigPaths {
  baseUrl?: string;
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function loadTsConfigPaths(rootDir: string): TsConfigPaths {
  const result: TsConfigPaths = { paths: [] };
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return result;

  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    // Strip single-line and multi-line comments for loose JSONC parsing
    const cleaned = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(cleaned);
    const opts = parsed?.compilerOptions;
    if (opts?.baseUrl && typeof opts.baseUrl === 'string') {
      result.baseUrl = opts.baseUrl.replace(/^\.\//, '').replace(/\/$/, '');
    }
    if (opts?.paths && typeof opts.paths === 'object') {
      for (const [pattern, targetList] of Object.entries(opts.paths)) {
        if (!Array.isArray(targetList)) continue;
        const starIdx = pattern.indexOf('*');
        const prefix = starIdx === -1 ? pattern : pattern.slice(0, starIdx);
        const suffix = starIdx === -1 ? '' : pattern.slice(starIdx + 1);
        result.paths.push({
          prefix,
          suffix,
          targets: targetList.filter((t): t is string => typeof t === 'string'),
        });
      }
    }
  } catch {
    // Ignore malformed tsconfig
  }
  return result;
}

function tryResolveTsCandidate(candidateNoExt: string, fileSet: Set<string>): string | null {
  const normalized = toPosixPath(path.posix.normalize(candidateNoExt)).replace(/^\.\//, '');
  if (fileSet.has(normalized)) return normalized;

  // Handle TypeScript ESM convention: import './foo.js' -> './foo.ts'
  const strippedJs = normalized.replace(/\.(mjs|cjs|jsx|js)$/, '');
  for (const ext of TS_EXTENSIONS) {
    if (fileSet.has(strippedJs + ext)) return strippedJs + ext;
  }
  for (const ext of TS_EXTENSIONS) {
    if (fileSet.has(`${normalized}/index${ext}`)) return `${normalized}/index${ext}`;
  }
  return null;
}

function resolveImport(
  fromFile: FileNode,
  imp: ImportSpec,
  fileSet: Set<string>,
  tsPaths: TsConfigPaths,
): string | null {
  const spec = imp.specifier;
  const fromDir = path.posix.dirname(fromFile.id);

  if (fromFile.language === 'typescript' || fromFile.language === 'javascript') {
    if (spec.startsWith('.')) {
      const joined = path.posix.join(fromDir, spec);
      return tryResolveTsCandidate(joined, fileSet);
    }

    // Check tsconfig paths aliases (e.g. @/components/Button)
    for (const rule of tsPaths.paths) {
      if (spec.startsWith(rule.prefix) && spec.endsWith(rule.suffix)) {
        const wildcard = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
        for (const target of rule.targets) {
          const mapped = target.replace('*', wildcard);
          const candidate = tsPaths.baseUrl ? path.posix.join(tsPaths.baseUrl, mapped) : mapped;
          const resolved = tryResolveTsCandidate(candidate, fileSet);
          if (resolved) return resolved;
        }
      }
    }

    if (tsPaths.baseUrl) {
      const resolved = tryResolveTsCandidate(path.posix.join(tsPaths.baseUrl, spec), fileSet);
      if (resolved) return resolved;
    }

    return null;
  }

  if (fromFile.language === 'python') {
    if (spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)?.[0].length ?? 1;
      const rest = spec.slice(dots).replace(/\./g, '/');
      let base = fromDir;
      for (let i = 1; i < dots; i++) {
        base = path.posix.dirname(base);
      }
      const candidate = rest ? path.posix.join(base, rest) : base;
      if (fileSet.has(`${candidate}.py`)) return `${candidate}.py`;
      if (fileSet.has(`${candidate}/__init__.py`)) return `${candidate}/__init__.py`;
      return null;
    }
    const asPath = spec.replace(/\./g, '/');
    if (fileSet.has(`${asPath}.py`)) return `${asPath}.py`;
    if (fileSet.has(`${asPath}/__init__.py`)) return `${asPath}/__init__.py`;
    if (fileSet.has(`src/${asPath}.py`)) return `src/${asPath}.py`;
    if (fileSet.has(`src/${asPath}/__init__.py`)) return `src/${asPath}/__init__.py`;
    return null;
  }

  if (fromFile.language === 'rust') {
    if (spec.startsWith('mod::')) {
      const modName = spec.slice(5);
      const c1 = path.posix.join(fromDir, `${modName}.rs`);
      const c2 = path.posix.join(fromDir, `${modName}/mod.rs`);
      if (fileSet.has(c1)) return c1;
      if (fileSet.has(c2)) return c2;
      return null;
    }
    if (spec.startsWith('crate::')) {
      const parts = spec.slice(7).split('::')[0];
      const c1 = `src/${parts}.rs`;
      const c2 = `src/${parts}/mod.rs`;
      if (fileSet.has(c1)) return c1;
      if (fileSet.has(c2)) return c2;
    }
    return null;
  }

  if (fromFile.language === 'go') {
    // Match suffix against local repo directories
    const parts = spec.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      for (const f of fileSet) {
        if (f.endsWith('.go') && path.posix.dirname(f) === suffix && f !== fromFile.id) {
          return f;
        }
      }
    }
    return null;
  }

  return null;
}

/**
 * Iterative PageRank over the dependency graph.
 * Files imported by many important files receive the highest PageRank.
 * Scores are normalized to a 0..100 scale for human readability.
 */
function computePageRank(nodes: Map<string, FileNode>, iterations = 30, damping = 0.85): void {
  const ids = Array.from(nodes.keys());
  const n = ids.length;
  if (n === 0) return;

  let ranks = new Map<string, number>();
  for (const id of ids) ranks.set(id, 1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    let danglingSum = 0;

    for (const id of ids) {
      const node = nodes.get(id)!;
      if (node.dependencies.length === 0) {
        danglingSum += ranks.get(id)!;
      }
    }

    const base = (1 - damping) / n + (damping * danglingSum) / n;
    for (const id of ids) next.set(id, base);

    for (const id of ids) {
      const node = nodes.get(id)!;
      if (node.dependencies.length === 0) continue;
      const share = (damping * ranks.get(id)!) / node.dependencies.length;
      for (const dep of node.dependencies) {
        next.set(dep, (next.get(dep) ?? base) + share);
      }
    }

    ranks = next;
  }

  const maxRank = Math.max(...ranks.values(), 1e-9);
  for (const id of ids) {
    const node = nodes.get(id)!;
    node.pageRank = Math.round(((ranks.get(id)! / maxRank) * 100) * 10) / 10;
  }
}

/**
 * Tarjan's Strongly Connected Components (SCC) algorithm.
 * Returns all cycles (SCCs with size > 1, or self-loops).
 */
function detectCycles(nodes: Map<string, FileNode>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const node = nodes.get(v)!;
    for (const w of node.dependencies) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      if (component.length > 1) {
        cycles.push(component.reverse());
      } else if (component.length === 1 && node.dependencies.includes(v)) {
        cycles.push(component);
      }
    }
  }

  for (const id of nodes.keys()) {
    if (!indices.has(id)) strongConnect(id);
  }

  for (const cycle of cycles) {
    for (const id of cycle) {
      const node = nodes.get(id);
      if (node) node.inCycle = true;
    }
  }

  return cycles;
}

export function buildRepoGraph(rootDir: string): RepoGraph {
  const absRoot = path.resolve(rootDir);
  const scanned = scanRepository(absRoot);
  const tsPaths = loadTsConfigPaths(absRoot);

  const nodes = new Map<string, FileNode>();
  const fileSet = new Set<string>();

  for (const file of scanned) {
    fileSet.add(file.id);
    const parsed = parseFile(file.id, file.language, file.content);
    nodes.set(file.id, {
      id: file.id,
      absPath: file.absPath,
      language: file.language,
      group: file.group,
      lines: file.lines,
      bytes: file.bytes,
      tokens: estimateTokens(file.content),
      skeletonTokens: estimateTokens(parsed.skeleton),
      content: file.content,
      skeleton: parsed.skeleton,
      imports: parsed.imports,
      symbols: parsed.symbols,
      dependencies: [],
      dependents: [],
      pageRank: 0,
      inDegree: 0,
      outDegree: 0,
      inCycle: false,
    });
  }

  const edges: GraphEdge[] = [];
  const edgeDedup = new Set<string>();

  for (const node of nodes.values()) {
    const depSet = new Set<string>();
    for (const imp of node.imports) {
      const target = resolveImport(node, imp, fileSet, tsPaths);
      if (!target || target === node.id) continue;
      depSet.add(target);

      const key = `${node.id}->${target}`;
      if (!edgeDedup.has(key)) {
        edgeDedup.add(key);
        edges.push({ source: node.id, target, isTypeOnly: imp.isTypeOnly });
      }
    }
    node.dependencies = Array.from(depSet).sort();
    node.outDegree = node.dependencies.length;
  }

  for (const edge of edges) {
    const targetNode = nodes.get(edge.target);
    if (targetNode) {
      targetNode.dependents.push(edge.source);
    }
  }

  for (const node of nodes.values()) {
    node.dependents.sort();
    node.inDegree = node.dependents.length;
  }

  computePageRank(nodes);
  const cycles = detectCycles(nodes);

  const languages: Record<string, number> = {};
  let totalLines = 0;
  let totalTokens = 0;
  let totalSkeletonTokens = 0;

  for (const node of nodes.values()) {
    languages[node.language] = (languages[node.language] ?? 0) + 1;
    totalLines += node.lines;
    totalTokens += node.tokens;
    totalSkeletonTokens += node.skeletonTokens;
  }

  const stats: RepoStats = {
    totalFiles: nodes.size,
    totalEdges: edges.length,
    totalLines,
    totalTokens,
    totalSkeletonTokens,
    cycleCount: cycles.length,
    languages,
  };

  return {
    rootDir: absRoot,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    cycles,
    stats,
  };
}

/**
 * Computes the direct and transitive blast radius (dependents & dependencies)
 * for a given file path (supports exact or partial suffix matching).
 */
export function computeBlastRadius(graph: RepoGraph, fileQuery: string): BlastRadiusResult {
  const normalizedQuery = toPosixPath(fileQuery).replace(/^\.\//, '');
  let targetNode = graph.nodes.get(normalizedQuery);

  if (!targetNode) {
    for (const node of graph.nodes.values()) {
      if (node.id.endsWith(normalizedQuery) || node.id.includes(normalizedQuery)) {
        targetNode = node;
        break;
      }
    }
  }

  if (!targetNode) {
    throw new Error(`File not found in graph: "${fileQuery}"`);
  }

  function bfs(start: string, getNeighbors: (n: FileNode) => string[]): string[] {
    const visited = new Set<string>([start]);
    const queue = [start];
    const order: string[] = [];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const node = graph.nodes.get(curr);
      if (!node) continue;
      for (const next of getNeighbors(node)) {
        if (!visited.has(next)) {
          visited.add(next);
          order.push(next);
          queue.push(next);
        }
      }
    }
    return order;
  }

  const transitiveDependents = bfs(targetNode.id, (n) => n.dependents);
  const transitiveDependencies = bfs(targetNode.id, (n) => n.dependencies);
  const impactScore =
    graph.nodes.size > 1
      ? Math.round((transitiveDependents.length / (graph.nodes.size - 1)) * 1000) / 10
      : 0;

  return {
    target: targetNode.id,
    directDependents: [...targetNode.dependents],
    transitiveDependents,
    directDependencies: [...targetNode.dependencies],
    transitiveDependencies,
    impactScore,
  };
}
