import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATUSES = [
    "busy",
    "waiting-user",
    "waiting-plan",
    "blocked",
    "failed",
    "completed",
    "idle",
    "archived",
];

export const FILTER_PROPERTIES = {
    status: { type: "string", enum: STATUSES },
    repository: { type: "string", minLength: 1, maxLength: 180 },
};

export const CANVAS_OPEN_INPUT_SCHEMA = {
    type: "object",
    properties: {
        ...FILTER_PROPERTIES,
        demoLocalModel: { type: "boolean" },
    },
    additionalProperties: false,
};

const statusPriority = new Map(STATUSES.map((status, index) => [status, index]));
const localProviders = new Set(["ollama", "winml", "local"]);
const localModelPrefix = /^(?:ollama|winml|local)[/:]/;

export function sanitizeText(value, maxLength = 180) {
    if (typeof value !== "string") return "";
    return value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

export function isLocalModelMetadata({ provider, model } = {}) {
    const normalizedProvider = sanitizeText(provider, 80).toLowerCase();
    const normalizedModel = sanitizeText(model, 100).toLowerCase();
    return (
        localProviders.has(normalizedProvider) ||
        localModelPrefix.test(normalizedModel)
    );
}

function parseTimestamp(value) {
    const timestamp = Date.parse(typeof value === "string" ? value : "");
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function isoTimestamp(value) {
    const timestamp = parseTimestamp(value);
    return timestamp ? new Date(timestamp).toISOString() : undefined;
}

function shortId(value) {
    return sanitizeText(value, 36).slice(0, 8) || "unknown";
}

function databaseRows(database, sql, parameters = []) {
    try {
        return database.prepare(sql).all(...parameters);
    } catch {
        return [];
    }
}

function databaseColumns(database, table) {
    return new Set(
        databaseRows(database, `PRAGMA table_info(${table})`)
            .map((row) => sanitizeText(row.name, 80))
            .filter(Boolean)
    );
}

function openReadonlyDatabase(filePath) {
    if (!filePath || !existsSync(filePath)) return undefined;
    try {
        return new DatabaseSync(filePath, { readOnly: true });
    } catch {
        return undefined;
    }
}

function repositoryLabel(value) {
    const text = sanitizeText(value, 240).replaceAll("\\", "/").replace(/\.git$/i, "");
    if (!text) return "";
    try {
        const url = new URL(text);
        return url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/").slice(-2).join("/");
    } catch {
        const segments = text.split("/").filter(Boolean);
        if (/^[a-z]:$/i.test(segments[0] ?? "")) {
            return segments.at(-1) ?? "";
        }
        return segments.length > 2 ? segments.slice(-2).join("/") : segments.join("/");
    }
}

function readEventTail(sessionStateRoot, sessionId, maxBytes = 768_000) {
    const result = {
        lastActivityAt: 0,
        latestTurnStartAt: 0,
        latestTurnEndAt: 0,
        latestTaskCompleteAt: 0,
        latestErrorAt: 0,
        latestUserMessageAt: 0,
        outstandingAskUser: false,
        outstandingPermission: false,
        available: false,
    };
    const eventPath = path.join(sessionStateRoot, sessionId, "events.jsonl");
    if (!existsSync(eventPath)) return result;

    let descriptor;
    try {
        descriptor = openSync(eventPath, "r");
        const size = fstatSync(descriptor).size;
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        readSync(descriptor, buffer, 0, length, size - length);
        let text = buffer.toString("utf8");
        if (size > length) {
            text = text.slice(text.indexOf("\n") + 1);
        }
        const pendingTools = new Map();
        let latestPermissionRequestAt = 0;
        let latestPermissionCompleteAt = 0;
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                continue;
            }
            const timestamp = parseTimestamp(event.timestamp);
            result.lastActivityAt = Math.max(result.lastActivityAt, timestamp);
            switch (event.type) {
                case "assistant.turn_start":
                    result.latestTurnStartAt = Math.max(result.latestTurnStartAt, timestamp);
                    break;
                case "assistant.turn_end":
                    result.latestTurnEndAt = Math.max(result.latestTurnEndAt, timestamp);
                    break;
                case "session.task_complete":
                    result.latestTaskCompleteAt = Math.max(result.latestTaskCompleteAt, timestamp);
                    break;
                case "session.error":
                    result.latestErrorAt = Math.max(result.latestErrorAt, timestamp);
                    break;
                case "user.message":
                    result.latestUserMessageAt = Math.max(result.latestUserMessageAt, timestamp);
                    break;
                case "tool.execution_start": {
                    const callId = sanitizeText(event.data?.toolCallId, 160);
                    const toolName = sanitizeText(event.data?.toolName, 80);
                    if (callId && toolName) pendingTools.set(callId, toolName);
                    break;
                }
                case "tool.execution_complete": {
                    const callId = sanitizeText(event.data?.toolCallId, 160);
                    if (callId) pendingTools.delete(callId);
                    break;
                }
                case "permission.requested":
                    latestPermissionRequestAt = Math.max(latestPermissionRequestAt, timestamp);
                    break;
                case "permission.completed":
                    latestPermissionCompleteAt = Math.max(latestPermissionCompleteAt, timestamp);
                    break;
            }
        }
        result.outstandingAskUser = [...pendingTools.values()].includes("ask_user");
        result.outstandingPermission = latestPermissionRequestAt > latestPermissionCompleteAt;
        result.available = true;
    } catch {
        return result;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
    return result;
}

function latestActivities(database) {
    const activities = new Map();
    const rows = databaseRows(
        database,
        `SELECT session_id, activity_type, updated_at
         FROM activity_items
         WHERE session_id IS NOT NULL
           AND activity_type IN ('agent_asking', 'agent_error', 'agent_idle')
         ORDER BY updated_at DESC
         LIMIT 5000`
    );
    for (const row of rows) {
        if (typeof row.session_id !== "string" || activities.has(row.session_id)) continue;
        activities.set(row.session_id, {
            type: sanitizeText(row.activity_type, 40),
            timestamp: parseTimestamp(row.updated_at),
        });
    }
    return activities;
}

function deriveStatus(sessionRow, eventState, activity) {
    const archived = Boolean(sessionRow.session_archived_at || sessionRow.workspace_archived_at);
    if (archived) return { status: "archived" };

    const asking = eventState.outstandingAskUser || activity?.type === "agent_asking";
    if (asking) {
        const plan = sessionRow.mode === "plan";
        return {
            status: plan ? "waiting-plan" : "waiting-user",
            humanGate: {
                type: plan ? "plan" : "user",
                label: plan ? "Plan approval required" : "User response required",
            },
        };
    }
    if (eventState.outstandingPermission) {
        return {
            status: "blocked",
            humanGate: { type: "permission", label: "Permission decision required" },
        };
    }

    const latestError = Math.max(
        eventState.latestErrorAt,
        activity?.type === "agent_error" ? activity.timestamp : 0
    );
    const recoveredAfterError =
        Number(sessionRow.is_running) === 1 ||
        eventState.latestTurnStartAt > latestError ||
        (activity?.type === "agent_idle" && activity.timestamp > latestError);
    if ((Number(sessionRow.was_interrupted) === 1 || latestError) && !recoveredAfterError) {
        return { status: "failed" };
    }
    if (Number(sessionRow.is_running) === 1) {
        const busySince =
            eventState.latestUserMessageAt ||
            eventState.latestTurnStartAt ||
            eventState.lastActivityAt ||
            activity?.timestamp ||
            parseTimestamp(sessionRow.updated_at) ||
            parseTimestamp(sessionRow.created_at);
        return {
            status: "busy",
            busySince: busySince ? new Date(busySince).toISOString() : undefined,
        };
    }

    const completedAfterLatestPrompt =
        eventState.latestTaskCompleteAt > 0 &&
        eventState.latestTaskCompleteAt >= eventState.latestUserMessageAt;
    return { status: completedAfterLatestPrompt ? "completed" : "idle" };
}

function readApplicationRows(appDatabase) {
    if (!appDatabase) {
        return {
            sessions: [],
            workspaces: [],
            aliases: [],
            parents: [],
            projects: [],
            repoContexts: [],
            activities: new Map(),
        };
    }
    const sessionColumns = databaseColumns(appDatabase, "sessions");
    const providerSelection = sessionColumns.has("provider_id")
        ? "provider_id"
        : "NULL AS provider_id";
    return {
        sessions: databaseRows(
            appDatabase,
            `SELECT id, mode, model, reasoning_effort, ${providerSelection},
                    is_running, was_interrupted,
                    created_at, updated_at, archived_at AS session_archived_at,
                    forked_from_session_id
             FROM sessions`
        ),
        workspaces: databaseRows(
            appDatabase,
            `SELECT id, project_id, branch, name, session_id, archived_at AS workspace_archived_at,
                    creator_session_id, coordinating_creator_session_id,
                    source_pr_repo_full_name, source_pr_number,
                    source_issue_repo_full_name, source_issue_number,
                    created_pr_repo_full_name, created_pr_number
             FROM workspaces`
        ),
        aliases: databaseRows(appDatabase, "SELECT session_id, workspace_id FROM workspace_session_aliases"),
        parents: databaseRows(
            appDatabase,
            "SELECT child_workspace_id, parent_workspace_id, creator_session_id FROM workspace_parent_links"
        ),
        projects: databaseRows(
            appDatabase,
            "SELECT id, name, github_owner, github_repo, main_repo_path FROM projects"
        ),
        repoContexts: databaseRows(
            appDatabase,
            `SELECT workspace_id, repo_full_name, source_pr_number,
                    source_issue_number, created_pr_number
             FROM workspace_repo_contexts`
        ),
        activities: latestActivities(appDatabase),
    };
}

function readSessionStoreRows(sessionStoreDatabase) {
    if (!sessionStoreDatabase) return { sessions: new Map(), refs: new Map() };
    const sessions = new Map();
    for (const row of databaseRows(
        sessionStoreDatabase,
        `SELECT id, cwd, repository, branch, created_at, updated_at
         FROM sessions
         ORDER BY updated_at DESC
         LIMIT 5000`
    )) {
        if (typeof row.id === "string" && !sessions.has(row.id)) sessions.set(row.id, row);
    }
    const refs = new Map();
    for (const row of databaseRows(
        sessionStoreDatabase,
        `SELECT session_id, ref_type, ref_value, created_at
         FROM session_refs
         WHERE ref_type IN ('pr', 'issue', 'task')
         ORDER BY created_at DESC
         LIMIT 5000`
    )) {
        if (typeof row.session_id !== "string") continue;
        if (!refs.has(row.session_id)) refs.set(row.session_id, []);
        const items = refs.get(row.session_id);
        if (items.length >= 8) continue;
        items.push({
            type: sanitizeText(row.ref_type, 20),
            value: sanitizeText(row.ref_value, 180),
        });
    }
    return { sessions, refs };
}

function referenceDetails(workspace, repoContext, storeRefs) {
    const prNumber =
        Number(workspace?.source_pr_number) ||
        Number(repoContext?.source_pr_number) ||
        Number(workspace?.created_pr_number) ||
        Number(repoContext?.created_pr_number) ||
        undefined;
    const issueNumber =
        Number(workspace?.source_issue_number) || Number(repoContext?.source_issue_number) || undefined;
    const taskRef = storeRefs.find((ref) => ref.type === "task");
    const fallbackPr = storeRefs.find((ref) => ref.type === "pr");
    const fallbackIssue = storeRefs.find((ref) => ref.type === "issue");
    return {
        task: taskRef?.value || undefined,
        pullRequest: prNumber ? `#${prNumber}` : fallbackPr?.value || undefined,
        issue: issueNumber ? `#${issueNumber}` : fallbackIssue?.value || undefined,
    };
}

function buildRawNodes(rows, store, sessionStateRoot) {
    const sessionsById = new Map(rows.sessions.map((row) => [row.id, row]));
    const projectsById = new Map(rows.projects.map((row) => [row.id, row]));
    const workspaceById = new Map(rows.workspaces.map((row) => [row.id, row]));
    const workspaceBySession = new Map();
    for (const workspace of rows.workspaces) {
        if (typeof workspace.session_id === "string") workspaceBySession.set(workspace.session_id, workspace);
    }
    for (const alias of rows.aliases) {
        const workspace = workspaceById.get(alias.workspace_id);
        if (workspace && typeof alias.session_id === "string" && !workspaceBySession.has(alias.session_id)) {
            workspaceBySession.set(alias.session_id, workspace);
        }
    }
    const sessionByWorkspace = new Map();
    for (const [sessionId, workspace] of workspaceBySession) {
        if (!sessionByWorkspace.has(workspace.id)) sessionByWorkspace.set(workspace.id, sessionId);
    }
    const parentByWorkspace = new Map(
        rows.parents.map((row) => [row.child_workspace_id, row])
    );
    const contextByWorkspace = new Map();
    for (const context of rows.repoContexts) {
        if (!contextByWorkspace.has(context.workspace_id)) contextByWorkspace.set(context.workspace_id, context);
    }

    const nodes = new Map();
    for (const sessionRow of rows.sessions) {
        if (typeof sessionRow.id !== "string") continue;
        const workspace = workspaceBySession.get(sessionRow.id);
        const project = workspace ? projectsById.get(workspace.project_id) : undefined;
        const repoContext = workspace ? contextByWorkspace.get(workspace.id) : undefined;
        const storeRow = store.sessions.get(sessionRow.id);
        const parentLink = workspace ? parentByWorkspace.get(workspace.id) : undefined;
        const parentSessionId =
            sessionByWorkspace.get(parentLink?.parent_workspace_id) ||
            sanitizeText(parentLink?.creator_session_id, 80) ||
            sanitizeText(workspace?.coordinating_creator_session_id, 80) ||
            sanitizeText(workspace?.creator_session_id, 80) ||
            sanitizeText(sessionRow.forked_from_session_id, 80) ||
            undefined;
        const repository =
            repositoryLabel(
                repoContext?.repo_full_name ||
                    workspace?.source_pr_repo_full_name ||
                    workspace?.source_issue_repo_full_name ||
                    workspace?.created_pr_repo_full_name ||
                    (project?.github_owner && project?.github_repo
                        ? `${project.github_owner}/${project.github_repo}`
                        : "") ||
                    storeRow?.repository ||
                    project?.main_repo_path
            ) || "Unknown repository";
        const events = readEventTail(sessionStateRoot, sessionRow.id);
        const statusDetails = deriveStatus(sessionRow, events, rows.activities.get(sessionRow.id));
        const refs = referenceDetails(workspace, repoContext, store.refs.get(sessionRow.id) ?? []);
        nodes.set(sessionRow.id, {
            id: sessionRow.id,
            parentId: parentSessionId,
            workspaceId: sanitizeText(workspace?.id, 80) || undefined,
            name:
                sanitizeText(workspace?.name, 140) ||
                `Session ${shortId(sessionRow.id)}`,
            repository,
            branch: sanitizeText(workspace?.branch || storeRow?.branch, 180) || undefined,
            mode: sanitizeText(sessionRow.mode, 30) || undefined,
            provider: sanitizeText(sessionRow.provider_id, 80) || undefined,
            model: sanitizeText(sessionRow.model, 100) || undefined,
            reasoningEffort: sanitizeText(sessionRow.reasoning_effort, 30) || undefined,
            createdAt: isoTimestamp(sessionRow.created_at || storeRow?.created_at),
            updatedAt: isoTimestamp(
                events.lastActivityAt
                    ? new Date(events.lastActivityAt).toISOString()
                    : sessionRow.updated_at || storeRow?.updated_at
            ),
            ...refs,
            ...statusDetails,
        });
    }
    return nodes;
}

function fallbackRoot(currentSessionId, store, sessionStateRoot) {
    const row = store.sessions.get(currentSessionId);
    const events = readEventTail(sessionStateRoot, currentSessionId);
    return {
        id: currentSessionId,
        name: `Current session ${shortId(currentSessionId)}`,
        repository: repositoryLabel(row?.repository || row?.cwd) || "Unknown repository",
        branch: sanitizeText(row?.branch, 180) || undefined,
        createdAt: isoTimestamp(row?.created_at),
        updatedAt: isoTimestamp(
            events.lastActivityAt ? new Date(events.lastActivityAt).toISOString() : row?.updated_at
        ),
        status: "idle",
    };
}

function descendantsOf(rootId, rawNodes) {
    const children = new Map();
    for (const node of rawNodes.values()) {
        if (!node.parentId) continue;
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node.id);
    }
    const selected = [];
    const queue = [rootId];
    const visited = new Set();
    while (queue.length) {
        const id = queue.shift();
        if (!id || visited.has(id)) continue;
        visited.add(id);
        const node = rawNodes.get(id);
        if (node) selected.push(node);
        for (const childId of children.get(id) ?? []) queue.push(childId);
    }
    return selected;
}

