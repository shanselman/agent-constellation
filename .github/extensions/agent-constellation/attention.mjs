export const ATTENTION_THRESHOLDS = Object.freeze({
    inactiveBusyMs: 45 * 60 * 1000,
    recentCompletionMs: 10 * 60 * 1000,
    visibleItemLimit: 6,
});

export const ATTENTION_STATUS_ORDER = Object.freeze([
    "waiting-user",
    "waiting-plan",
    "blocked",
    "failed",
]);

const definitions = new Map([
    [
        "waiting-user",
        {
            priority: 0,
            label: "Waiting for you",
            shapeLabel: "diamond",
            category: "action",
        },
    ],
    [
        "waiting-plan",
        {
            priority: 1,
            label: "Plan approval",
            shapeLabel: "clock",
            category: "action",
        },
    ],
    [
        "blocked",
        {
            priority: 2,
            label: "Blocked",
            shapeLabel: "octagon",
            category: "action",
        },
    ],
    [
        "failed",
        {
            priority: 3,
            label: "Failed",
            shapeLabel: "cross",
            category: "action",
        },
    ],
    [
        "inactive-busy",
        {
            priority: 4,
            label: "No recent activity",
            shapeLabel: "filled circle",
            category: "action",
        },
    ],
    [
        "recent-completed",
        {
            priority: 5,
            label: "Recently completed",
            shapeLabel: "check",
            category: "update",
        },
    ],
]);

function cleanText(value, maxLength) {
    if (typeof value !== "string") return "";
    return value
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function timestamp(value) {
    const parsed = Date.parse(typeof value === "string" ? value : "");
    return Number.isFinite(parsed) ? parsed : undefined;
}

function safeNow(value) {
    return Number.isFinite(value) ? value : Date.now();
}

export function isImmediateAttentionStatus(status) {
    return ATTENTION_STATUS_ORDER.includes(status);
}

export function lastMeaningfulActivityTimestamp(node) {
    return timestamp(node?.lastActivityAt) ?? timestamp(node?.updatedAt);
}

export function resolveAttentionFocus({
    previousIds = [],
    nextIds = [],
    focusedId = "",
    hasOverflow = false,
} = {}) {
    const previous = Array.isArray(previousIds) ? previousIds : [];
    const next = Array.isArray(nextIds) ? nextIds : [];
    const previousIndex = previous.indexOf(focusedId);
    if (previousIndex < 0) return { kind: "none" };
    if (next.includes(focusedId)) {
        return { kind: "item", id: focusedId, changed: false };
    }
    const nextId = next[previousIndex];
    if (nextId) return { kind: "item", id: nextId, changed: true };
    const previousId = next[Math.min(previousIndex - 1, next.length - 1)];
    if (previousId) {
        return { kind: "item", id: previousId, changed: true };
    }
    if (hasOverflow) return { kind: "overflow", changed: true };
    return { kind: "heading", changed: true };
}

export function classifyAttentionNode(node, now = Date.now()) {
    if (!node || node.synthetic || node.isShelf || node.isRepositoryGroup) {
        return undefined;
    }
    const currentTime = safeNow(now);
    if (definitions.has(node.status)) return node.status;
    if (node.status === "busy") {
        const activityAt = lastMeaningfulActivityTimestamp(node);
        if (
            activityAt !== undefined &&
            activityAt <= currentTime &&
            currentTime - activityAt >= ATTENTION_THRESHOLDS.inactiveBusyMs
        ) {
            return "inactive-busy";
        }
    }
    if (node.status === "completed") {
        const completedAt = timestamp(node.updatedAt);
        if (
            completedAt !== undefined &&
            completedAt <= currentTime &&
            currentTime - completedAt <=
                ATTENTION_THRESHOLDS.recentCompletionMs
        ) {
            return "recent-completed";
        }
    }
    return undefined;
}

function attentionItem(node, kind, now) {
    const definition = definitions.get(kind);
    const activityAt =
        kind === "inactive-busy"
            ? lastMeaningfulActivityTimestamp(node)
            : timestamp(node.updatedAt) ??
              lastMeaningfulActivityTimestamp(node) ??
              timestamp(node.createdAt);
    const ageMs =
        activityAt === undefined ? undefined : Math.max(0, now - activityAt);
    return {
        id: cleanText(node.id, 80),
        name: cleanText(node.name, 140) || "Unnamed session",
        repository: cleanText(node.repository, 180),
        status: cleanText(node.status, 30) || "idle",
        kind,
        label: definition.label,
        shapeLabel: definition.shapeLabel,
        category: definition.category,
        priority: definition.priority,
        ageMs,
        activityAt,
        sortTime:
            kind === "recent-completed"
                ? -(activityAt ?? 0)
                : activityAt ?? Number.MAX_SAFE_INTEGER,
    };
}

export function buildAttentionQueue(
    nodes,
    {
        now = Date.now(),
        limit = ATTENTION_THRESHOLDS.visibleItemLimit,
    } = {}
) {
    const currentTime = safeNow(now);
    const safeLimit = Math.max(0, Math.min(12, Math.floor(Number(limit) || 0)));
    const allItems = (Array.isArray(nodes) ? nodes : [])
        .flatMap((node) => {
            const kind = classifyAttentionNode(node, currentTime);
            const item = kind ? attentionItem(node, kind, currentTime) : undefined;
            return item?.id ? [item] : [];
        })
        .sort(
            (left, right) =>
                left.priority - right.priority ||
                left.sortTime - right.sortTime ||
                left.name.localeCompare(right.name) ||
                left.id.localeCompare(right.id)
        );
    const items = allItems.slice(0, safeLimit);
    const actionCount = allItems.filter(
        (item) => item.category === "action"
    ).length;
    const updateCount = allItems.length - actionCount;
    const overflowCount = Math.max(0, allItems.length - items.length);
    const summaryParts = [];
    if (actionCount) {
        summaryParts.push(
            `${actionCount} need${actionCount === 1 ? "s" : ""} action`
        );
    }
    if (updateCount) {
        summaryParts.push(
            `${updateCount} recent completion${updateCount === 1 ? "" : "s"}`
        );
    }
    if (overflowCount) summaryParts.push(`+${overflowCount} more`);
    return {
        items,
        targetIds: items.map((item) => item.id),
        totalCount: allItems.length,
        actionCount,
        updateCount,
        overflowCount,
        summary:
            summaryParts.join(" · ") ||
            "Nothing needs attention right now",
    };
}
