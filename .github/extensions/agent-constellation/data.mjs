import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { filterConstellationView } from "./layout.mjs";

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
    project: { type: "string", minLength: 1, maxLength: 180 },
};

export const CANVAS_OPEN_INPUT_SCHEMA = {
    type: "object",
    properties: {
        ...FILTER_PROPERTIES,
        scope: { type: "string", enum: ["tree", "all"] },
        demoLocalModel: { type: "boolean" },
    },
    additionalProperties: false,
};

const overviewRootId = "__agent_constellation_overview__";
const statusPriority = new Map(STATUSES.map((status, index) => [status, index]));
const localProviders = new Set(["ollama", "winml", "local"]);
const localModelPrefix = /^(?:ollama|winml|local)[/:]/;
const sourceStates = new Set([
    "healthy",
    "partial",
    "unavailable",
    "query-incompatible",
]);
const provenanceKinds = new Set([
    "recorded",
    "inferred",
    "demo",
    "unavailable",
]);
const provenanceSources = new Set([
    "appDatabase",
    "sessionStore",
    "eventMetadata",
    "demoDecoration",
]);

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

export function normalizeSourceState(value, fallback = "unavailable") {
    if (sourceStates.has(value)) return value;
    if (value === true) return "healthy";
    if (value === false) return "unavailable";
    return sourceStates.has(fallback) ? fallback : "unavailable";
}

