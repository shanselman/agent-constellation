const SNAPSHOT_SCHEMA = "agent-constellation.snapshot";
const SNAPSHOT_VERSION = 1;
const allowedStatuses = new Set([
    "busy",
    "waiting-user",
    "waiting-plan",
    "blocked",
    "failed",
    "completed",
    "idle",
    "archived",
]);
const allowedGateTypes = new Set(["user", "plan", "permission"]);
const identifierPattern = /^[a-z0-9][a-z0-9._:/+-]*$/i;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const sensitiveIdentifierPattern =
    /(?:^|[-_.:/])(bearer|cookie|password|secret|token)(?:$|[-_.:/])|^(?:gh[pousr]_|github_pat_|sk-|eyJ)/i;

function cleanText(value, maximum) {
    if (typeof value !== "string") return "";
    return value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum);
}

function safeIdentifier(value, maximum) {
    const text = cleanText(value, maximum);
    if (
        !identifierPattern.test(text) ||
        sensitiveIdentifierPattern.test(text) ||
        /^[a-z]:[\\/]/i.test(text) ||
        text.startsWith("/") ||
        /^file:/i.test(text)
    ) {
        return undefined;
    }
    return text;
}

function safeRepository(value) {
    const text = cleanText(value, 180).replace(/\.git$/i, "");
    return repositoryPattern.test(text) ? text : "Unknown repository";
}

