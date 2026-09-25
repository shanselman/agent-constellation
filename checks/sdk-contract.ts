import type {
    CanvasJsonSchema,
    CanvasOptions,
} from "@github/copilot-sdk/extension";

const openInputSchema = {
    type: "object",
    properties: {
        status: { type: "string" },
        repository: { type: "string" },
        demoLocalModel: { type: "boolean" },
    },
    additionalProperties: false,
} satisfies CanvasJsonSchema;

const canvasContract = {
    id: "agent-constellation",
    displayName: "Agent Constellation",
    description:
        "A live, accessible family tree of the current Copilot project session and its descendants.",
    inputSchema: openInputSchema,
    actions: [
        {
            name: "refresh",
            description: "Refresh sanitized session metadata.",
            inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            handler: async (context) => ({
                instanceId: context.instanceId,
                refreshed: true,
            }),
        },
        {
            name: "get_state",
            description: "Return sanitized session metadata.",
            inputSchema: {
                type: "object",
                properties: {
                    status: { type: "string" },
                    repository: { type: "string" },
                },
                additionalProperties: false,
            },
            handler: async (context) => ({
                instanceId: context.instanceId,
            }),
        },
    ],
    open: async (context) => ({
        title: "Agent Constellation",
        status: context.instanceId,
        url: "http://127.0.0.1:1/",
    }),
    onClose: async () => {},
} satisfies CanvasOptions;

void canvasContract;
