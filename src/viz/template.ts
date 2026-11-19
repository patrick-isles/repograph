import path from 'node:path';
import type { RepoGraph } from '../core/types.js';

interface VizNodePayload {
  id: string;
  group: string;
  language: string;
  lines: number;
  tokens: number;
  skeletonTokens: number;
  pageRank: number;
  inDegree: number;
  outDegree: number;
  inCycle: boolean;
  dependencies: string[];
  dependents: string[];
  symbols: Array<{ name: string; kind: string; exported: boolean; line: number }>;
  skeleton: string;
}

export function renderInteractiveGraphHtml(graph: RepoGraph): string {
  const repoName = path.basename(graph.rootDir);

  const nodes: VizNodePayload[] = Array.from(graph.nodes.values()).map((n) => ({
    id: n.id,
    group: n.group,
    language: n.language,
    lines: n.lines,
    tokens: n.tokens,
    skeletonTokens: n.skeletonTokens,
    pageRank: n.pageRank,
    inDegree: n.inDegree,
    outDegree: n.outDegree,
    inCycle: n.inCycle,
    dependencies: n.dependencies,
    dependents: n.dependents,
    symbols: n.symbols.slice(0, 30).map((s) => ({
      name: s.name,
      kind: s.kind,
      exported: s.exported,
      line: s.line,
    })),
    skeleton: n.skeleton.slice(0, 4000),
  }));

  const payload = {
    repoName,
    generatedAt: graph.generatedAt,
    stats: graph.stats,
    cycles: graph.cycles,
    nodes,
    edges: graph.edges,
  };

  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>repograph — ${escapeHtml(repoName)}</title>
  <style>
    :root {
      --bg: #09090b;
      --panel: rgba(18, 18, 22, 0.86);
      --border: rgba(255, 255, 255, 0.09);
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #38bdf8;
      --emerald: #34d399;
      --amber: #fbbf24;
      --rose: #f43f5e;
      --violet: #a78bfa;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: var(--bg); color: var(--text);
      font-family: var(--sans); -webkit-font-smoothing: antialiased;
    }
    #canvas {
      display: block; width: 100vw; height: 100vh; cursor: grab;
      background-image: radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px);
      background-size: 24px 24px;
    }
    #canvas:active { cursor: grabbing; }

    .topbar {
      position: fixed; top: 14px; left: 14px; right: 14px; z-index: 20;
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 10px 14px; border-radius: 12px;
      background: var(--panel); border: 1px solid var(--border);
      backdrop-filter: blur(14px);
    }
    .brand {
      display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px;
      letter-spacing: -0.02em; padding-right: 10px; border-right: 1px solid var(--border);
    }
    .brand-dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), var(--violet));
      box-shadow: 0 0 12px var(--accent);
    }
    .repo-pill {
      font-family: var(--mono); font-size: 12px; color: var(--accent);
      background: rgba(56, 189, 248, 0.12); padding: 3px 8px; border-radius: 6px;
    }
    .sim-box {
      display: flex; align-items: center; gap: 8px; flex: 1; min-width: 260px;
    }
    .sim-input {
      flex: 1; min-width: 160px; padding: 7px 11px; border-radius: 8px;
      background: rgba(255,255,255,0.04); border: 1px solid var(--border);
      color: var(--text); font-size: 13px; outline: none;
    }
    .sim-input:focus { border-color: var(--accent); }
    .budget-wrap {
      display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted);
      font-family: var(--mono); white-space: nowrap;
    }
    .budget-wrap input[type="range"] { width: 90px; accent-color: var(--accent); }
    .btn {
      padding: 6px 11px; border-radius: 8px; border: 1px solid var(--border);
      background: rgba(255,255,255,0.05); color: var(--text); font-size: 12px;
      cursor: pointer; transition: 0.15s;
    }
    .btn:hover { background: rgba(255,255,255,0.12); }
    .btn.active { border-color: var(--rose); color: var(--rose); background: rgba(244,63,94,0.12); }

    .stats-bar {
      position: fixed; bottom: 14px; left: 14px; z-index: 20;
      display: flex; gap: 14px; padding: 8px 14px; border-radius: 10px;
      background: var(--panel); border: 1px solid var(--border);
      backdrop-filter: blur(14px); font-size: 12px; color: var(--muted);
      font-family: var(--mono);
    }
    .stats-bar strong { color: var(--text); }

    .legend {
      position: fixed; bottom: 60px; left: 14px; z-index: 20;
      display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
      border-radius: 10px; background: var(--panel); border: 1px solid var(--border);
      backdrop-filter: blur(14px); font-size: 11px; max-height: 220px; overflow-y: auto;
    }
    .legend-item { display: flex; align-items: center; gap: 7px; color: var(--muted); }
    .legend-swatch { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

    .inspector {
      position: fixed; top: 76px; right: 14px; bottom: 14px; width: 370px; z-index: 20;
      display: none; flex-direction: column; gap: 12px; padding: 16px;
      border-radius: 12px; background: var(--panel); border: 1px solid var(--border);
      backdrop-filter: blur(16px); overflow-y: auto;
    }
    .inspector.open { display: flex; }
    .insp-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
    .insp-title { font-family: var(--mono); font-size: 13px; font-weight: 600; word-break: break-all; }
    .insp-close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .metric-card {
      padding: 8px; border-radius: 8px; background: rgba(255,255,255,0.03);
      border: 1px solid var(--border); text-align: center;
    }
    .metric-val { font-family: var(--mono); font-size: 14px; font-weight: 700; color: var(--text); }
    .metric-lbl { font-size: 10px; color: var(--muted); margin-top: 2px; text-transform: uppercase; }
    .section-lbl {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); margin-bottom: 6px;
    }
    .chip-list { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip {
      font-family: var(--mono); font-size: 11px; padding: 3px 7px; border-radius: 6px;
      background: rgba(255,255,255,0.05); border: 1px solid var(--border); cursor: pointer;
    }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    .chip.dep { border-color: rgba(56, 189, 248, 0.35); color: var(--accent); }
    .chip.caller { border-color: rgba(251, 191, 36, 0.35); color: var(--amber); }
    .skeleton-pre {
      font-family: var(--mono); font-size: 11px; line-height: 1.45;
      padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.45);
      border: 1px solid var(--border); color: #e4e4e7;
      overflow-x: auto; white-space: pre; max-height: 300px; overflow-y: auto;
    }
    .sim-banner {
      display: none; font-family: var(--mono); font-size: 11px;
      padding: 4px 9px; border-radius: 6px;
      background: rgba(52, 211, 153, 0.14); border: 1px solid rgba(52, 211, 153, 0.35);
      color: var(--emerald);
    }
    .sim-banner.active { display: inline-flex; align-items: center; gap: 6px; }
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>

  <div class="topbar">
    <div class="brand">
      <span class="brand-dot"></span>
      <span>repograph</span>
      <span class="repo-pill" id="repoName"></span>
    </div>
    <div class="sim-box">
      <input id="queryInput" class="sim-input" type="text" placeholder="Simulate context pack (e.g. auth, parser, router)..." />
      <div class="budget-wrap">
        <span>Budget:</span>
        <input id="budgetSlider" type="range" min="1000" max="64000" step="1000" value="16000" />
        <span id="budgetVal">16k</span>
      </div>
      <span id="simBanner" class="sim-banner"></span>
    </div>
    <button id="cyclesBtn" class="btn">Highlight Cycles</button>
    <button id="fitBtn" class="btn">Fit View</button>
  </div>

  <div id="legend" class="legend"></div>

  <div class="stats-bar" id="statsBar"></div>

  <aside id="inspector" class="inspector">
    <div class="insp-header">
      <div class="insp-title" id="inspTitle"></div>
      <button class="insp-close" id="inspClose">✕</button>
    </div>
    <div class="metrics-grid" id="inspMetrics"></div>
    <div>
      <div class="section-lbl">Blast Radius — Dependents (Callers)</div>
      <div class="chip-list" id="inspCallers"></div>
    </div>
    <div>
      <div class="section-lbl">Dependencies (Imports)</div>
      <div class="chip-list" id="inspDeps"></div>
    </div>
    <div>
      <div class="section-lbl">AST Skeleton (Context-Optimized)</div>
      <pre class="skeleton-pre" id="inspSkeleton"></pre>
    </div>
  </aside>

  <script>
    const DATA = ${safeJson};

    const PALETTE = [
      '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185',
      '#2dd4bf', '#818cf8', '#f97316', '#e879f9', '#4ade80'
    ];
    const groups = [...new Set(DATA.nodes.map(n => n.group))];
    const groupColors = Object.fromEntries(groups.map((g, i) => [g, PALETTE[i % PALETTE.length]]));

    document.getElementById('repoName').textContent = DATA.repoName;
    document.getElementById('statsBar').innerHTML =
      '<span>Files: <strong>' + DATA.stats.totalFiles + '</strong></span>' +
      '<span>Edges: <strong>' + DATA.stats.totalEdges + '</strong></span>' +
      '<span>Tokens: <strong>' + fmtTok(DATA.stats.totalTokens) + '</strong></span>' +
      '<span>Skeleton: <strong>' + fmtTok(DATA.stats.totalSkeletonTokens) + '</strong></span>' +
      '<span>Cycles: <strong style="color:' + (DATA.stats.cycleCount ? '#f43f5e' : '#34d399') + '">' + DATA.stats.cycleCount + '</strong></span>';

    const legendEl = document.getElementById('legend');
    legendEl.innerHTML = groups.map(g =>
      '<div class="legend-item"><span class="legend-swatch" style="background:' + groupColors[g] + '"></span><span>' + g + '</span></div>'
    ).join('');

    function fmtTok(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    // Physics state
    const nodes = DATA.nodes.map((n, i) => {
      const angle = (i / Math.max(1, DATA.nodes.length)) * Math.PI * 2;
      const r = 120 + Math.sqrt(DATA.nodes.length) * 32;
      return {
        ...n,
        x: Math.cos(angle) * r + (Math.random() - 0.5) * 40,
        y: Math.sin(angle) * r + (Math.random() - 0.5) * 40,
        vx: 0, vy: 0,
        radius: 6 + (n.pageRank / 100) * 14,
        color: groupColors[n.group] || '#38bdf8'
      };
    });
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const edges = DATA.edges
      .map(e => ({ source: nodeById.get(e.source), target: nodeById.get(e.target), isTypeOnly: e.isTypeOnly }))
      .filter(e => e.source && e.target);

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    let W = window.innerWidth, H = window.innerHeight;
    let cam = { x: 0, y: 0, zoom: 1 };
    let selected = null;
    let hovered = null;
    let draggingNode = null;
    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let highlightCycles = false;
    let simTiers = new Map(); // id -> 'full' | 'skeleton'

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener('resize', resize);
    resize();

    function screenToWorld(sx, sy) {
      return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y };
    }

    function fitView() {
      if (!nodes.length) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      cam.x = (minX + maxX) / 2;
      cam.y = (minY + maxY) / 2;
      const spanX = Math.max(200, maxX - minX + 160);
      const spanY = Math.max(200, maxY - minY + 160);
      cam.zoom = Math.min(1.4, Math.max(0.25, Math.min(W / spanX, H / spanY) * 0.85));
    }

    // Force-directed simulation step
    let alpha = 1.0;
    function stepPhysics() {
      if (alpha < 0.005 && !draggingNode) return;
      const repulsion = 3200;
      const springLen = 115;
      const springK = 0.035;
      const centerK = 0.008;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.vx += -a.x * centerK * alpha;
        a.vy += -a.y * centerK * alpha;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let distSq = dx * dx + dy * dy + 1;
          let dist = Math.sqrt(distSq);
          let force = (repulsion / distSq) * alpha;
          let fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      for (const e of edges) {
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const diff = (dist - springLen) * springK * alpha;
        const fx = (dx / dist) * diff, fy = (dy / dist) * diff;
        e.source.vx += fx; e.source.vy += fy;
        e.target.vx -= fx; e.target.vy -= fy;
      }

      for (const n of nodes) {
        if (n === draggingNode) continue;
        n.vx *= 0.84; n.vy *= 0.84;
        n.x += n.vx; n.y += n.vy;
      }
      alpha *= 0.992;
    }

    function getBlastSets(node) {
      const deps = new Set(), callers = new Set();
      if (!node) return { deps, callers };
      const q1 = [...node.dependencies];
      while (q1.length) {
        const id = q1.shift();
        if (!deps.has(id)) {
          deps.add(id);
          const n = nodeById.get(id);
          if (n) q1.push(...n.dependencies);
        }
      }
      const q2 = [...node.dependents];
      while (q2.length) {
        const id = q2.shift();
        if (!callers.has(id)) {
          callers.add(id);
          const n = nodeById.get(id);
          if (n) q2.push(...n.dependents);
        }
      }
      return { deps, callers };
    }

    function draw() {
      stepPhysics();
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      const { deps, callers } = getBlastSets(selected);
      const hasSim = simTiers.size > 0;

      // Edges
      for (const e of edges) {
        let stroke = 'rgba(255,255,255,0.11)';
        let width = 1;
        if (highlightCycles && e.source.inCycle && e.target.inCycle) {
          stroke = 'rgba(244,63,94,0.85)'; width = 2;
        } else if (selected) {
          if (e.source === selected || (deps.has(e.source.id) && deps.has(e.target.id))) {
            stroke = 'rgba(56,189,248,0.65)'; width = 1.6;
          } else if (e.target === selected || (callers.has(e.source.id) && callers.has(e.target.id))) {
            stroke = 'rgba(251,191,36,0.65)'; width = 1.6;
          } else {
            stroke = 'rgba(255,255,255,0.03)';
          }
        } else if (hasSim) {
          if (simTiers.has(e.source.id) && simTiers.has(e.target.id)) {
            stroke = 'rgba(52,211,153,0.45)'; width = 1.4;
          } else {
            stroke = 'rgba(255,255,255,0.03)';
          }
        }

        ctx.beginPath();
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        ctx.stroke();

        // Arrowhead
        const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len, uy = dy / len;
        const ax = e.target.x - ux * (e.target.radius + 4);
        const ay = e.target.y - uy * (e.target.radius + 4);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - ux * 6 - uy * 3, ay - uy * 6 + ux * 3);
        ctx.lineTo(ax - ux * 6 + uy * 3, ay - uy * 6 - ux * 3);
        ctx.closePath();
        ctx.fillStyle = stroke;
        ctx.fill();
      }

      // Nodes
      for (const n of nodes) {
        let dimmed = false;
        let ringColor = null;
        if (selected && n !== selected && !deps.has(n.id) && !callers.has(n.id)) dimmed = true;
        if (hasSim && !simTiers.has(n.id)) dimmed = true;
        if (highlightCycles && !n.inCycle) dimmed = true;

        if (n === selected) ringColor = '#ffffff';
        else if (selected && callers.has(n.id)) ringColor = '#fbbf24';
        else if (selected && deps.has(n.id)) ringColor = '#38bdf8';
        else if (simTiers.get(n.id) === 'full') ringColor = '#34d399';
        else if (simTiers.get(n.id) === 'skeleton') ringColor = '#a78bfa';
        else if (n.inCycle) ringColor = '#f43f5e';

        ctx.globalAlpha = dimmed ? 0.16 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();

        if (ringColor) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = n === selected || simTiers.get(n.id) === 'full' ? 2.5 : 1.6;
          ctx.stroke();
        }

        // Labels for hubs, hovered, selected, or zoomed-in nodes
        if (!dimmed && (cam.zoom > 0.72 || n.pageRank >= 45 || n === hovered || n === selected || simTiers.get(n.id) === 'full')) {
          const shortName = n.id.split('/').pop();
          ctx.font = '500 11px ui-monospace, SFMono-Regular, monospace';
          ctx.fillStyle = '#f4f4f5';
          ctx.textAlign = 'center';
          ctx.fillText(shortName, n.x, n.y + n.radius + 14);
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
      requestAnimationFrame(draw);
    }

    function openInspector(node) {
      selected = node;
      const el = document.getElementById('inspector');
      el.classList.add('open');
      document.getElementById('inspTitle').textContent = node.id;
      const ratio = node.tokens > 0 ? Math.round((1 - node.skeletonTokens / node.tokens) * 100) : 0;
      document.getElementById('inspMetrics').innerHTML =
        '<div class="metric-card"><div class="metric-val">' + node.pageRank.toFixed(1) + '</div><div class="metric-lbl">PageRank</div></div>' +
        '<div class="metric-card"><div class="metric-val">' + fmtTok(node.tokens) + '</div><div class="metric-lbl">Tokens</div></div>' +
        '<div class="metric-card"><div class="metric-val">-' + Math.max(0, ratio) + '%</div><div class="metric-lbl">Skeleton Save</div></div>';

      const callersEl = document.getElementById('inspCallers');
      callersEl.innerHTML = node.dependents.length
        ? node.dependents.map(id => '<span class="chip caller" data-id="' + id + '">' + id + '</span>').join('')
        : '<span style="color:var(--muted);font-size:12px;">None (entrypoint / leaf)</span>';

      const depsEl = document.getElementById('inspDeps');
      depsEl.innerHTML = node.dependencies.length
        ? node.dependencies.map(id => '<span class="chip dep" data-id="' + id + '">' + id + '</span>').join('')
        : '<span style="color:var(--muted);font-size:12px;">None (zero internal deps)</span>';

      document.getElementById('inspSkeleton').textContent = node.skeleton;

      el.querySelectorAll('.chip[data-id]').forEach(chip => {
        chip.addEventListener('click', () => {
          const target = nodeById.get(chip.getAttribute('data-id'));
          if (target) openInspector(target);
        });
      });
    }

    document.getElementById('inspClose').addEventListener('click', () => {
      selected = null;
      document.getElementById('inspector').classList.remove('open');
    });

    // Interactive Context Budget Simulator
    function runContextSim() {
      const q = document.getElementById('queryInput').value.trim().toLowerCase();
      const budget = Number(document.getElementById('budgetSlider').value);
      document.getElementById('budgetVal').textContent = fmtTok(budget);
      const banner = document.getElementById('simBanner');
      simTiers.clear();

      if (!q) {
        banner.classList.remove('active');
        return;
      }

      const terms = q.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
      const baseScores = new Map();
      for (const n of nodes) {
        let s = 0;
        const hay = (n.id + ' ' + n.symbols.map(x => x.name).join(' ') + ' ' + n.skeleton).toLowerCase();
        for (const t of terms) {
          if (n.id.toLowerCase().includes(t)) s += 5;
          if (hay.includes(t)) s += 2;
        }
        baseScores.set(n.id, s);
      }
      const scores = new Map(baseScores);
      for (const n of nodes) {
        const b = baseScores.get(n.id) || 0;
        if (b <= 0) continue;
        for (const dep of n.dependencies) scores.set(dep, (scores.get(dep) || 0) + b * 0.45);
        for (const cal of n.dependents) scores.set(cal, (scores.get(cal) || 0) + b * 0.3);
      }

      const ranked = [...nodes].sort((a, b) => ((scores.get(b.id) || 0) + b.pageRank * 0.01) - ((scores.get(a.id) || 0) + a.pageRank * 0.01));
      let used = 0, fullC = 0, skelC = 0;
      const cap = budget * 0.68;
      const rest = [];
      for (const n of ranked) {
        if ((scores.get(n.id) || 0) <= 0) continue;
        if (fullC < 8 && used + n.tokens <= cap && (baseScores.get(n.id) || 0) > 0) {
          simTiers.set(n.id, 'full');
          used += n.tokens; fullC++;
        } else {
          rest.push(n);
        }
      }
      for (const n of rest) {
        if (used + n.skeletonTokens <= budget) {
          simTiers.set(n.id, 'skeleton');
          used += n.skeletonTokens; skelC++;
        }
      }

      const saved = DATA.stats.totalTokens > 0 ? Math.max(0, Math.round((1 - used / DATA.stats.totalTokens) * 100)) : 0;
      banner.textContent = fullC + ' full · ' + skelC + ' skeleton · ' + fmtTok(used) + ' tok (-' + saved + '%)';
      banner.classList.add('active');
    }

    document.getElementById('queryInput').addEventListener('input', runContextSim);
    document.getElementById('budgetSlider').addEventListener('input', runContextSim);
    document.getElementById('fitBtn').addEventListener('click', fitView);
    document.getElementById('cyclesBtn').addEventListener('click', (e) => {
      highlightCycles = !highlightCycles;
      e.target.classList.toggle('active', highlightCycles);
    });

    // Pointer interactions
    function hitTest(wx, wy) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = wx - n.x, dy = wy - n.y;
        if (dx * dx + dy * dy <= (n.radius + 5) * (n.radius + 5)) return n;
      }
      return null;
    }

    canvas.addEventListener('mousedown', (e) => {
      const w = screenToWorld(e.clientX, e.clientY);
      const hit = hitTest(w.x, w.y);
      if (hit) {
        draggingNode = hit;
        openInspector(hit);
      } else {
        isPanning = true;
        panStart = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const w = screenToWorld(e.clientX, e.clientY);
      if (draggingNode) {
        draggingNode.x = w.x; draggingNode.y = w.y;
        draggingNode.vx = 0; draggingNode.vy = 0;
        alpha = Math.max(alpha, 0.2);
      } else if (isPanning) {
        cam.x -= (e.clientX - panStart.x) / cam.zoom;
        cam.y -= (e.clientY - panStart.y) / cam.zoom;
        panStart = { x: e.clientX, y: e.clientY };
      } else {
        hovered = hitTest(w.x, w.y);
        canvas.style.cursor = hovered ? 'pointer' : 'grab';
      }
    });

    window.addEventListener('mouseup', () => {
      draggingNode = null; isPanning = false;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      cam.zoom = Math.min(3.5, Math.max(0.18, cam.zoom * factor));
    }, { passive: false });

    // Settle initial layout then fit
    for (let i = 0; i < 80; i++) stepPhysics();
    fitView();
    requestAnimationFrame(draw);
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