function topmostAccessibleAncestor(currentSessionId, nodes) {
    let rootId = currentSessionId;
    const visited = new Set();
    while (nodes.has(rootId) && !visited.has(rootId)) {
        visited.add(rootId);
        const parentId = nodes.get(rootId)?.parentId;
        if (!parentId || !nodes.has(parentId) || visited.has(parentId)) break;
        rootId = parentId;
    }
    return rootId;
}

export function layoutConstellation(nodes, rootId, currentSessionId = rootId) {
    const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
    if (!byId.has(rootId)) return { nodes: [], edges: [], width: 960, height: 600 };
    const children = new Map();
    for (const node of byId.values()) {
        if (!node.parentId || !byId.has(node.parentId)) continue;
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node.id);
    }
    for (const items of children.values()) {
        items.sort((leftId, rightId) => {
            const left = byId.get(leftId);
            const right = byId.get(rightId);
            const statusDelta =
                (statusPriority.get(left.status) ?? 99) - (statusPriority.get(right.status) ?? 99);
            return statusDelta || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
        });
    }

    let nextLeaf = 0;
    let maxDepth = 0;
    const positioned = new Map();
    function place(id, depth, lineage) {
        if (lineage.has(id)) return nextLeaf++;
        maxDepth = Math.max(maxDepth, depth);
        const nextLineage = new Set(lineage).add(id);
        const childIds = children.get(id) ?? [];
        const childPositions = childIds.map((childId) => place(childId, depth + 1, nextLineage));
        const leaf = childPositions.length
            ? childPositions.reduce((sum, value) => sum + value, 0) / childPositions.length
            : nextLeaf++;
        positioned.set(id, { leaf, depth });
        return leaf;
    }
    place(rootId, 0, new Set());

    const leafCount = Math.max(1, nextLeaf);
    const width = Math.max(960, leafCount * 230 + 140);
    const height = Math.max(600, (maxDepth + 1) * 190 + 140);
    const horizontalStep = leafCount === 1 ? 0 : (width - 220) / (leafCount - 1);
    const laidOutNodes = [...positioned.entries()].map(([id, position]) => ({
        ...byId.get(id),
        depth: position.depth,
        x: leafCount === 1 ? width / 2 : 110 + position.leaf * horizontalStep,
        y: 90 + position.depth * 190,
        isRoot: id === rootId,
        isCurrent: id === currentSessionId,
    }));
    const edges = laidOutNodes
        .filter((node) => node.parentId && positioned.has(node.parentId))
        .map((node) => ({ source: node.parentId, target: node.id }));
    return { nodes: laidOutNodes, edges, width, height };
}

