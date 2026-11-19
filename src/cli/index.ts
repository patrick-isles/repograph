#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Command } from 'commander';
import { buildRepoGraph, computeBlastRadius } from '../core/graph.js';
import { formatRepoMap, packContext } from '../core/packer.js';
import { formatTokens } from '../core/tokens.js';
import type { PackFormat } from '../core/types.js';
import { renderInteractiveGraphHtml } from '../viz/template.js';
import { startMcpServer } from '../mcp/server.js';

const ansi = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const program = new Command();

program
  .name('repograph')
  .description(
    'AST-powered codebase dependency graph, token-optimal context packer, interactive explorer, and MCP server.',
  )
  .version('0.1.0');

program
  .command('map')
  .description('Print an architectural overview of a repository (PageRank hubs, tokens, cycles)')
  .argument('[dir]', 'Repository directory', '.')
  .option('-n, --top <number>', 'Number of top hubs to display', '15')
  .option('--json', 'Output raw graph summary as JSON')
  .action((dir: string, opts: { top: string; json?: boolean }) => {
    const t0 = performance.now();
    const graph = buildRepoGraph(dir);
    const ms = Math.round(performance.now() - t0);

    if (opts.json) {
      const topNodes = Array.from(graph.nodes.values())
        .sort((a, b) => b.pageRank - a.pageRank)
        .slice(0, Number(opts.top))
        .map(({ content: _c, skeleton: _s, ...rest }) => rest);
      console.log(JSON.stringify({ stats: graph.stats, cycles: graph.cycles, topNodes }, null, 2));
      return;
    }

    console.log('');
    console.log(ansi.bold(ansi.cyan('  repograph')) + ansi.dim(` — indexed in ${ms}ms`));
    console.log('');
    console.log(formatRepoMap(graph, Number(opts.top)));
    console.log('');
  });

program
  .command('pack')
  .description('Pack the token-optimal context slice (full + AST skeletons) for a natural-language task')
  .argument('<query>', 'Natural-language task, bug, or feature description')
  .argument('[dir]', 'Repository directory', '.')
  .option('-b, --budget <tokens>', 'Maximum token budget', '24000')
  .option('-f, --format <format>', 'Output format: xml or markdown', 'xml')
  .option('-o, --out <file>', 'Write packed context to a file instead of stdout')
  .option('--no-map', 'Omit the architectural repo map header')
  .action(
    (
      query: string,
      dir: string,
      opts: { budget: string; format: string; out?: string; map: boolean },
    ) => {
      const t0 = performance.now();
      const graph = buildRepoGraph(dir);
      const format: PackFormat = opts.format === 'markdown' || opts.format === 'md' ? 'markdown' : 'xml';
      const result = packContext(graph, {
        query,
        budget: Number(opts.budget),
        format,
        includeMap: opts.map,
      });
      const ms = Math.round(performance.now() - t0);

      const fullCount = result.files.filter((f) => f.tier === 'full').length;
      const skelCount = result.files.filter((f) => f.tier === 'skeleton').length;

      // Always write diagnostics to stderr so stdout stays cleanly pipeable
      console.error(
        ansi.cyan('repograph pack') +
          ansi.dim(` (${ms}ms) · `) +
          ansi.green(`${fullCount} full`) +
          ansi.dim(' + ') +
          ansi.magenta(`${skelCount} skeleton`) +
          ansi.dim(' · ') +
          ansi.bold(`~${formatTokens(result.usedTokens)}`) +
          ansi.dim(` / ${formatTokens(result.budget)} tok (`) +
          ansi.green(`-${result.savingsPercent}% vs full repo`) +
          ansi.dim(')'),
      );

      if (opts.out) {
        const outPath = path.resolve(opts.out);
        fs.writeFileSync(outPath, result.output, 'utf8');
        console.error(ansi.dim(`Wrote context pack -> ${outPath}`));
      } else {
        process.stdout.write(result.output + '\n');
      }
    },
  );

