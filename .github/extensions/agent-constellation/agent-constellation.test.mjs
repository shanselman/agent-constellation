import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
    ATTENTION_THRESHOLDS,
    buildAttentionQueue,
    classifyAttentionNode,
    lastMeaningfulActivityTimestamp,
    resolveAttentionFocus,
} from "./attention.mjs";
import {
    CANVAS_OPEN_INPUT_SCHEMA,
    FILTER_PROPERTIES,
    collectConstellationState,
    decorateConstellationForDemo,
    diagnosticsLevel,
    filterConstellationState,
    isLocalModelMetadata,
    layoutConstellation,
    normalizeConstellation,
    normalizeSourceState,
    overviewRootId,
    selectRepositoryMetadata,
    stateFingerprint,
    summarizeDatabaseCapability,
    summarizeRelationshipCoverage,
} from "./data.mjs";
import {
    applyPinchGesture,
    archivedShelfId,
    buildLineageFocusSet,
    buildProtectedRevealSet,
    cardMarkerLayout,
    compactOverflowNodes,
    completedShelfId,
    defaultGroupingThreshold,
    defaultMinimumGroupSize,
    defaultOverflowPageSize,
    defaultVisibleCardBudget,
    describeMeaningfulConstellationChange,
    filterConstellationView,
    filteredProjectRootId,
    fitWidthScale,
    formatModelLabel,
    groupDirectRepositorySiblings,
    isPlainSearchShortcut,
    layoutResponsiveConstellation,
    normalizeSearchQuery,
    orientationForSize,
    overflowSummaryId,
    programmaticScrollBehavior,
    resolveVisibleSelection,
    repositoryGroupId,
    resolveProjectFilter,
    selectConstellationVisibility,
    sessionMatchesSearch,
    summarizeLayoutVisibility,
    visualParentId,
} from "./layout.mjs";
import { renderConstellationHtml } from "./renderer.mjs";
import {
    closeConstellationServer,
    getOrCreateConstellationServer,
    refreshConstellationServer,
    withRefreshHealth,
} from "./server.mjs";

const extensionDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));

function rawRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const requestHandle = request(
            {
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                method: options.method ?? "GET",
                headers: options.headers,
            },
            (response) => {
                response.resume();
                response.on("end", () => resolve(response));
            }
        );
        requestHandle.on("error", reject);
        if (options.body) requestHandle.write(options.body);
        requestHandle.end();
    });
}

function readFirstSseState(url, cookie) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        let settled = false;
        const requestHandle = request(
            {
                hostname: target.hostname,
                port: target.port,
                path: target.pathname,
                headers: { cookie, accept: "text/event-stream" },
            },
            (response) => {
                let body = "";
                response.on("data", (chunk) => {
                    body += chunk.toString("utf8");
                    const match = /event: state\ndata: (.+)\n\n/.exec(body);
                    if (!match || settled) return;
                    settled = true;
                    resolve(JSON.parse(match[1]));
                    response.destroy();
                });
                response.on("error", (error) => {
                    if (!settled) reject(error);
                });
            }
        );
        requestHandle.on("error", (error) => {
            if (!settled) reject(error);
        });
        requestHandle.end();
    });
}

function fixtureState(scope = "tree") {
    return normalizeConstellation(
        [
            {
                id: "root-session",
                name: "Root\u0000 session",
                repository: "octo/root",
                model: "gpt-5.6-sol-fast",
                reasoningEffort: "high",
                status: "idle",
            },
            {
                id: "busy-child",
                parentId: "root-session",
                name: "Busy child",
                repository: "octo/child",
                branch: "feature/one",
                status: "busy",
                busySince: "2026-09-25T16:00:00.000Z",
            },
            {
                id: "waiting-grandchild",
                parentId: "busy-child",
                name: "Waiting child",
                repository: "octo/child",
                status: "waiting-user",
                humanGate: { type: "user", label: "User response required" },
            },
        ],
        "root-session",
        {
            appDatabase: true,
            sessionStore: true,
            eventMetadata: true,
            relationships: true,
            projects: true,
            scope,
        }
    );
}

function multiProjectFixtureState(
    scope = "all",
    { projectAName = "Project A", includeProjectA = true, duplicateProjectAName = false } = {}
) {
    const nodes = [
        {
            id: "home",
            name: "Home chat",
            projectName: "My Copilot",
            repository: "No project",
            sessionType: "general_chat",
            isHomeChat: true,
            status: "idle",
        },
        {
            id: "project-b-root",
            name: "Project B root",
            projectId: "project-b",
            projectName: duplicateProjectAName ? projectAName : "Project B",
            repository: "octo/b",
            status: "completed",
        },
    ];
    if (includeProjectA) {
        nodes.push(
            {
                id: "project-a-root",
                parentId: "project-b-root",
                name: "Project A root",
                projectId: "project-a",
                projectName: projectAName,
                repository: "octo/a",
                status: "busy",
            },
            {
                id: "project-a-child",
                parentId: "project-a-root",
                name: "Project A child",
                projectId: "project-a",
                projectName: projectAName,
                repository: "octo/a",
                status: "waiting-user",
            }
        );
    }
    return normalizeConstellation(nodes, "home", {
        appDatabase: true,
        sessionStore: true,
        eventMetadata: true,
        relationships: true,
        projects: true,
        scope,
    });
}

function crossProjectFixtureState(scope = "tree") {
    return normalizeConstellation(
        [
            {
                id: "foreign-root",
                name: "Foreign coordinator",
                projectId: "project-b",
                projectName: "Project B",
                repository: "octo/b",
                status: "idle",
            },
            {
                id: "a-waiting",
                parentId: "foreign-root",
                name: "Waiting child",
                projectId: "project-a",
                projectName: "Project A",
                repository: "octo/a",
                status: "waiting-user",
            },
            {
                id: "a-busy",
                parentId: "a-waiting",
                name: "Busy grandchild",
                projectId: "project-a",
                projectName: "Project A",
                repository: "octo/a",
                status: "busy",
            },
            {
                id: "a-idle",
                parentId: "foreign-root",
                name: "Idle sibling",
                projectId: "project-a",
                projectName: "Project A",
                repository: "octo/a",
                status: "idle",
            },
        ],
        "a-busy",
        {
            appDatabase: true,
            sessionStore: true,
            eventMetadata: true,
            relationships: true,
            projects: true,
            scope,
        }
    );
}

function scalableFixtureState(
    totalRealSessions = 121,
    repositoryCount = 8,
    scope = "tree"
) {
    const childCount = Math.max(0, totalRealSessions - 1);
    const nodes = [
        {
            id: "scale-root",
            name: "Scale coordinator",
            projectName: "Scale project",
            repository: "octo/coordinator",
            status: "idle",
        },
        ...Array.from({ length: childCount }, (_, index) => ({
            id: `scale-${index}`,
            parentId: "scale-root",
            name: `Scale session ${String(index).padStart(4, "0")}`,
            projectName: "Scale project",
            repository: `octo/repository-${String(
                index % repositoryCount
            ).padStart(2, "0")}`,
            branch: `feature/${index}`,
            task: index === 42 ? "Reveal search target" : undefined,
            status:
                index === 1
                    ? "waiting-user"
                    : index === 2
                      ? "blocked"
                      : index === 3
                        ? "failed"
                        : index === 0
                          ? "busy"
                          : "idle",
        })),
    ];
    return normalizeConstellation(nodes, childCount ? "scale-0" : "scale-root", {
        appDatabase: true,
        sessionStore: true,
        eventMetadata: true,
        relationships: true,
        projects: true,
        scope,
    });
}

function shelfOnlyFixtureState(scope = "tree", count = 17) {
    return normalizeConstellation(
        [
            {
                id: "shelf-root",
                name: "Shelf coordinator",
                projectId: "project-shelf",
                projectName: "Shelf project",
                repository: "octo/shelf",
                status: "idle",
            },
            ...Array.from({ length: count }, (_, index) => ({
                id: `shelved-${index}`,
                parentId: "shelf-root",
                name: `Shelved session ${index}`,
                projectId: "project-shelf",
                projectName: "Shelf project",
                repository: `octo/completed-${index}`,
                status: "completed",
                task: index === 0 ? "Focused completed target" : undefined,
            })),
        ],
        "shelf-root",
        {
            appDatabase: true,
            sessionStore: true,
            eventMetadata: true,
            relationships: true,
            projects: true,
            scope,
        }
    );
}

function homeChatFixtureState(totalSessions = 600) {
    return normalizeConstellation(
        Array.from({ length: totalSessions }, (_, index) => ({
            id: `home-${index}`,
            name: `Home chat ${String(index).padStart(4, "0")}`,
            projectName: "My Copilot",
            repository: "No project",
            sessionType: "general_chat",
            isHomeChat: true,
            status: "idle",
        })),
        "home-0",
        {
            appDatabase: true,
            relationships: true,
            projects: true,
            scope: "all",
        }
    );
}

function attentionFixtureState({ uniqueRepositories = false } = {}) {
    return normalizeConstellation(
        [
            {
                id: "attention-root",
                name: "Attention coordinator",
                repository: "octo/coordinator",
                status: "idle",
            },
            ...Array.from({ length: 100 }, (_, index) => ({
                id: `attention-${index}`,
                parentId: "attention-root",
                name: `Attention session ${String(index).padStart(3, "0")}`,
                repository: uniqueRepositories
                    ? `octo/attention-${String(index).padStart(3, "0")}`
                    : "octo/attention",
                status:
                    index % 3 === 0
                        ? "waiting-user"
                        : index % 3 === 1
                          ? "blocked"
                          : "failed",
            })),
        ],
        "attention-0",
        {
            appDatabase: true,
            relationships: true,
            projects: true,
        }
    );
}

test("normalization sanitizes metadata and layout is deterministic", () => {
    const first = fixtureState();
    const second = fixtureState();
    assert.equal(first.nodes.length, 3);
    assert.equal(first.nodes.find((node) => node.id === "root-session").name, "Root session");
    assert.equal(first.nodes.find((node) => node.id === "root-session").model, "gpt-5.6-sol-fast");
    assert.equal(first.nodes.find((node) => node.id === "root-session").reasoningEffort, "high");
    assert.deepEqual(
        first.nodes.map(({ id, x, y, depth }) => ({ id, x, y, depth })),
        second.nodes.map(({ id, x, y, depth }) => ({ id, x, y, depth }))
    );
    assert.deepEqual(
        [...first.edges].sort((left, right) => left.target.localeCompare(right.target)),
        [
            {
                source: "root-session",
                target: "busy-child",
                kind: "parent-child",
                synthetic: false,
            },
            {
                source: "busy-child",
                target: "waiting-grandchild",
                kind: "parent-child",
                synthetic: false,
            },
        ]
    );
    assert.equal(first.version, 3);
    assert.equal(
        first.nodes.find((node) => node.id === "root-session").provenance
            .repository.kind,
        "recorded"
    );
    assert.equal(
        first.nodes.find((node) => node.id === "busy-child").provenance.status
            .kind,
        "inferred"
    );
    assert.equal(first.diagnostics.sources.appDatabase.status, "healthy");
    assert.equal(first.diagnostics.sources.sessionStore.status, "healthy");
    assert.deepEqual(first.diagnostics.coverage.relationships, {
        selectedSessions: 3,
        sessionsWithRecordedParent: 2,
        recordedEdges: 2,
        syntheticDisplayEdges: 0,
    });
    assert.equal(first.diagnostics.level, "healthy");

    const filtered = filterConstellationState(first, { status: "waiting-user" });
    assert.deepEqual(
        filtered.nodes.map((node) => node.id).sort(),
        ["busy-child", "root-session", "waiting-grandchild"]
    );
    assert.equal(layoutConstellation([], "missing").nodes.length, 0);
});

test("attention thresholds use inactivity since meaningful activity at exact boundaries", () => {
    const now = Date.parse("2026-09-26T00:00:00.000Z");
    const before = (milliseconds) =>
        new Date(now - milliseconds).toISOString();
    const queue = buildAttentionQueue(
        [
            {
                id: "waiting-user",
                name: "Question",
                repository: "octo/a",
                status: "waiting-user",
                updatedAt: before(4_000),
            },
            {
                id: "waiting-plan",
                name: "Plan",
                repository: "octo/a",
                status: "waiting-plan",
                updatedAt: before(3_000),
            },
            {
                id: "blocked",
                name: "Permission",
                repository: "octo/a",
                status: "blocked",
                updatedAt: before(2_000),
            },
            {
                id: "failed",
                name: "Failure",
                repository: "octo/a",
                status: "failed",
                updatedAt: before(1_000),
            },
            {
                id: "inactive-boundary",
                name: "Inactive runner",
                repository: "octo/a",
                status: "busy",
                busySince: before(60 * 60 * 1000),
                lastActivityAt: before(
                    ATTENTION_THRESHOLDS.inactiveBusyMs
                ),
                updatedAt: before(1_000),
            },
            {
                id: "active-boundary",
                name: "Active runner",
                repository: "octo/a",
                status: "busy",
                busySince: before(12 * 60 * 60 * 1000),
                lastActivityAt: before(
                    ATTENTION_THRESHOLDS.inactiveBusyMs - 1
                ),
            },
            {
                id: "recent-boundary",
                name: "Fresh result",
                repository: "octo/a",
                status: "completed",
                updatedAt: before(
                    ATTENTION_THRESHOLDS.recentCompletionMs
                ),
            },
            {
                id: "completed-too-old",
                name: "Old result",
                repository: "octo/a",
                status: "completed",
                updatedAt: before(
                    ATTENTION_THRESHOLDS.recentCompletionMs + 1
                ),
            },
            {
                id: "future-completion",
                name: "Future result",
                repository: "octo/a",
                status: "completed",
                updatedAt: new Date(now + 1).toISOString(),
            },
        ],
        { now, limit: 20 }
    );
    assert.deepEqual(
        queue.items.map(({ id, kind }) => ({ id, kind })),
        [
            { id: "waiting-user", kind: "waiting-user" },
            { id: "waiting-plan", kind: "waiting-plan" },
            { id: "blocked", kind: "blocked" },
            { id: "failed", kind: "failed" },
            { id: "inactive-boundary", kind: "inactive-busy" },
            { id: "recent-boundary", kind: "recent-completed" },
        ]
    );
    assert.equal(
        classifyAttentionNode(
            {
                status: "busy",
                busySince: before(24 * 60 * 60 * 1000),
                lastActivityAt: before(
                    ATTENTION_THRESHOLDS.inactiveBusyMs - 1
                ),
            },
            now
        ),
        undefined
    );
    assert.equal(
        lastMeaningfulActivityTimestamp({
            lastActivityAt: before(2_000),
            updatedAt: before(1_000),
        }),
        now - 2_000
    );
});

