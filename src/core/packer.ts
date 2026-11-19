import type {
  PackOptions,
  PackResult,
  PackedFile,
  RepoGraph,
} from './types.js';
import { estimateTokens, formatTokens, tokenizeIdentifierText } from './tokens.js';

interface ScoredNode {
  id: string;
  lexicalScore: number;
  propagatedScore: number;
  finalScore: number;
  reason: string;
}

/**
 * Generates a compact architectural summary of the repository
 * (top hubs by PageRank, module clusters, and circular dependencies).
 */
export function formatRepoMap(graph: RepoGraph, topN = 15): string {
  const sorted = Array.from(graph.nodes.values()).sort((a, b) => b.pageRank - a.pageRank);
  const topFiles = sorted.slice(0, topN);

  const lines: string[] = [
    `Repository: ${graph.rootDir}`,
    `Files: ${graph.stats.totalFiles} | Edges: ${graph.stats.totalEdges} | Lines: ${graph.stats.totalLines.toLocaleString()} | Tokens: ~${formatTokens(graph.stats.totalTokens)} (skeletons: ~${formatTokens(graph.stats.totalSkeletonTokens)})`,
    '',
    `Top Architectural Hubs (by PageRank):`,
  ];

  for (const node of topFiles) {
    const exportedNames = node.symbols
      .filter((s) => s.exported)
      .slice(0, 5)
      .map((s) => s.name);
    const symHint = exportedNames.length > 0 ? ` — exports: ${exportedNames.join(', ')}` : '';
    const cycleTag = node.inCycle ? ' [CYCLE]' : '';
    lines.push(
      `  • ${node.id} (PR: ${node.pageRank.toFixed(1)}, in:${node.inDegree} out:${node.outDegree}, ~${formatTokens(node.tokens)} tok)${cycleTag}${symHint}`,
    );
  }

  if (graph.cycles.length > 0) {
    lines.push('', `Circular Dependencies (${graph.cycles.length}):`);
    for (const cycle of graph.cycles.slice(0, 5)) {
      lines.push(`  ↻ ${cycle.join(' -> ')} -> ${cycle[0]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Scores all files using BM25 over paths + symbols + source code,
 * then propagates relevance along dependency & dependent edges (2-hop graph diffusion).
 */
export function rankNodesForQuery(graph: RepoGraph, query: string): ScoredNode[] {
  const queryTerms = Array.from(new Set(tokenizeIdentifierText(query)));
  const nodes = Array.from(graph.nodes.values());
  const N = nodes.length;
  if (N === 0) return [];

  // Build weighted term frequencies per document
  const docTermFreq = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  const docFreq = new Map<string, number>();

  for (const node of nodes) {
    const tf = new Map<string, number>();
    const addTerms = (terms: string[], weight: number) => {
      for (const t of terms) {
        tf.set(t, (tf.get(t) ?? 0) + weight);
      }
    };

    // File path & exported symbols carry strong structural signal
    addTerms(tokenizeIdentifierText(node.id), 4.0);
    addTerms(
      tokenizeIdentifierText(node.symbols.map((s) => s.name).join(' ')),
      3.0,
    );
    addTerms(tokenizeIdentifierText(node.content.slice(0, 24_000)), 1.0);

    docTermFreq.set(node.id, tf);
    let len = 0;
    for (const v of tf.values()) len += v;
    docLengths.set(node.id, len);

    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const avgDocLen =
    Array.from(docLengths.values()).reduce((a, b) => a + b, 0) / Math.max(1, N);

  const k1 = 1.5;
  const b = 0.75;
  const lexicalScores = new Map<string, number>();

  for (const node of nodes) {
    const tfMap = docTermFreq.get(node.id)!;
    const dl = docLengths.get(node.id) ?? 1;
    let score = 0;

    for (const term of queryTerms) {
      const tf = tfMap.get(term) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / Math.max(1, avgDocLen)))));
    }

    // Exact path substring bonus
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.includes(node.id.toLowerCase())) {
      score += 12;
    }

    lexicalScores.set(node.id, score);
  }

  // 2-hop graph propagation (personalized diffusion)
  // Forward imports (dependencies) carry 0.45 weight; callers (dependents) carry 0.30 weight.
  const prop1 = new Map<string, number>();
  for (const node of nodes) {
    const base = lexicalScores.get(node.id) ?? 0;
    if (base <= 0) continue;
    for (const dep of node.dependencies) {
      prop1.set(dep, (prop1.get(dep) ?? 0) + base * 0.45);
    }
    for (const caller of node.dependents) {
      prop1.set(caller, (prop1.get(caller) ?? 0) + base * 0.3);
    }
  }

  const prop2 = new Map<string, number>();
  for (const [id, score] of prop1.entries()) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    for (const dep of node.dependencies) {
      prop2.set(dep, (prop2.get(dep) ?? 0) + score * 0.25);
    }
    for (const caller of node.dependents) {
      prop2.set(caller, (prop2.get(caller) ?? 0) + score * 0.15);
    }
  }

  const ranked: ScoredNode[] = nodes.map((node) => {
    const lex = lexicalScores.get(node.id) ?? 0;
    const prop = (prop1.get(node.id) ?? 0) + (prop2.get(node.id) ?? 0);
    // Gentle PageRank prior breaks ties in favor of architectural hubs
    const prPrior = (node.pageRank / 100) * 0.8;
    const finalScore = lex + prop + prPrior;

    let reason = 'architectural hub';
    if (lex > 0 && prop > 0) reason = 'direct match + graph neighbor';
    else if (lex > 0) reason = 'direct query match';
    else if (prop > 0) reason = 'dependency graph neighbor';

    return {
      id: node.id,
      lexicalScore: Math.round(lex * 100) / 100,
      propagatedScore: Math.round(prop * 100) / 100,
      finalScore: Math.round(finalScore * 100) / 100,
      reason,
    };
  });

  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return ranked;
}

/**
 * Packs a token-optimal context window for a natural-language task:
 * - Tier 1 (full): Top-ranked files included verbatim
 * - Tier 2 (skeleton): Structurally relevant neighbor files included as AST-stripped signatures
 * - Tier 3 (map): Compact repository architecture header
 */
export function packContext(graph: RepoGraph, options: PackOptions): PackResult {
  const budget = Math.max(1000, options.budget ?? 32_000);
  const format = options.format ?? 'xml';
  const includeMap = options.includeMap ?? true;
  const maxFullFiles = options.maxFullFiles ?? 8;

  const ranked = rankNodesForQuery(graph, options.query);
  const mapText = includeMap ? formatRepoMap(graph, 12) : '';
  let usedTokens = includeMap ? estimateTokens(mapText) + 40 : 0;

  const packed: PackedFile[] = [];
  const fullBudgetCap = Math.floor(budget * 0.68);
  let fullCount = 0;

  // Pass 1: Allocate Tier 1 (full source) to top-scoring files
  const remaining: ScoredNode[] = [];
  for (const item of ranked) {
    const node = graph.nodes.get(item.id)!;
    const fitsFull =
      fullCount < maxFullFiles &&
      usedTokens + node.tokens <= fullBudgetCap &&
      (item.lexicalScore > 0 || fullCount < 3);

    if (fitsFull) {
      packed.push({
        id: node.id,
        tier: 'full',
        score: item.finalScore,
        reason: item.reason,
        tokens: node.tokens,
        originalTokens: node.tokens,
        content: node.content,
      });
      usedTokens += node.tokens;
      fullCount++;
    } else {
      remaining.push(item);
    }
  }

  // Pass 2: Allocate Tier 2 (AST skeleton) to graph neighbors & secondary matches
  for (const item of remaining) {
    const node = graph.nodes.get(item.id)!;
    if (usedTokens + node.skeletonTokens > budget) continue;

    // If a file is tiny and already fits full within remaining budget, prefer full for top matches
    if (node.tokens <= node.skeletonTokens + 40 && usedTokens + node.tokens <= budget) {
      packed.push({
        id: node.id,
        tier: 'full',
        score: item.finalScore,
        reason: item.reason,
        tokens: node.tokens,
        originalTokens: node.tokens,
        content: node.content,
      });
      usedTokens += node.tokens;
    } else {
      packed.push({
        id: node.id,
        tier: 'skeleton',
        score: item.finalScore,
        reason: item.reason,
        tokens: node.skeletonTokens,
        originalTokens: node.tokens,
        content: node.skeleton,
      });
      usedTokens += node.skeletonTokens;
    }
  }

  const totalRepoTokens = Math.max(1, graph.stats.totalTokens);
  const savingsPercent = Math.max(
    0,
    Math.round((1 - usedTokens / totalRepoTokens) * 1000) / 10,
  );

  const output =
    format === 'xml'
      ? renderXml(options.query, mapText, packed, usedTokens, budget)
      : renderMarkdown(options.query, mapText, packed, usedTokens, budget);

  return {
    query: options.query,
    budget,
    usedTokens,
    totalRepoTokens: graph.stats.totalTokens,
    savingsPercent,
    files: packed,
    output,
  };
}

function renderXml(
  query: string,
  mapText: string,
  files: PackedFile[],
  usedTokens: number,
  budget: number,
): string {
  const parts: string[] = [
    `<repograph_context query="${escapeXmlAttr(query)}" tokens="${usedTokens}" budget="${budget}">`,
  ];

  if (mapText) {
    parts.push(`  <repo_map>\n${mapText}\n  </repo_map>`);
  }

  for (const f of files) {
    parts.push(
      `  <file path="${escapeXmlAttr(f.id)}" tier="${f.tier}" score="${f.score}" tokens="${f.tokens}" reason="${escapeXmlAttr(f.reason)}">\n${f.content}\n  </file>`,
    );
  }

  parts.push('</repograph_context>');
  return parts.join('\n');
}

function renderMarkdown(
  query: string,
  mapText: string,
  files: PackedFile[],
  usedTokens: number,
  budget: number,
): string {
  const parts: string[] = [
    `# RepoGraph Context`,
    `> **Query:** ${query} | **Tokens:** ~${formatTokens(usedTokens)} / ${formatTokens(budget)}`,
    '',
  ];

  if (mapText) {
    parts.push('## Repository Map', '```text', mapText, '```', '');
  }

  for (const f of files) {
    const ext = f.id.split('.').pop() ?? '';
    parts.push(
      `## \`${f.id}\` (${f.tier}, ~${formatTokens(f.tokens)} tok — ${f.reason})`,
      `\`\`\`${ext}`,
      f.content,
      '```',
      '',
    );
  }

  return parts.join('\n');
}

function escapeXmlAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