export function summarizeDatabaseCapability({
    opened = false,
    requiredTables = [],
    optionalTables = [],
} = {}) {
    if (!opened) return "unavailable";
    const required = Array.isArray(requiredTables) ? requiredTables : [];
    const optional = Array.isArray(optionalTables) ? optionalTables : [];
    if (
        [...required, ...optional].some(
            (status) => status === "incompatible"
        ) ||
        required.some((status) => status !== "ready")
    ) {
        return "query-incompatible";
    }
    return optional.some((status) => status !== "ready")
        ? "partial"
        : "healthy";
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

function queryDatabaseRows(database, sql, parameters = []) {
    try {
        return {
            ok: true,
            rows: database.prepare(sql).all(...parameters),
        };
    } catch {
        return { ok: false, rows: [] };
    }
}

function databaseColumns(database, table) {
    if (!/^[a-z_]+$/i.test(table)) return { ok: false, columns: new Set() };
    const result = queryDatabaseRows(database, `PRAGMA table_info(${table})`);
    return {
        ok: result.ok,
        columns: new Set(
            result.rows
                .map((row) => sanitizeText(row.name, 80))
                .filter(Boolean)
        ),
    };
}

function inspectDatabaseTable(database, table, requiredColumns) {
    if (!database) return "missing";
    const tableResult = queryDatabaseRows(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [table]
    );
    if (!tableResult.ok) return "incompatible";
    if (!tableResult.rows[0]) return "missing";
    const { ok, columns } = databaseColumns(database, table);
    if (!ok) return "incompatible";
    return requiredColumns.every((column) => columns.has(column))
        ? "ready"
        : "incompatible";
}

function databaseRows(database, sql, parameters = []) {
    return queryDatabaseRows(database, sql, parameters).rows;
}

function optionalDatabaseColumn(database, table, column) {
    const { ok, columns } = databaseColumns(database, table);
    return ok && columns.has(column);
}

function provenanceSourcesFor(input) {
    return new Set(
        Array.isArray(input?.sources)
            ? input.sources.filter((item) => provenanceSources.has(item))
            : []
    );
}

function normalizedProvenanceField(input, fallbackKind = "unavailable") {
    const sources = provenanceSourcesFor(input);
    const kind = provenanceKinds.has(input?.kind)
        ? input.kind
        : provenanceKinds.has(fallbackKind)
          ? fallbackKind
          : "unavailable";
    const source = provenanceSources.has(input?.source)
        ? input.source
        : undefined;
    return {
        kind,
        ...(source ? { source } : {}),
        ...(sources.size ? { sources: [...sources] } : {}),
    };
}

function normalizeNodeProvenance(input, node) {
    return {
        relationship: normalizedProvenanceField(
            input?.relationship,
            node.parentId ? "recorded" : "unavailable"
        ),
        repository: normalizedProvenanceField(
            input?.repository,
            node.repository && node.repository !== "No project"
                ? "recorded"
                : "unavailable"
        ),
        branch: normalizedProvenanceField(
            input?.branch,
            node.branch ? "recorded" : "unavailable"
        ),
        model: normalizedProvenanceField(
            input?.model,
            node.model ? "recorded" : "unavailable"
        ),
        status: normalizedProvenanceField(input?.status, "inferred"),
    };
}

export function selectRepositoryMetadata({
    appRepository,
    sessionStoreRepository,
    projectRepository,
    sessionStoreCwd,
    projectPath,
} = {}) {
    const candidates = [
        {
            value: appRepository,
            kind: "recorded",
            source: "appDatabase",
        },
        {
            value: sessionStoreRepository,
            kind: "recorded",
            source: "sessionStore",
        },
        {
            value: projectRepository,
            kind: "recorded",
            source: "appDatabase",
        },
        {
            value: sessionStoreCwd,
            kind: "inferred",
            source: "sessionStore",
        },
        {
            value: projectPath,
            kind: "inferred",
            source: "appDatabase",
        },
    ];
    for (const candidate of candidates) {
        const label = repositoryLabel(candidate.value);
        if (label) {
            return {
                label,
                provenance: {
                    kind: candidate.kind,
                    source: candidate.source,
                },
            };
        }
    }
    return {
        label: "No project",
        provenance: { kind: "unavailable" },
    };
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
    const pathSegments = text.split("/").filter(Boolean);
    if (
        /^[a-z]:\//i.test(text) ||
        text.startsWith("/") ||
        text.startsWith("//")
    ) {
        return pathSegments.at(-1) ?? "";
    }
    try {
        const url = new URL(text);
        return url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/").slice(-2).join("/");
    } catch {
        return pathSegments.length > 2
            ? pathSegments.slice(-2).join("/")
            : pathSegments.join("/");
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
        lastMeaningfulActivityAt: 0,
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
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                case "assistant.turn_end":
                    result.latestTurnEndAt = Math.max(result.latestTurnEndAt, timestamp);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                case "session.task_complete":
                    result.latestTaskCompleteAt = Math.max(result.latestTaskCompleteAt, timestamp);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                case "session.error":
                    result.latestErrorAt = Math.max(result.latestErrorAt, timestamp);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                case "user.message":
                    result.latestUserMessageAt = Math.max(result.latestUserMessageAt, timestamp);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                case "tool.execution_start": {
                    const callId = sanitizeText(event.data?.toolCallId, 160);
                    const toolName = sanitizeText(event.data?.toolName, 80);
                    if (callId && toolName) pendingTools.set(callId, toolName);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                }
                case "tool.execution_complete": {
                    const callId = sanitizeText(event.data?.toolCallId, 160);
                    if (callId) pendingTools.delete(callId);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                }
                case "permission.requested":
                    latestPermissionRequestAt = Math.max(latestPermissionRequestAt, timestamp);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
                    break;
                case "permission.completed":
                    latestPermissionCompleteAt = Math.max(latestPermissionCompleteAt, timestamp);
                    result.lastMeaningfulActivityAt = Math.max(
                        result.lastMeaningfulActivityAt,
                        timestamp
                    );
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
            capability: "unavailable",
            availability: {
                relationships: "unavailable",
                projects: "unavailable",
            },
        };
    }
    const tables = {
        sessions: inspectDatabaseTable(appDatabase, "sessions", [
            "id",
            "mode",
            "model",
            "reasoning_effort",
            "is_running",
            "was_interrupted",
            "created_at",
            "updated_at",
            "archived_at",
            "forked_from_session_id",
        ]),
        workspaces: inspectDatabaseTable(appDatabase, "workspaces", [
            "id",
            "project_id",
            "branch",
            "name",
            "session_id",
            "archived_at",
            "creator_session_id",
            "coordinating_creator_session_id",
            "source_pr_repo_full_name",
            "source_pr_number",
            "source_issue_repo_full_name",
            "source_issue_number",
            "created_pr_repo_full_name",
            "created_pr_number",
        ]),
        aliases: inspectDatabaseTable(
            appDatabase,
            "workspace_session_aliases",
            ["session_id", "workspace_id"]
        ),
        parents: inspectDatabaseTable(appDatabase, "workspace_parent_links", [
            "child_workspace_id",
            "parent_workspace_id",
            "creator_session_id",
        ]),
        projects: inspectDatabaseTable(appDatabase, "projects", [
            "id",
            "name",
            "github_owner",
            "github_repo",
            "main_repo_path",
        ]),
        repoContexts: inspectDatabaseTable(
            appDatabase,
            "workspace_repo_contexts",
            [
                "workspace_id",
                "repo_full_name",
                "source_pr_number",
                "source_issue_number",
                "created_pr_number",
            ]
        ),
        activities: inspectDatabaseTable(appDatabase, "activity_items", [
            "session_id",
            "activity_type",
            "updated_at",
        ]),
    };
    const capability = summarizeDatabaseCapability({
        opened: true,
        requiredTables: [tables.sessions],
        optionalTables: [
            tables.workspaces,
            tables.aliases,
            tables.parents,
            tables.projects,
            tables.repoContexts,
            tables.activities,
        ],
    });
    if (tables.sessions !== "ready") {
        return {
            sessions: [],
            workspaces: [],
            aliases: [],
            parents: [],
            projects: [],
            repoContexts: [],
            activities: new Map(),
            capability,
            availability: {
                relationships: "query-incompatible",
                projects: "query-incompatible",
            },
        };
    }
    const providerSelection = optionalDatabaseColumn(
        appDatabase,
        "sessions",
        "provider_id"
    )
        ? "provider_id"
        : "NULL AS provider_id";
    const sessionTypeSelection = optionalDatabaseColumn(
        appDatabase,
        "sessions",
        "session_type"
    )
        ? "session_type"
        : "NULL AS session_type";
    const hasWorkspaces = tables.workspaces === "ready";
    const hasAliases = tables.aliases === "ready";
    const hasParents = tables.parents === "ready";
    const hasProjects = tables.projects === "ready";
    const hasRepoContexts = tables.repoContexts === "ready";
    const hasActivities = tables.activities === "ready";
    return {
        sessions: databaseRows(
            appDatabase,
            `SELECT id, mode, model, reasoning_effort, ${providerSelection},
                    ${sessionTypeSelection},
                    is_running, was_interrupted,
                    created_at, updated_at, archived_at AS session_archived_at,
                    forked_from_session_id
             FROM sessions`
        ),
        workspaces: hasWorkspaces ? databaseRows(
            appDatabase,
            `SELECT id, project_id, branch, name, session_id, archived_at AS workspace_archived_at,
                    creator_session_id, coordinating_creator_session_id,
                    source_pr_repo_full_name, source_pr_number,
                    source_issue_repo_full_name, source_issue_number,
                    created_pr_repo_full_name, created_pr_number
             FROM workspaces`
        ) : [],
        aliases: hasAliases
            ? databaseRows(appDatabase, "SELECT session_id, workspace_id FROM workspace_session_aliases")
            : [],
        parents: hasParents ? databaseRows(
            appDatabase,
            "SELECT child_workspace_id, parent_workspace_id, creator_session_id FROM workspace_parent_links"
        ) : [],
        projects: hasProjects ? databaseRows(
            appDatabase,
            "SELECT id, name, github_owner, github_repo, main_repo_path FROM projects"
        ) : [],
        repoContexts: hasRepoContexts ? databaseRows(
            appDatabase,
            `SELECT workspace_id, repo_full_name, source_pr_number,
                    source_issue_number, created_pr_number
             FROM workspace_repo_contexts`
        ) : [],
        activities: hasActivities ? latestActivities(appDatabase) : new Map(),
        capability,
        availability: {
            relationships:
                hasWorkspaces && hasParents
                    ? "healthy"
                    : [tables.workspaces, tables.parents].includes("incompatible")
                      ? "query-incompatible"
                      : "partial",
            projects:
                hasWorkspaces && hasProjects
                    ? "healthy"
                    : [tables.workspaces, tables.projects].includes("incompatible")
                      ? "query-incompatible"
                      : "partial",
        },
    };
}