test("attention queue ordering, cap, overflow, and sanitization are deterministic", () => {
    const now = Date.parse("2026-09-26T00:00:00.000Z");
    const updatedAt = new Date(now - 1_000).toISOString();
    const nodes = [
        ...Array.from({ length: 8 }, (_, index) => ({
            id: `wait-${String(index).padStart(2, "0")}`,
            name:
                index === 0
                    ? `Alpha\u0000 ${"x".repeat(180)}`
                    : `Session ${String(index).padStart(2, "0")}`,
            repository: `octo/${index}`,
            status: "waiting-user",
            updatedAt,
        })),
        {
            id: "synthetic",
            name: "Synthetic",
            status: "failed",
            synthetic: true,
        },
    ];
    const first = buildAttentionQueue(nodes, { now, limit: 3 });
    const second = buildAttentionQueue([...nodes].reverse(), {
        now,
        limit: 3,
    });
    assert.deepEqual(first.targetIds, second.targetIds);
    assert.deepEqual(first.targetIds, ["wait-00", "wait-01", "wait-02"]);
    assert.equal(first.totalCount, 8);
    assert.equal(first.actionCount, 8);
    assert.equal(first.updateCount, 0);
    assert.equal(first.overflowCount, 5);
    assert.equal(first.summary, "8 need action · +5 more");
    assert.equal(first.items[0].name.includes("\u0000"), false);
    assert.equal(first.items[0].name.length <= 140, true);
});

test("attention focus restoration is deterministic across queue mutations", () => {
    const previousIds = ["a", "b", "c", "d", "e", "f"];
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds,
            nextIds: ["x", "b", "c", "d", "e", "f"],
            focusedId: "c",
        }),
        { kind: "item", id: "c", changed: false }
    );
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds,
            nextIds: ["a", "c", "d", "e", "f"],
            focusedId: "b",
        }),
        { kind: "item", id: "c", changed: true }
    );
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds,
            nextIds: ["a", "b"],
            focusedId: "c",
        }),
        { kind: "item", id: "b", changed: true }
    );
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds,
            nextIds: ["x", "a", "b", "c", "d", "e"],
            focusedId: "f",
        }),
        { kind: "item", id: "e", changed: true }
    );
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds: ["a"],
            nextIds: [],
            focusedId: "a",
            hasOverflow: true,
        }),
        { kind: "overflow", changed: true }
    );
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds: ["a"],
            nextIds: [],
            focusedId: "a",
        }),
        { kind: "heading", changed: true }
    );
    assert.deepEqual(
        resolveAttentionFocus({
            previousIds,
            nextIds: previousIds,
            focusedId: "",
        }),
        { kind: "none" }
    );
});

test("model labels use conservative humanization and optional reasoning effort", () => {
    assert.equal(formatModelLabel("gpt-5.6-sol", "high"), "GPT-5.6 Sol · High");
    assert.equal(formatModelLabel("gpt-5.6-sol-fast", "xhigh"), "GPT-5.6 Sol Fast · Extra High");
    assert.equal(formatModelLabel("claude-sonnet-5", "medium"), "Claude Sonnet 5 · Medium");
    assert.equal(formatModelLabel("openai/gpt_5.6_sol", "low"), "OpenAI GPT-5.6 Sol · Low");
    assert.equal(formatModelLabel("auto"), "Auto");
    assert.equal(formatModelLabel("gpt-5.6-sol", "none"), "GPT-5.6 Sol");
    assert.equal(formatModelLabel("gpt-5.6-sol", ""), "GPT-5.6 Sol");
    assert.equal(formatModelLabel("", "high"), "");
});

test("normalization sanitizes raw model state and fingerprints model changes", () => {
    const first = normalizeConstellation(
        [
            {
                id: "root",
                name: "Root",
                repository: "octo/root",
                provider: "\u0000ollama ",
                model: "gpt-5.6-sol\u0000",
                reasoningEffort: "\u0000high",
                status: "idle",
            },
        ],
        "root"
    );
    const node = first.nodes[0];
    assert.equal(node.provider, "ollama");
    assert.equal(node.model, "gpt-5.6-sol");
    assert.equal(node.reasoningEffort, "high");
    assert.equal(node.isLocalModel, true);

    const modelChanged = structuredClone(first);
    modelChanged.nodes[0].model = "claude-sonnet-5";
    assert.notEqual(stateFingerprint(first), stateFingerprint(modelChanged));

    const effortChanged = structuredClone(first);
    effortChanged.nodes[0].reasoningEffort = "low";
    assert.notEqual(stateFingerprint(first), stateFingerprint(effortChanged));

    const providerChanged = structuredClone(first);
    providerChanged.nodes[0].provider = "github";
    assert.notEqual(stateFingerprint(first), stateFingerprint(providerChanged));

    const localityChanged = structuredClone(first);
    localityChanged.nodes[0].isLocalModel = false;
    assert.notEqual(stateFingerprint(first), stateFingerprint(localityChanged));
});

test("local model classification requires explicit provider or runtime prefixes", () => {
    for (const provider of ["ollama", "OLLAMA", "winml", "local"]) {
        assert.equal(isLocalModelMetadata({ provider, model: "custom-model" }), true);
    }
    for (const model of [
        "ollama/llama-3.3",
        "ollama:llama-3.3",
        "winml/phi-4",
        "local/custom",
        "local:custom",
    ]) {
        assert.equal(isLocalModelMetadata({ provider: "github", model }), true);
    }
    for (const model of [
        "llama-3.3",
        "phi-4",
        "mistral-large",
        "qwen-2.5",
        "openai/gpt-5.6-sol",
        "anthropic/claude-sonnet-5",
        "github/gpt-6-astra",
    ]) {
        assert.equal(isLocalModelMetadata({ provider: "github", model }), false);
    }
    assert.equal(isLocalModelMetadata(), false);
    assert.equal(isLocalModelMetadata({ provider: "", model: "" }), false);
});

test("source capability helpers distinguish healthy, partial, unavailable, and incompatible", () => {
    assert.equal(normalizeSourceState(true), "healthy");
    assert.equal(normalizeSourceState(false), "unavailable");
    assert.equal(normalizeSourceState("partial"), "partial");
    assert.equal(
        summarizeDatabaseCapability({
            opened: true,
            requiredTables: ["ready"],
            optionalTables: ["ready"],
        }),
        "healthy"
    );
    assert.equal(
        summarizeDatabaseCapability({
            opened: true,
            requiredTables: ["ready"],
            optionalTables: ["missing"],
        }),
        "partial"
    );
    assert.equal(
        summarizeDatabaseCapability({
            opened: true,
            requiredTables: ["incompatible"],
        }),
        "query-incompatible"
    );
    assert.equal(
        summarizeDatabaseCapability({
            opened: false,
            requiredTables: ["ready"],
        }),
        "unavailable"
    );
});

test("recorded session-store repository outranks filesystem fallbacks", () => {
    assert.deepEqual(
        selectRepositoryMetadata({
            sessionStoreRepository: "octo/recorded",
            projectPath: "D:\\private\\fallback-project",
        }),
        {
            label: "octo/recorded",
            provenance: {
                kind: "recorded",
                source: "sessionStore",
            },
        }
    );
    assert.deepEqual(
        selectRepositoryMetadata({
            projectPath: "D:\\private\\fallback-project",
        }),
        {
            label: "fallback-project",
            provenance: {
                kind: "inferred",
                source: "appDatabase",
            },
        }
    );
});

test("demo decoration clones state and changes only the current session", () => {
    const source = fixtureState();
    const decorated = decorateConstellationForDemo(source);
    assert.notEqual(decorated, source);
    const originalCurrent = source.nodes.find((node) => node.id === source.currentSessionId);
    assert.equal(originalCurrent.provider, undefined);
    assert.equal(originalCurrent.model, "gpt-5.6-sol-fast");
    assert.equal(originalCurrent.isLocalModel, false);
    assert.equal(originalCurrent.demoLocalModel, undefined);
    const current = decorated.nodes.find((node) => node.id === decorated.currentSessionId);
    assert.equal(current.provider, "ollama");
    assert.equal(current.model, "ollama/llama-3.3");
    assert.equal(current.reasoningEffort, "high");
    assert.equal(current.isLocalModel, true);
    assert.equal(current.demoLocalModel, true);
    assert.deepEqual(current.provenance.model, {
        kind: "demo",
        source: "demoDecoration",
    });
    assert.deepEqual(decorated.diagnostics.demo, {
        active: true,
        kind: "decoration",
        scope: "Current session model presentation only.",
    });
    for (const node of decorated.nodes.filter((node) => node.id !== decorated.currentSessionId)) {
        assert.equal(node.demoLocalModel, undefined);
    }
    assert.notEqual(stateFingerprint(source), stateFingerprint(decorated));
});

test("canvas open schema adds contextual scope and project inputs", () => {
    assert.deepEqual(CANVAS_OPEN_INPUT_SCHEMA.properties.demoLocalModel, {
        type: "boolean",
    });
    assert.deepEqual(CANVAS_OPEN_INPUT_SCHEMA.properties.scope, {
        type: "string",
        enum: ["tree", "all"],
    });
    assert.equal(CANVAS_OPEN_INPUT_SCHEMA.properties.project.type, "string");
    assert.equal(FILTER_PROPERTIES.project.type, "string");
    assert.equal(CANVAS_OPEN_INPUT_SCHEMA.additionalProperties, false);
});

test("collector remains compatible when provider metadata is unavailable", () => {
    const scratch = path.join(extensionDir, `.test-artifacts-${randomUUID()}`);
    const appPath = path.join(scratch, "data.db");
    mkdirSync(scratch, { recursive: true });
    const app = new DatabaseSync(appPath);
    try {
        app.exec(`
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, mode TEXT, model TEXT, reasoning_effort TEXT,
                is_running INTEGER, was_interrupted INTEGER, created_at TEXT,
                updated_at TEXT, archived_at TEXT, forked_from_session_id TEXT
            );
        `);
        app.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            "current",
            "interactive",
            "llama-3.3",
            "high",
            0,
            0,
            "2026-09-25T16:00:00.000Z",
            "2026-09-25T16:01:00.000Z",
            null,
            null
        );
        const state = collectConstellationState({
            currentSessionId: "current",
            appDatabasePath: appPath,
            sessionStorePath: path.join(scratch, "missing-session-store.db"),
            sessionStateRoot: path.join(scratch, "session-state"),
        });
        const current = state.nodes.find((node) => node.id === "current");
        assert.equal(current.provider, undefined);
        assert.equal(current.model, "llama-3.3");
        assert.equal(current.isLocalModel, false);
        assert.equal(current.name.startsWith("Standalone session"), true);
        assert.equal(current.repository, "No project");
        assert.equal(state.diagnostics.sources.appDatabase.status, "partial");
        assert.equal(state.diagnostics.sources.sessionStore.status, "unavailable");
        assert.equal(state.diagnostics.sources.eventMetadata.status, "unavailable");
        assert.equal(state.diagnostics.capabilities.relationships, "partial");
        assert.equal(state.diagnostics.capabilities.projects, "partial");
        assert.equal(state.diagnostics.level, "limited");
        assert.match(
            state.diagnostics.limitations.join(" "),
            /relationships may be incomplete/i
        );
        assert.match(
            state.diagnostics.limitations.join(" "),
            /Project grouping metadata may be incomplete/i
        );
    } finally {
        app.close();
        rmSync(scratch, { recursive: true, force: true });
    }
});

test("opened databases with incompatible schemas are not reported healthy", () => {
    const scratch = path.join(extensionDir, `.test-artifacts-${randomUUID()}`);
    const appPath = path.join(scratch, "data.db");
    const storePath = path.join(scratch, "session-store.db");
    mkdirSync(scratch, { recursive: true });
    const app = new DatabaseSync(appPath);
    const store = new DatabaseSync(storePath);
    try {
        app.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY);");
        store.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY);");
        app.close();
        store.close();
        const state = collectConstellationState({
            currentSessionId: "current",
            appDatabasePath: appPath,
            sessionStorePath: storePath,
            sessionStateRoot: path.join(scratch, "session-state"),
        });
        assert.equal(
            state.diagnostics.sources.appDatabase.status,
            "query-incompatible"
        );
        assert.equal(
            state.diagnostics.sources.sessionStore.status,
            "query-incompatible"
        );
        assert.equal(state.diagnostics.level, "limited");
        assert.match(
            state.diagnostics.limitations.join(" "),
            /opened, but expected tables or columns are incompatible/i
        );
        assert.equal(JSON.stringify(state).includes(appPath), false);
        assert.equal(JSON.stringify(state).includes(storePath), false);
    } finally {
        try {
            app.close();
        } catch {}
        try {
            store.close();
        } catch {}
        rmSync(scratch, { recursive: true, force: true });
    }
});

test("current grandchild resolves topmost root and includes sibling descendants", () => {
    const rawNodes = [
        {
            id: "root",
            name: "Coordinator",
            repository: "octo/root",
            status: "idle",
        },
        {
            id: "current-parent",
            parentId: "root",
            name: "Current parent",
            repository: "octo/current",
            status: "completed",
        },
        {
            id: "current-grandchild",
            parentId: "current-parent",
            name: "Current grandchild",
            repository: "octo/current",
            status: "busy",
        },
        {
            id: "sibling",
            parentId: "root",
            name: "Sibling",
            repository: "octo/sibling",
            status: "idle",
        },
        {
            id: "sibling-child",
            parentId: "sibling",
            name: "Sibling child",
            repository: "octo/sibling",
            status: "waiting-user",
        },
    ];
    const first = normalizeConstellation(rawNodes, "current-grandchild");
    const second = normalizeConstellation(rawNodes, "current-grandchild");

    assert.equal(first.rootId, "root");
    assert.equal(first.currentSessionId, "current-grandchild");
    assert.deepEqual(
        first.nodes.map((node) => node.id).sort(),
        ["current-grandchild", "current-parent", "root", "sibling", "sibling-child"]
    );
    assert.equal(first.nodes.find((node) => node.id === "root").isRoot, true);
    assert.equal(first.nodes.find((node) => node.id === "current-grandchild").isCurrent, true);
    assert.deepEqual(
        first.nodes.map(({ id, x, y, depth }) => ({ id, x, y, depth })),
        second.nodes.map(({ id, x, y, depth }) => ({ id, x, y, depth }))
    );

    const filtered = filterConstellationState(first, { repository: "octo/sibling" });
    assert.deepEqual(
        filtered.nodes.map((node) => node.id).sort(),
        ["current-grandchild", "current-parent", "root", "sibling", "sibling-child"]
    );
    assert.equal(filtered.rootId, "root");
    assert.equal(filtered.currentSessionId, "current-grandchild");

    const noMatches = filterConstellationState(first, { status: "failed" });
    assert.deepEqual(noMatches.nodes, []);
    assert.deepEqual(noMatches.edges, []);
});

