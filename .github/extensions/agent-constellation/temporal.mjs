const minute = 60_000;

const operationalFields = [
    "name",
    "parentId",
    "repository",
    "branch",
    "mode",
    "provider",
    "model",
    "reasoningEffort",
    "status",
    "busySince",
    "updatedAt",
    "pullRequest",
    "issue",
    "task",
];

function parsedTime(value) {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) ? timestamp : undefined;
}

function operationalFingerprint(node) {
    return JSON.stringify({
        ...Object.fromEntries(operationalFields.map((field) => [field, node?.[field]])),
        humanGate: node?.humanGate?.type,
    });
}

function transition(node, kind, changedAt, previousStatus) {
    return {
        nodeId: node.id,
        nodeName: node.name || "Unnamed session",
        kind,
        fromStatus: previousStatus,
        toStatus: node.status,
        changedAt,
    };
}

export function activityAgeBucket(updatedAt, now = Date.now()) {
    const updated = parsedTime(updatedAt);
    if (updated === undefined) {
        return {
            key: "unknown",
            shortLabel: "",
            ariaLabel: "activity age unknown",
        };
    }

    const age = Math.max(0, Number(now) - updated);
    if (age < minute) {
        return {
            key: "now",
            shortLabel: "now",
            ariaLabel: "activity within the last minute",
        };
    }
    if (age < 5 * minute) {
        return {
            key: "recent",
            shortLabel: "<5m",
            ariaLabel: "activity within the last 5 minutes",
        };
    }
    if (age < 30 * minute) {
        return {
            key: "warm",
            shortLabel: "<30m",
            ariaLabel: "activity within the last 30 minutes",
        };
    }
    return {
        key: "quiet",
        shortLabel: "30m+",
        ariaLabel: "activity 30 minutes ago or longer",
    };
}

export function detectNodeTransitions(previousNodes, nextNodes, changedAt = new Date().toISOString()) {
    if (!Array.isArray(previousNodes) || !Array.isArray(nextNodes)) return [];

    const previous = new Map(previousNodes.map((node) => [node.id, node]));
    const next = new Map(nextNodes.map((node) => [node.id, node]));
    const transitions = [];

    for (const node of nextNodes) {
        const before = previous.get(node.id);
        if (!before) {
            transitions.push(transition(node, "added", changedAt));
            continue;
        }
        if (before.status !== node.status) {
            transitions.push(transition(node, "status", changedAt, before.status));
            continue;
        }
        if (operationalFingerprint(before) !== operationalFingerprint(node)) {
            transitions.push(transition(node, "updated", changedAt, before.status));
        }
    }

    for (const node of previousNodes) {
        if (!next.has(node.id)) {
            transitions.push({
                nodeId: node.id,
                nodeName: node.name || "Unnamed session",
                kind: "removed",
                fromStatus: node.status,
                toStatus: undefined,
                changedAt,
            });
        }
    }

    return transitions;
}

export function boundTransitionHistory(history, transitions, limit = 8) {
    const maximum = Math.max(0, Math.floor(Number(limit) || 0));
    if (!maximum) return [];
    return [
        ...(Array.isArray(transitions) ? transitions : []),
        ...(Array.isArray(history) ? history : []),
    ].slice(0, maximum);
}

export function motionAffordances(prefersReducedMotion) {
    return prefersReducedMotion
        ? {
              scrollBehavior: "auto",
              recentChangeClass: "recent-change recent-change-static",
              recentChangeDurationMs: 6_000,
          }
        : {
              scrollBehavior: "smooth",
              recentChangeClass: "recent-change recent-change-animated",
              recentChangeDurationMs: 3_000,
          };
}