function readSessionStoreRows(sessionStoreDatabase) {
    if (!sessionStoreDatabase) {
        return {
            sessions: new Map(),
            refs: new Map(),
            capability: "unavailable",
        };
    }
    const sessionTable = inspectDatabaseTable(sessionStoreDatabase, "sessions", [
        "id",
        "cwd",
        "repository",
        "branch",
        "created_at",
        "updated_at",
    ]);
    const refsTable = inspectDatabaseTable(
        sessionStoreDatabase,
        "session_refs",
        ["session_id", "ref_type", "ref_value", "created_at"]
    );
    const capability = summarizeDatabaseCapability({
        opened: true,
        requiredTables: [sessionTable],
        optionalTables: [refsTable],
    });
    const sessions = new Map();
    if (sessionTable === "ready") {
        for (const row of databaseRows(
            sessionStoreDatabase,
            `SELECT id, cwd, repository, branch, created_at, updated_at
             FROM sessions
             ORDER BY updated_at DESC
             LIMIT 5000`
        )) {
            if (typeof row.id === "string" && !sessions.has(row.id)) {
                sessions.set(row.id, row);
            }
        }
    }
    const refs = new Map();
    if (refsTable === "ready") {
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
    }
    return { sessions, refs, capability };
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
        const sessionType = sanitizeText(sessionRow.session_type, 40);
        const isHomeChat = sessionType === "general_chat";
        const repositoryMetadata = selectRepositoryMetadata({
            appRepository:
                repoContext?.repo_full_name ||
                workspace?.source_pr_repo_full_name ||
                workspace?.source_issue_repo_full_name ||
                workspace?.created_pr_repo_full_name,
            sessionStoreRepository: storeRow?.repository,
            projectRepository:
                project?.github_owner && project?.github_repo
                    ? `${project.github_owner}/${project.github_repo}`
                    : "",
            sessionStoreCwd: storeRow?.cwd,
            projectPath: project?.main_repo_path,
        });
        const appBranch = workspace?.branch;
        const storeBranch = storeRow?.branch;
        const events = readEventTail(sessionStateRoot, sessionRow.id);
        const statusDetails = deriveStatus(sessionRow, events, rows.activities.get(sessionRow.id));
        const refs = referenceDetails(workspace, repoContext, store.refs.get(sessionRow.id) ?? []);
        nodes.set(sessionRow.id, {
            id: sessionRow.id,
            parentId: parentSessionId,
            workspaceId: sanitizeText(workspace?.id, 80) || undefined,
            projectId: sanitizeText(project?.id, 80) || undefined,
            projectName:
                sanitizeText(project?.name, 140) ||
                (isHomeChat ? "My Copilot" : "No project"),
            sessionType: sessionType || undefined,
            isHomeChat,
            name:
                sanitizeText(workspace?.name, 140) ||
                (isHomeChat ? "Home chat" : `Standalone session ${shortId(sessionRow.id)}`),
            repository: repositoryMetadata.label,
            branch: sanitizeText(appBranch || storeBranch, 180) || undefined,
            mode: sanitizeText(sessionRow.mode, 30) || undefined,
            provider: sanitizeText(sessionRow.provider_id, 80) || undefined,
            model: sanitizeText(sessionRow.model, 100) || undefined,
            reasoningEffort: sanitizeText(sessionRow.reasoning_effort, 30) || undefined,
            createdAt: isoTimestamp(sessionRow.created_at || storeRow?.created_at),
            updatedAt: isoTimestamp(
                events.lastMeaningfulActivityAt
                    ? new Date(events.lastMeaningfulActivityAt).toISOString()
                    : sessionRow.updated_at || storeRow?.updated_at
            ),
            lastActivityAt: isoTimestamp(
                events.lastMeaningfulActivityAt
                    ? new Date(events.lastMeaningfulActivityAt).toISOString()
                    : sessionRow.updated_at || storeRow?.updated_at
            ),
            provenance: {
                relationship: {
                    kind: parentSessionId ? "recorded" : "unavailable",
                    ...(parentSessionId ? { source: "appDatabase" } : {}),
                },
                repository: repositoryMetadata.provenance,
                branch: appBranch
                    ? { kind: "recorded", source: "appDatabase" }
                    : storeBranch
                      ? { kind: "recorded", source: "sessionStore" }
                      : { kind: "unavailable" },
                model: sessionRow.model
                    ? { kind: "recorded", source: "appDatabase" }
                    : { kind: "unavailable" },
                status: {
                    kind: "inferred",
                    sources: [
                        "appDatabase",
                        ...(events.available ? ["eventMetadata"] : []),
                    ],
                },
            },
            ...refs,
            ...statusDetails,
        });
    }
    return nodes;
}