test("all scope preserves real lineage and groups independent roots synthetically", () => {
    const rawNodes = [
        {
            id: "home",
            name: "Home chat",
            projectName: "My Copilot",
            repository: "No project",
            sessionType: "general_chat",
            isHomeChat: true,
            status: "idle",
        },
        {
            id: "project-a-root",
            name: "Project A",
            projectId: "project-a",
            projectName: "Project A",
            repository: "octo/a",
            status: "busy",
        },
        {
            id: "project-a-child",
            parentId: "project-a-root",
            name: "Project A child",
            projectId: "project-a",
            projectName: "Project A",
            repository: "octo/a",
            status: "waiting-user",
        },
        {
            id: "project-b-root",
            name: "Project B",
            projectId: "project-b",
            projectName: "Project B",
            repository: "octo/b",
            status: "completed",
        },
        {
            id: "standalone-cli",
            name: "Standalone session standalone",
            projectName: "No project",
            repository: "No project",
            sessionType: "cli_session",
            status: "idle",
        },
        {
            id: "orphan",
            parentId: "missing-parent",
            name: "Orphan",
            projectName: "No project",
            repository: "No project",
            status: "failed",
        },
    ];

    const tree = normalizeConstellation(rawNodes, "project-a-child");
    assert.equal(tree.diagnostics.requestedScope, "tree");
    assert.equal(tree.diagnostics.effectiveScope, "tree");
    assert.deepEqual(
        tree.nodes.map((node) => node.id).sort(),
        ["project-a-child", "project-a-root"]
    );

    const all = normalizeConstellation(rawNodes, "home", {
        scope: "all",
        appDatabase: true,
        relationships: true,
        projects: true,
    });
    assert.equal(all.rootId, overviewRootId);
    assert.equal(all.nodes.length, rawNodes.length + 1);
    assert.equal(all.diagnostics.selectedRealSessionCount, rawNodes.length);
    assert.equal(all.diagnostics.totalDiscoveredSessionCount, rawNodes.length);
    assert.equal(all.diagnostics.independentRealRootCount, 5);
    assert.deepEqual(all.diagnostics.coverage.relationships, {
        selectedSessions: rawNodes.length,
        sessionsWithRecordedParent: 2,
        recordedEdges: 1,
        syntheticDisplayEdges: 5,
    });
    assert.equal(Object.values(all.counts).reduce((sum, count) => sum + count, 0), rawNodes.length);
    assert.equal(all.nodes.find((node) => node.id === overviewRootId).synthetic, true);
    assert.equal(all.nodes.find((node) => node.id === "project-a-child").parentId, "project-a-root");
    assert.equal(all.nodes.find((node) => node.id === "orphan").parentId, "missing-parent");
    assert.equal(all.nodes.find((node) => node.id === "orphan").syntheticParentId, overviewRootId);
    assert.deepEqual(
        all.edges.find((edge) => edge.target === "project-a-child"),
        {
            source: "project-a-root",
            target: "project-a-child",
            kind: "parent-child",
            synthetic: false,
        }
    );
    assert.deepEqual(
        all.edges.find((edge) => edge.target === "project-b-root"),
        {
            source: overviewRootId,
            target: "project-b-root",
            kind: "containment",
            synthetic: true,
        }
    );

    const projectFiltered = filterConstellationState(all, { project: "project-a" });
    assert.deepEqual(
        projectFiltered.nodes.map((node) => node.id).sort(),
        [overviewRootId, "project-a-child", "project-a-root"].sort()
    );
    const repositoryFiltered = filterConstellationState(all, { repository: "octo/b" });
    assert.deepEqual(
        repositoryFiltered.nodes.map((node) => node.id).sort(),
        [overviewRootId, "project-b-root"].sort()
    );
    assert.equal(
        repositoryFiltered.diagnostics.visibility.repositoryFilter.enforcement,
        "display"
    );
    assert.deepEqual(
        repositoryFiltered.diagnostics.coverage.relationships,
        {
            selectedSessions: 1,
            sessionsWithRecordedParent: 0,
            recordedEdges: 0,
            syntheticDisplayEdges: 1,
        }
    );
    assert.equal(
        all.nodes.find((node) => node.id === "standalone-cli").isHomeChat,
        false
    );
    assert.equal(
        all.nodes.find((node) => node.id === "standalone-cli").name.startsWith("Home chat"),
        false
    );
});

test("project filters resolve IDs and names case-insensitively and fail closed", () => {
    const state = multiProjectFixtureState();
    const byId = filterConstellationState(state, { project: "project-a" });
    const byName = filterConstellationState(state, { project: "Project A" });
    const byCaseInsensitiveName = filterConstellationView(state, {
        project: "pRoJeCt A",
    });
    for (const filtered of [byId, byName, byCaseInsensitiveName]) {
        assert.deepEqual(
            filtered.nodes.filter((node) => !node.synthetic).map((node) => node.id).sort(),
            ["project-a-child", "project-a-root"]
        );
        assert.equal(filtered.diagnostics.selectedRealSessionCount, 2);
        assert.equal(filtered.diagnostics.projectFilter.status, "resolved");
        assert.equal(
            filtered.diagnostics.projectFilter.effectiveProjectId,
            "project-a"
        );
        const reattached = filtered.nodes.find(
            (node) => node.id === "project-a-root"
        );
        assert.equal(reattached.parentId, "project-b-root");
        assert.equal(reattached.syntheticParentId, overviewRootId);
        assert.deepEqual(
            filtered.edges.find((edge) => edge.target === "project-a-root"),
            {
                source: overviewRootId,
                target: "project-a-root",
                kind: "containment",
                synthetic: true,
            }
        );
    }

    const unknown = filterConstellationState(state, {
        project: "deleted-project",
    });
    assert.deepEqual(unknown.nodes, []);
    assert.deepEqual(unknown.edges, []);
    assert.equal(unknown.diagnostics.selectedRealSessionCount, 0);
    assert.equal(unknown.diagnostics.projectFilter.status, "unknown");

    const ambiguousState = multiProjectFixtureState("all", {
        duplicateProjectAName: true,
    });
    const ambiguous = filterConstellationState(ambiguousState, {
        project: "Project A",
    });
    assert.deepEqual(ambiguous.nodes, []);
    assert.equal(ambiguous.diagnostics.projectFilter.status, "ambiguous");
    const explicitId = filterConstellationState(ambiguousState, {
        project: "project-b",
    });
    assert.deepEqual(
        explicitId.nodes.filter((node) => !node.synthetic).map((node) => node.id),
        ["project-b-root"]
    );

    assert.deepEqual(resolveProjectFilter(state.projects, "PROJECT-A"), {
        requested: "PROJECT-A",
        status: "resolved",
        matched: true,
        id: "project-a",
        name: "Project A",
        value: "project-a",
    });
    assert.equal(
        resolveProjectFilter(ambiguousState.projects, "project a").status,
        "ambiguous"
    );
});

test("project filtering reattaches cross-project descendants for every layout", () => {
    for (const scope of ["tree", "all"]) {
        const source = crossProjectFixtureState(scope);
        const filtered = filterConstellationState(source, {
            project: "Project A",
        });
        const expectedRootId =
            scope === "all" ? overviewRootId : filteredProjectRootId;
        assert.equal(filtered.rootId, expectedRootId);
        assert.equal(filtered.currentSessionId, "a-busy");
        assert.equal(filtered.diagnostics.selectedRealSessionCount, 3);
        assert.equal(filtered.diagnostics.independentRealRootCount, 2);
        assert.equal(
            Object.values(filtered.counts).reduce((sum, count) => sum + count, 0),
            3
        );
        assert.equal(filtered.counts["waiting-user"], 1);
        assert.equal(
            filtered.nodes.some((node) => node.id === "foreign-root"),
            false
        );
        for (const id of ["a-waiting", "a-idle"]) {
            const node = filtered.nodes.find((item) => item.id === id);
            assert.equal(node.parentId, "foreign-root");
            assert.equal(node.syntheticParentId, expectedRootId);
            assert.deepEqual(
                filtered.edges.find((edge) => edge.target === id),
                {
                    source: expectedRootId,
                    target: id,
                    kind: "containment",
                    synthetic: true,
                }
            );
        }
        assert.deepEqual(
            filtered.edges.find((edge) => edge.target === "a-busy"),
            {
                source: "a-waiting",
                target: "a-busy",
                kind: "parent-child",
                synthetic: false,
            }
        );

        for (const [width, height, orientation] of [
            [1200, 700, "horizontal"],
            [420, 900, "vertical"],
        ]) {
            const layout = layoutResponsiveConstellation(filtered, {
                width,
                height,
                completedExpanded: true,
            });
            assert.equal(layout.orientation, orientation);
            assert.equal(
                layout.nodes.filter((node) => !node.synthetic).length,
                filtered.diagnostics.selectedRealSessionCount
            );
            assert.equal(
                layout.nodes.some(
                    (node) => node.id === "a-waiting" && node.status === "waiting-user"
                ),
                true
            );
            assert.equal(
                layout.nodes.some((node) => node.id === "foreign-root"),
                false
            );
        }
    }
});

test("cross-project project scopes remain rooted across refresh and reopen", async () => {
    const servers = new Map();
    const provider = async ({ scope } = {}) => crossProjectFixtureState(scope);
    const options = (scope) => ({
        dataProvider: provider,
        initialScope: scope,
        initialProject: "Project A",
        pollIntervalMs: 60_000,
    });
    try {
        const [tree, all] = await Promise.all([
            getOrCreateConstellationServer(servers, "cross-tree", options("tree")),
            getOrCreateConstellationServer(servers, "cross-all", options("all")),
        ]);
        for (const entry of [tree, all]) {
            assert.equal(entry.state.diagnostics.selectedRealSessionCount, 3);
            assert.equal(
                entry.state.nodes.some((node) => node.id === "foreign-root"),
                false
            );
            const horizontal = layoutResponsiveConstellation(entry.state, {
                width: 1200,
                height: 700,
            });
            assert.equal(
                horizontal.nodes.filter((node) => !node.synthetic).length,
                3
            );
            assert.equal(
                horizontal.nodes.some(
                    (node) => node.id === "a-waiting" && node.status === "waiting-user"
                ),
                true
            );
        }

        await Promise.all([
            refreshConstellationServer(tree),
            refreshConstellationServer(all),
        ]);
        assert.equal(tree.state.diagnostics.selectedRealSessionCount, 3);
        assert.equal(all.state.diagnostics.selectedRealSessionCount, 3);

        const [treeReopened, allReopened] = await Promise.all([
            getOrCreateConstellationServer(servers, "cross-tree", {
                ...options("tree"),
                initialProject: "",
            }),
            getOrCreateConstellationServer(servers, "cross-all", {
                ...options("all"),
                initialProject: "",
            }),
        ]);
        assert.equal(treeReopened, tree);
        assert.equal(allReopened, all);
        assert.equal(treeReopened.projectScope.id, "project-a");
        assert.equal(allReopened.projectScope.id, "project-a");
        assert.equal(
            layoutResponsiveConstellation(treeReopened.state, {
                width: 1200,
                height: 700,
            }).nodes.filter((node) => !node.synthetic).length,
            3
        );
        assert.equal(
            layoutResponsiveConstellation(allReopened.state, {
                width: 1200,
                height: 700,
            }).nodes.filter((node) => !node.synthetic).length,
            3
        );
    } finally {
        await Promise.all([
            closeConstellationServer(servers, "cross-tree"),
            closeConstellationServer(servers, "cross-all"),
        ]);
    }
});

test("search normalization matches only sanitized session metadata", () => {
    assert.equal(
        normalizeSearchQuery("  Café\\PR-42 / Waiting_User  "),
        "cafe pr 42 waiting user"
    );
    assert.equal(normalizeSearchQuery("\u0000\u0007"), "");
    const node = {
        name: "Résumé review",
        projectName: "Navigation",
        repository: "octo/agent-tools",
        branch: "feature/PR-42",
        pullRequest: "#42",
        task: "Keyboard focus",
        provider: "github",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        status: "waiting-user",
    };
    assert.equal(sessionMatchesSearch(node, "resume pr 42"), true);
    assert.equal(sessionMatchesSearch(node, "waiting attention"), true);
    assert.equal(sessionMatchesSearch(node, "private prompt text"), false);
    assert.equal(sessionMatchesSearch({ ...node, synthetic: true }, "resume"), false);
});

test("search shortcut accepts only unmodified slash", () => {
    assert.equal(isPlainSearchShortcut({ key: "/" }), true);
    assert.equal(isPlainSearchShortcut({ key: "/", ctrlKey: true }), false);
    assert.equal(isPlainSearchShortcut({ key: "/", metaKey: true }), false);
    assert.equal(isPlainSearchShortcut({ key: "/", altKey: true }), false);
    assert.equal(isPlainSearchShortcut({ key: "f" }), false);
    assert.equal(isPlainSearchShortcut({ key: "f", ctrlKey: true }), false);
    assert.equal(isPlainSearchShortcut({ key: "f", metaKey: true }), false);
});

test("lineage focus follows real and synthetic visual parents safely", () => {
    const source = normalizeConstellation(
        [
            {
                id: "home",
                name: "Home",
                repository: "No project",
                status: "idle",
            },
            {
                id: "real-root",
                name: "Real root",
                repository: "octo/example",
                status: "idle",
            },
            {
                id: "real-child",
                parentId: "real-root",
                name: "Real child",
                repository: "octo/example",
                status: "busy",
            },
            {
                id: "real-grandchild",
                parentId: "real-child",
                name: "Real grandchild",
                repository: "octo/example",
                status: "idle",
            },
        ],
        "home",
        { scope: "all" }
    );
    const focused = buildLineageFocusSet(source.nodes, "real-child");
    assert.deepEqual(
        [...focused].sort(),
        [
            overviewRootId,
            "real-child",
            "real-grandchild",
            "real-root",
        ].sort()
    );
    assert.equal(
        visualParentId(source.nodes.find((node) => node.id === "real-root")),
        overviewRootId
    );

    const cyclic = buildLineageFocusSet(
        [
            { id: "a", parentId: "b" },
            { id: "b", parentId: "a" },
            { id: "orphan", parentId: "missing" },
        ],
        "a"
    );
    assert.deepEqual([...cyclic].sort(), ["a", "b"]);
    assert.deepEqual(
        [...buildLineageFocusSet([{ id: "orphan", parentId: "missing" }], "orphan")],
        ["orphan"]
    );
});

test("search and focus share exact visibility, ancestry, no-match, and reset behavior", () => {
    const source = scalableFixtureState(61, 4);
    const searched = selectConstellationVisibility(source, {
        search: "reveal target",
    });
    assert.equal(searched.visibility.directMatchCount, 1);
    assert.equal(searched.visibility.noMatches, false);
    assert.deepEqual(
        searched.nodes.map((node) => node.id).sort(),
        ["scale-42", "scale-root"]
    );
    assert.deepEqual(searched.edges, [
        {
            source: "scale-root",
            target: "scale-42",
            kind: "parent-child",
            synthetic: false,
        },
    ]);

    const focused = selectConstellationVisibility(source, {
        focusSessionId: "scale-42",
    });
    assert.deepEqual(
        focused.nodes.map((node) => node.id).sort(),
        ["scale-42", "scale-root"]
    );

    const combined = selectConstellationVisibility(source, {
        search: "repository 02",
        focusSessionId: "scale-42",
    });
    assert.equal(combined.visibility.directMatchCount, 1);
    assert.deepEqual(
        combined.nodes.map((node) => node.id).sort(),
        ["scale-42", "scale-root"]
    );

    const noMatches = selectConstellationVisibility(source, {
        search: "definitely absent",
    });
    assert.equal(noMatches.visibility.noMatches, true);
    assert.equal(noMatches.visibility.directMatchCount, 0);
    assert.deepEqual(noMatches.nodes, []);
    assert.deepEqual(noMatches.edges, []);

    const reset = selectConstellationVisibility(source);
    assert.equal(reset.nodes.length, source.nodes.length);
    assert.equal(reset.visibility.query, "");
    assert.equal(reset.visibility.noMatches, false);
});