function safeTimestamp(value) {
    const timestamp = Date.parse(typeof value === "string" ? value : "");
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeAvailability(value, fallback) {
    return ["available", "unavailable", "partial"].includes(value) ? value : fallback;
}

function compareText(left, right) {
    const normalizedLeft = String(left ?? "").toLowerCase();
    const normalizedRight = String(right ?? "").toLowerCase();
    return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function compareInternalNodes(left, right) {
    return (
        compareText(left.repository, right.repository) ||
        compareText(left.status, right.status) ||
        compareText(left.model, right.model) ||
        compareText(left.id, right.id)
    );
}

function orderedNodes(state) {
    const unique = new Map();
    for (const input of Array.isArray(state?.nodes) ? state.nodes : []) {
        const id = cleanText(input?.id, 160);
        if (!id || unique.has(id)) continue;
        unique.set(id, {
            id,
            parentId: cleanText(input?.parentId, 160) || undefined,
            repository: safeRepository(input?.repository),
            status: allowedStatuses.has(input?.status) ? input.status : "idle",
            mode: safeIdentifier(input?.mode, 30),
            provider: safeIdentifier(input?.provider, 80),
            model: safeIdentifier(input?.model, 100),
            reasoningEffort: safeIdentifier(input?.reasoningEffort, 30),
            isLocalModel: input?.isLocalModel === true,
            demoLocalModel: input?.demoLocalModel === true,
            gateType: allowedGateTypes.has(input?.humanGate?.type)
                ? input.humanGate.type
                : undefined,
        });
    }

    const children = new Map();
    for (const node of unique.values()) {
        if (!node.parentId || !unique.has(node.parentId)) continue;
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node);
    }
    for (const items of children.values()) items.sort(compareInternalNodes);

    const ordered = [];
    const visited = new Set();
    function visit(node) {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        ordered.push(node);
        for (const child of children.get(node.id) ?? []) visit(child);
    }

    visit(unique.get(cleanText(state?.rootId, 160)));
    for (const node of [...unique.values()].sort(compareInternalNodes)) visit(node);
    return ordered;
}

function compactObject(entries) {
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export function buildJsonSnapshot(state) {
    const ordered = orderedNodes(state);
    const aliases = new Map(
        ordered.map((node, index) => [node.id, `session-${String(index + 1).padStart(3, "0")}`])
    );
    const nodes = ordered.map((node) =>
        compactObject([
            ["alias", aliases.get(node.id)],
            ["parentAlias", aliases.get(node.parentId)],
            ["repository", node.repository],
            ["status", node.status],
            ["mode", node.mode],
            [
                "model",
                node.provider || node.model || node.reasoningEffort || node.isLocalModel
                    ? compactObject([
                          ["provider", node.provider],
                          ["name", node.model],
                          ["reasoningEffort", node.reasoningEffort],
                          ["local", node.isLocalModel || undefined],
                      ])
                    : undefined,
            ],
            ["humanGate", node.gateType ? { type: node.gateType } : undefined],
            ["root", node.id === cleanText(state?.rootId, 160) || undefined],
            ["current", node.id === cleanText(state?.currentSessionId, 160) || undefined],
        ])
    );
    const counts = Object.fromEntries(
        [...allowedStatuses].map((status) => [
            status,
            nodes.filter((node) => node.status === status).length,
        ])
    );
    const demo = ordered.some((node) => node.demoLocalModel);

    return {
        schema: SNAPSHOT_SCHEMA,
        schemaVersion: SNAPSHOT_VERSION,
        generatedAt: safeTimestamp(state?.generatedAt),
        provenance: {
            application: "Agent Constellation",
            stateVersion: Number.isInteger(state?.version) ? state.version : null,
            source: demo ? "demo" : "live-local-metadata",
            demo,
            metadataAvailability: {
                appDatabase: safeAvailability(state?.source?.appDatabase, "unavailable"),
                sessionStore: safeAvailability(state?.source?.sessionStore, "unavailable"),
                eventMetadata: safeAvailability(state?.source?.eventMetadata, "partial"),
            },
        },
        privacy: {
            sessionIdentifiers: "Replaced with aliases that are stable only within this snapshot.",
            included: [
                "topology",
                "status",
                "repository labels",
                "model metadata",
                "mode",
                "human-gate type",
            ],
            excluded: [
                "session and workspace IDs",
                "machine-specific paths",
                "session names and branches",
                "prompts and messages",
                "tasks and raw references",
                "secrets, cookies, and page tokens",
                "raw event data",
            ],
        },
        rootAlias: aliases.get(cleanText(state?.rootId, 160)) ?? null,
        currentAlias: aliases.get(cleanText(state?.currentSessionId, 160)) ?? null,
        counts,
        nodes,
    };
}

export function serializeJsonSnapshot(state) {
    return `${JSON.stringify(buildJsonSnapshot(state), null, 2)}\n`;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function modelLabel(model) {
    if (!model) return "";
    return [
        model.provider,
        model.name,
        model.reasoningEffort,
        model.local ? "local" : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

export function buildVisualSnapshot(state) {
    const snapshot = buildJsonSnapshot(state);
    const cards = snapshot.nodes
        .map((node) => {
            const badges = [
                node.root ? "root" : "",
                node.current ? "current" : "",
                node.humanGate?.type ? `gate: ${node.humanGate.type}` : "",
            ].filter(Boolean);
            return `<article class="card status-${escapeHtml(node.status)}">
  <div class="card-head"><strong>${escapeHtml(node.alias)}</strong><span>${escapeHtml(node.status)}</span></div>
  <div>${escapeHtml(node.repository)}</div>
  ${node.parentAlias ? `<small>Parent: ${escapeHtml(node.parentAlias)}</small>` : "<small>Constellation root</small>"}
  ${modelLabel(node.model) ? `<small>Model: ${escapeHtml(modelLabel(node.model))}</small>` : ""}
  ${node.mode ? `<small>Mode: ${escapeHtml(node.mode)}</small>` : ""}
  ${badges.length ? `<small>${escapeHtml(badges.join(" · "))}</small>` : ""}
</article>`;
        })
        .join("\n");
    const generatedAt = snapshot.generatedAt
        ? `<time datetime="${escapeHtml(snapshot.generatedAt)}">${escapeHtml(snapshot.generatedAt)}</time>`
        : "Not recorded";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Constellation safe snapshot</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#0d1117;color:#f0f6fc}
*{box-sizing:border-box}body{margin:0;padding:24px;background:#0d1117;color:#f0f6fc}
main{max-width:1100px;margin:auto}h1{margin:0 0 4px}.meta,.privacy{color:#a7b0ba}
.privacy{border:1px solid #3d444d;border-radius:10px;padding:12px 16px;margin:20px 0;background:#151b23}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.card{border:2px solid #8b949e;border-radius:10px;padding:12px;background:#161b22;min-height:130px}
.card-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}.card small{display:block;color:#a7b0ba;margin-top:7px}
.status-busy{border-color:#2f81f7}.status-completed{border-color:#3fb950}.status-waiting-user,.status-waiting-plan{border-color:#d29922}
.status-blocked{border-color:#db6d28}.status-failed{border-color:#f85149}.status-archived{border-color:#6e7681}
@media print{body{background:#fff;color:#111}.card,.privacy{background:#fff;color:#111;break-inside:avoid}.meta,.privacy,.card small{color:#444}}
</style>
</head>
<body>
<main>
<h1>Agent Constellation safe snapshot</h1>
<div class="meta">Generated: ${generatedAt} · Provenance: ${escapeHtml(snapshot.provenance.source)} · Schema v${snapshot.schemaVersion}</div>
<section class="privacy">
<strong>Privacy guarantee</strong>
<p>This saved view uses snapshot-only aliases and excludes session IDs, machine paths, names, branches, prompts, messages, tasks, raw references, secrets, cookies, page tokens, and raw events.</p>
</section>
<section class="grid" aria-label="Sanitized constellation">${cards || "<p>No sessions were available.</p>"}</section>
</main>
</body>
</html>`;
}

export { SNAPSHOT_SCHEMA, SNAPSHOT_VERSION };
