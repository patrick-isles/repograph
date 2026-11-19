import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRepoGraph,
  computeBlastRadius,
  packContext,
  parseFile,
  renderInteractiveGraphHtml,
} from '../src/index.js';

let tmpDir: string;

function writeFixture(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repograph-test-'));

  writeFixture(
    'src/core/config.ts',
    `export interface AppConfig {
  port: number;
  jwtSecret: string;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3000);
  const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret';
  return { port, jwtSecret };
}
`,
  );

  writeFixture(
    'src/auth/token.ts',
    `import { loadConfig } from '../core/config.js';

export interface TokenPayload {
  userId: string;
  exp: number;
}

export function signToken(userId: string): string {
  const cfg = loadConfig();
  const payload = JSON.stringify({ userId, exp: Date.now() + 3600_000 });
  return Buffer.from(payload + ':' + cfg.jwtSecret).toString('base64');
}

export function verifyToken(token: string): TokenPayload | null {
  const cfg = loadConfig();
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  if (!decoded.endsWith(':' + cfg.jwtSecret)) return null;
  return JSON.parse(decoded.slice(0, -(cfg.jwtSecret.length + 1)));
}
`,
  );

  writeFixture(
    'src/api/server.ts',
    `import { loadConfig } from '../core/config.js';
import { verifyToken } from '../auth/token.js';

export class ApiServer {
  start(): void {
    const cfg = loadConfig();
    console.log('Listening on', cfg.port);
  }

  authenticate(header: string): boolean {
    return verifyToken(header) !== null;
  }
}
`,
  );

  // Intentional circular dependency between cycleA and cycleB
  writeFixture(
    'src/cycle/a.ts',
    `import { helperB } from './b.js';
export function helperA(): number {
  return helperB() + 1;
}
`,
  );

  writeFixture(
    'src/cycle/b.ts',
    `import { helperA } from './a.js';
export function helperB(): number {
  return typeof helperA === 'function' ? 1 : 0;
}
`,
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('repograph core engine', () => {
  it('builds a dependency graph with accurate edges, PageRank, and cycle detection', () => {
    const graph = buildRepoGraph(tmpDir);

    expect(graph.stats.totalFiles).toBe(5);
    expect(graph.stats.totalEdges).toBe(5);

    // config.ts is imported by both token.ts and server.ts -> highest PageRank
    const configNode = graph.nodes.get('src/core/config.ts')!;
    const serverNode = graph.nodes.get('src/api/server.ts')!;
    expect(configNode.inDegree).toBe(2);
    expect(configNode.pageRank).toBeGreaterThan(serverNode.pageRank);

    // Detects the A <-> B circular dependency
    expect(graph.cycles.length).toBe(1);
    expect(graph.cycles[0].sort()).toEqual(['src/cycle/a.ts', 'src/cycle/b.ts']);
    expect(graph.nodes.get('src/cycle/a.ts')!.inCycle).toBe(true);
    expect(graph.nodes.get('src/core/config.ts')!.inCycle).toBe(false);
  });

  it('computes direct and transitive blast radius', () => {
    const graph = buildRepoGraph(tmpDir);
    const impact = computeBlastRadius(graph, 'src/core/config.ts');

    expect(impact.target).toBe('src/core/config.ts');
    expect(impact.directDependents).toEqual(['src/api/server.ts', 'src/auth/token.ts']);
    expect(impact.transitiveDependents).toContain('src/api/server.ts');
    expect(impact.impactScore).toBeGreaterThan(0);
  });

  it('extracts AST skeletons that compress implementation bodies', () => {
    const source = `import { x } from './x';
export interface User { id: string; }
export function computeHeavy(u: User): number {
  let sum = 0;
  for (let i = 0; i < 1000; i++) {
    sum += i * u.id.length;
  }
  return sum;
}
`;
    const parsed = parseFile('demo.ts', 'typescript', source);
    expect(parsed.imports).toHaveLength(1);
    expect(parsed.symbols.map((s) => s.name)).toEqual(['User', 'computeHeavy']);
    expect(parsed.skeleton).toContain('export function computeHeavy(u: User): number { /* ... */ }');
    expect(parsed.skeleton).not.toContain('for (let i = 0');
  });

  it('parses Python, Rust, and Go files', () => {
    const py = parseFile(
      'app.py',
      'python',
      `from core.db import Session\nclass AuthService:\n    def login(self, user: str) -> bool:\n        return True\n`,
    );
    expect(py.imports[0].specifier).toBe('core.db');
    expect(py.symbols.map((s) => s.name)).toContain('AuthService');
    expect(py.symbols.map((s) => s.name)).toContain('login');

    const rs = parseFile(
      'lib.rs',
      'rust',
      `mod router;\nuse crate::config::Settings;\npub struct Engine {}\npub fn run() { println!("ok"); }\n`,
    );
    expect(rs.imports.map((i) => i.specifier)).toEqual(['mod::router', 'crate::config::Settings']);
    expect(rs.symbols.map((s) => s.name)).toEqual(['Engine', 'run']);

    const go = parseFile(
      'main.go',
      'go',
      `package main\nimport "myrepo/internal/auth"\ntype Server struct{}\nfunc StartServer() { }\n`,
    );
    expect(go.imports[0].specifier).toBe('myrepo/internal/auth');
    expect(go.symbols.map((s) => s.name)).toEqual(['Server', 'StartServer']);
  });

  it('packs token-optimal context using BM25 + graph propagation', () => {
    const graph = buildRepoGraph(tmpDir);
    const result = packContext(graph, {
      query: 'fix jwt token verification',
      budget: 8000,
      format: 'xml',
    });

    expect(result.usedTokens).toBeLessThanOrEqual(8000);
    expect(result.files[0].id).toBe('src/auth/token.ts');
    expect(result.files[0].tier).toBe('full');
    expect(result.output).toContain('<repograph_context');
    // Structural neighbor config.ts should also be pulled in
    expect(result.files.map((f) => f.id)).toContain('src/core/config.ts');
  });

  it('renders self-contained interactive HTML visualization', () => {
    const graph = buildRepoGraph(tmpDir);
    const html = renderInteractiveGraphHtml(graph);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('src/core/config.ts');
    expect(html).toContain('Simulate context pack');
  });
});