test("protected reveal set includes only explicit targets and visual ancestry", () => {
    const source = scalableFixtureState(61, 4, "all");
    const protectedIds = buildProtectedRevealSet(source.nodes, {
        rootId: source.rootId,
        currentSessionId: source.currentSessionId,
        selectedId: "scale-10",
        directMatchIds: ["scale-42"],
        focusIds: ["scale-20"],
        revealedIds: ["scale-30"],
    });
    for (const id of [
        overviewRootId,
        "scale-root",
        "scale-0",
        "scale-10",
        "scale-20",
        "scale-30",
        "scale-42",
    ]) {
        assert.equal(protectedIds.has(id), true, `${id} should be protected`);
    }
    for (const id of ["scale-1", "scale-2", "scale-3"]) {
        assert.equal(
            protectedIds.has(id),
            false,
            `${id} attention status should remain compactable`
        );
    }
});

test("attention targets reveal through synthetic ancestry and repository groups", () => {
    const synthetic = normalizeConstellation(
        [
            {
                id: "foreign",
                name: "Foreign root",
                projectId: "foreign-project",
                projectName: "Foreign",
                repository: "octo/foreign",
                status: "idle",
            },
            {
                id: "target",
                parentId: "foreign",
                name: "Target",
                projectId: "project-a",
                projectName: "Project A",
                repository: "octo/a",
                status: "completed",
                updatedAt: "2026-09-25T23:59:00.000Z",
            },
        ],
        "target",
        { scope: "all", relationships: true, projects: true }
    );
    const project = filterConstellationView(synthetic, {
        project: "Project A",
    });
    const target = project.nodes.find((node) => node.id === "target");
    assert.equal(Boolean(target.syntheticParentId), true);
    const protectedIds = buildProtectedRevealSet(project.nodes, {
        rootId: project.rootId,
        currentSessionId: project.currentSessionId,
        revealedIds: ["target"],
    });
    assert.equal(protectedIds.has("target"), true);
    assert.equal(protectedIds.has(target.syntheticParentId), true);
    assert.equal(protectedIds.has(project.rootId), true);

    const dense = scalableFixtureState(121, 8);
    const layout = layoutResponsiveConstellation(dense, {
        width: 320,
        height: 700,
        revealedIds: ["scale-42"],
    });
    assert.equal(layout.nodes.some((node) => node.id === "scale-42"), true);
    assert.equal(
        layout.edges.some(
            (edge) =>
                edge.source === "scale-root" &&
                edge.target === "scale-42" &&
                edge.kind === "parent-child"
        ),
        true
    );
    assert.equal(layout.protectedIds.includes("scale-42"), true);
});

test("recent completed and selected archived targets escape collapsed shelves", () => {
    const source = normalizeConstellation(
        [
            {
                id: "root",
                name: "Root",
                repository: "octo/root",
                status: "idle",
            },
            {
                id: "recent",
                parentId: "root",
                name: "Recent completion",
                repository: "octo/root",
                status: "completed",
                updatedAt: "2026-09-25T23:59:00.000Z",
            },
            {
                id: "old",
                parentId: "root",
                name: "Old completion",
                repository: "octo/root",
                status: "completed",
                updatedAt: "2026-09-25T20:00:00.000Z",
            },
            {
                id: "archived",
                parentId: "root",
                name: "Archived",
                repository: "octo/root",
                status: "archived",
            },
        ],
        "root"
    );
    const layout = layoutResponsiveConstellation(source, {
        width: 320,
        height: 700,
        revealedIds: ["recent"],
        selectedId: "archived",
    });
    assert.equal(layout.nodes.some((node) => node.id === "recent"), true);
    assert.equal(layout.nodes.some((node) => node.id === "archived"), true);
    assert.equal(layout.nodes.some((node) => node.id === "old"), false);
    assert.equal(
        layout.nodes.find((node) => node.id === completedShelfId)?.shelfCount,
        1
    );
});

test("repository grouping has exact thresholds, boundaries, and deterministic ordering", () => {
    const below = scalableFixtureState(defaultGroupingThreshold - 1, 1);
    const belowGrouped = groupDirectRepositorySiblings(
        below.nodes,
        below.rootId,
        {
            groupingThreshold: defaultGroupingThreshold,
            minimumGroupSize: defaultMinimumGroupSize,
        }
    );
    assert.equal(belowGrouped.groupCount, 0);
    assert.equal(belowGrouped.nodes.length, below.nodes.length);

    const boundary = scalableFixtureState(defaultGroupingThreshold, 1);
    const first = groupDirectRepositorySiblings(
        boundary.nodes,
        boundary.rootId,
        {
            groupingThreshold: defaultGroupingThreshold,
            minimumGroupSize: defaultMinimumGroupSize,
        }
    );
    const second = groupDirectRepositorySiblings(
        [...boundary.nodes].reverse(),
        boundary.rootId,
        {
            groupingThreshold: defaultGroupingThreshold,
            minimumGroupSize: defaultMinimumGroupSize,
        }
    );
    const groupId = repositoryGroupId(
        "scale-root",
        "octo/repository-00"
    );
    assert.equal(first.groupCount, 1);
    assert.equal(first.hiddenSessionCount, defaultGroupingThreshold - 1);
    assert.equal(first.nodes.some((node) => node.id === groupId), true);
    assert.deepEqual(
        first.nodes.map((node) => node.id),
        second.nodes.map((node) => node.id)
    );

    const boundarySize = scalableFixtureState(defaultGroupingThreshold, 20);
    const noMinimumGroup = groupDirectRepositorySiblings(
        boundarySize.nodes,
        boundarySize.rootId,
        {
            groupingThreshold: defaultGroupingThreshold,
            minimumGroupSize: defaultMinimumGroupSize,
        }
    );
    assert.equal(noMinimumGroup.groupCount, 0);
});

test("overflow compaction is deterministic and honors the explicit hard budget", () => {
    const source = scalableFixtureState(1001, 1000);
    const protectedIds = buildProtectedRevealSet(source.nodes, {
        rootId: source.rootId,
        currentSessionId: source.currentSessionId,
    });
    const first = compactOverflowNodes(source.nodes, source.rootId, {
        protectedIds,
        visibleCardBudget: defaultVisibleCardBudget,
        overflowPageSize: defaultOverflowPageSize,
    });
    const second = compactOverflowNodes(
        [...source.nodes].reverse(),
        source.rootId,
        {
            protectedIds,
            visibleCardBudget: defaultVisibleCardBudget,
            overflowPageSize: defaultOverflowPageSize,
        }
    );
    assert.equal(first.nodes.length <= defaultVisibleCardBudget, true);
    assert.equal(first.overflowCount, 10);
    assert.equal(first.hiddenSessionCount, 999);
    assert.equal(first.budgetExceeded, false);
    assert.deepEqual(
        first.nodes.map((node) => node.id).sort(),
        second.nodes.map((node) => node.id).sort()
    );
});

test("expanded repository groups persist and selection never dissolves them", () => {
    const source = scalableFixtureState(81, 4);
    const groupId = repositoryGroupId(
        "scale-root",
        "octo/repository-00"
    );
    const collapsed = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
    });
    assert.equal(
        collapsed.nodes.find((node) => node.id === groupId)?.groupExpanded,
        false
    );
    assert.equal(collapsed.nodes.some((node) => node.id === "scale-4"), false);

    const expandedIds = new Set([groupId]);
    const expanded = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
        expandedGroupIds: expandedIds,
    });
    const rerendered = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
        selectedId: "scale-4",
        expandedGroupIds: expandedIds,
    });
    for (const layout of [expanded, rerendered]) {
        assert.equal(
            layout.nodes.find((node) => node.id === groupId)?.groupExpanded,
            true
        );
        assert.equal(layout.nodes.some((node) => node.id === "scale-4"), true);
    }
    assert.equal(expandedIds.has(groupId), true);
});

test("shelf-only compaction reports 17 hidden real sessions across tree, all, and project scopes", () => {
    const states = [
        shelfOnlyFixtureState("tree"),
        shelfOnlyFixtureState("all"),
        filterConstellationState(shelfOnlyFixtureState("all"), {
            project: "project-shelf",
        }),
    ];
    for (const state of states) {
        const layout = layoutResponsiveConstellation(state, {
            width: 480,
            height: 900,
        });
        assert.deepEqual(layout.visibilityDiagnostics, {
            scopeFilteredRealSessionCount: 18,
            selectedRealSessionCount: 18,
            excludedBySearchOrFocusCount: 0,
            visibleRealSessionCount: 1,
            groupedHiddenSessionCount: 0,
            repositoryGroupedHiddenSessionCount: 0,
            overflowGroupedHiddenSessionCount: 0,
            completedShelvedSessionCount: 17,
            archivedShelvedSessionCount: 0,
            totalHiddenRealSessionCount: 17,
        });
        assert.deepEqual(
            layout.diagnostics.visibility.compaction,
            layout.visibilityDiagnostics
        );
        assert.equal(layout.hiddenSessionCount, 17);
        assert.equal(layout.nodes.some((node) => node.isShelf), true);
        assert.equal(
            layout.nodes.filter(
                (node) =>
                    !node.synthetic &&
                    !node.isShelf &&
                    !node.isRepositoryGroup &&
                    !node.isOverflowSummary
            ).length,
            1
        );
        assert.equal(
            layout.visibilityDiagnostics.visibleRealSessionCount +
                layout.visibilityDiagnostics.totalHiddenRealSessionCount,
            layout.visibilityDiagnostics.selectedRealSessionCount
        );
    }
});

test("mixed repository grouping and shelves remain additive through expansion", () => {
    const state = normalizeConstellation(
        [
            {
                id: "mixed-root",
                name: "Mixed coordinator",
                repository: "octo/root",
                status: "idle",
            },
            ...Array.from({ length: 6 }, (_, index) => ({
                id: `grouped-${index}`,
                parentId: "mixed-root",
                name: `Grouped ${index}`,
                repository: "octo/shared",
                status: "idle",
            })),
            ...Array.from({ length: 4 }, (_, index) => ({
                id: `done-${index}`,
                parentId: "mixed-root",
                name: `Done ${index}`,
                repository: `octo/done-${index}`,
                status: "completed",
            })),
            ...Array.from({ length: 3 }, (_, index) => ({
                id: `archive-${index}`,
                parentId: "mixed-root",
                name: `Archive ${index}`,
                repository: `octo/archive-${index}`,
                status: "archived",
            })),
        ],
        "mixed-root"
    );
    const groupId = repositoryGroupId("mixed-root", "octo/shared");
    const collapsed = layoutResponsiveConstellation(state, {
        width: 480,
        height: 900,
        groupingThreshold: 1,
        minimumGroupSize: 3,
        visibleCardBudget: 100,
    });
    assert.deepEqual(collapsed.visibilityDiagnostics, {
        scopeFilteredRealSessionCount: 14,
        selectedRealSessionCount: 14,
        excludedBySearchOrFocusCount: 0,
        visibleRealSessionCount: 1,
        groupedHiddenSessionCount: 6,
        repositoryGroupedHiddenSessionCount: 6,
        overflowGroupedHiddenSessionCount: 0,
        completedShelvedSessionCount: 4,
        archivedShelvedSessionCount: 3,
        totalHiddenRealSessionCount: 13,
    });

    const groupExpanded = layoutResponsiveConstellation(state, {
        width: 480,
        height: 900,
        groupingThreshold: 1,
        minimumGroupSize: 3,
        visibleCardBudget: 100,
        expandedGroupIds: [groupId],
    });
    assert.equal(
        groupExpanded.visibilityDiagnostics.groupedHiddenSessionCount,
        0
    );
    assert.equal(
        groupExpanded.visibilityDiagnostics.completedShelvedSessionCount,
        4
    );
    assert.equal(
        groupExpanded.visibilityDiagnostics.archivedShelvedSessionCount,
        3
    );
    assert.equal(
        groupExpanded.visibilityDiagnostics.totalHiddenRealSessionCount,
        7
    );

    const shelvesExpanded = layoutResponsiveConstellation(state, {
        width: 480,
        height: 900,
        groupingThreshold: 1,
        minimumGroupSize: 3,
        visibleCardBudget: 100,
        expandedGroupIds: [groupId],
        completedExpanded: true,
        archivedExpanded: true,
    });
    assert.equal(
        shelvesExpanded.visibilityDiagnostics.totalHiddenRealSessionCount,
        0
    );
    assert.equal(
        shelvesExpanded.visibilityDiagnostics.visibleRealSessionCount,
        14
    );
    assert.equal(
        shelvesExpanded.nodes.filter(
            (node) =>
                !node.synthetic &&
                !node.isShelf &&
                !node.isRepositoryGroup &&
                !node.isOverflowSummary
        ).length,
        14
    );
});

test("overflow grouping and shelves report separate hidden components without synthetic counts", () => {
    const state = normalizeConstellation(
        [
            {
                id: "overflow-root",
                name: "Overflow coordinator",
                repository: "octo/root",
                status: "idle",
            },
            ...Array.from({ length: 20 }, (_, index) => ({
                id: `overflow-real-${index}`,
                parentId: "overflow-root",
                name: `Overflow real ${index}`,
                repository: `octo/unique-${index}`,
                status: "idle",
            })),
            ...Array.from({ length: 4 }, (_, index) => ({
                id: `overflow-done-${index}`,
                parentId: "overflow-root",
                name: `Overflow done ${index}`,
                repository: `octo/done-${index}`,
                status: "completed",
            })),
        ],
        "overflow-root"
    );
    const layout = layoutResponsiveConstellation(state, {
        width: 480,
        height: 900,
        groupingThreshold: 100,
        visibleCardBudget: 6,
        overflowPageSize: 10,
    });
    assert.equal(layout.visibilityDiagnostics.selectedRealSessionCount, 25);
    assert.equal(layout.visibilityDiagnostics.visibleRealSessionCount, 1);
    assert.equal(
        layout.visibilityDiagnostics.repositoryGroupedHiddenSessionCount,
        0
    );
    assert.equal(
        layout.visibilityDiagnostics.overflowGroupedHiddenSessionCount,
        20
    );
    assert.equal(
        layout.visibilityDiagnostics.completedShelvedSessionCount,
        4
    );
    assert.equal(
        layout.visibilityDiagnostics.totalHiddenRealSessionCount,
        24
    );
    assert.equal(
        layout.visibilityDiagnostics.visibleRealSessionCount +
            layout.visibilityDiagnostics.totalHiddenRealSessionCount,
        layout.visibilityDiagnostics.selectedRealSessionCount
    );
    assert.equal(
        layout.nodes.some(
            (node) => node.isShelf || node.isOverflowSummary
        ),
        true
    );
});