export function normalizeConstellation(rawNodes, currentSessionId, metadata = {}) {
    const currentId = sanitizeText(currentSessionId, 80);
    const unique = new Map();
    for (const input of rawNodes) {
        const id = sanitizeText(input?.id, 80);
        if (!id || unique.has(id)) continue;
        const status = STATUSES.includes(input.status) ? input.status : "idle";
        const provider = sanitizeText(input.provider, 80) || undefined;
        const model = sanitizeText(input.model, 100) || undefined;
        unique.set(id, {
            id,
            parentId: sanitizeText(input.parentId, 80) || undefined,
            workspaceId: sanitizeText(input.workspaceId, 80) || undefined,
            name: sanitizeText(input.name, 140) || `Session ${shortId(id)}`,
            repository: sanitizeText(input.repository, 180) || "Unknown repository",
            branch: sanitizeText(input.branch, 180) || undefined,
            mode: sanitizeText(input.mode, 30) || undefined,
            provider,
            model,
            reasoningEffort: sanitizeText(input.reasoningEffort, 30) || undefined,
            isLocalModel: isLocalModelMetadata({ provider, model }),
            task: sanitizeText(input.task, 180) || undefined,
            pullRequest: sanitizeText(input.pullRequest, 180) || undefined,
            issue: sanitizeText(input.issue, 180) || undefined,
            createdAt: isoTimestamp(input.createdAt),
            updatedAt: isoTimestamp(input.updatedAt),
            busySince: isoTimestamp(input.busySince),
            humanGate: input.humanGate
                ? {
                      type: sanitizeText(input.humanGate.type, 30),
                      label: sanitizeText(input.humanGate.label, 100),
                  }
                : undefined,
            status,
        });
    }
    if (!unique.has(currentId)) {
        unique.set(currentId, {
            id: currentId,
            name: `Current session ${shortId(currentId)}`,
            repository: "Unknown repository",
            status: "idle",
        });
    }
    const rootId = topmostAccessibleAncestor(currentId, unique);
    const selected = descendantsOf(rootId, unique);
    const layout = layoutConstellation(selected, rootId, currentId);
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const node of layout.nodes) counts[node.status]++;
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        rootId,
        currentSessionId: currentId,
        ...layout,
        counts,
        repositories: [...new Set(layout.nodes.map((node) => node.repository))].sort(),
        source: {
            appDatabase: metadata.appDatabase ? "available" : "unavailable",
            sessionStore: metadata.sessionStore ? "available" : "unavailable",
            eventMetadata: metadata.eventMetadata ? "available" : "partial",
            limitations: Array.isArray(metadata.limitations)
                ? metadata.limitations.map((item) => sanitizeText(item, 180)).filter(Boolean)
                : [],
        },
    };
}

