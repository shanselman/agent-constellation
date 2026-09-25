export const STALE_BUSY_THRESHOLD_MS = 45 * 60 * 1000;
export const RECENT_COMPLETION_THRESHOLD_MS = 10 * 60 * 1000;

const attentionDefinitions = new Map([
    ["waiting-user", { priority: 0, label: "Waiting for you" }],
    ["waiting-plan", { priority: 1, label: "Plan approval" }],
    ["blocked", { priority: 2, label: "Blocked" }],
    ["failed", { priority: 3, label: "Failed" }],
    ["stale-busy", { priority: 4, label: "Busy unusually long" }],
    ["recent-completed", { priority: 5, label: "Just completed" }],
]);

function timestamp(value) {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : undefined;
}

function attentionKind(node, now) {
    if (attentionDefinitions.has(node.status)) return node.status;
    if (node.status === "busy") {
        const activityAt = timestamp(node.updatedAt) ?? timestamp(node.busySince);
        if (activityAt !== undefined && now - activityAt >= STALE_BUSY_THRESHOLD_MS) {
            return "stale-busy";
        }
    }
    if (node.status === "completed") {
        const completedAt = timestamp(node.updatedAt);
        const age = completedAt === undefined ? undefined : now - completedAt;
        if (age !== undefined && age >= 0 && age <= RECENT_COMPLETION_THRESHOLD_MS) {
            return "recent-completed";
        }
    }
    return undefined;
}

export function getAttentionItems(nodes, now = Date.now()) {
    const currentTime = Number.isFinite(now) ? now : Date.now();
    return (Array.isArray(nodes) ? nodes : [])
        .flatMap((node) => {
            const kind = attentionKind(node, currentTime);
            if (!kind) return [];
            const definition = attentionDefinitions.get(kind);
            const activityAt =
                timestamp(node.updatedAt) ??
                timestamp(node.busySince) ??
                timestamp(node.createdAt);
            return [{
                id: node.id,
                name: node.name,
                repository: node.repository,
                status: node.status,
                kind,
                label: definition.label,
                priority: definition.priority,
                ageMs: activityAt === undefined ? undefined : Math.max(0, currentTime - activityAt),
                sortTime:
                    kind === "recent-completed"
                        ? -(activityAt ?? 0)
                        : activityAt ?? Number.MAX_SAFE_INTEGER,
            }];
        })
        .sort(
            (left, right) =>
                left.priority - right.priority ||
                left.sortTime - right.sortTime ||
                String(left.name ?? "").localeCompare(String(right.name ?? "")) ||
                String(left.id).localeCompare(String(right.id))
        );
}