test("filters and focus distinguish excluded sessions from compacted hidden sessions", () => {
    const source = shelfOnlyFixtureState("all");
    const filtered = filterConstellationState(source, {
        status: "completed",
    });
    const filteredLayout = layoutResponsiveConstellation(filtered, {
        width: 480,
        height: 900,
    });
    assert.equal(
        filteredLayout.visibilityDiagnostics.scopeFilteredRealSessionCount,
        18
    );
    assert.equal(
        filteredLayout.visibilityDiagnostics.totalHiddenRealSessionCount,
        17
    );

    for (const visibleState of [
        selectConstellationVisibility(source, {
            search: "focused completed target",
        }),
        selectConstellationVisibility(source, {
            focusSessionId: "shelved-0",
        }),
    ]) {
        const layout = layoutResponsiveConstellation(visibleState, {
            width: 480,
            height: 900,
        });
        assert.deepEqual(layout.visibilityDiagnostics, {
            scopeFilteredRealSessionCount: 18,
            selectedRealSessionCount: 2,
            excludedBySearchOrFocusCount: 16,
            visibleRealSessionCount: 2,
            groupedHiddenSessionCount: 0,
            repositoryGroupedHiddenSessionCount: 0,
            overflowGroupedHiddenSessionCount: 0,
            completedShelvedSessionCount: 0,
            archivedShelvedSessionCount: 0,
            totalHiddenRealSessionCount: 0,
        });
    }

    assert.deepEqual(
        summarizeLayoutVisibility(source, {
            nodes: [
                {
                    id: "synthetic",
                    synthetic: true,
                    isShelf: true,
                },
            ],
            completedShelvedSessionCount: 17,
        }),
        {
            scopeFilteredRealSessionCount: 18,
            selectedRealSessionCount: 18,
            excludedBySearchOrFocusCount: 0,
            visibleRealSessionCount: 0,
            groupedHiddenSessionCount: 0,
            repositoryGroupedHiddenSessionCount: 0,
            overflowGroupedHiddenSessionCount: 0,
            completedShelvedSessionCount: 17,
            archivedShelvedSessionCount: 0,
            totalHiddenRealSessionCount: 17,
        }
    );
});

test("dense grouping compacts attention while explicit and searched targets retain real edges", () => {
    const source = scalableFixtureState(121, 8);
    const layout = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
    });
    assert.equal(layout.nodes.some((node) => node.id === "scale-0"), true);
    for (const id of ["scale-1", "scale-2", "scale-3"]) {
        assert.equal(layout.nodes.some((node) => node.id === id), false);
    }
    assert.equal(layout.groupCount, 8);
    assert.equal(layout.hiddenSessionCount, 119);

    const revealed = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
        revealedIds: ["scale-2"],
    });
    assert.equal(revealed.nodes.some((node) => node.id === "scale-2"), true);
    assert.equal(
        revealed.edges.some(
            (edge) =>
                edge.source === "scale-root" &&
                edge.target === "scale-2" &&
                edge.kind === "parent-child" &&
                edge.synthetic === false
        ),
        true
    );

    const searched = selectConstellationVisibility(source, {
        search: "reveal target",
    });
    const searchLayout = layoutResponsiveConstellation(searched, {
        width: 320,
        height: 700,
    });
    assert.deepEqual(
        searchLayout.nodes.map((node) => node.id).sort(),
        ["scale-42", "scale-root"]
    );
});

test("100+ session overview stays bounded at required pane widths in both orientations", () => {
    const dense = scalableFixtureState(121, 8);
    for (const width of [280, 320, 480, 700, 960]) {
        const layout = layoutResponsiveConstellation(dense, {
            width,
            height: width === 960 ? 600 : 900,
        });
        assert.equal(layout.orientation, "vertical");
        assert.equal(layout.width, Math.max(280, width));
        assert.equal(layout.nodes.length <= defaultVisibleCardBudget, true);
        assert.equal(layout.height <= 3000, true);
        assert.equal(layout.hiddenSessionCount, 119);
        assert.equal(layout.budgetExceeded, false);
        for (const node of layout.nodes) {
            assert.equal(node.x - layout.cardWidth / 2 >= 0, true);
            assert.equal(node.x + layout.cardWidth / 2 <= layout.width, true);
        }
    }

    const small = fixtureState();
    const horizontal = layoutResponsiveConstellation(small, {
        width: 960,
        height: 600,
    });
    const vertical = layoutResponsiveConstellation(small, {
        width: 480,
        height: 700,
    });
    assert.equal(horizontal.orientation, "horizontal");
    assert.equal(vertical.orientation, "vertical");
});

test("global overflow compaction bounds unique repositories and Home chats", () => {
    const unique = scalableFixtureState(1001, 1000);
    const homes = homeChatFixtureState(600);
    for (const [name, source] of [
        ["unique repositories", unique],
        ["Home chats", homes],
    ]) {
        for (const width of [320, 480, 700]) {
            const layout = layoutResponsiveConstellation(source, {
                width,
                height: 900,
            });
            assert.equal(
                layout.nodes.length <= defaultVisibleCardBudget,
                true,
                `${name} at ${width}px exceeded the card budget`
            );
            assert.equal(
                layout.height <= 3000,
                true,
                `${name} at ${width}px exceeded the height budget`
            );
            assert.equal(layout.budgetExceeded, false);
            assert.equal(layout.overflowCount > 0, true);
        }
    }

    const selected = layoutResponsiveConstellation(unique, {
        width: 480,
        height: 900,
        selectedId: "scale-500",
    });
    assert.equal(selected.nodes.some((node) => node.id === "scale-500"), true);
    const revealed = layoutResponsiveConstellation(unique, {
        width: 480,
        height: 900,
        revealedIds: ["scale-777"],
    });
    assert.equal(revealed.nodes.some((node) => node.id === "scale-777"), true);
});

test("overflow pages expand persistently and retain original lineage", () => {
    const source = scalableFixtureState(201, 200);
    const summaryId = overflowSummaryId("scale-root", 0);
    const collapsed = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
    });
    assert.equal(
        collapsed.nodes.find((node) => node.id === summaryId)?.overflowExpanded,
        false
    );
    const expandedIds = new Set([summaryId]);
    const expanded = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
        expandedOverflowIds: expandedIds,
    });
    const rerendered = layoutResponsiveConstellation(source, {
        width: 480,
        height: 900,
        expandedOverflowIds: expandedIds,
    });
    for (const layout of [expanded, rerendered]) {
        assert.equal(
            layout.nodes.find((node) => node.id === summaryId)?.overflowExpanded,
            true
        );
        const revealedNode = layout.nodes.find(
            (node) => node.id !== "scale-root" && !node.synthetic
        );
        assert.ok(revealedNode);
        assert.equal(
            layout.edges.some(
                (edge) =>
                    edge.source === "scale-root" &&
                    edge.target === revealedNode.id &&
                    edge.synthetic === false
            ),
            true
        );
    }
});

test("100 attention sessions compact by default and every explicit target is revealable", () => {
    for (const uniqueRepositories of [false, true]) {
        const source = attentionFixtureState({ uniqueRepositories });
        for (const width of [320, 480, 700]) {
            const layout = layoutResponsiveConstellation(source, {
                width,
                height: 900,
            });
            assert.equal(layout.nodes.length <= defaultVisibleCardBudget, true);
            assert.equal(layout.height <= 3000, true);
            assert.equal(layout.budgetExceeded, false);
        }
        for (let index = 0; index < 100; index++) {
            const id = `attention-${index}`;
            const revealed = layoutResponsiveConstellation(source, {
                width: 480,
                height: 900,
                revealedIds: [id],
            });
            assert.equal(
                revealed.nodes.some((node) => node.id === id),
                true,
                `${id} should be explicitly revealable`
            );
        }
    }
});

test("scale benchmark matrix stays within hard card and height budgets", () => {
    const scenarios = [
        ["shared-repo-1001", scalableFixtureState(1001, 1)],
        ["unique-repo-1001", scalableFixtureState(1001, 1000)],
        ["home-chat-600", homeChatFixtureState(600)],
        ["attention-shared-100", attentionFixtureState()],
        [
            "attention-unique-100",
            attentionFixtureState({ uniqueRepositories: true }),
        ],
    ];
    const iterations = 20;
    for (const [name, source] of scenarios) {
        for (const width of [320, 480, 700]) {
            layoutResponsiveConstellation(source, { width, height: 900 });
            const startedAt = performance.now();
            let layout;
            for (let index = 0; index < iterations; index++) {
                layout = layoutResponsiveConstellation(source, {
                    width,
                    height: 900,
                });
            }
            const averageMilliseconds =
                (performance.now() - startedAt) / iterations;
            assert.equal(layout.nodes.length <= defaultVisibleCardBudget, true);
            assert.equal(layout.height <= 3000, true);
            assert.equal(layout.budgetExceeded, false);
            console.log(
                `benchmark: ${name} @ ${width}px -> ` +
                    `${layout.nodes.length} cards, ${layout.height}px, ` +
                    `${averageMilliseconds.toFixed(2)} ms average`
            );
        }
    }
});

test("responsive layout is right-pane-first across required breakpoints", () => {
    const source = normalizeConstellation(
        [
            {
                id: "root",
                name: "Coordinator",
                repository: "octo/root",
                status: "waiting-user",
            },
            {
                id: "waiting",
                parentId: "root",
                name: "Waiting child",
                repository: "octo/waiting",
                status: "waiting-plan",
            },
            {
                id: "current",
                parentId: "root",
                name: "Current child",
                repository: "octo/current",
                provider: "ollama",
                model: "ollama/llama-3.3",
                status: "busy",
            },
            ...Array.from({ length: 12 }, (_, index) => ({
                id: `completed-${index}`,
                parentId: "root",
                name: `Completed child ${index}`,
                repository: "octo/completed",
                status: "completed",
            })),
            ...Array.from({ length: 5 }, (_, index) => ({
                id: `archived-${index}`,
                parentId: "root",
                name: `Archived child ${index}`,
                repository: "octo/archived",
                status: "archived",
            })),
            {
                id: "deep",
                parentId: "current",
                name: "Deep child",
                repository: "octo/current",
                status: "idle",
            },
        ],
        "current"
    );

    for (const [width, height, orientation] of [
        [280, 700, "vertical"],
        [320, 700, "vertical"],
        [480, 700, "vertical"],
        [700, 700, "vertical"],
        [960, 600, "horizontal"],
        [960, 1200, "vertical"],
    ]) {
        const layout = layoutResponsiveConstellation(source, { width, height });
        assert.equal(layout.orientation, orientation);
        assert.equal(layout.completedCount, 12);
        assert.equal(layout.archivedCount, 5);
        assert.equal(layout.completedShelvedSessionCount, 12);
        assert.equal(layout.archivedShelvedSessionCount, 5);
        assert.equal(layout.groupedHiddenSessionCount, 0);
        assert.equal(layout.totalHiddenRealSessionCount, 17);
        assert.equal(layout.hiddenSessionCount, 17);
        assert.equal(layout.nodes.some((node) => node.id === completedShelfId), true);
        assert.equal(layout.nodes.some((node) => node.id === archivedShelfId), true);
        assert.equal(layout.nodes.some((node) => node.id === "completed-0"), false);
        assert.equal(layout.nodes.some((node) => node.id === "archived-0"), false);
        const root = layout.nodes.find((node) => node.id === "root");
        const waiting = layout.nodes.find((node) => node.id === "waiting");
        const current = layout.nodes.find((node) => node.id === "current");
        const deep = layout.nodes.find((node) => node.id === "deep");
        assert.equal(current.isLocalModel, true);
        assert.equal(
            layout.nodes.find((node) => node.id === completedShelfId).isLocalModel,
            undefined
        );
        assert.equal(waiting.y <= current.y, true);
        assert.equal(layout.cardWidth >= 172, true);
        assert.equal(layout.cardHeight, 76);
        assert.equal(layout.height >= height, true);
        if (orientation === "vertical") {
            assert.equal(root.x < current.x, true);
            assert.equal(current.x < deep.x, true);
            const archivedShelf = layout.nodes.find(
                (node) => node.id === archivedShelfId
            );
            const completedShelf = layout.nodes.find(
                (node) => node.id === completedShelfId
            );
            assert.equal(waiting.y < current.y, true);
            assert.equal(current.y < archivedShelf.y, true);
            assert.equal(archivedShelf.y < completedShelf.y, true);
            assert.equal(layout.width, Math.max(280, width));
            for (const node of layout.nodes) {
                assert.equal(node.x - layout.cardWidth / 2 >= 0, true);
                assert.equal(node.x + layout.cardWidth / 2 <= layout.width, true);
            }
        } else {
            assert.equal(layout.width <= 960, true);
        }
    }

    const expanded = layoutResponsiveConstellation(source, {
        width: 420,
        height: 900,
        completedExpanded: true,
    });
    assert.equal(expanded.completedCount, 12);
    assert.equal(expanded.archivedCount, 5);
    assert.equal(expanded.completedShelvedSessionCount, 0);
    assert.equal(expanded.archivedShelvedSessionCount, 5);
    assert.equal(expanded.totalHiddenRealSessionCount, 5);
    assert.equal(expanded.nodes.some((node) => node.id === completedShelfId), true);
    assert.equal(expanded.nodes.some((node) => node.id === archivedShelfId), true);
    assert.equal(
        expanded.nodes.filter((node) => node.status === "completed" && !node.isShelf).length,
        12
    );
    assert.equal(
        expanded.nodes.filter((node) => node.status === "archived" && !node.isShelf)
            .length,
        0
    );
    assert.equal(expanded.height > 900, true);

    const archivedExpanded = layoutResponsiveConstellation(source, {
        width: 420,
        height: 900,
        archivedExpanded: true,
    });
    assert.equal(
        archivedExpanded.nodes.filter(
            (node) => node.status === "archived" && !node.isShelf
        ).length,
        5
    );
    assert.equal(
        archivedExpanded.nodes.filter(
            (node) => node.status === "completed" && !node.isShelf
        ).length,
        0
    );
    assert.equal(archivedExpanded.completedShelvedSessionCount, 12);
    assert.equal(archivedExpanded.archivedShelvedSessionCount, 0);
    assert.equal(archivedExpanded.totalHiddenRealSessionCount, 12);

    const wide = layoutResponsiveConstellation(source, { width: 1200, height: 700 });
    assert.equal(wide.orientation, "horizontal");
    assert.equal(wide.cardHeight, 76);
    assert.equal(wide.nodes.find((node) => node.id === "current").isLocalModel, true);
    assert.equal(orientationForSize(280, 700), "vertical");
    assert.equal(orientationForSize(320, 700), "vertical");
    assert.equal(orientationForSize(480, 700), "vertical");
    assert.equal(orientationForSize(700, 700), "vertical");
    assert.equal(
        orientationForSize(960, 600, { nodeCount: 6, leafCount: 3 }),
        "horizontal"
    );
    assert.equal(
        orientationForSize(960, 1200, { nodeCount: 6, leafCount: 3 }),
        "vertical"
    );
    assert.equal(
        orientationForSize(960, 600, { nodeCount: 14, leafCount: 12 }),
        "vertical"
    );
    assert.equal(fitWidthScale(420, 2400), 0.82);
});

test("attention and busy sessions sort ahead of idle and collapsed shelves", () => {
    const state = normalizeConstellation(
        [
            {
                id: "root",
                name: "Root",
                repository: "octo/root",
                status: "idle",
            },
            ...[
                "completed",
                "archived",
                "idle",
                "busy",
                "failed",
                "blocked",
                "waiting-plan",
                "waiting-user",
            ].map((status) => ({
                id: status,
                parentId: "root",
                name: status,
                repository: "octo/root",
                status,
            })),
        ],
        "busy"
    );
    const layout = layoutResponsiveConstellation(state, {
        width: 480,
        height: 900,
    });
    assert.deepEqual(
        layout.nodes
            .filter((node) => node.id !== "root")
            .sort((left, right) => left.y - right.y)
            .map((node) => node.id),
        [
            "waiting-user",
            "waiting-plan",
            "blocked",
            "failed",
            "busy",
            "idle",
            archivedShelfId,
            completedShelfId,
        ]
    );
});

