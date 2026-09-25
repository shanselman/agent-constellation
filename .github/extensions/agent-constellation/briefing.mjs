const terminalStatuses = new Set(["completed", "archived"]);
const attentionStatuses = new Set([
    "busy",
    "waiting-user",
    "waiting-plan",
    "blocked",
    "failed",
]);
const decisionStatuses = new Set(["waiting-user", "waiting-plan"]);
const recentWindowMs = 24 * 60 * 60 * 1000;
const longRunningMs = 2 * 60 * 60 * 1000;

export const BRIEFING_SECTION_ORDER = [
    "active-work",
    "decisions-needed",
    "failures",
    "blocked-sessions",
    "recent-completions",
    "repository-spread",
    "likely-bottlenecks",
];

const sectionDefinitions = new Map(
    [
        ["active-work", "Active work"],
        ["decisions-needed", "Decisions needed"],
        ["failures", "Failures"],
        ["blocked-sessions", "Blocked sessions"],
        ["recent-completions", "Recent completions"],
        ["repository-spread", "Repository spread"],
        ["likely-bottlenecks", "Likely bottlenecks"],
    ].map(([id, label], index) => [id, { id, label, priority: (index + 1) * 10 }])
);

function cleanText(value, fallback = "") {
    if (typeof value !== "string") return fallback;
    return (
        value
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180) || fallback
    );
}

function timestamp(value) {
    const parsed = Date.parse(typeof value === "string" ? value : "");
    return Number.isFinite(parsed) ? parsed : 0;
}

function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function stableNodes(nodes) {
    return (Array.isArray(nodes) ? nodes : [])
        .map((node) => ({
            id: cleanText(node?.id, "unknown"),
            name: cleanText(node?.name, "Unnamed session"),
            repository: cleanText(node?.repository, "Unknown repository"),
            status: cleanText(node?.status, "idle"),
            updatedAt: cleanText(node?.updatedAt),
            busySince: cleanText(node?.busySince),
            humanGate: cleanText(node?.humanGate?.label),
        }))
        .sort(
            (left, right) =>
                right.updatedAt.localeCompare(left.updatedAt) ||
                left.name.localeCompare(right.name) ||
                left.id.localeCompare(right.id)
        );
}

function sessionItem(node, detail) {
    return {
        key: node.id,
        label: node.name,
        detail: cleanText(detail),
    };
}

function section(id, count, summary, items = []) {
    const definition = sectionDefinitions.get(id);
    return {
        ...definition,
        count,
        summary,
        items,
    };
}

function coverageFrom(source = {}) {
    const unavailableSources = [];
    if (source.appDatabase !== "available") unavailableSources.push("app database");
    if (source.sessionStore !== "available") unavailableSources.push("session store");
    if (source.eventMetadata !== "available") unavailableSources.push("event metadata");
    const limitations = Array.isArray(source.limitations)
        ? source.limitations.map((item) => cleanText(item)).filter(Boolean)
        : [];
    const partial = unavailableSources.length > 0 || limitations.length > 0;
    return {
        level: partial ? "partial" : "complete",
        summary: partial
            ? unavailableSources.length
                ? `Partial local view: ${plural(unavailableSources.length, "metadata source")} unavailable or incomplete; the briefing may omit work or misclassify status.`
                : "Partial local view: reported source limitations may omit work or misclassify status."
            : "Based only on sanitized local operational metadata.",
        unavailableSources,
        limitations,
    };
}

function repositorySection(nodes) {
    const byRepository = new Map();
    for (const node of nodes) {
        const entry = byRepository.get(node.repository) ?? { total: 0, unresolved: 0 };
        entry.total++;
        if (!terminalStatuses.has(node.status)) entry.unresolved++;
        byRepository.set(node.repository, entry);
    }
    const items = [...byRepository.entries()]
        .sort(
            ([leftName, left], [rightName, right]) =>
                right.unresolved - left.unresolved ||
                right.total - left.total ||
                leftName.localeCompare(rightName)
        )
        .map(([repository, counts]) => ({
            key: repository,
            label: repository,
            detail: `${plural(counts.unresolved, "unresolved session")} · ${plural(counts.total, "session")}`,
        }));
    const count = byRepository.size;
    return section(
        "repository-spread",
        count,
        count
            ? `${plural(count, "repository", "repositories")} represented in the visible local state.`
            : "No repository metadata is visible.",
        items
    );
}