export function decorateConstellationForDemo(state) {
    const decorated = structuredClone(state);
    decorated.nodes = decorated.nodes.map((node) =>
        node.id === decorated.currentSessionId
            ? {
                  ...node,
                  provider: "ollama",
                  model: "ollama/llama-3.3",
                  reasoningEffort: "high",
                  isLocalModel: true,
                  demoLocalModel: true,
              }
            : node
    );
    return decorated;
}

export function filterConstellationState(state, input = {}) {
    const status = STATUSES.includes(input?.status) ? input.status : undefined;
    const repository = sanitizeText(input?.repository, 180);
    if (!status && !repository) return state;
    const keep = new Set(
        state.nodes
            .filter(
                (node) =>
                    (!status || node.status === status) &&
                    (!repository || node.repository.toLowerCase() === repository.toLowerCase())
            )
            .map((node) => node.id)
    );
    keep.add(state.rootId);
    keep.add(state.currentSessionId);
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of state.nodes) {
            if (keep.has(node.id) && node.parentId && !keep.has(node.parentId)) {
                keep.add(node.parentId);
                changed = true;
            }
        }
    }
    const nodes = state.nodes.filter((node) => keep.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
        ...state,
        nodes,
        edges: state.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    };
}

export function stateFingerprint(state) {
    return JSON.stringify({
        rootId: state.rootId,
        currentSessionId: state.currentSessionId,
        nodes: state.nodes.map((node) => ({
            id: node.id,
            parentId: node.parentId,
            name: node.name,
            repository: node.repository,
            branch: node.branch,
            provider: node.provider,
            model: node.model,
            reasoningEffort: node.reasoningEffort,
            isLocalModel: node.isLocalModel,
            demoLocalModel: node.demoLocalModel,
            status: node.status,
            busySince: node.busySince,
            updatedAt: node.updatedAt,
            gate: node.humanGate?.type,
            task: node.task,
            pullRequest: node.pullRequest,
            issue: node.issue,
        })),
        source: state.source,
    });
}