test("dense synthetic overview and project roots stay bounded in half-screen panes", () => {
    const overview = normalizeConstellation(
        Array.from({ length: 12 }, (_, index) => ({
            id: `session-${index}`,
            name: `Session ${index}`,
            projectId: `project-${index}`,
            projectName: `Project ${index}`,
            repository: `octo/project-${index}`,
            status: index % 2 ? "idle" : "busy",
        })),
        "session-0",
        { scope: "all", relationships: true, projects: true }
    );
    const overviewLayout = layoutResponsiveConstellation(overview, {
        width: 960,
        height: 600,
    });
    assert.equal(overview.rootId, overviewRootId);
    assert.equal(overviewLayout.orientation, "vertical");
    assert.equal(overviewLayout.width, 960);
    assert.equal(
        overviewLayout.nodes.filter((node) => !node.synthetic).length,
        overview.diagnostics.selectedRealSessionCount
    );

    const project = filterConstellationView(crossProjectFixtureState("all"), {
        project: "Project A",
    });
    const projectLayout = layoutResponsiveConstellation(project, {
        width: 480,
        height: 900,
    });
    assert.equal(project.rootId, overviewRootId);
    assert.equal(projectLayout.orientation, "vertical");
    assert.equal(projectLayout.width, 480);
    assert.equal(
        projectLayout.nodes.some(
            (node) => node.id === "a-waiting" && node.status === "waiting-user"
        ),
        true
    );
});

test("card corner marker slots are shared, distinct, and future-ready", () => {
    const slots = cardMarkerLayout(172, 76);
    assert.deepEqual(Object.keys(slots), [
        "status",
        "identity",
        "activity",
        "trust",
    ]);
    assert.equal(slots.status.x < 0 && slots.status.y < 0, true);
    assert.equal(slots.identity.right > 0 && slots.identity.y < 0, true);
    assert.equal(slots.activity.x > 0 && slots.activity.y > 0, true);
    assert.equal(slots.trust.x < 0 && slots.trust.y > 0, true);
    assert.notDeepEqual(slots.activity, slots.trust);
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /class: "node-trust-marker"/);
    assert.match(html, /x: markerLayout\.trust\.x - 6/);
    assert.match(html, /y: markerLayout\.trust\.y - 7/);
});

test("automatic announcements ignore timestamps and report operational changes", () => {
    const previous = fixtureState();
    const timestampOnly = structuredClone(previous);
    timestampOnly.generatedAt = "2026-09-25T23:00:00.000Z";
    timestampOnly.nodes[0].updatedAt = "2026-09-25T23:00:00.000Z";
    assert.equal(describeMeaningfulConstellationChange(previous, timestampOnly), "");
    const refreshOnly = structuredClone(previous);
    refreshOnly.diagnostics.refresh = {
        ...refreshOnly.diagnostics.refresh,
        status: "degraded",
        usingLastGood: true,
        consecutiveFailures: 1,
    };
    assert.equal(describeMeaningfulConstellationChange(previous, refreshOnly), "");

    const changed = structuredClone(previous);
    changed.nodes.find((node) => node.id === "busy-child").status = "completed";
    changed.nodes.push({
        id: "new-session",
        name: "New session",
        repository: "octo/new",
        status: "idle",
    });
    assert.equal(
        describeMeaningfulConstellationChange(previous, changed),
        "1 session added. 1 session changed status."
    );
});

test("pinch gesture zooms around the moving midpoint", () => {
    const zoomed = applyPinchGesture({
        transform: { x: 0, y: 0, k: 1 },
        startA: { x: 0, y: 0 },
        startB: { x: 100, y: 0 },
        currentA: { x: 10, y: 20 },
        currentB: { x: 210, y: 20 },
    });

    assert.deepEqual(zoomed, { x: 10, y: 20, k: 2 });

    const clamped = applyPinchGesture({
        transform: { x: 5, y: 8, k: 1 },
        startA: { x: 0, y: 0 },
        startB: { x: 100, y: 0 },
        currentA: { x: 49, y: 0 },
        currentB: { x: 51, y: 0 },
    });
    assert.equal(clamped.k, 0.65);
});

test("programmatic scroll behavior honors normal and reduced motion modes", () => {
    assert.equal(
        programmaticScrollBehavior({
            smooth: true,
            reducedMotion: false,
        }),
        "smooth"
    );
    assert.equal(
        programmaticScrollBehavior({
            smooth: true,
            reducedMotion: true,
        }),
        "auto"
    );
    assert.equal(
        programmaticScrollBehavior({
            smooth: false,
            reducedMotion: false,
        }),
        "auto"
    );
});

test("visible selection survives layout changes and falls back only when removed", () => {
    const narrow = [
        { id: "root" },
        { id: "selected" },
        { id: "current" },
    ];
    const wide = [
        { id: "current" },
        { id: "root" },
        { id: "selected" },
    ];
    assert.equal(
        resolveVisibleSelection(narrow, "selected", ["current", "root"]),
        "selected"
    );
    assert.equal(
        resolveVisibleSelection(wide, "selected", ["current", "root"]),
        "selected"
    );
    assert.equal(
        resolveVisibleSelection(
            [{ id: "root" }, { id: "current" }],
            "selected",
            ["current", "root"]
        ),
        "current"
    );
    assert.equal(
        resolveVisibleSelection([{ id: "root" }], "selected", ["current", "root"]),
        "root"
    );
});

test("collector uses app relationships and gracefully combines safe fallbacks", () => {
    const scratch = path.join(extensionDir, `.test-artifacts-${randomUUID()}`);
    const appPath = path.join(scratch, "data.db");
    const storePath = path.join(scratch, "session-store.db");
    const sessionStateRoot = path.join(scratch, "session-state");
    mkdirSync(sessionStateRoot, { recursive: true });
    let app;
    let store;
    try {
        app = new DatabaseSync(appPath);
        app.exec(`
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, title TEXT, mode TEXT, model TEXT, reasoning_effort TEXT,
                provider_id TEXT, is_running INTEGER,
                was_interrupted INTEGER, interruption_reason TEXT, created_at TEXT,
                updated_at TEXT, archived_at TEXT, forked_from_session_id TEXT
            );
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY, project_id TEXT, branch TEXT, name TEXT,
                session_id TEXT, archived_at TEXT, creator_session_id TEXT,
                coordinating_creator_session_id TEXT, source_pr_repo_full_name TEXT,
                source_pr_number INTEGER, source_pr_title TEXT,
                source_issue_repo_full_name TEXT, source_issue_number INTEGER,
                created_pr_repo_full_name TEXT, created_pr_number INTEGER
            );
            CREATE TABLE workspace_session_aliases (session_id TEXT, workspace_id TEXT);
            CREATE TABLE workspace_parent_links (
                child_workspace_id TEXT, parent_workspace_id TEXT, creator_session_id TEXT
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY, name TEXT, github_owner TEXT, github_repo TEXT, main_repo_path TEXT
            );
            CREATE TABLE workspace_repo_contexts (
                workspace_id TEXT, repo_full_name TEXT, source_pr_number INTEGER,
                source_pr_title TEXT, source_issue_number INTEGER, created_pr_number INTEGER
            );
            CREATE TABLE activity_items (
                session_id TEXT, activity_type TEXT, updated_at TEXT
            );
        `);
        app.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(
            "project",
            "Example",
            "octo",
            "example",
            "D:\\repos\\example"
        );
        app.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            "root",
            "Coordinator",
            "autopilot",
            "gpt-5.6-sol",
            "high",
            "ollama\u0000",
            1,
            0,
            null,
            "2026-09-25T16:00:00.000Z",
            "2026-09-25T16:01:00.000Z",
            null,
            null
        );
        app.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            "child",
            "Private child prompt",
            "plan",
            "auto\u0000",
            null,
            "github",
            0,
            0,
            null,
            "2026-09-25T16:02:00.000Z",
            "2026-09-25T16:03:00.000Z",
            null,
            null
        );
        app.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            "root-workspace",
            "project",
            "main",
            "Coordinator",
            "root",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null
        );
        app.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            "child-workspace",
            "project",
            "feature/review",
            "Review child",
            "child",
            null,
            "root",
            "root",
            "octo/example",
            42,
            "Safe title",
            null,
            null,
            null,
            null
        );
        app.prepare("INSERT INTO workspace_parent_links VALUES (?, ?, ?)").run(
            "child-workspace",
            "root-workspace",
            "root"
        );
        app.prepare("INSERT INTO activity_items VALUES (?, ?, ?)").run(
            "child",
            "agent_asking",
            "2026-09-25T16:04:00.000Z"
        );
        app.close();
        app = undefined;

        store = new DatabaseSync(storePath);
        store.exec(`
            CREATE TABLE sessions (
                id TEXT, cwd TEXT, repository TEXT, branch TEXT,
                created_at TEXT, updated_at TEXT
            );
            CREATE TABLE session_refs (
                session_id TEXT, ref_type TEXT, ref_value TEXT, created_at TEXT
            );
        `);
        store.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run(
            "child",
            "D:\\repos\\example",
            "octo/example",
            "feature/review",
            "2026-09-25T16:02:00.000Z",
            "2026-09-25T16:03:00.000Z"
        );
        store.prepare("INSERT INTO session_refs VALUES (?, ?, ?, ?)").run(
            "child",
            "issue",
            "#7",
            "2026-09-25T16:03:30.000Z"
        );
        store.close();
        store = undefined;

        const rootEvents = path.join(sessionStateRoot, "root");
        mkdirSync(rootEvents, { recursive: true });
        writeFileSync(
            path.join(rootEvents, "events.jsonl"),
            [
                {
                    type: "user.message",
                    timestamp: "2026-09-25T16:01:05.000Z",
                    data: {},
                },
                {
                    type: "assistant.turn_start",
                    timestamp: "2026-09-25T16:01:10.000Z",
                    data: { turnId: "turn" },
                },
            ]
                .map((event) => JSON.stringify(event))
                .join("\n") + "\n"
        );

        const result = collectConstellationState({
            currentSessionId: "root",
            appDatabasePath: appPath,
            sessionStorePath: storePath,
            sessionStateRoot,
        });
        assert.equal(result.nodes.length, 2);
        const root = result.nodes.find((node) => node.id === "root");
        assert.equal(root.status, "busy");
        assert.equal(root.busySince, "2026-09-25T16:01:05.000Z");
        assert.equal(root.provider, "ollama");
        assert.equal(root.model, "gpt-5.6-sol");
        assert.equal(root.reasoningEffort, "high");
        assert.equal(root.isLocalModel, true);
        const child = result.nodes.find((node) => node.id === "child");
        assert.equal(child.parentId, "root");
        assert.equal(child.name, "Review child");
        assert.equal(child.status, "waiting-plan");
        assert.equal(child.provider, "github");
        assert.equal(child.model, "auto");
        assert.equal(child.reasoningEffort, undefined);
        assert.equal(child.isLocalModel, false);
        assert.equal(child.humanGate.label, "Plan approval required");
        assert.equal(child.pullRequest, "#42");
        assert.equal(child.issue, "#7");
        assert.equal(result.diagnostics.sources.appDatabase.status, "healthy");
        assert.equal(result.diagnostics.sources.sessionStore.status, "healthy");
        assert.equal(result.diagnostics.sources.eventMetadata.status, "partial");
        assert.deepEqual(result.diagnostics.coverage.events, {
            observedSessions: 1,
            selectedSessions: 2,
        });
        assert.equal(result.diagnostics.level, "limited");
        assert.deepEqual(root.provenance.repository, {
            kind: "recorded",
            source: "appDatabase",
        });
        assert.deepEqual(root.provenance.model, {
            kind: "recorded",
            source: "appDatabase",
        });
        assert.deepEqual(root.provenance.status, {
            kind: "inferred",
            sources: ["appDatabase", "eventMetadata"],
        });
        assert.deepEqual(child.provenance.status, {
            kind: "inferred",
            sources: ["appDatabase"],
        });
        assert.equal(JSON.stringify(result).includes("Safe title"), false);
        assert.equal(JSON.stringify(result).includes("Private child prompt"), false);
        assert.equal(JSON.stringify(result).includes(appPath), false);
        assert.equal(JSON.stringify(result).includes(storePath), false);
    } finally {
        app?.close();
        store?.close();
        rmSync(scratch, { recursive: true, force: true });
    }
});

