// Extension: agent-constellation
// Visualize live Copilot project sessions as an accessible agent constellation.
//
// This remains scaffold-derived: joinSession/createCanvas wiring lives here,
// while data collection, the renderer, and the loopback server are split into
// sibling modules to keep the entry point focused.

import path from "node:path";
import {
    CanvasError,
    createCanvas,
    joinSession,
} from "@github/copilot-sdk/extension";
import {
    CANVAS_OPEN_INPUT_SCHEMA,
    FILTER_PROPERTIES,
    collectConstellationState,
    decorateConstellationForDemo,
    filterConstellationState,
} from "./data.mjs";
import {
    closeConstellationServer,
    getOrCreateConstellationServer,
    refreshConstellationServer,
} from "./server.mjs";

// One loopback-only HTTP server per open canvas instance. Re-opens and
// rehydration reuse the same server within this provider process.
const servers = new Map();
const copilotHome =
    process.env.COPILOT_HOME ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".copilot");
let session;

function collectFor(sessionId, { demoLocalModel = false, scope = "tree" } = {}) {
    const state = collectConstellationState({
        currentSessionId: sessionId,
        copilotHome,
        scope,
    });
    return demoLocalModel ? decorateConstellationForDemo(state) : state;
}

async function requireOpenEntry(instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) {
        throw new CanvasError(
            "instance_not_open",
            "The Agent Constellation instance is not open"
        );
    }
    return entry;
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "agent-constellation",
            displayName: "Agent Constellation",
            description:
                "A live, accessible family tree or all-sessions overview for Copilot project sessions.",
            inputSchema: CANVAS_OPEN_INPUT_SCHEMA,
            actions: [
                {
                    name: "refresh",
                    description:
                        "Refreshes live project-session metadata and pushes the updated constellation to the open canvas.",
                    inputSchema: {
                        type: "object",
                        properties: {},
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = await requireOpenEntry(ctx.instanceId);
                        const state = await refreshConstellationServer(entry);
                        return {
                            generatedAt: state.generatedAt,
                            rootId: state.rootId,
                            nodeCount: state.nodes.length,
                            counts: state.counts,
                            diagnostics: state.diagnostics,
                            source: state.source,
                        };
                    },
                },
                {
                    name: "get_state",
                    description:
                        "Returns sanitized constellation metadata, optionally filtered by status or repository.",
                    inputSchema: {
                        type: "object",
                        properties: FILTER_PROPERTIES,
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const entry = await requireOpenEntry(ctx.instanceId);
                        const state = await refreshConstellationServer(entry);
                        return filterConstellationState(state, ctx.input);
                    },
                },
            ],
            // Port 0 chooses a fresh ephemeral port, bound only to 127.0.0.1.
            // The helper stores an in-flight Promise so concurrent/repeated
            // opens of the same instance remain idempotent.
            open: async (ctx) => {
                const entry = await getOrCreateConstellationServer(
                    servers,
                    ctx.instanceId,
                    {
                        dataProvider: ({ scope }) =>
                            collectFor(ctx.sessionId, {
                                demoLocalModel: ctx.input?.demoLocalModel === true,
                                scope,
                            }),
                        initialRepository: ctx.input?.repository,
                        initialProject: ctx.input?.project,
                        initialStatus: ctx.input?.status,
                        initialScope: ctx.input?.scope,
                        logger: (message, options) => session?.log?.(message, options),
                    }
                );
                return {
                    title: "Agent Constellation",
                    status: `${entry.state.diagnostics.selectedRealSessionCount} sessions`,
                    url: entry.openUrl,
                };
            },
            // Closing an instance ends its SSE clients, timers, and server.
            onClose: async (ctx) => {
                await closeConstellationServer(servers, ctx.instanceId);
            },
        }),
    ],
});
