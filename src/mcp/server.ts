import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildRepoGraph, computeBlastRadius } from '../core/graph.js';
import { formatRepoMap, packContext } from '../core/packer.js';
import { toPosixPath } from '../core/scanner.js';
import type { RepoGraph } from '../core/types.js';

export async function startMcpServer(rootDir: string): Promise<void> {
  let cachedGraph: RepoGraph | null = null;

  function getGraph(refresh = false): RepoGraph {
    if (!cachedGraph || refresh) {
      cachedGraph = buildRepoGraph(rootDir);
    }
    return cachedGraph;
  }

  const server = new McpServer({
    name: 'repograph',
    version: '0.1.0',
  });

  server.tool(
    'get_repo_map',
    'Get an architectural overview of the repository: top hubs ranked by PageRank, file/token counts, language breakdown, and circular dependencies.',
    {
      topN: z.number().int().min(1).max(50).optional().describe('Number of top PageRank hubs to list (default 15)'),
      refresh: z.boolean().optional().describe('Force re-indexing the repository from disk'),
    },
    async ({ topN, refresh }) => {
      const graph = getGraph(refresh);
      return {
        content: [{ type: 'text', text: formatRepoMap(graph, topN ?? 15) }],
      };
    },
  );

  server.tool(
    'pack_context',
    'Pack the token-optimal codebase context slice for a natural-language task using BM25 + dependency graph propagation + AST skeleton compression.',
    {
      task: z.string().min(1).describe('Natural-language description of the bug, feature, or question'),
      budget: z.number().int().min(1000).max(200000).optional().describe('Max token budget (default 24000)'),
      format: z.enum(['xml', 'markdown']).optional().describe('Output format (default xml)'),
      refresh: z.boolean().optional().describe('Force re-indexing the repository from disk'),
    },
    async ({ task, budget, format, refresh }) => {
      const graph = getGraph(refresh);
      const result = packContext(graph, {
        query: task,
        budget: budget ?? 24_000,
        format: format ?? 'xml',
      });
      return {
        content: [{ type: 'text', text: result.output }],
      };
    },
  );

  server.tool(
    'get_blast_radius',
    'Compute the direct and transitive blast radius (all callers/dependents and dependencies) of modifying a specific file.',
    {
      file: z.string().min(1).describe('Relative path (or suffix) of the file to inspect'),
      refresh: z.boolean().optional().describe('Force re-indexing the repository from disk'),
    },
    async ({ file, refresh }) => {
      const graph = getGraph(refresh);
      const impact = computeBlastRadius(graph, file);
      return {
        content: [{ type: 'text', text: JSON.stringify(impact, null, 2) }],
      };
    },
  );

  server.tool(
    'get_file_skeleton',
    'Return the AST-stripped public API skeleton (imports, types, interfaces, function/class signatures) of a file without implementation bodies.',
    {
      file: z.string().min(1).describe('Relative path (or suffix) of the file'),
      refresh: z.boolean().optional().describe('Force re-indexing the repository from disk'),
    },
    async ({ file, refresh }) => {
      const graph = getGraph(refresh);
      const norm = toPosixPath(file).replace(/^\.\//, '');
      const node =
        graph.nodes.get(norm) ??
        Array.from(graph.nodes.values()).find((n) => n.id.endsWith(norm) || n.id.includes(norm));

      if (!node) {
        return {
          isError: true,
          content: [{ type: 'text', text: `File not found in graph: "${file}"` }],
        };
      }

      const header = `// ${node.id} (skeleton: ~${node.skeletonTokens} tok vs full: ~${node.tokens} tok, PageRank: ${node.pageRank})\n\n`;
      return {
        content: [{ type: 'text', text: header + node.skeleton }],
      };
    },
  );

  server.tool(
    'find_cycles',
    'Detect all circular dependency chains (Tarjan strongly connected components) in the repository.',
    {
      refresh: z.boolean().optional().describe('Force re-indexing the repository from disk'),
    },
    async ({ refresh }) => {
      const graph = getGraph(refresh);
      if (graph.cycles.length === 0) {
        return {
          content: [{ type: 'text', text: 'No circular dependencies detected.' }],
        };
      }
      const lines = graph.cycles.map((c, idx) => `${idx + 1}. ${c.join(' -> ')} -> ${c[0]}`);
      return {
        content: [{ type: 'text', text: `Found ${graph.cycles.length} circular dependency group(s):\n${lines.join('\n')}` }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