function bottleneckSection(nodes, now) {
    const decisions = nodes.filter((node) => decisionStatuses.has(node.status));
    const blocked = nodes.filter((node) => node.status === "blocked");
    const failed = nodes.filter((node) => node.status === "failed");
    const busy = nodes.filter((node) => node.status === "busy");
    const longRunning = busy.filter((node) => {
        const startedAt = timestamp(node.busySince);
        return startedAt > 0 && now - startedAt >= longRunningMs;
    });
    const attention = nodes.filter((node) => attentionStatuses.has(node.status));
    const attentionByRepository = new Map();
    for (const node of attention) {
        attentionByRepository.set(
            node.repository,
            (attentionByRepository.get(node.repository) ?? 0) + 1
        );
    }
    const concentrated = [...attentionByRepository.entries()]
        .filter(
            ([, count]) =>
                count >= 3 &&
                attention.length > 0 &&
                count / attention.length >= 0.6
        )
        .sort(
            ([leftName, leftCount], [rightName, rightCount]) =>
                rightCount - leftCount || leftName.localeCompare(rightName)
        );

    const items = [];
    if (decisions.length >= 2) {
        items.push({
            key: "decision-queue",
            label: "Decision queue",
            detail: `${plural(decisions.length, "session")} await user input or plan approval.`,
        });
    }
    if (blocked.length) {
        items.push({
            key: "blocked-work",
            label: "Blocked work",
            detail: `${plural(blocked.length, "session")} ${blocked.length === 1 ? "reports" : "report"} a permission decision as outstanding.`,
        });
    }
    if (failed.length) {
        items.push({
            key: "failed-work",
            label: "Failed work",
            detail: `${plural(failed.length, "session")} ${failed.length === 1 ? "has" : "have"} an unrecovered local failure signal.`,
        });
    }
    if (longRunning.length) {
        items.push({
            key: "long-running",
            label: "Long-running work",
            detail: `${plural(longRunning.length, "busy session")} ${longRunning.length === 1 ? "has" : "have"} run for at least 2 hours.`,
        });
    }
    for (const [repository, count] of concentrated) {
        items.push({
            key: `repository:${repository}`,
            label: "Repository concentration",
            detail: `${plural(count, "attention session")} are in ${repository}, at least 60% of visible attention work.`,
        });
    }
    return section(
        "likely-bottlenecks",
        items.length,
        items.length
            ? `${plural(items.length, "possible bottleneck signal")} detected from observable status and timing thresholds; these are indicators, not diagnoses.`
            : "No configured bottleneck threshold is met in the visible local state.",
        items
    );
}

export function buildOperationalBriefing(
    { nodes = [], source = {} } = {},
    { now = new Date().toISOString() } = {}
) {
    const generatedAt = new Date(timestamp(now) || 0).toISOString();
    const nowMs = timestamp(generatedAt);
    const normalizedNodes = stableNodes(nodes);
    const busy = normalizedNodes.filter((node) => node.status === "busy");
    const decisions = normalizedNodes.filter((node) => decisionStatuses.has(node.status));
    const failures = normalizedNodes.filter((node) => node.status === "failed");
    const blocked = normalizedNodes.filter((node) => node.status === "blocked");
    const recentCompletions = normalizedNodes.filter((node) => {
        const updatedAt = timestamp(node.updatedAt);
        return (
            node.status === "completed" &&
            updatedAt > 0 &&
            updatedAt <= nowMs &&
            nowMs - updatedAt <= recentWindowMs
        );
    });
    const coverage = coverageFrom(source);

    const sections = [
        section(
            "active-work",
            busy.length,
            busy.length
                ? `${plural(busy.length, "session")} currently report busy.`
                : "No session currently reports busy.",
            busy.map((node) =>
                sessionItem(
                    node,
                    `${node.repository}${node.busySince ? ` · busy since ${node.busySince}` : ""}`
                )
            )
        ),
        section(
            "decisions-needed",
            decisions.length,
            decisions.length
                ? `${plural(decisions.length, "session")} await user input or plan approval.`
                : "No user or plan decision is currently recorded.",
            decisions.map((node) =>
                sessionItem(
                    node,
                    `${node.repository} · ${node.humanGate || (node.status === "waiting-plan" ? "Plan approval required" : "User response required")}`
                )
            )
        ),
        section(
            "failures",
            failures.length,
            failures.length
                ? `${plural(failures.length, "session")} ${failures.length === 1 ? "has" : "have"} an unrecovered local failure signal.`
                : "No unrecovered local failure signal is visible.",
            failures.map((node) => sessionItem(node, node.repository))
        ),
        section(
            "blocked-sessions",
            blocked.length,
            blocked.length
                ? `${plural(blocked.length, "session")} ${blocked.length === 1 ? "reports" : "report"} an outstanding permission decision.`
                : "No session reports an outstanding permission decision.",
            blocked.map((node) =>
                sessionItem(node, `${node.repository} · ${node.humanGate || "Permission decision required"}`)
            )
        ),
        section(
            "recent-completions",
            recentCompletions.length,
            recentCompletions.length
                ? `${plural(recentCompletions.length, "session")} completed within the last 24 hours.`
                : "No timestamped completion is visible from the last 24 hours.",
            recentCompletions.map((node) =>
                sessionItem(node, `${node.repository} · completed ${node.updatedAt}`)
            )
        ),
        repositorySection(normalizedNodes),
        bottleneckSection(normalizedNodes, nowMs),
    ];

    const state =
        normalizedNodes.length === 0
            ? "empty"
            : normalizedNodes.length === 1
              ? "single"
              : "multi";
    const headline =
        state === "empty"
            ? "No sessions are visible"
            : state === "single"
              ? "1 session visible · no coordination spread"
              : `${busy.length} active · ${decisions.length} decisions · ${failures.length} failed · ${blocked.length} blocked`;

    return {
        version: 1,
        generatedAt,
        state,
        headline,
        coverage,
        sections,
    };
}
