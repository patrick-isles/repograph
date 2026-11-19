# repograph

**AST-powered codebase dependency graph, token-optimal context packer, interactive architecture explorer, and MCP server for AI coding agents.**

Stop stuffing entire repositories into your LLM context window—or manually grepping for the 6 files that actually matter. `repograph` parses your repo's AST, computes PageRank centrality and Tarjan circular dependencies, and packs the exact **full + AST-skeleton** context slice for any task under a strict token budget.

---

## Why `repograph`?

- **Graph-Aware Context Packing (`repograph pack`)** — Combines **BM25** lexical search (with camelCase/snake_case identifier splitting) and **2-hop personalized graph propagation** over imports & callers. Top-ranked files are packed verbatim (**Tier 1: Full**), while neighboring files are compressed into **AST-stripped skeletons** (**Tier 2: Signatures & Types only**) — typically cutting token usage by **60–85%** without losing type or API context.
- **Interactive Architecture Explorer (`repograph viz`)** — Generates a zero-dependency, self-contained HTML force-directed graph with PageRank node sizing, circular dependency halos, click-to-inspect **Blast Radius**, live **AST Skeleton** inspection, and an **in-browser Context Budget Simulator**.
- **First-Class MCP Server (`repograph mcp`)** — Drop-in stdio Model Context Protocol server so Claude Desktop, Cursor, Windsurf, and other coding agents can query `get_repo_map`, `pack_context`, `get_blast_radius`, `get_file_skeleton`, and `find_cycles` on demand.
- **Polyglot & Zero-Config** — Exact TypeScript Compiler API AST parsing for `.ts/.tsx/.js/.jsx` (including `tsconfig.json` path aliases), plus structural parsers & skeletonizers for **Python**, **Rust**, and **Go**. Respects `.gitignore` automatically.

---

## Quickstart

```bash
# Run directly with npx
npx repograph map .

# Pack the optimal 16k-token context slice for a task and copy to clipboard
npx repograph pack "fix auth token refresh race condition" --budget 16000 | pbcopy

# Check what breaks if you refactor a core file
npx repograph impact src/core/graph.ts

# Launch the interactive visual architecture explorer
npx repograph viz --serve
```

Or install globally:

```bash
npm install -g repograph
```

---

## CLI Reference

| Command | Description |
| :--- | :--- |
| `repograph map [dir]` | Print architectural overview: PageRank hubs, module stats, token footprint, and circular dependencies. Supports `--top <n>` and `--json`. |
| `repograph pack "<query>" [dir]` | Pack the token-optimal context slice for a natural-language task. Supports `--budget <tokens>`, `--format xml\|markdown`, `--out <file>`, `--no-map`. Diagnostics go to `stderr` so `stdout` is cleanly pipeable. |
| `repograph impact <file> [dir]` | Compute direct & transitive blast radius (all callers/dependents and dependencies) of a file. Supports `--json`. |
| `repograph viz [dir]` | Generate a self-contained interactive HTML force-directed graph (`--out repograph.html`) or serve it locally (`--serve --port 4173`). |
| `repograph mcp [dir]` | Start the stdio MCP server exposing your repository to AI coding agents. |

---

## MCP Server Setup

Add `repograph` to your MCP client config (e.g., Claude Desktop, Cursor, Windsurf, or Antigravity):

```json
{
  "mcpServers": {
    "repograph": {
      "command": "npx",
      "args": ["-y", "repograph", "mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

### Exposed MCP Tools

| Tool | What it gives your agent |
| :--- | :--- |
| `get_repo_map` | Top PageRank architectural hubs, token counts, and circular dependencies. |
| `pack_context` | Token-optimal tiered context (`full` + `skeleton`) for a given `task` and `budget`. |
| `get_blast_radius` | Direct & transitive dependents (callers) and dependencies of a file before editing. |
| `get_file_skeleton` | AST-stripped public API signatures & types of a file (~10–20% of full token cost). |
| `find_cycles` | All circular dependency chains detected via Tarjan's SCC algorithm. |

---

## Programmatic API

```ts
import { buildRepoGraph, packContext, computeBlastRadius } from 'repograph';

const graph = buildRepoGraph('./my-project');

const pack = packContext(graph, {
  query: 'add rate limiting middleware',
  budget: 16_000,
  format: 'xml',
});

console.log(`Packed ${pack.files.length} files in ~${pack.usedTokens} tokens (-${pack.savingsPercent}%)`);

const impact = computeBlastRadius(graph, 'src/auth/session.ts');
console.log(`Blast radius: ${impact.transitiveDependents.length} dependent files`);
```

---

## How It Works

```text
  Source Files (.ts/.js/.py/.rs/.go)
         │
         ▼
  ┌───────────────────┐     ┌──────────────────────────────────┐
  │ AST & Structural  │────▶│ Directed Dependency Graph G(V,E) │
  │ Parsers +         │     │  • PageRank Centrality           │
  │ Skeletonizer      │     │  • Tarjan SCC Cycle Detection    │
  └───────────────────┘     │  • Transitive Blast Radius       │
                            └───────────────┬──────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
   ┌────────────────────┐      ┌─────────────────────────┐     ┌────────────────────┐
   │ Tiered Context     │      │ Interactive Canvas UI   │     │ stdio MCP Server   │
   │ Packer (BM25 +     │      │ Force-Directed Graph +  │     │ 5 Agent Tools      │
   │ 2-Hop Propagation) │      │ Live Budget Simulator   │     │                    │
   └────────────────────┘      └─────────────────────────┘     └────────────────────┘
```

---

## Development

```bash
git clone https://github.com/patrick-isles/repograph.git
cd repograph
npm install
npm test
npm run build
```

## License

[MIT](./LICENSE)