program
  .command('impact')
  .description('Show the blast radius (direct & transitive dependents and dependencies) of a file')
  .argument('<file>', 'Relative file path (or suffix) to analyze')
  .argument('[dir]', 'Repository directory', '.')
  .option('--json', 'Output as JSON')
  .action((file: string, dir: string, opts: { json?: boolean }) => {
    const graph = buildRepoGraph(dir);
    try {
      const impact = computeBlastRadius(graph, file);
      if (opts.json) {
        console.log(JSON.stringify(impact, null, 2));
        return;
      }

      console.log('');
      console.log(
        ansi.bold(ansi.cyan(`Blast Radius: ${impact.target}`)) +
          ansi.dim(` (affects ${impact.impactScore}% of repo)`),
      );
      console.log('');
      console.log(
        ansi.yellow(`▲ Dependents / Callers (${impact.transitiveDependents.length} transitive, ${impact.directDependents.length} direct):`),
      );
      if (impact.transitiveDependents.length === 0) {
        console.log(ansi.dim('  (none — safe entrypoint/leaf)'));
      } else {
        for (const dep of impact.transitiveDependents) {
          const isDirect = impact.directDependents.includes(dep);
          console.log(`  ${isDirect ? ansi.yellow('●') : ansi.dim('○')} ${dep}${isDirect ? ansi.dim(' (direct)') : ''}`);
        }
      }

      console.log('');
      console.log(
        ansi.cyan(`▼ Dependencies / Imports (${impact.transitiveDependencies.length} transitive, ${impact.directDependencies.length} direct):`),
      );
      if (impact.transitiveDependencies.length === 0) {
        console.log(ansi.dim('  (none — zero internal dependencies)'));
      } else {
        for (const dep of impact.transitiveDependencies) {
          const isDirect = impact.directDependencies.includes(dep);
          console.log(`  ${isDirect ? ansi.cyan('●') : ansi.dim('○')} ${dep}${isDirect ? ansi.dim(' (direct)') : ''}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(ansi.red((err as Error).message));
      process.exitCode = 1;
    }
  });

program
  .command('viz')
  .description('Generate an interactive force-directed HTML architecture graph & context simulator')
  .argument('[dir]', 'Repository directory', '.')
  .option('-o, --out <file>', 'Output HTML file path', 'repograph.html')
  .option('--serve', 'Serve the interactive graph over a local HTTP server')
  .option('-p, --port <port>', 'Port for --serve', '4173')
  .action((dir: string, opts: { out: string; serve?: boolean; port: string }) => {
    const t0 = performance.now();
    const graph = buildRepoGraph(dir);
    const html = renderInteractiveGraphHtml(graph);
    const ms = Math.round(performance.now() - t0);

    if (opts.serve) {
      const port = Number(opts.port);
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      server.listen(port, '127.0.0.1', () => {
        console.log(
          ansi.bold(ansi.cyan('repograph viz')) +
            ansi.dim(` (${graph.stats.totalFiles} files, ${graph.stats.totalEdges} edges, ${ms}ms)`),
        );
        console.log(ansi.green(`  ➜ Local: http://127.0.0.1:${port}`));
        console.log(ansi.dim('  Press Ctrl+C to stop.'));
      });
      return;
    }

    const outPath = path.resolve(opts.out);
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(
      ansi.bold(ansi.cyan('repograph viz')) +
        ansi.dim(` (${graph.stats.totalFiles} files, ${graph.stats.totalEdges} edges, ${ms}ms)`),
    );
    console.log(ansi.green(`  ➜ Wrote interactive graph: ${outPath}`));
  });

program
  .command('mcp')
  .description('Start the stdio MCP server for Claude Desktop, Cursor, Antigravity, and other agents')
  .argument('[dir]', 'Repository directory to expose', '.')
  .action(async (dir: string) => {
    await startMcpServer(path.resolve(dir));
  });

program.parse();