test("collector all scope labels home chat only from positive session metadata", () => {
    const scratch = path.join(extensionDir, `.test-artifacts-${randomUUID()}`);
    const appPath = path.join(scratch, "data.db");
    mkdirSync(scratch, { recursive: true });
    const app = new DatabaseSync(appPath);
    try {
        app.exec(`
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY, title TEXT, session_type TEXT, mode TEXT,
                model TEXT, reasoning_effort TEXT, provider_id TEXT,
                is_running INTEGER, was_interrupted INTEGER, created_at TEXT,
                updated_at TEXT, archived_at TEXT, forked_from_session_id TEXT
            );
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY, project_id TEXT, branch TEXT, name TEXT,
                session_id TEXT, archived_at TEXT, creator_session_id TEXT,
                coordinating_creator_session_id TEXT, source_pr_repo_full_name TEXT,
                source_pr_number INTEGER, source_issue_repo_full_name TEXT,
                source_issue_number INTEGER, created_pr_repo_full_name TEXT,
                created_pr_number INTEGER
            );
            CREATE TABLE workspace_parent_links (
                child_workspace_id TEXT, parent_workspace_id TEXT, creator_session_id TEXT
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY, name TEXT, github_owner TEXT, github_repo TEXT, main_repo_path TEXT
            );
        `);
        const insertSession = app.prepare(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        for (const session of [
            ["home", "Sensitive home prompt", "general_chat", null],
            ["cli", "Sensitive CLI prompt", "cli_session", null],
            ["a-root", "Sensitive A prompt", "project", null],
            ["a-child", "Sensitive child prompt", "project", "a-root"],
            ["b-root", "Sensitive B prompt", "project", null],
        ]) {
            insertSession.run(
                session[0],
                session[1],
                session[2],
                "interactive",
                "auto",
                null,
                "github",
                0,
                0,
                "2026-09-25T16:00:00.000Z",
                "2026-09-25T16:01:00.000Z",
                null,
                session[3]
            );
        }
        app.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(
            "project-a", "Project A", "octo", "a", "D:\\repos\\a"
        );
        app.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(
            "project-b", "Project B", "octo", "b", "D:\\repos\\b"
        );
        const insertWorkspace = app.prepare(
            "INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        insertWorkspace.run(
            "a-workspace", "project-a", "main", "Project A root", "a-root",
            null, null, null, null, null, null, null, null, null
        );
        insertWorkspace.run(
            "a-child-workspace", "project-a", "feature", "Project A child", "a-child",
            null, "a-root", "a-root", null, null, null, null, null, null
        );
        insertWorkspace.run(
            "b-workspace", "project-b", "main", "Project B root", "b-root",
            null, null, null, null, null, null, null, null, null
        );
        app.prepare("INSERT INTO workspace_parent_links VALUES (?, ?, ?)").run(
            "a-child-workspace", "a-workspace", "a-root"
        );
        app.close();

        const state = collectConstellationState({
            currentSessionId: "home",
            scope: "all",
            appDatabasePath: appPath,
            sessionStorePath: path.join(scratch, "missing-store.db"),
            sessionStateRoot: path.join(scratch, "session-state"),
        });
        assert.equal(state.diagnostics.selectedRealSessionCount, 5);
        assert.equal(state.diagnostics.independentRealRootCount, 4);
        const home = state.nodes.find((node) => node.id === "home");
        assert.equal(home.name, "Home chat");
        assert.equal(home.projectName, "My Copilot");
        assert.equal(home.repository, "No project");
        assert.equal(home.isHomeChat, true);
        const cli = state.nodes.find((node) => node.id === "cli");
        assert.equal(cli.name, "Standalone session cli");
        assert.equal(cli.projectName, "No project");
        assert.equal(cli.repository, "No project");
        assert.equal(cli.isHomeChat, false);
        assert.equal(
            state.nodes.find((node) => node.id === "a-child").parentId,
            "a-root"
        );
        assert.equal(
            state.nodes.find((node) => node.id === "b-root").projectName,
            "Project B"
        );
        assert.equal(JSON.stringify(state).includes("Sensitive"), false);
        assert.equal(JSON.stringify(state).includes("D:\\repos"), false);
    } finally {
        try {
            app.close();
        } catch {}
        rmSync(scratch, { recursive: true, force: true });
    }
});

test("refresh failure retains last-good state, publishes once, and recovers", async () => {
    const initial = withRefreshHealth(fixtureState(), {
        status: "healthy",
        lastSuccessfulAt: "2026-09-25T18:00:00.000Z",
    });
    let fail = true;
    const publications = [];
    const entry = {
        dataProvider: async () => {
            if (fail) {
                throw new Error(
                    "private payload at D:\\Users\\person\\.copilot\\data.db"
                );
            }
            return fixtureState();
        },
        scope: "tree",
        projectScope: {
            requested: "",
            id: undefined,
            name: undefined,
            status: "none",
        },
        state: initial,
        lastGoodState: initial,
        refreshFailures: 0,
        fingerprint: stateFingerprint(initial),
        clients: new Set([
            {
                write(payload) {
                    publications.push(payload);
                },
            },
        ]),
        refreshPromise: undefined,
    };

    await assert.rejects(refreshConstellationServer(entry), /private payload/);
    assert.equal(entry.state.diagnostics.refresh.status, "degraded");
    assert.equal(entry.state.diagnostics.refresh.usingLastGood, true);
    assert.equal(entry.state.diagnostics.refresh.consecutiveFailures, 1);
    assert.equal(
        entry.state.diagnostics.refresh.lastSuccessfulAt,
        "2026-09-25T18:00:00.000Z"
    );
    assert.deepEqual(
        entry.state.nodes.map((node) => node.id),
        initial.nodes.map((node) => node.id)
    );
    assert.equal(publications.length, 1);
    assert.equal(JSON.stringify(entry.state).includes("private payload"), false);
    assert.equal(JSON.stringify(entry.state).includes("data.db"), false);

    await assert.rejects(refreshConstellationServer(entry), /private payload/);
    assert.equal(entry.state.diagnostics.refresh.consecutiveFailures, 2);
    assert.equal(publications.length, 1);

    fail = false;
    const recovered = await refreshConstellationServer(entry);
    assert.equal(recovered.diagnostics.refresh.status, "healthy");
    assert.equal(recovered.diagnostics.refresh.usingLastGood, false);
    assert.equal(recovered.diagnostics.refresh.consecutiveFailures, 0);
    assert.equal(publications.length, 2);
});

test("refresh health and diagnostic levels remain pure and sanitized", () => {
    const initial = fixtureState();
    const degraded = withRefreshHealth(initial, {
        status: "degraded",
        consecutiveFailures: 3,
    });
    assert.notEqual(degraded, initial);
    assert.equal(diagnosticsLevel(degraded.diagnostics), "degraded");
    assert.equal(initial.diagnostics.refresh.status, "healthy");
    assert.deepEqual(
        summarizeRelationshipCoverage(degraded.nodes, degraded.edges),
        degraded.diagnostics.coverage.relationships
    );
});

test("extension actions expose sanitized refresh failures", () => {
    const source = readFileSync(path.join(extensionDir, "extension.mjs"), "utf8");
    assert.match(source, /async function refreshForAction/);
    assert.match(source, /"refresh_unavailable"/);
    assert.match(source, /could not refresh sanitized local metadata/);
    assert.match(source, /catch \{/);
    assert.doesNotMatch(source, /error\.message/);
    assert.doesNotMatch(source, /error\.stack/);
});

test("loopback server rejects unsafe requests and cleans up idempotently", async () => {
    const servers = new Map();
    const options = {
        dataProvider: async ({ scope } = {}) => fixtureState(scope),
        pollIntervalMs: 60_000,
    };
    let first;
    try {
        const entries = await Promise.all([
            getOrCreateConstellationServer(servers, "instance-one", options),
            getOrCreateConstellationServer(servers, "instance-one", options),
        ]);
        [first] = entries;
        assert.equal(first, entries[1]);
        assert.equal(servers.size, 1);

        const bootstrap = await fetch(first.openUrl, { redirect: "manual" });
        assert.equal(bootstrap.status, 302);
        const cookie = bootstrap.headers.get("set-cookie").split(";")[0];

        const page = await fetch(first.url, { headers: { cookie } });
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /Agent Constellation/);
        assert.doesNotMatch(html, /https?:\/\/[^"]*(cdn|unpkg|jsdelivr)/i);

        const layoutModule = await fetch(`${first.url}layout.mjs`, { headers: { cookie } });
        assert.equal(layoutModule.status, 200);
        assert.match(await layoutModule.text(), /layoutResponsiveConstellation/);

        const attentionModule = await fetch(`${first.url}attention.mjs`, {
            headers: { cookie },
        });
        assert.equal(attentionModule.status, 200);
        assert.match(await attentionModule.text(), /buildAttentionQueue/);

        const stateResponse = await fetch(`${first.url}state`, { headers: { cookie } });
        assert.equal(stateResponse.status, 200);
        const normalState = await stateResponse.json();
        assert.equal(normalState.nodes.length, 3);
        assert.equal(normalState.diagnostics.effectiveScope, "tree");
        assert.equal(
            normalState.nodes.find((node) => node.id === normalState.currentSessionId).isLocalModel,
            false
        );

        const demo = await getOrCreateConstellationServer(servers, "demo-instance", {
            dataProvider: async () => decorateConstellationForDemo(fixtureState()),
            pollIntervalMs: 60_000,
        });
        const demoBootstrap = await fetch(demo.openUrl, { redirect: "manual" });
        const demoCookie = demoBootstrap.headers.get("set-cookie").split(";")[0];
        const demoStateResponse = await fetch(`${demo.url}state`, {
            headers: { cookie: demoCookie },
        });
        const demoState = await demoStateResponse.json();
        const demoCurrent = demoState.nodes.find(
            (node) => node.id === demoState.currentSessionId
        );
        assert.equal(demoCurrent.demoLocalModel, true);
        assert.equal(demoCurrent.provider, "ollama");
        const demoSseState = await readFirstSseState(`${demo.url}events`, demoCookie);
        assert.equal(
            demoSseState.nodes.find((node) => node.id === demoSseState.currentSessionId)
                .demoLocalModel,
            true
        );
        assert.equal(
            first.state.nodes.find((node) => node.id === first.state.currentSessionId)
                .isLocalModel,
            false
        );

        const loopbackNavigation = await fetch(`${first.url}state`, {
            headers: { cookie, "sec-fetch-site": "same-site" },
        });
        assert.equal(loopbackNavigation.status, 200);

        const noCookie = await fetch(`${first.url}state`);
        assert.equal(noCookie.status, 403);

        const crossSite = await fetch(`${first.url}refresh`, {
            method: "POST",
            headers: { cookie, "sec-fetch-site": "cross-site", "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(crossSite.status, 403);

        const invalidBody = await fetch(`${first.url}refresh`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ unexpected: true }),
        });
        assert.equal(invalidBody.status, 400);

        const allScope = await fetch(`${first.url}scope`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ scope: "all" }),
        });
        assert.equal(allScope.status, 200);
        const allState = await allScope.json();
        assert.equal(allState.diagnostics.effectiveScope, "all");
        assert.equal(allState.nodes.some((node) => node.id === overviewRootId), true);
        assert.equal(first.scope, "all");

        const invalidScope = await fetch(`${first.url}scope`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ scope: "everything" }),
        });
        assert.equal(invalidScope.status, 400);

        const unsafeHost = await rawRequest(`${first.url}state`, {
            headers: { cookie, Host: "example.invalid" },
        });
        assert.equal(unsafeHost.statusCode, 403);
    } finally {
        await closeConstellationServer(servers, "instance-one");
        await closeConstellationServer(servers, "demo-instance");
    }
    assert.equal(first.server.listening, false);
    assert.equal(first.clients.size, 0);
    assert.equal(await closeConstellationServer(servers, "instance-one"), false);
});

test("simultaneous canvas instances keep scope and filters isolated across refresh and reload", async () => {
    const servers = new Map();
    let projectAName = "Project A";
    let includeProjectA = true;
    const provider = async ({ scope } = {}) =>
        multiProjectFixtureState(scope, { projectAName, includeProjectA });
    const homeOptions = {
        dataProvider: provider,
        initialScope: "all",
        pollIntervalMs: 60_000,
    };
    const projectOptions = {
        dataProvider: provider,
        initialScope: "all",
        initialProject: "pRoJeCt A",
        initialRepository: "octo/a",
        pollIntervalMs: 60_000,
    };
    const unknownProjectOptions = {
        dataProvider: provider,
        initialScope: "all",
        initialProject: "deleted-project",
        pollIntervalMs: 60_000,
    };
    const treeOptions = {
        dataProvider: provider,
        pollIntervalMs: 60_000,
    };
    try {
        const [home, project, unknownProject, tree] = await Promise.all([
            getOrCreateConstellationServer(servers, "home-view", homeOptions),
            getOrCreateConstellationServer(servers, "project-view", projectOptions),
            getOrCreateConstellationServer(
                servers,
                "unknown-project-view",
                unknownProjectOptions
            ),
            getOrCreateConstellationServer(servers, "tree-view", treeOptions),
        ]);
        assert.equal(home.scope, "all");
        assert.equal(project.scope, "all");
        assert.equal(project.projectScope.id, "project-a");
        assert.equal(project.projectScope.status, "resolved");
        assert.equal(
            project.state.diagnostics.projectFilter.enforcement,
            "server"
        );
        assert.equal(
            project.state.diagnostics.visibility.projectFilter.enforcement,
            "server"
        );
        assert.equal(project.state.currentSessionId, undefined);
        assert.deepEqual(
            project.state.nodes
                .filter((node) => !node.synthetic)
                .map((node) => node.id)
                .sort(),
            ["project-a-child", "project-a-root"]
        );
        assert.equal(
            project.state.nodes.some((node) => node.id === "project-b-root"),
            false
        );
        assert.equal(
            layoutResponsiveConstellation(project.state, {
                width: 1200,
                height: 700,
            }).nodes.filter((node) => !node.synthetic).length,
            project.state.diagnostics.selectedRealSessionCount
        );
        assert.equal(unknownProject.state.nodes.length, 0);
        assert.equal(unknownProject.projectScope.status, "unknown");
        assert.equal(tree.scope, "tree");

        const reopenedHome = await getOrCreateConstellationServer(
            servers,
            "home-view",
            { ...homeOptions, initialScope: "tree" }
        );
        const reopenedProject = await getOrCreateConstellationServer(
            servers,
            "project-view",
            { ...projectOptions, initialProject: "" }
        );
        assert.equal(reopenedHome, home);
        assert.equal(reopenedHome.scope, "all");
        assert.equal(reopenedProject, project);
        assert.equal(reopenedProject.projectScope.id, "project-a");

        const homeBootstrap = await fetch(home.openUrl, { redirect: "manual" });
        const homeCookie = homeBootstrap.headers.get("set-cookie").split(";")[0];
        const changed = await fetch(`${home.url}scope`, {
            method: "POST",
            headers: { cookie: homeCookie, "content-type": "application/json" },
            body: JSON.stringify({ scope: "tree" }),
        });
        assert.equal(changed.status, 200);
        assert.equal(home.scope, "tree");
        projectAName = "Project A Renamed";
        await Promise.all([
            refreshConstellationServer(project),
            refreshConstellationServer(unknownProject),
            refreshConstellationServer(tree),
        ]);
        assert.equal(project.scope, "all");
        assert.equal(project.state.diagnostics.effectiveScope, "all");
        assert.equal(project.projectScope.id, "project-a");
        assert.equal(project.projectScope.name, "Project A Renamed");
        assert.equal(project.state.diagnostics.selectedRealSessionCount, 2);
        assert.equal(
            layoutResponsiveConstellation(project.state, {
                width: 1200,
                height: 700,
            }).nodes.filter((node) => !node.synthetic).length,
            2
        );
        assert.equal(unknownProject.state.nodes.length, 0);
        assert.equal(tree.scope, "tree");
        assert.equal(tree.state.diagnostics.effectiveScope, "tree");

        includeProjectA = false;
        await refreshConstellationServer(project);
        assert.equal(project.state.nodes.length, 0);
        assert.equal(project.projectScope.id, "project-a");
        assert.equal(project.projectScope.status, "unknown");

        includeProjectA = true;
        await refreshConstellationServer(project);
        assert.equal(project.state.diagnostics.selectedRealSessionCount, 2);
        assert.equal(project.projectScope.id, "project-a");
        assert.equal(
            project.state.nodes.some((node) => node.id === "project-b-root"),
            false
        );

        const projectBootstrap = await fetch(project.openUrl, { redirect: "manual" });
        const projectCookie = projectBootstrap.headers.get("set-cookie").split(";")[0];
        const projectPage = await fetch(project.url, {
            headers: { cookie: projectCookie },
        });
        const projectHtml = await projectPage.text();
        assert.match(projectHtml, /"initialProject":"project-a"/);
        assert.match(projectHtml, /"initialRepository":"octo\/a"/);
    } finally {
        await Promise.all([
            closeConstellationServer(servers, "home-view"),
            closeConstellationServer(servers, "project-view"),
            closeConstellationServer(servers, "unknown-project-view"),
            closeConstellationServer(servers, "tree-view"),
        ]);
    }

    projectAName = "Project A";
    includeProjectA = true;
    const reloadedServers = new Map();
    try {
        const [homeReloaded, projectReloaded, unknownReloaded, treeReloaded] =
            await Promise.all([
            getOrCreateConstellationServer(reloadedServers, "home-view", homeOptions),
            getOrCreateConstellationServer(reloadedServers, "project-view", projectOptions),
            getOrCreateConstellationServer(
                reloadedServers,
                "unknown-project-view",
                unknownProjectOptions
            ),
            getOrCreateConstellationServer(reloadedServers, "tree-view", treeOptions),
        ]);
        assert.equal(homeReloaded.scope, "all");
        assert.equal(projectReloaded.scope, "all");
        assert.equal(projectReloaded.projectScope.id, "project-a");
        assert.equal(projectReloaded.state.diagnostics.selectedRealSessionCount, 2);
        assert.equal(unknownReloaded.state.nodes.length, 0);
        assert.equal(treeReloaded.scope, "tree");
    } finally {
        await Promise.all([
            closeConstellationServer(reloadedServers, "home-view"),
            closeConstellationServer(reloadedServers, "project-view"),
            closeConstellationServer(reloadedServers, "unknown-project-view"),
            closeConstellationServer(reloadedServers, "tree-view"),
        ]);
    }
});

