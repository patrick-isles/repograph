export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'other';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'struct'
  | 'trait'
  | 'method';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  line: number;
  signature: string;
}

export interface ImportSpec {
  specifier: string;
  isTypeOnly?: boolean;
  isDynamic?: boolean;
  names?: string[];
}

export interface ParsedFile {
  imports: ImportSpec[];
  symbols: SymbolInfo[];
  skeleton: string;
}

export interface FileNode {
  /** Posix-normalized path relative to repo root */
  id: string;
  /** Absolute path on disk */
  absPath: string;
  language: Language;
  /** Top-level module/directory bucket for clustering & coloring */
  group: string;
  lines: number;
  bytes: number;
  tokens: number;
  skeletonTokens: number;
  content: string;
  skeleton: string;
  imports: ImportSpec[];
  symbols: SymbolInfo[];
  /** Resolved internal file IDs this file imports */
  dependencies: string[];
  /** Resolved internal file IDs that import this file */
  dependents: string[];
  /** Normalized PageRank score (0..100 scale) */
  pageRank: number;
  inDegree: number;
  outDegree: number;
  inCycle: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  isTypeOnly?: boolean;
}

export interface RepoStats {
  totalFiles: number;
  totalEdges: number;
  totalLines: number;
  totalTokens: number;
  totalSkeletonTokens: number;
  cycleCount: number;
  languages: Record<string, number>;
}

export interface RepoGraph {
  rootDir: string;
  generatedAt: string;
  nodes: Map<string, FileNode>;
  edges: GraphEdge[];
  cycles: string[][];
  stats: RepoStats;
}

export type PackFormat = 'xml' | 'markdown';

export interface PackOptions {
  query: string;
  budget?: number;
  format?: PackFormat;
  includeMap?: boolean;
  maxFullFiles?: number;
}

export type PackTier = 'full' | 'skeleton';

export interface PackedFile {
  id: string;
  tier: PackTier;
  score: number;
  reason: string;
  tokens: number;
  originalTokens: number;
  content: string;
}

export interface PackResult {
  query: string;
  budget: number;
  usedTokens: number;
  totalRepoTokens: number;
  savingsPercent: number;
  files: PackedFile[];
  output: string;
}

export interface BlastRadiusResult {
  target: string;
  directDependents: string[];
  transitiveDependents: string[];
  directDependencies: string[];
  transitiveDependencies: string[];
  impactScore: number;
}
