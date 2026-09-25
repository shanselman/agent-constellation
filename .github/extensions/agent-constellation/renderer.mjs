export function renderConstellationHtml(config) {
    const serializedConfig = JSON.stringify(config).replaceAll("<", "\\u003c");
    return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Constellation</title>
  <style>
    :root {
      color-scheme: light dark;
      --canvas-bg: var(--background-color-default, #0d1117);
      --panel-bg: color-mix(in srgb, var(--background-color-default, #0d1117) 94%, var(--text-color-default, #f0f6fc) 6%);
      --card-bg: color-mix(in srgb, var(--background-color-default, #0d1117) 86%, var(--text-color-default, #f0f6fc) 14%);
      --text: var(--text-color-default, #f0f6fc);
      --muted: var(--text-color-muted, #8b949e);
      --border: var(--border-color-default, #30363d);
      --focus: var(--color-focus-outline, #58a6ff);
      --busy: var(--true-color-blue, #2f81f7);
      --idle: var(--text-color-muted, #8b949e);
      --complete: #3fb950;
      --local-model: color-mix(in srgb, var(--complete) 86%, var(--text) 14%);
      --waiting: #d29922;
      --plan: #a371f7;
      --blocked: #db6d28;
      --failed: var(--true-color-red, #f85149);
      --archived: #6e7681;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      height: 100vh;
      overflow: hidden;
      background: var(--canvas-bg);
      color: var(--text);
    }
    button, select {
      color: inherit;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      font: inherit;
    }
    button { cursor: pointer; min-height: 30px; padding: 4px 8px; }
    button:hover { border-color: var(--muted); }
    button:focus-visible, select:focus-visible, .node:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    .app {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(0, 1fr);
      height: 100vh;
    }
    .chrome {
      grid-row: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      padding: 5px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--panel-bg);
    }
    .brand {
      display: flex;
      align-items: baseline;
      min-width: 0;
      gap: 7px;
    }
    .brand h1 {
      margin: 0;
      font-size: var(--text-title-small, 16px);
      line-height: 22px;
      font-weight: var(--font-weight-semibold, 600);
      white-space: nowrap;
    }
    .summary {
      max-width: 240px;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .scope-control {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .scope-control select { max-width: 120px; padding: 3px 22px 3px 6px; }
    .status-strip {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
    }
    .status-strip button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 26px;
      padding: 2px 6px;
      border-color: transparent;
      color: var(--muted);
      white-space: nowrap;
    }
    .status-strip button.active { border-color: var(--status-color); color: var(--text); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-color); flex: none; }
    .toolbar { display: flex; align-items: center; gap: 4px; margin-left: auto; }
    .toolbar button { min-width: 30px; }
    .toolbar .text-control { min-width: auto; }
    .filters {
      grid-row: 2;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--panel-bg);
    }
    .filters.open { display: flex; }
    .filters label {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }
    select { min-width: 0; max-width: 240px; padding: 4px 24px 4px 7px; }
    .workspace {
      grid-row: 3;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      min-width: 0;
      min-height: 0;
      position: relative;
    }
    .stage {
      position: relative;
      min-width: 0;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      background:
        radial-gradient(circle at 16% 12%, color-mix(in srgb, var(--busy) 7%, transparent), transparent 34%),
        radial-gradient(circle at 82% 72%, color-mix(in srgb, var(--plan) 6%, transparent), transparent 38%),
        var(--canvas-bg);
    }
    #constellation {
      display: block;
      min-width: 100%;
      min-height: 100%;
      touch-action: none;
      user-select: none;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: none;
      place-items: center;
      color: var(--muted);
      pointer-events: none;
    }
    .edge {
      fill: none;
      stroke: color-mix(in srgb, var(--muted) 48%, transparent);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
      transition: d 180ms ease;
    }
    .edge.working {
      stroke: var(--busy);
      stroke-dasharray: 7 9;
      animation: flow 1.3s linear infinite;
    }
    .edge.attention { stroke: var(--waiting); stroke-width: 2.2; }
    .edge.shelf { stroke-dasharray: 3 5; opacity: .7; }
    .edge.containment {
      stroke: var(--plan);
      stroke-dasharray: 2 7;
      opacity: .78;
    }
    @keyframes flow { to { stroke-dashoffset: -32; } }
    .node { cursor: pointer; }
    .node-card {
      fill: var(--card-bg);
      stroke: var(--status-color);
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
      filter: drop-shadow(0 3px 8px rgb(0 0 0 / .18));
    }
    .node:hover .node-card, .node.selected .node-card { stroke-width: 3; }
    .node.root .node-card { stroke-width: 3; }
    .node.current .node-card {
      stroke-dasharray: 5 3;
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--focus) 45%, transparent));
    }
    .node.current.selected .node-card { stroke-dasharray: none; }
    .node.shelf .node-card { fill: color-mix(in srgb, var(--card-bg) 78%, var(--complete) 22%); stroke-dasharray: 5 4; }
    .node.synthetic .node-card {
      fill: color-mix(in srgb, var(--card-bg) 76%, var(--plan) 24%);
      stroke: var(--plan);
      stroke-dasharray: 3 5;
    }
    .node-halo { fill: none; stroke: var(--status-color); opacity: 0; transform-origin: center; }
    .node.busy .node-halo { opacity: .46; animation: pulse 1.8s ease-out infinite; }
    .node.waiting-user .node-card, .node.waiting-plan .node-card {
      stroke-width: 3;
      animation: attention 2.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0% { r: 36px; opacity: .5; }
      75%, 100% { r: 56px; opacity: 0; }
    }
    @keyframes attention {
      0%, 100% { filter: drop-shadow(0 3px 8px rgb(0 0 0 / .18)); }
      50% { filter: drop-shadow(0 0 10px color-mix(in srgb, var(--waiting) 55%, transparent)); }
    }
    .node-name { fill: var(--text); font-weight: var(--font-weight-semibold, 600); font-size: 12px; }
    .node-repo, .node-model, .node-status { fill: var(--muted); font-size: 10px; }
    .node-model { font-size: 9px; }
    .local-model-leaf { color: var(--local-model); overflow: visible; }
    .local-model-leaf .leaf-body { fill: currentColor; }
    .local-model-leaf .leaf-vein {
      fill: none;
      stroke: color-mix(in srgb, currentColor 58%, var(--canvas-bg) 42%);
      stroke-linecap: round;
      stroke-width: 1.25;
    }
    .node-status { fill: var(--status-color); font-weight: var(--font-weight-semibold, 600); }
    .current-marker { fill: var(--focus); }
    .current-marker-text {
      fill: var(--color-white, #fff);
      font-size: 8px;
      font-weight: var(--font-weight-semibold, 600);
      letter-spacing: .4px;
    }
    .inspector {
      display: none;
      max-height: min(42vh, 320px);
      overflow: auto;
      border-top: 1px solid var(--border);
      background: var(--panel-bg);
      padding: 8px 10px 10px;
    }
    .inspector.open { display: block; }
    .inspector-head {
      display: flex;
      align-items: center;
      gap: 8px;
      position: sticky;
      top: -8px;
      margin: -8px -10px 4px;
      padding: 7px 10px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
    }
    .inspector h2 {
      margin: 0;
      font-size: var(--text-title-small, 16px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .inspector-close { margin-left: auto; }
    .detail-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--status-color, var(--muted));
      font-weight: var(--font-weight-semibold, 600);
      font-size: 12px;
      white-space: nowrap;
    }
    dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 4px 10px;
      margin: 8px 0 0;
    }
    dt { color: var(--muted); font-size: 12px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .model-detail { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 5px; }
    .demo-local-model {
      color: var(--local-model);
      font-size: 11px;
      font-weight: var(--font-weight-semibold, 600);
      white-space: nowrap;
    }
    code { font-family: var(--font-mono, Consolas, monospace); font-size: var(--text-code-inline, 12px); }
    .source-note { margin-top: 8px; color: var(--muted); font-size: 11px; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .status-busy { --status-color: var(--busy); }
    .status-idle { --status-color: var(--idle); }
    .status-completed { --status-color: var(--complete); }
    .status-waiting-user { --status-color: var(--waiting); }
    .status-waiting-plan { --status-color: var(--plan); }
    .status-blocked { --status-color: var(--blocked); }
    .status-failed { --status-color: var(--failed); }
    .status-archived { --status-color: var(--archived); }
    @media (max-width: 620px) {
      .chrome { flex-wrap: wrap; row-gap: 3px; }
      .brand { flex: 1 1 auto; }
      .summary { max-width: 150px; }
      .scope-control span { display: none; }
      .status-strip { order: 3; flex: 1 0 100%; }
      .status-strip button { font-size: 11px; }
      .toolbar .optional-label { display: none; }
      .filters.open { align-items: stretch; flex-direction: column; }
      .filters label { display: grid; grid-template-columns: 70px minmax(0, 1fr); }
      select { max-width: none; width: 100%; }
      dl { grid-template-columns: 1fr; gap: 1px; }
      dd { margin-bottom: 4px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .001ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: .001ms !important;
      }
      .edge.working { stroke-dasharray: none; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="chrome">
      <div class="brand">
        <h1>Constellation</h1>
        <span class="summary" id="summary">Loading…</span>
      </div>
      <label class="scope-control" for="scopeSelect">
        <span>View</span>
        <select id="scopeSelect" aria-describedby="scopeDescription">
          <option value="tree">Tree</option>
          <option value="all">All sessions</option>
        </select>
      </label>
      <div class="status-strip" id="legend" aria-label="Mission status counts"></div>
      <div class="toolbar" aria-label="Constellation controls">
        <button id="refresh" type="button" title="Refresh live state">↻<span class="sr-only">Refresh</span></button>
        <button id="home" class="text-control" type="button" title="Center the current session">◎<span class="optional-label"> Current</span><span class="sr-only">Center current session</span></button>
        <button id="fitWidth" class="text-control" type="button" title="Fit readable card width">↔<span class="optional-label"> Width</span><span class="sr-only">Fit width</span></button>
        <button id="zoomOut" type="button" aria-label="Zoom out">−</button>
        <button id="zoomIn" type="button" aria-label="Zoom in">+</button>
        <button id="filtersToggle" type="button" aria-expanded="false" aria-controls="filters">Filter</button>
      </div>
    </header>
    <section class="filters" id="filters" aria-label="Constellation filters">
      <label>Status
        <select id="statusFilter">
          <option value="">All statuses</option>
          <option value="waiting-user">Waiting for user</option>
          <option value="waiting-plan">Waiting for plan approval</option>
          <option value="blocked">Blocked</option>
          <option value="failed">Failed</option>
          <option value="busy">Busy</option>
          <option value="idle">Idle</option>
          <option value="archived">Archived</option>
          <option value="completed">Completed</option>
        </select>
      </label>
      <label>Repository
        <select id="repoFilter"><option value="">All repositories</option></select>
      </label>
      <label>Project
        <select id="projectFilter"><option value="">All projects</option></select>
      </label>
    </section>
    <main class="workspace">
      <section class="stage" id="stage" aria-label="Agent family tree">
        <svg id="constellation" role="tree" aria-label="Copilot project session constellation">
          <g id="viewport"><g id="edges"></g><g id="nodes"></g></g>
        </svg>
        <div class="empty" id="empty">No live sessions match these filters.</div>
      </section>
      <section class="inspector" id="inspector" aria-label="Selected session details" aria-hidden="true">
        <div class="inspector-head">
          <h2 id="detailName">Session details</h2>
          <div class="detail-status status-idle" id="detailStatus"><span class="dot"></span><span></span></div>
          <button class="inspector-close" id="inspectorClose" type="button" aria-label="Close session details">×</button>
        </div>
        <dl id="details"></dl>
        <div class="source-note" id="sourceNote">Sanitized metadata only.</div>
      </section>
    </main>
  </div>
  <div class="sr-only" id="scopeDescription">
    Tree shows the current session family. All sessions adds a synthetic overview container; dashed grouping connections do not represent parent-child lineage.
  </div>
  <div class="sr-only" id="live" aria-live="polite"></div>
  <script type="module">
    import {
      applyPinchGesture,
      filterConstellationView,
      fitWidthScale,
      formatModelLabel,
      layoutResponsiveConstellation,
      resolveProjectFilter
    } from "./layout.mjs";

    const config = ${serializedConfig};
    const svgNs = "http://www.w3.org/2000/svg";
    const statusOrder = [
      "waiting-user", "waiting-plan", "blocked", "failed",
      "busy", "idle", "archived", "completed"
    ];
    const statusLabels = {
      "busy": "Busy",
      "idle": "Idle",
      "completed": "Completed",
      "waiting-user": "Waiting",
      "waiting-plan": "Plan",
      "blocked": "Blocked",
      "failed": "Failed",
      "archived": "Archived"
    };
    const state = {
      data: null,
      layout: null,
      selectedId: null,
      status: config.initialStatus || "",
      repository: config.initialRepository || "",
      project: config.initialProject || "",
      scope: config.initialScope === "all" ? "all" : "tree",
      completedExpanded: false,
      transform: { x: 0, y: 0, k: 1 },
      pointers: new Map(),
      gesture: null,
      firstRender: true
    };
    const elements = Object.fromEntries([
      "summary", "scopeSelect", "refresh", "home", "fitWidth", "zoomOut", "zoomIn",
      "filtersToggle", "filters", "statusFilter", "repoFilter", "legend",
      "projectFilter",
      "stage", "constellation", "viewport", "edges", "nodes", "empty",
      "inspector", "inspectorClose", "detailName", "detailStatus", "details",
      "sourceNote", "live"
    ].map((id) => [id, document.getElementById(id)]));

    function svgElement(name, attributes) {
      const item = document.createElementNS(svgNs, name);
      Object.entries(attributes || {}).forEach(([key, value]) => {
        if (value !== undefined) item.setAttribute(key, String(value));
      });
      return item;
    }

    function localModelLeaf(attributes = {}) {
      const leaf = svgElement("svg", {
        class: "local-model-leaf",
        width: 11,
        height: 11,
        viewBox: "0 0 16 16",
        role: "img",
        "aria-label": "Runs locally",
        ...attributes
      });
      const title = svgElement("title");
      title.textContent = "Runs locally";
      const body = svgElement("path", {
        class: "leaf-body",
        d: "M14.3 1.7C8.7 2 4.7 4 3 7.5c-1.3 2.8-.2 5.7 2.4 6.5 2.6.8 5.1-.8 5.9-3.4.7-2.3.8-5.3 3-8.9Z"
      });
      const vein = svgElement("path", {
        class: "leaf-vein",
        d: "M3.7 14c1.8-3.4 4.3-5.9 7.8-7.6"
      });
      leaf.append(title, body, vein);
      return leaf;
    }

    function elapsed(iso) {
      const start = Date.parse(iso || "");
      if (!Number.isFinite(start)) return "";
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      if (seconds < 60) return seconds + "s";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
      return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
    }

    function statusText(node) {
      if (node.synthetic) return "Grouping only";
      const base = statusLabels[node.status] || node.status;
      return node.status === "busy" && node.busySince
        ? base + " · " + elapsed(node.busySince)
        : base;
    }

    function filteredState() {
      if (!state.data) return null;
      return filterConstellationView(state.data, {
        status: state.status,
        repository: state.repository,
        project: state.project
      });
    }

    function stageSize() {
      const rect = elements.stage.getBoundingClientRect();
      return {
        width: Math.max(320, rect.width),
        height: Math.max(320, rect.height)
      };
    }

    function updateCanvasSize() {
      if (!state.layout) return;
      const stage = stageSize();
      const width = Math.max(stage.width, state.layout.width * state.transform.k + Math.abs(state.transform.x));
      const height = Math.max(stage.height, state.layout.height * state.transform.k + Math.abs(state.transform.y));
      elements.constellation.setAttribute("width", String(width));
      elements.constellation.setAttribute("height", String(height));
      elements.constellation.style.width = width + "px";
      elements.constellation.style.height = height + "px";
    }

    function applyTransform() {
      const transform = state.transform;
      elements.viewport.setAttribute(
        "transform",
        "translate(" + transform.x + " " + transform.y + ") scale(" + transform.k + ")"
      );
      updateCanvasSize();
    }

    function setZoom(next, centerX, centerY) {
      const current = state.transform;
      const rect = elements.stage.getBoundingClientRect();
      const cx = centerX ?? rect.width / 2;
      const cy = centerY ?? rect.height / 2;
      const k = Math.max(.65, Math.min(3, next));
      const worldX = (cx + elements.stage.scrollLeft - current.x) / current.k;
      const worldY = (cy + elements.stage.scrollTop - current.y) / current.k;
      state.transform = {
        k,
        x: cx + elements.stage.scrollLeft - worldX * k,
        y: cy + elements.stage.scrollTop - worldY * k
      };
      applyTransform();
    }

    function appendDetail(label, value, code) {
      if (!value) return;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      const content = code ? document.createElement("code") : document.createElement("span");
      content.textContent = value;
      dd.appendChild(content);
      elements.details.append(dt, dd);
    }

    function appendModelDetail(node) {
      const value = formatModelLabel(node.model, node.reasoningEffort);
      if (!value) return;
      const dt = document.createElement("dt");
      dt.textContent = "Model";
      const dd = document.createElement("dd");
      dd.className = "model-detail";
      if (node.isLocalModel) {
        dd.appendChild(localModelLeaf());
        const localLabel = document.createElement("span");
        localLabel.className = node.demoLocalModel ? "demo-local-model" : "sr-only";
        localLabel.textContent = node.demoLocalModel ? "Demo local model" : "Local model";
        dd.appendChild(localLabel);
      }
      const content = document.createElement("span");
      content.textContent = value;
      dd.appendChild(content);
      elements.details.append(dt, dd);
    }

    function openInspector(node, announce) {
      if (node.synthetic) return;
      state.selectedId = node.id;
      elements.inspector.classList.add("open");
      elements.inspector.setAttribute("aria-hidden", "false");
      elements.detailName.textContent = node.name;
      elements.detailStatus.className = "detail-status status-" + node.status;
      elements.detailStatus.lastElementChild.textContent = statusText(node);
      elements.details.replaceChildren();
      appendDetail("Project", node.projectName);
      appendDetail("Repository", node.repository);
      appendDetail("Branch", node.branch, true);
      appendDetail("Mode", node.mode);
      appendModelDetail(node);
      appendDetail(
        "Role",
        [node.isCurrent ? "Current session" : "", node.isRoot ? "Root coordinator" : ""]
          .filter(Boolean).join(" · ")
      );
      appendDetail("Task", node.task);
      appendDetail("Pull request", node.pullRequest);
      appendDetail("Issue", node.issue);
      appendDetail("Human gate", node.humanGate?.label);
      appendDetail("Busy elapsed", node.status === "busy" ? elapsed(node.busySince) : "");
      appendDetail("Last activity", node.updatedAt ? new Date(node.updatedAt).toLocaleString() : "");
      appendDetail("Session ID", node.id, true);
      updateSelection();
      if (announce) elements.live.textContent = "Opened details for " + node.name + ", " + statusText(node);
    }

    function closeInspector({ restoreFocus = true } = {}) {
      elements.inspector.classList.remove("open");
      elements.inspector.setAttribute("aria-hidden", "true");
      if (restoreFocus && state.selectedId) {
        elements.nodes.querySelector('[data-id="' + CSS.escape(state.selectedId) + '"]')?.focus();
      }
    }

    function updateSelection() {
      elements.nodes.querySelectorAll(".node").forEach((item) => {
        const selected = item.dataset.id === state.selectedId;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-selected", selected ? "true" : "false");
      });
    }

    function nodeAriaLabel(node) {
      if (node.isShelf) {
        return node.name + ", " + (state.completedExpanded ? "collapse completed agents" : "expand completed agents");
      }
      if (node.synthetic) {
        return node.name + ", synthetic grouping container, not a session or parent-child relationship";
      }
      const parts = [node.name, statusText(node), node.repository];
      if (node.projectName) parts.push("project " + node.projectName);
      if (node.syntheticParentId) {
        parts.push(
          node.parentId
            ? "parent session outside this project; grouped for display"
            : "no recorded parent; grouped for display"
        );
      }
      if (node.isCurrent) parts.push("current session");
      if (node.isRoot) parts.push("constellation root");
      if (node.branch) parts.push("branch " + node.branch);
      const modelLabel = formatModelLabel(node.model, node.reasoningEffort);
      if (modelLabel) parts.push("model " + modelLabel);
      if (node.isLocalModel) {
        parts.push(node.demoLocalModel ? "Demo local model" : "Local model");
      }
      if (node.humanGate) parts.push(node.humanGate.label);
      return parts.join(", ");
    }

    function renderLegend() {
      elements.legend.replaceChildren();
      statusOrder.forEach((status) => {
        const count = Number(state.data?.counts?.[status] || 0);
        if (!count) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "status-" + status + (state.status === status ? " active" : "");
        button.title = "Filter to " + statusLabels[status];
        const dot = document.createElement("span");
        dot.className = "dot";
        const label = document.createElement("span");
        label.textContent = statusLabels[status] + " " + count;
        button.append(dot, label);
        button.addEventListener("click", () => {
          state.status = state.status === status ? "" : status;
          if (state.status === "completed") state.completedExpanded = true;
          elements.statusFilter.value = state.status;
          render();
        });
        elements.legend.appendChild(button);
      });
    }

    function renderRepositories() {
      const current = state.repository;
      elements.repoFilter.replaceChildren(new Option("All repositories", ""));
      state.data.repositories.forEach((repository) => {
        elements.repoFilter.add(new Option(repository, repository));
      });
      elements.repoFilter.value = state.data.repositories.includes(current) ? current : "";
      state.repository = elements.repoFilter.value;
    }

    function renderProjects() {
      const scopedProject = state.data.diagnostics?.projectFilter;
      const current = state.project ||
        scopedProject?.effectiveProjectId ||
        scopedProject?.requested ||
        "";
      elements.projectFilter.replaceChildren();
      elements.projectFilter.disabled = Boolean(scopedProject?.requested);
      if (!scopedProject?.requested) {
        elements.projectFilter.add(new Option("All projects", ""));
      }
      (state.data.projects || []).forEach((project) => {
        const value = project.id || project.name;
        const duplicateName = (state.data.projects || []).filter(
          (candidate) => candidate.name.toLowerCase() === project.name.toLowerCase()
        ).length > 1;
        const label = duplicateName && project.id
          ? project.name + " (" + project.id.slice(0, 8) + ")"
          : project.name;
        elements.projectFilter.add(new Option(label, value));
      });
      const resolution = resolveProjectFilter(state.data.projects, current);
      if (!current) {
        elements.projectFilter.value = "";
        state.project = "";
      } else if (resolution.matched) {
        elements.projectFilter.value = resolution.value;
        state.project = resolution.value;
      } else {
        const filterStatus =
          state.data.diagnostics?.projectFilter?.status || resolution.status;
        const label = filterStatus === "ambiguous"
          ? "Ambiguous project filter"
          : "Project unavailable";
        elements.projectFilter.add(new Option(label, current));
        elements.projectFilter.value = current;
        state.project = current;
      }
    }

    function edgePath(edge, byId) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return "";
      const halfWidth = state.layout.cardWidth / 2;
      const halfHeight = state.layout.cardHeight / 2;
      if (state.layout.orientation === "vertical") {
        const startX = source.x + halfWidth;
        const endX = target.x - halfWidth;
        const middleX = (startX + endX) / 2;
        return "M " + startX + " " + source.y +
          " C " + middleX + " " + source.y + ", " +
          middleX + " " + target.y + ", " + endX + " " + target.y;
      }
      const startY = source.y + halfHeight;
      const endY = target.y - halfHeight;
      const middleY = (startY + endY) / 2;
      return "M " + source.x + " " + startY +
        " C " + source.x + " " + middleY + ", " +
        target.x + " " + middleY + ", " + target.x + " " + endY;
    }

    function renderEdges(byId) {
      elements.edges.replaceChildren();
      state.layout.edges.forEach((edge) => {
        const target = byId.get(edge.target);
        const path = svgElement("path", {
          d: edgePath(edge, byId),
          class: "edge" +
            (target?.status === "busy" ? " working" : "") +
            (target?.status === "waiting-user" || target?.status === "waiting-plan" ? " attention" : "") +
            (edge.isShelf ? " shelf" : "") +
            (edge.kind === "containment" ? " containment" : ""),
          "aria-hidden": "true"
        });
        elements.edges.appendChild(path);
      });
    }

    function toggleCompletedShelf() {
      state.completedExpanded = !state.completedExpanded;
      render();
      elements.live.textContent = state.completedExpanded
        ? "Completed agents expanded."
        : "Completed agents collapsed.";
    }

    function renderNodes() {
      elements.nodes.replaceChildren();
      const width = state.layout.cardWidth;
      const height = state.layout.cardHeight;
      state.layout.nodes.forEach((node) => {
        const modelLabel = node.isShelf
          ? ""
          : formatModelLabel(node.model, node.reasoningEffort);
        const hasModelLabel = Boolean(modelLabel);
        const group = svgElement("g", {
          class: "node " + node.status + " status-" + node.status +
            (node.isRoot ? " root" : "") +
            (node.isCurrent ? " current" : "") +
            (node.isShelf ? " shelf" : "") +
            (node.synthetic ? " synthetic" : ""),
          transform: "translate(" + node.x + " " + node.y + ")",
          tabindex: "0",
          role: "treeitem",
          "aria-label": nodeAriaLabel(node),
          "aria-selected": state.selectedId === node.id ? "true" : "false",
          "aria-level": Number(node.depth || 0) + 1
        });
        group.dataset.id = node.id;
        const halo = svgElement("circle", {
          class: "node-halo",
          r: Math.min(width, height) / 2,
          cx: 0,
          cy: 0
        });
        const card = svgElement("rect", {
          class: "node-card",
          x: -width / 2,
          y: -height / 2,
          width,
          height,
          rx: 11
        });
        const name = svgElement("text", {
          class: "node-name",
          x: 0,
          y: hasModelLabel ? -20 : -10,
          "text-anchor": "middle"
        });
        name.textContent = node.name.length > 29 ? node.name.slice(0, 28) + "…" : node.name;
        const repo = svgElement("text", {
          class: "node-repo",
          x: 0,
          y: hasModelLabel ? -5 : 8,
          "text-anchor": "middle"
        });
        repo.textContent = node.repository.length > 31
          ? "…" + node.repository.slice(-30)
          : node.repository;
        const status = svgElement("text", {
          class: "node-status",
          x: 0,
          y: hasModelLabel ? 28 : 27,
          "text-anchor": "middle"
        });
        status.textContent = node.isShelf
          ? (state.completedExpanded ? "Collapse shelf" : "Expand shelf")
          : statusText(node);
        group.append(halo, card, name, repo);
        if (hasModelLabel) {
          const displayedModelLabel = modelLabel.length > 34
            ? modelLabel.slice(0, 33) + "…"
            : modelLabel;
          const model = svgElement("text", {
            class: "node-model",
            x: node.isLocalModel ? 6 : 0,
            y: 11,
            "text-anchor": "middle"
          });
          model.textContent = displayedModelLabel;
          if (node.isLocalModel && !node.isShelf) {
            const estimatedWidth = displayedModelLabel.length * 4.7;
            group.appendChild(localModelLeaf({
              x: 6 - estimatedWidth / 2 - 13,
              y: 3
            }));
          }
          group.appendChild(model);
        }
        group.appendChild(status);
        if (node.isCurrent) {
          const marker = svgElement("rect", {
            class: "current-marker",
            x: width / 2 - 54,
            y: -height / 2 - 7,
            width: 50,
            height: 17,
            rx: 8
          });
          const markerText = svgElement("text", {
            class: "current-marker-text",
            x: width / 2 - 29,
            y: -height / 2 + 5,
            "text-anchor": "middle"
          });
          markerText.textContent = "CURRENT";
          group.append(marker, markerText);
        }
        group.addEventListener("click", () => {
          if (node.isShelf) toggleCompletedShelf();
          else if (!node.synthetic) openInspector(node, true);
        });
        group.addEventListener("keydown", (event) => handleNodeKey(event, node));
        elements.nodes.appendChild(group);
      });
      updateSelection();
    }

    function handleNodeKey(event, node) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (node.isShelf) toggleCompletedShelf();
        else if (!node.synthetic) openInspector(node, true);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      const candidates = state.layout.nodes.filter((item) => item.id !== node.id);
      const direction = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }[event.key];
      const scored = candidates.flatMap((item) => {
        const dx = item.x - node.x;
        const dy = item.y - node.y;
        const directional = dx * direction[0] + dy * direction[1];
        if (directional <= 0) return [];
        const cross = Math.abs(dx * direction[1] - dy * direction[0]);
        return [{ item, score: directional + cross * 2 }];
      }).sort((left, right) => left.score - right.score);
      if (scored[0]) {
        event.preventDefault();
        elements.nodes.querySelector(
          '[data-id="' + CSS.escape(scored[0].item.id) + '"]'
        )?.focus();
      }
    }

    function updateSummary() {
      const counts = state.data.counts;
      const waiting = (counts["waiting-user"] || 0) + (counts["waiting-plan"] || 0);
      const live = waiting + (counts.busy || 0) + (counts.idle || 0);
      const scopeLabel = state.data.diagnostics?.effectiveScope === "all"
        ? "All sessions"
        : "Tree";
      elements.summary.textContent =
        scopeLabel + " · " + live + " live · " +
        (counts.completed || 0) + " completed · " + state.layout.orientation;
    }

    function render() {
      if (!state.data) return;
      const size = stageSize();
      const visibleState = filteredState();
      state.layout = layoutResponsiveConstellation(visibleState, {
        width: size.width,
        height: size.height,
        completedExpanded: state.completedExpanded
      });
      const byId = new Map(state.layout.nodes.map((node) => [node.id, node]));
      renderEdges(byId);
      renderNodes();
      renderLegend();
      updateSummary();
      const projectFilter = visibleState?.diagnostics?.projectFilter;
      elements.empty.textContent = projectFilter?.status === "ambiguous"
        ? "The project name is ambiguous. Use its project ID."
        : projectFilter?.status === "unknown"
          ? "The selected project is unavailable."
          : "No live sessions match these filters.";
      elements.empty.style.display = state.layout.nodes.length ? "none" : "grid";
      applyTransform();
      if (state.firstRender) {
        state.firstRender = false;
        state.selectedId = state.data.currentSessionId;
        requestAnimationFrame(() => homeCurrent({ smooth: false }));
      }
    }

    function homeCurrent({ smooth = true, resetZoom = true } = {}) {
      if (!state.layout) return;
      const target =
        state.layout.nodes.find((node) => node.id === state.data.currentSessionId) ||
        state.layout.nodes.find((node) => node.id === state.data.rootId);
      if (!target) return;
      if (resetZoom) {
        state.transform = { x: 0, y: 0, k: 1 };
        applyTransform();
      }
      const size = stageSize();
      elements.stage.scrollTo({
        left: Math.max(
          0,
          target.x * state.transform.k + state.transform.x - size.width / 2
        ),
        top: Math.max(
          0,
          target.y * state.transform.k + state.transform.y - size.height / 3
        ),
        behavior: smooth ? "smooth" : "auto"
      });
      state.selectedId = target.id;
      updateSelection();
    }

    function fitReadableWidth() {
      if (!state.layout) return;
      const size = stageSize();
      const k = fitWidthScale(size.width, state.layout.width);
      state.transform = { x: 0, y: 0, k };
      applyTransform();
      homeCurrent({ resetZoom: false });
    }

    function acceptState(next, announce) {
      if (!next || !Array.isArray(next.nodes) || !Array.isArray(next.edges)) return;
      state.data = next;
      state.scope = next.diagnostics?.effectiveScope === "all" ? "all" : "tree";
      elements.scopeSelect.value = state.scope;
      renderRepositories();
      renderProjects();
      render();
      elements.stage.setAttribute(
        "aria-label",
        state.scope === "all"
          ? "All Copilot sessions overview; dashed connections are synthetic grouping only"
          : "Agent family tree"
      );
      const selected = next.nodes.find((node) => node.id === state.selectedId);
      if (selected && elements.inspector.classList.contains("open")) openInspector(selected, false);
      if (announce) {
        elements.live.textContent = "Constellation refreshed. " +
          (next.diagnostics?.selectedRealSessionCount || 0) + " sessions available.";
      }
      const limitations = next.source?.limitations || [];
      elements.sourceNote.textContent = limitations.length
        ? "Sanitized metadata only. " + limitations.join(" ")
        : "Live sanitized metadata only; prompts, messages, secrets, and file contents are not returned.";
    }

    async function fetchState(url, options) {
      const response = await fetch(url, { cache: "no-store", ...(options || {}) });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }

    async function refresh(manual) {
      elements.refresh.disabled = true;
      try {
        const next = manual
          ? await fetchState(config.refreshUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}"
            })
          : await fetchState(config.stateUrl);
        acceptState(next, manual);
      } catch {
        elements.live.textContent = "Constellation refresh failed. Existing state remains visible.";
      } finally {
        elements.refresh.disabled = false;
      }
    }

    async function switchScope(scope) {
      if (!["tree", "all"].includes(scope) || scope === state.scope) return;
      elements.scopeSelect.disabled = true;
      try {
        const next = await fetchState(config.scopeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope })
        });
        state.firstRender = true;
        acceptState(next, false);
        elements.live.textContent =
          "View changed to " + (scope === "all" ? "All sessions" : "Tree") + ". " +
          (next.diagnostics?.selectedRealSessionCount || 0) + " sessions available.";
      } catch {
        elements.scopeSelect.value = state.scope;
        elements.live.textContent = "Scope change failed. Existing view remains visible.";
      } finally {
        elements.scopeSelect.disabled = false;
      }
    }

    function pointerPoint(event) {
      const rect = elements.stage.getBoundingClientRect();
      return {
        x: event.clientX - rect.left + elements.stage.scrollLeft,
        y: event.clientY - rect.top + elements.stage.scrollTop
      };
    }

    function startGesture() {
      const contacts = [...state.pointers.values()];
      if (contacts.length >= 2) {
        state.gesture = {
          mode: "pinch",
          startA: { ...contacts[0] },
          startB: { ...contacts[1] },
          transform: { ...state.transform }
        };
      } else if (contacts.length === 1) {
        state.gesture = {
          mode: "pan",
          pointerId: contacts[0].pointerId,
          start: { ...contacts[0] },
          transform: { ...state.transform }
        };
      } else {
        state.gesture = null;
      }
    }

    function finishPointer(event) {
      state.pointers.delete(event.pointerId);
      try {
        if (elements.constellation.hasPointerCapture(event.pointerId)) {
          elements.constellation.releasePointerCapture(event.pointerId);
        }
      } catch {}
      startGesture();
    }

    elements.refresh.addEventListener("click", () => refresh(true));
    elements.scopeSelect.value = state.scope;
    elements.scopeSelect.addEventListener("change", () => switchScope(elements.scopeSelect.value));
    elements.home.addEventListener("click", () => homeCurrent());
    elements.fitWidth.addEventListener("click", fitReadableWidth);
    elements.zoomIn.addEventListener("click", () => setZoom(state.transform.k * 1.16));
    elements.zoomOut.addEventListener("click", () => setZoom(state.transform.k / 1.16));
    elements.filtersToggle.addEventListener("click", () => {
      const open = elements.filters.classList.toggle("open");
      elements.filtersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    elements.inspectorClose.addEventListener("click", () => closeInspector());
    elements.statusFilter.value = state.status;
    elements.statusFilter.addEventListener("change", () => {
      state.status = elements.statusFilter.value;
      if (state.status === "completed") state.completedExpanded = true;
      render();
    });
    elements.repoFilter.addEventListener("change", () => {
      state.repository = elements.repoFilter.value;
      render();
    });
    elements.projectFilter.addEventListener("change", () => {
      state.project = elements.projectFilter.value;
      render();
    });
    elements.constellation.addEventListener("wheel", (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = elements.stage.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * .0025);
      setZoom(
        state.transform.k * factor,
        event.clientX - rect.left,
        event.clientY - rect.top
      );
    }, { passive: false });
    elements.constellation.addEventListener("dblclick", (event) => {
      if (event.target.closest(".node")) return;
      const rect = elements.stage.getBoundingClientRect();
      setZoom(
        state.transform.k * 1.25,
        event.clientX - rect.left,
        event.clientY - rect.top
      );
    });
    elements.constellation.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".node")) return;
      const point = { ...pointerPoint(event), pointerId: event.pointerId };
      state.pointers.set(event.pointerId, point);
      elements.constellation.setPointerCapture(event.pointerId);
      startGesture();
    });
    elements.constellation.addEventListener("pointermove", (event) => {
      if (!state.pointers.has(event.pointerId)) return;
      state.pointers.set(event.pointerId, {
        ...pointerPoint(event),
        pointerId: event.pointerId
      });
      const contacts = [...state.pointers.values()];
      if (contacts.length >= 2 && state.gesture?.mode === "pinch") {
        state.transform = applyPinchGesture({
          transform: state.gesture.transform,
          startA: state.gesture.startA,
          startB: state.gesture.startB,
          currentA: contacts[0],
          currentB: contacts[1]
        });
      } else if (contacts.length === 1 && state.gesture?.mode === "pan") {
        state.transform = {
          ...state.gesture.transform,
          x: state.gesture.transform.x + contacts[0].x - state.gesture.start.x,
          y: state.gesture.transform.y + contacts[0].y - state.gesture.start.y
        };
      }
      applyTransform();
    });
    elements.constellation.addEventListener("pointerup", finishPointer);
    elements.constellation.addEventListener("pointercancel", finishPointer);
    elements.constellation.addEventListener("lostpointercapture", finishPointer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && elements.inspector.classList.contains("open")) {
        event.preventDefault();
        closeInspector();
      }
      if (event.target.matches("select, button")) return;
      if (event.key === "+" || event.key === "=") setZoom(state.transform.k * 1.16);
      if (event.key === "-") setZoom(state.transform.k / 1.16);
      if (event.key === "Home") {
        event.preventDefault();
        homeCurrent();
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!state.data) return;
      const previousOrientation = state.layout?.orientation;
      render();
      if (previousOrientation !== state.layout.orientation) homeCurrent({ smooth: false });
    });
    resizeObserver.observe(elements.stage);

    refresh(false);
    const events = new EventSource(config.eventsUrl);
    events.addEventListener("state", (event) => {
      try { acceptState(JSON.parse(event.data), true); } catch {}
    });
    events.onerror = () => {
      window.setTimeout(() => refresh(false), 3000);
    };
    window.setInterval(() => {
      elements.nodes.querySelectorAll(".node").forEach((group) => {
        const node = state.layout?.nodes.find((item) => item.id === group.dataset.id);
        const label = group.querySelector(".node-status");
        if (node && label && !node.isShelf) label.textContent = statusText(node);
      });
      if (elements.inspector.classList.contains("open")) {
        const selected = state.data?.nodes.find((node) => node.id === state.selectedId);
        if (selected) elements.detailStatus.lastElementChild.textContent = statusText(selected);
      }
    }, 1000);
    window.setInterval(() => refresh(false), 30000);
  </script>
</body>
</html>`;
}
