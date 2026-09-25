import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
    CANVAS_OPEN_INPUT_SCHEMA,
    collectConstellationState,
    decorateConstellationForDemo,
    filterConstellationState,
    isLocalModelMetadata,
    layoutConstellation,
    normalizeConstellation,
    stateFingerprint,
} from "./data.mjs";
import {
    applyPinchGesture,
    completedShelfId,
    fitWidthScale,
    formatModelLabel,
    layoutResponsiveConstellation,
    orientationForSize,
} from "./layout.mjs";
import { renderConstellationHtml } from "./renderer.mjs";
import {
    closeConstellationServer,
    getOrCreateConstellationServer,
    refreshConstellationServer,
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

function fixtureState() {
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
            eventMetadata: "available",
            eventSessionsObserved: 3,
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
            { source: "root-session", target: "busy-child" },
            { source: "busy-child", target: "waiting-grandchild" },
        ]
    );

    const filtered = filterConstellationState(first, { status: "waiting-user" });
    assert.deepEqual(
        filtered.nodes.map((node) => node.id).sort(),
        ["busy-child", "root-session", "waiting-grandchild"]
    );
    assert.equal(layoutConstellation([], "missing").nodes.length, 0);
    assert.equal(first.trust.level, "healthy");
    assert.deepEqual(
        first.trust.sources.map(({ id, availability }) => ({ id, availability })),
        [
            { id: "appDatabase", availability: "available" },
            { id: "sessionStore", availability: "available" },
            { id: "eventMetadata", availability: "available" },
        ]
    );
    assert.equal(
        first.nodes.find((node) => node.id === "root-session").provenance.model,
        "recorded"
    );
    assert.equal(
        first.nodes.find((node) => node.id === "busy-child").provenance.status,
        "inferred"
    );
    assert.match(
        first.trust.privacy,
        /prompts, messages, secrets, raw errors, event payloads, database paths/
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
    assert.equal(current.provenance.model, "demo");
    assert.equal(decorated.trust.demoDecoration.active, true);
    assert.equal(
        decorated.trust.demoDecoration.scope,
        "Current session model presentation only."
    );
    for (const node of decorated.nodes.filter((node) => node.id !== decorated.currentSessionId)) {
        assert.equal(node.demoLocalModel, undefined);
    }
    assert.notEqual(stateFingerprint(source), stateFingerprint(decorated));
});

test("canvas open schema accepts only optional demo local model input", () => {
    assert.deepEqual(CANVAS_OPEN_INPUT_SCHEMA.properties.demoLocalModel, {
        type: "boolean",
    });
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
        assert.equal(current.provenance.model, "recorded");
        assert.equal(current.provenance.modelSource, "appDatabase");
        assert.equal(state.source.sessionStore, "unavailable");
        assert.equal(state.source.eventMetadata, "unavailable");
        assert.equal(state.trust.level, "limited");
    } finally {
        app.close();
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
    assert.deepEqual(
        noMatches.nodes.map((node) => node.id).sort(),
        ["current-grandchild", "current-parent", "root"]
    );
});