export function collectConstellationState({
    currentSessionId,
    copilotHome = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".copilot"),
    appDatabasePath = path.join(copilotHome, "data.db"),
    sessionStorePath = path.join(copilotHome, "session-store.db"),
    sessionStateRoot = path.join(copilotHome, "session-state"),
} = {}) {
    const sessionId = sanitizeText(currentSessionId, 80);
    if (!sessionId) throw new Error("A current session ID is required");

    const appDatabase = openReadonlyDatabase(appDatabasePath);
    const sessionStoreDatabase = openReadonlyDatabase(sessionStorePath);
    try {
        const rows = readApplicationRows(appDatabase);
        const store = readSessionStoreRows(sessionStoreDatabase);
        const rawNodes = buildRawNodes(rows, store, sessionStateRoot);
        if (!rawNodes.has(sessionId)) rawNodes.set(sessionId, fallbackRoot(sessionId, store, sessionStateRoot));
        const hasEventMetadata = [...rawNodes.keys()].some((id) =>
            existsSync(path.join(sessionStateRoot, id, "events.jsonl"))
        );
        const limitations = [];
        if (!appDatabase) {
            limitations.push("Project relationships and live app status are unavailable.");
        }
        if (!sessionStoreDatabase) {
            limitations.push("Repository, branch, and reference fallback metadata are unavailable.");
        }
        if (!hasEventMetadata) {
            limitations.push("Busy timing and human-gate inference are limited.");
        }
        return normalizeConstellation([...rawNodes.values()], sessionId, {
            appDatabase: Boolean(appDatabase),
            sessionStore: Boolean(sessionStoreDatabase),
            eventMetadata: hasEventMetadata,
            limitations,
        });
    } finally {
        appDatabase?.close();
        sessionStoreDatabase?.close();
    }
}