function fallbackRoot(currentSessionId, store, sessionStateRoot) {
    const row = store.sessions.get(currentSessionId);
    const events = readEventTail(sessionStateRoot, currentSessionId);
    const repositoryMetadata = selectRepositoryMetadata({
        sessionStoreRepository: row?.repository,
        sessionStoreCwd: row?.cwd,
    });
    const branch = sanitizeText(row?.branch, 180) || undefined;
    return {
        id: currentSessionId,
        name: `Current session ${shortId(currentSessionId)}`,
        repository: repositoryMetadata.label,
        projectName: "No project",
        branch,
        createdAt: isoTimestamp(row?.created_at),
        updatedAt: isoTimestamp(
            events.lastMeaningfulActivityAt
                ? new Date(events.lastMeaningfulActivityAt).toISOString()
                : row?.updated_at
        ),
        lastActivityAt: isoTimestamp(
            events.lastMeaningfulActivityAt
                ? new Date(events.lastMeaningfulActivityAt).toISOString()
                : row?.updated_at
        ),
        status: "idle",
        provenance: {
            relationship: { kind: "unavailable" },
            repository: repositoryMetadata.provenance,
            branch: branch
                ? { kind: "recorded", source: "sessionStore" }
                : { kind: "unavailable" },
            model: { kind: "unavailable" },
            status: {
                kind: "inferred",
                sources: events.available ? ["eventMetadata"] : [],
            },
        },
    };
}