test("responsive layout uses vertical mission-control columns and collapses completed agents", () => {
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

    for (const [width, height] of [
        [420, 900],
        [700, 1100],
    ]) {
        const layout = layoutResponsiveConstellation(source, { width, height });
        assert.equal(layout.orientation, "vertical");
        assert.equal(layout.completedCount, 12);
        assert.equal(layout.nodes.some((node) => node.id === completedShelfId), true);
        assert.equal(layout.nodes.some((node) => node.id === "completed-0"), false);
        const root = layout.nodes.find((node) => node.id === "root");
        const waiting = layout.nodes.find((node) => node.id === "waiting");
        const current = layout.nodes.find((node) => node.id === "current");
        const deep = layout.nodes.find((node) => node.id === "deep");
        assert.equal(root.x < current.x, true);
        assert.equal(current.x < deep.x, true);
        assert.equal(current.isLocalModel, true);
        assert.equal(
            layout.nodes.find((node) => node.id === completedShelfId).isLocalModel,
            undefined
        );
        assert.equal(waiting.y <= current.y, true);
        assert.equal(layout.cardWidth >= 172, true);
        assert.equal(layout.cardHeight, 72);
        assert.equal(layout.height >= height, true);
    }

    const expanded = layoutResponsiveConstellation(source, {
        width: 420,
        height: 900,
        completedExpanded: true,
    });
    assert.equal(expanded.completedCount, 12);
    assert.equal(expanded.nodes.some((node) => node.id === completedShelfId), true);
    assert.equal(
        expanded.nodes.filter((node) => node.status === "completed" && !node.isShelf).length,
        12
    );
    assert.equal(expanded.height > 900, true);

    const wide = layoutResponsiveConstellation(source, { width: 1200, height: 700 });
    assert.equal(wide.orientation, "horizontal");
    assert.equal(wide.cardHeight, 76);
    assert.equal(wide.nodes.find((node) => node.id === "current").isLocalModel, true);
    assert.equal(orientationForSize(420, 900), "vertical");
    assert.equal(orientationForSize(700, 1100), "vertical");
    assert.equal(orientationForSize(1200, 700), "horizontal");
    assert.equal(fitWidthScale(420, 2400), 0.82);
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
        assert.equal(result.source.appDatabase, "available");
        assert.equal(result.source.sessionStore, "available");
        assert.equal(result.source.eventMetadata, "partial");
        assert.deepEqual(result.source.eventMetadataCoverage, {
            observed: 1,
            total: 2,
        });
        assert.equal(result.trust.level, "limited");
        assert.equal(root.provenance.repositorySource, "appDatabase");
        assert.equal(root.provenance.modelSource, "appDatabase");
        assert.deepEqual(root.provenance.statusSources, [
            "appDatabase",
            "eventMetadata",
        ]);
        assert.deepEqual(child.provenance.statusSources, ["appDatabase"]);
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

test("refresh health degrades without leaking errors and recovers on success", async () => {
    const initial = fixtureState();
    let fail = true;
    const entry = {
        dataProvider: async () => {
            if (fail) {
                throw new Error(
                    "private prompt and D:\\Users\\person\\.copilot\\data.db must not escape"
                );
            }
            return fixtureState();
        },
        state: initial,
        fingerprint: stateFingerprint(initial),
        clients: new Set(),
        refreshPromise: undefined,
    };

    await assert.rejects(refreshConstellationServer(entry), /must not escape/);
    assert.deepEqual(entry.state.diagnostics.refresh, {
        status: "degraded",
        consecutiveFailures: 1,
    });
    assert.equal(JSON.stringify(entry.state).includes("private prompt"), false);
    assert.equal(JSON.stringify(entry.state).includes("data.db"), false);

    fail = false;
    const recovered = await refreshConstellationServer(entry);
    assert.deepEqual(recovered.diagnostics.refresh, {
        status: "healthy",
        consecutiveFailures: 0,
    });
});

test("extension actions replace refresh failures with a sanitized canvas error", () => {
    const source = readFileSync(path.join(extensionDir, "extension.mjs"), "utf8");
    assert.match(source, /async function refreshForAction/);
    assert.match(source, /"refresh_unavailable"/);
    assert.match(source, /could not refresh local metadata/);
    assert.match(source, /catch \{/);
    assert.doesNotMatch(source, /refreshForAction\(entry,\s*error/);
});

test("loopback server rejects unsafe requests and cleans up idempotently", async () => {
    const servers = new Map();
    const options = {
        dataProvider: async () => fixtureState(),
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

        const stateResponse = await fetch(`${first.url}state`, { headers: { cookie } });
        assert.equal(stateResponse.status, 200);
        const normalState = await stateResponse.json();
        assert.equal(normalState.nodes.length, 3);
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

test("renderer exposes accessibility and reduced-motion affordances", () => {
    const html = renderConstellationHtml({
        stateUrl: "http://127.0.0.1/state",
        eventsUrl: "http://127.0.0.1/events",
        refreshUrl: "http://127.0.0.1/refresh",
    });
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /role="tree"/);
    assert.match(html, /Mission status counts/);
    assert.match(html, /CURRENT/);
    assert.match(html, /current session/);
    assert.match(html, /id="inspectorClose"/);
    assert.match(html, /aria-label="Close session details"/);
    assert.match(html, /id="trustToggle"/);
    assert.match(html, /aria-controls="diagnostics"/);
    assert.match(html, /aria-label="Trust and diagnostics"/);
    assert.match(html, /aria-label="Close trust and diagnostics"/);
    assert.match(html, /Demo decoration is active/);
    assert.match(html, /Local models are supported without this decoration/);
    assert.match(html, /function renderDiagnostics/);
    assert.match(html, /latest refresh did not complete/i);
    assert.match(html, /existing state retained/i);
    assert.match(html, /demoMarkerText\.textContent = "DEMO"/);
    assert.match(html, /sensitive content is not returned/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /function closeInspector/);
    assert.match(html, /function appendModelDetail/);
    assert.match(html, /localLabel\.textContent = node\.demoLocalModel \? "Demo local model" : "Local model"/);
    assert.match(html, /"aria-label": "Runs locally"/);
    assert.match(html, /title\.textContent = "Runs locally"/);
    assert.match(html, /parts\.push\(node\.demoLocalModel \? "Demo local model" : "Local model"\)/);
    assert.match(html, /class: "node-model"/);
    assert.match(html, /node\.isShelf\s*\?\s*""\s*:\s*formatModelLabel/);
    assert.match(html, /node\.isLocalModel && !node\.isShelf/);
    assert.match(html, /--local-model:/);
    assert.match(html, /\.model-detail/);
    assert.match(html, /\.demo-local-model/);
    assert.match(html, /y: hasModelLabel \? -20 : -10/);
    assert.match(html, /state\.pointers = new Map|pointers: new Map/);
    assert.match(html, /applyPinchGesture/);
    assert.match(html, /completedExpanded/);
    assert.match(html, /id="fitWidth"/);
    assert.doesNotMatch(html, />Fit</);
});