test("renderer exposes accessibility and reduced-motion affordances", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /role="tree"/);
    assert.match(html, /id="scopeSelect"/);
    assert.match(html, />All sessions</);
    assert.match(html, /id="projectFilter"/);
    assert.match(html, /synthetic grouping container, not a session or parent-child relationship/);
    assert.match(html, /filterConstellationView/);
    assert.match(html, /resolveProjectFilter/);
    assert.match(html, /"aria-hidden": "true"/);
    assert.match(html, /Ambiguous project filter/);
    assert.match(html, /Project unavailable/);
    assert.match(html, /elements\.projectFilter\.disabled = Boolean\(scopedProject\?\.requested\)/);
    assert.match(html, /The project name is ambiguous\. Use its project ID\./);
    assert.match(html, /The selected project is unavailable\./);
    assert.match(html, /async function switchScope/);
    assert.match(html, /scope change failed/i);
    assert.match(html, /Mission status counts/);
    assert.match(html, /CURRENT/);
    assert.match(html, /current session/);
    assert.match(html, /id="inspectorClose"/);
    assert.match(html, /aria-label="Close session details"/);
    assert.match(html, /id="trustToggle"/);
    assert.match(html, /aria-controls="diagnostics"/);
    assert.match(html, /aria-label="Trust and diagnostics"/);
    assert.match(html, /aria-label="Close trust and diagnostics"/);
    assert.match(html, /function renderDiagnostics/);
    assert.match(html, /function presentationFingerprint/);
    assert.match(
        html,
        /if \(!presentationChanged\) \{[\s\S]*if \(previousAttention !== nextAttentionFingerprint\) render\(\);[\s\S]*else renderAttention\(\);[\s\S]*renderDiagnostics\(\);[\s\S]*return;/
    );
    assert.match(html, /Query incompatible/);
    assert.match(html, /last known sanitized state remains visible/i);
    assert.match(
        html,
        /consecutiveFailures: Math\.max\(\s*1,\s*Number\(refresh\.consecutiveFailures \|\| 0\)\s*\)/
    );
    assert.match(html, /Synthetic edges do not assert provenance/);
    assert.match(html, /Repository is an additive display filter/);
    assert.match(html, /"Search and visibility"/);
    assert.match(html, /"Compaction"/);
    assert.match(html, /totalHiddenRealSessionCount/);
    assert.match(html, /groupedHiddenSessionCount/);
    assert.match(html, /repositoryGroupedHiddenSessionCount/);
    assert.match(html, /overflowGroupedHiddenSessionCount/);
    assert.match(html, /completedShelvedSessionCount/);
    assert.match(html, /archivedShelvedSessionCount/);
    assert.match(html, /Synthetic summaries are excluded/);
    assert.match(
        html,
        /state\.layout\.hiddenSessionCount \+ " hidden"/
    );
    assert.match(html, /Sensitive content is not returned/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /function closeInspector/);
    assert.match(html, /function closeDiagnostics/);
    assert.match(html, /function appendModelDetail/);
    assert.match(
        html,
        /node\.parentId\s*\?\s*"parent session outside this project; grouped for display"\s*:\s*"no recorded parent; grouped for display"/
    );
    assert.match(html, /localLabel\.textContent = node\.demoLocalModel \? "Demo local runtime" : "Local runtime"/);
    assert.match(html, /"aria-label": "Runs locally"/);
    assert.match(html, /title\.textContent = "Runs locally"/);
    assert.match(html, /parts\.push\(node\.demoLocalModel \? "Demo local model" : "Local model"\)/);
    assert.match(html, /class: "node-model"/);
    assert.match(
        html,
        /node\.isShelf \|\| node\.isRepositoryGroup \|\| node\.isOverflowSummary\s*\?\s*""\s*:\s*formatModelLabel/
    );
    assert.match(html, /node\.isLocalModel && !node\.isShelf/);
    assert.match(html, /--local-model:/);
    assert.match(html, /\.model-detail/);
    assert.match(html, /\.local-model-label/);
    assert.match(html, /"LOCAL · " \+ modelLabel/);
    assert.match(html, /y: hasModelLabel \? -20 : -10/);
    assert.match(html, /state\.pointers = new Map|pointers: new Map/);
    assert.match(html, /applyPinchGesture/);
    assert.match(html, /completedExpanded/);
    assert.match(html, /archivedExpanded/);
    assert.match(
        html,
        /completedExpanded: config\.initialStatus === "completed"/
    );
    assert.match(
        html,
        /archivedExpanded: config\.initialStatus === "archived"/
    );
    assert.match(html, /function toggleShelf\(node\)/);
    assert.match(html, /function toggleRepositoryGroup\(node\)/);
    assert.match(html, /function toggleOverflowSummary\(node\)/);
    assert.match(html, /"aria-expanded": node\.isOverflowSummary/);
    assert.match(html, /id="fitWidth"/);
    assert.match(html, /id="attentionRadar"/);
    assert.match(html, /id="attentionList"/);
    assert.match(html, /Nothing needs attention right now\./);
    assert.match(html, /buildAttentionQueue/);
    assert.match(html, /function activateAttentionItem/);
    assert.match(html, /resetLocalNavigationForAttention/);
    assert.match(html, /state\.focusSessionId = ""/);
    assert.match(html, /state\.selectedId = item\.id/);
    assert.match(html, /state\.revealedIds\.add\(item\.id\)/);
    assert.match(html, /Session revealed and details opened\./);
    assert.match(html, /item\.shapeLabel \+ " status/);
    assert.match(html, /data-attention-id/);
    assert.match(html, /focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /focusNode\(item\.id, \{ smooth: true \}\)/);
    assert.match(html, /programmaticScrollBehavior\(\{/);
    assert.match(html, /openInspector\(sourceNode, false\)/);
    assert.match(html, /closeDiagnostics\(\{ restoreFocus: false \}\)/);
    assert.match(html, /Last meaningful activity/);
    assert.match(html, /attentionItem\?\.kind === "inactive-busy"/);
    assert.doesNotMatch(html, />Fit</);
});

test("renderer restores attention focus with roving keyboard navigation", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /id="attentionHeading"/);
    assert.match(
        html,
        /button class="attention-overflow" id="attentionOverflow" type="button"/
    );
    assert.match(html, /resolveAttentionFocus\(\{/);
    assert.match(html, /previousIds,/);
    assert.match(html, /nextIds: queue\.targetIds/);
    assert.match(html, /hasOverflow: queue\.overflowCount > 0/);
    assert.match(html, /attentionRovingId: null/);
    assert.match(
        html,
        /button\.tabIndex = item\.id === state\.attentionRovingId \? 0 : -1/
    );
    assert.match(html, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/);
    assert.match(html, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowUp"/);
    assert.match(html, /event\.key === "Home"/);
    assert.match(html, /event\.key === "End"/);
    assert.match(html, /button\.addEventListener\("click", \(\) => activateAttentionItem\(item\)\)/);
    assert.match(html, /focusResolution\.kind === "item"/);
    assert.match(html, /focusResolution\.kind === "overflow"/);
    assert.match(html, /focusResolution\.kind === "heading"/);
    assert.match(html, /focusTarget\?\.focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /Attention queue updated\. Focus moved to/);
    assert.match(html, /Attention queue is empty\. Focus moved to the Needs attention summary\./);
    assert.match(html, /overflowFocused && queue\.overflowCount === 0/);
    assert.match(html, /elements\.attentionHeading\.focus\(\{ preventScroll: true \}\)/);
});

test("renderer uses redundant status symbols in the legend, cards, and inspector", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /function nodeStatusMarker\(status/);
    assert.match(html, /class: "node-status-marker status-" \+ status/);
    assert.match(html, /className = "status-glyph"/);
    assert.match(html, /button\.setAttribute\("aria-pressed"/);
    assert.match(html, /detail-status status-idle/);
    for (const status of [
        "busy",
        "idle",
        "completed",
        "waiting-user",
        "waiting-plan",
        "blocked",
        "failed",
        "archived",
    ]) {
        assert.match(html, new RegExp(`status-${status}`));
    }
});

test("renderer preserves SVG focus across refreshes and exposes explicit focus rings", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /class: "node-focus-ring"/);
    assert.match(html, /\.node:focus-visible \.node-focus-ring \{ opacity: 1; \}/);
    assert.match(html, /document\.activeElement\?\.classList\?\.contains\("node"\)/);
    assert.match(
        html,
        /focusedId &&\s*!focusNode\(focusedId, \{ reveal: false \}\)/
    );
    assert.match(html, /group\.focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /"aria-current": node\.isCurrent \? "true" : undefined/);
    assert.match(html, /state\.selectedId = resolveVisibleSelection\(/);
    assert.match(html, /function centerCurrent\(\{ smooth = true, resetZoom = true \} = \{\}\)/);
    const centerStart = html.indexOf("function centerCurrent");
    const centerEnd = html.indexOf("function fitReadableWidth", centerStart);
    const centerBody = html.slice(centerStart, centerEnd);
    assert.doesNotMatch(centerBody, /state\.selectedId|updateSelection/);
    assert.match(
        html,
        /if \(previousOrientation !== state\.layout\.orientation\) \{\s*centerCurrent\(\{ smooth: false \}\);\s*\}/
    );
    assert.match(html, /if \(restoreFocus && state\.selectedId\) focusNode\(state\.selectedId\)/);
});

test("renderer combines search, focus, grouping, and keyboard reset accessibly", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /id="searchFocus"/);
    assert.match(html, /id="searchInput"/);
    assert.match(html, /id="showAll"/);
    assert.match(html, /id="focusSelected"/);
    assert.match(html, /selectConstellationVisibility\(filtered/);
    assert.match(html, /expandedGroupIds: new Set\(\)/);
    assert.match(html, /expandedGroupIds: state\.expandedGroupIds/);
    assert.match(html, /expandedOverflowIds: new Set\(\)/);
    assert.match(html, /expandedOverflowIds: state\.expandedOverflowIds/);
    assert.match(html, /revealedIds: new Set\(\)/);
    assert.match(html, /revealedIds: state\.revealedIds/);
    assert.match(html, /state\.revealedIds\.add\(nodeId\)/);
    assert.match(
        html,
        /group = elements\.nodes\.querySelector\(\s*'\[data-id="' \+ CSS\.escape\(nodeId\) \+ '"\]'\s*\)/
    );
    assert.match(html, /repository group, " \+ node\.totalCount/);
    assert.match(html, /Overflow page " \+ node\.overflowPage/);
    assert.match(html, /"aria-expanded": node\.isOverflowSummary/);
    assert.match(html, /visualParentId\(node\)/);
    assert.match(html, /event\.key === "PageUp"/);
    assert.match(html, /event\.key === "PageDown"/);
    assert.match(
        html,
        /if \(event\.key === "Home"\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/
    );
    assert.match(
        html,
        /if \(event\.key === "Home"\) \{\s*if \(event\.ctrlKey\) return;\s*event\.preventDefault\(\);\s*centerCurrent\(\);/
    );
    assert.doesNotMatch(html, /event\.key\.toLowerCase\(\) === "f"/);
    assert.match(html, /isPlainSearchShortcut\(event\)/);
    assert.doesNotMatch(html, /event\.key === "\/"/);
    assert.match(html, /Lineage focus cleared\. Search and filters remain active\./);
});

test("renderer honors reduced motion and forced colors with correct badge contrast", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(html, /animation-duration: \.001ms !important/);
    assert.match(html, /\.edge\.working \{ stroke-dasharray: none; \}/);
    assert.match(html, /\.node-halo \{ display: none; \}/);
    assert.match(
        html,
        /const reducedMotionQuery = window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/
    );
    assert.match(html, /function focusNode\(nodeId, \{ reveal = true, smooth = true \} = \{\}\)/);
    assert.match(html, /group\.focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /group\.scrollIntoView\(\{/);
    assert.match(
        html,
        /behavior: programmaticScrollBehavior\(\{\s*smooth,\s*reducedMotion: reducedMotionQuery\.matches\s*\}\)/
    );
    assert.doesNotMatch(html, /behavior: smooth \? "smooth" : "auto"/);
    assert.match(html, /@media \(forced-colors: active\)/);
    assert.match(html, /background: Canvas/);
    assert.match(html, /stroke: Highlight/);
    assert.match(html, /\.current-marker-text \{ fill: HighlightText; \}/);
    assert.match(html, /forced-color-adjust: none/);
});

test("renderer keeps chrome, filters, status context, and inspector usable when narrow", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    assert.match(html, /min-width: 280px/);
    assert.match(html, /@media \(max-width: 720px\)/);
    assert.match(html, /@media \(max-width: 520px\)/);
    assert.match(html, /@media \(max-width: 360px\)/);
    assert.match(html, /grid-template-columns: minmax\(0, 1fr\) auto/);
    assert.match(html, /\.status-strip[\s\S]*overflow-x: auto/);
    assert.match(html, /\.attention-panel[\s\S]*max-height: 176px/);
    assert.match(html, /\.attention-list[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(html, /window\.matchMedia\("\(max-width: 480px\)"\)\.matches/);
    assert.match(html, /elements\.attentionRadar\.open = false/);
    assert.match(html, /\.attention-radar\[open\] \.attention-caret/);
    assert.match(
        html,
        /\.inspector, \.diagnostics \{ max-height: min\(48vh, 320px\); \}/
    );
    assert.match(
        html,
        /\.inspector-head, \.diagnostics-head[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/
    );
    assert.match(html, /\.diagnostic-grid \{ grid-template-columns: 1fr/);
    assert.match(html, /\.source-description \{ grid-column: 1 \/ -1; \}/);
    assert.match(
        html,
        /\.trust-control:not\(\.limited\):not\(\.degraded\):not\(\.demo\) #trustLabel/
    );
    assert.match(html, /width: Math\.max\(280, rect\.width\)/);
});

test("renderer uses the documented canvas theme contract and meaningful updates only", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
        scopeUrl: "http://127.0.0.1/scope",
    });
    for (const token of [
        "--background-color-default",
        "--border-color-default",
        "--text-color-default",
        "--text-color-muted",
        "--color-focus-outline",
        "--color-white",
        "--true-color-blue",
        "--true-color-blue-muted",
        "--true-color-red",
        "--font-sans",
        "--font-mono",
    ]) {
        assert.match(html, new RegExp(token));
    }
    assert.match(html, /describeMeaningfulConstellationChange\(state\.data, next\)/);
    assert.match(html, /if \(announcement\) elements\.live\.textContent = announcement/);
});