function visualParentId(node) {
    return node?.syntheticParentId || node?.parentId;
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

function allScopeRootIds(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map();
    for (const node of nodes) {
        if (!node.parentId || !byId.has(node.parentId)) continue;
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node.id);
    }
    const roots = nodes
        .filter((node) => !node.parentId || !byId.has(node.parentId))
        .map((node) => node.id)
        .sort();
    const rootIds = new Set();
    const visited = new Set();
    const visit = (rootId) => {
        rootIds.add(rootId);
        const queue = [rootId];
        while (queue.length) {
            const id = queue.shift();
            if (!id || visited.has(id)) continue;
            visited.add(id);
            for (const childId of children.get(id) ?? []) queue.push(childId);
        }
    };
    for (const rootId of roots) visit(rootId);
    for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
        if (!visited.has(node.id)) visit(node.id);
    }
    return rootIds;
}

export function layoutConstellation(nodes, rootId, currentSessionId = rootId) {
    const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
    if (!byId.has(rootId)) return { nodes: [], edges: [], width: 960, height: 600 };
    const children = new Map();
    for (const node of byId.values()) {
        const parentId = visualParentId(node);
        if (!parentId || !byId.has(parentId)) continue;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(node.id);
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
        .filter((node) => visualParentId(node) && positioned.has(visualParentId(node)))
        .map((node) => ({
            source: visualParentId(node),
            target: node.id,
            kind: node.syntheticParentId ? "containment" : "parent-child",
            synthetic: Boolean(node.syntheticParentId),
        }));
    return { nodes: laidOutNodes, edges, width, height };
}

export function summarizeRelationshipCoverage(nodes = [], edges = []) {
    const realNodes = nodes.filter((node) => !node.synthetic);
    return {
        selectedSessions: realNodes.length,
        sessionsWithRecordedParent: realNodes.filter((node) => node.parentId)
            .length,
        recordedEdges: edges.filter((edge) => !edge.synthetic).length,
        syntheticDisplayEdges: edges.filter((edge) => edge.synthetic).length,
    };
}

export function diagnosticsLevel(diagnostics = {}) {
    if (diagnostics.refresh?.status === "degraded") return "degraded";
    return (
        Object.values(diagnostics.sources ?? {}).some(
            (source) => source?.status !== "healthy"
        ) ||
        Object.values(diagnostics.capabilities ?? {}).some(
            (status) => status !== "healthy"
        )
    )
        ? "limited"
        : "healthy";
}

export function normalizeConstellation(rawNodes, currentSessionId, metadata = {}) {
    const currentId = sanitizeText(currentSessionId, 80);
    const requestedScope = metadata.scope === "all" ? "all" : "tree";
    const unique = new Map();
    for (const input of rawNodes) {
        const id = sanitizeText(input?.id, 80);
        if (!id || unique.has(id)) continue;
        const status = STATUSES.includes(input.status) ? input.status : "idle";
        const provider = sanitizeText(input.provider, 80) || undefined;
        const model = sanitizeText(input.model, 100) || undefined;
        const node = {
            id,
            parentId: sanitizeText(input.parentId, 80) || undefined,
            workspaceId: sanitizeText(input.workspaceId, 80) || undefined,
            projectId: sanitizeText(input.projectId, 80) || undefined,
            projectName: sanitizeText(input.projectName, 140) || "No project",
            sessionType: sanitizeText(input.sessionType, 40) || undefined,
            isHomeChat: input.isHomeChat === true,
            name: sanitizeText(input.name, 140) || `Session ${shortId(id)}`,
            repository: sanitizeText(input.repository, 180) || "No project",
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
            lastActivityAt: isoTimestamp(input.lastActivityAt || input.updatedAt),
            busySince: isoTimestamp(input.busySince),
            humanGate: input.humanGate
                ? {
                      type: sanitizeText(input.humanGate.type, 30),
                      label: sanitizeText(input.humanGate.label, 100),
                  }
                : undefined,
            status,
            nodeType: "session",
            synthetic: false,
        };
        node.provenance = normalizeNodeProvenance(input.provenance, node);
        unique.set(id, node);
    }
    if (!unique.has(currentId)) {
        const node = {
            id: currentId,
            name: `Current session ${shortId(currentId)}`,
            repository: "No project",
            projectName: "No project",
            status: "idle",
            nodeType: "session",
            synthetic: false,
        };
        node.provenance = normalizeNodeProvenance(undefined, node);
        unique.set(currentId, node);
    }
    const totalDiscoveredSessionCount = unique.size;
    const treeRootId = topmostAccessibleAncestor(currentId, unique);
    let rootId = treeRootId;
    let selected;
    let independentRealRootCount;
    if (requestedScope === "all") {
        const realNodes = [...unique.values()];
        const allRootIds = allScopeRootIds(realNodes);
        independentRealRootCount = allRootIds.size;
        selected = [
            {
                id: overviewRootId,
                name: "All sessions",
                repository: "All projects",
                projectName: "All projects",
                status: "idle",
                nodeType: "overview",
                synthetic: true,
            },
            ...realNodes.map((node) =>
                allRootIds.has(node.id)
                    ? { ...node, syntheticParentId: overviewRootId }
                    : node
            ),
        ];
        rootId = overviewRootId;
    } else {
        selected = descendantsOf(rootId, unique);
    }
    const layout = layoutConstellation(selected, rootId, currentId);
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    for (const node of layout.nodes) {
        if (!node.synthetic) counts[node.status]++;
    }
    const selectedRealNodes = layout.nodes.filter((node) => !node.synthetic);
    const selectedRealIds = new Set(selectedRealNodes.map((node) => node.id));
    independentRealRootCount ??= selectedRealNodes.filter(
        (node) => !node.parentId || !selectedRealIds.has(node.parentId)
    ).length;
    const generatedAt = new Date().toISOString();
    const appDatabase = normalizeSourceState(metadata.appDatabase);
    const sessionStore = normalizeSourceState(metadata.sessionStore);
    const eventMetadata = normalizeSourceState(metadata.eventMetadata, "partial");
    const relationships = normalizeSourceState(metadata.relationships, "partial");
    const projects = normalizeSourceState(metadata.projects, "partial");
    const eventObserved = Math.max(
        0,
        Math.min(
            selectedRealNodes.length,
            Number.isFinite(metadata.eventSessionsObserved)
                ? Math.floor(metadata.eventSessionsObserved)
                : eventMetadata === "healthy"
                  ? selectedRealNodes.length
                  : 0
        )
    );
    const limitations = Array.isArray(metadata.limitations)
        ? metadata.limitations
              .map((item) => sanitizeText(item, 180))
              .filter(Boolean)
        : [];
    const diagnostics = {
        requestedScope,
        effectiveScope: requestedScope,
        selectedRealSessionCount: selectedRealNodes.length,
        totalDiscoveredSessionCount,
        independentRealRootCount,
        sources: {
            appDatabase: {
                label: "App database",
                status: appDatabase,
                provides:
                    "Session identity, app state, projects, models, and recorded relationships.",
            },
            sessionStore: {
                label: "Session store",
                status: sessionStore,
                provides:
                    "Recorded repository, branch, and reference metadata with safe fallbacks.",
            },
            eventMetadata: {
                label: "Event metadata",
                status: eventMetadata,
                provides:
                    "Bounded operational timing and human-gate signals used for status inference.",
            },
        },
        capabilities: {
            relationships,
            projects,
        },
        coverage: {
            events: {
                observedSessions: eventObserved,
                selectedSessions: selectedRealNodes.length,
            },
            relationships: summarizeRelationshipCoverage(
                layout.nodes,
                layout.edges
            ),
        },
        provenance: {
            recorded:
                "Repository, branch, model, and relationship fields identify their recorded local source.",
            inferred:
                "Session status is derived from the operational signals currently available.",
            synthetic:
                "Dashed containment and repository-group edges are display-only and never recorded lineage.",
        },
        demo: {
            active: false,
            kind: "none",
            scope: "None",
        },
        refresh: {
            status: "healthy",
            usingLastGood: false,
            consecutiveFailures: 0,
            lastSuccessfulAt: generatedAt,
        },
        visibility: {
            repositoryFilter: {
                enforcement: "display",
                active: false,
            },
            projectFilter: {
                enforcement: "display",
                active: false,
            },
        },
        limitations,
        privacy:
            "Sanitized operational metadata only; prompts, messages, secrets, raw errors, event payloads, database paths, tool arguments, and file contents are not returned.",
    };
    return {
        version: 3,
        generatedAt,
        rootId,
        currentSessionId: currentId,
        ...layout,
        counts,
        repositories: [
            ...new Set(selectedRealNodes.map((node) => node.repository)),
        ].sort(),
        projects: [
            ...new Map(
                selectedRealNodes.map((node) => [
                    `${node.projectId ?? ""}\u0000${node.projectName}`,
                    {
                        id: node.projectId,
                        name: node.projectName,
                    },
                ])
            ).values(),
        ].sort((left, right) => left.name.localeCompare(right.name)),
        diagnostics: {
            ...diagnostics,
            level: diagnosticsLevel(diagnostics),
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
                  provenance: {
                      ...node.provenance,
                      model: {
                          kind: "demo",
                          source: "demoDecoration",
                      },
                  },
              }
            : node
    );
    decorated.diagnostics = {
        ...decorated.diagnostics,
        demo: {
            active: true,
            kind: "decoration",
            scope: "Current session model presentation only.",
        },
    };
    decorated.diagnostics.level = diagnosticsLevel(decorated.diagnostics);
    return decorated;
}

export function filterConstellationState(state, input = {}) {
    const status = STATUSES.includes(input?.status) ? input.status : undefined;
    const repository = sanitizeText(input?.repository, 180);
    const project = sanitizeText(input?.project, 180);
    return filterConstellationView(state, { status, repository, project });
}

export function stateFingerprint(state) {
    const refresh = state.diagnostics?.refresh;
    return JSON.stringify({
        rootId: state.rootId,
        currentSessionId: state.currentSessionId,
        diagnostics: {
            ...state.diagnostics,
            refresh: refresh
                ? {
                      ...refresh,
                      lastSuccessfulAt: undefined,
                      consecutiveFailures:
                          refresh.status === "degraded" ? 1 : 0,
                  }
                : undefined,
        },
        nodes: state.nodes.map((node) => ({
            id: node.id,
            parentId: node.parentId,
            syntheticParentId: node.syntheticParentId,
            synthetic: node.synthetic,
            nodeType: node.nodeType,
            name: node.name,
            repository: node.repository,
            projectId: node.projectId,
            projectName: node.projectName,
            sessionType: node.sessionType,
            isHomeChat: node.isHomeChat,
            branch: node.branch,
            provider: node.provider,
            model: node.model,
            reasoningEffort: node.reasoningEffort,
            isLocalModel: node.isLocalModel,
            demoLocalModel: node.demoLocalModel,
            status: node.status,
            busySince: node.busySince,
            lastActivityAt: node.lastActivityAt,
            updatedAt: node.updatedAt,
            gate: node.humanGate?.type,
            task: node.task,
            pullRequest: node.pullRequest,
            issue: node.issue,
            provenance: node.provenance,
        })),
    });
}

export function collectConstellationState({
    currentSessionId,
    copilotHome = path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".copilot"),
    appDatabasePath = path.join(copilotHome, "data.db"),
    sessionStorePath = path.join(copilotHome, "session-store.db"),
    sessionStateRoot = path.join(copilotHome, "session-state"),
    scope = "tree",
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
        const selectedNodes =
            scope === "all"
                ? [...rawNodes.values()]
                : descendantsOf(
                      topmostAccessibleAncestor(sessionId, rawNodes),
                      rawNodes
                  );
        const eventSessionsObserved = selectedNodes.filter((node) =>
            node.provenance?.status?.sources?.includes("eventMetadata")
        ).length;
        const eventMetadata =
            eventSessionsObserved === 0
                ? "unavailable"
                : eventSessionsObserved === selectedNodes.length
                  ? "healthy"
                  : "partial";
        const limitations = [];
        if (rows.capability === "unavailable") {
            limitations.push("Project relationships and live app status are unavailable.");
        } else if (rows.capability === "query-incompatible") {
            limitations.push(
                "The app database opened, but expected tables or columns are incompatible."
            );
        } else if (rows.capability === "partial") {
            limitations.push(
                "Some optional app database tables are unavailable, so project or relationship detail may be partial."
            );
        }
        if (store.capability === "unavailable") {
            limitations.push("Repository, branch, and reference fallback metadata are unavailable.");
        } else if (store.capability === "query-incompatible") {
            limitations.push(
                "The session store opened, but expected tables or columns are incompatible."
            );
        } else if (store.capability === "partial") {
            limitations.push(
                "Some optional session-store reference metadata is unavailable."
            );
        }
        if (eventMetadata === "unavailable") {
            limitations.push("Busy timing and human-gate inference are limited.");
        } else if (eventMetadata === "partial") {
            limitations.push(
                "Busy timing and human-gate inference are available for only some selected sessions."
            );
        }
        if (rows.availability.relationships !== "healthy") {
            limitations.push("Parent-child relationships may be incomplete.");
        }
        if (rows.availability.projects !== "healthy") {
            limitations.push("Project grouping metadata may be incomplete.");
        }
        return normalizeConstellation([...rawNodes.values()], sessionId, {
            appDatabase: rows.capability,
            sessionStore: store.capability,
            eventMetadata,
            eventSessionsObserved,
            relationships: rows.availability.relationships,
            projects: rows.availability.projects,
            scope,
            limitations,
        });
    } finally {
        appDatabase?.close();
        sessionStoreDatabase?.close();
    }
}

export { overviewRootId };
