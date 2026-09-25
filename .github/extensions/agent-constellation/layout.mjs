const completedShelfId = "__agent_constellation_completed__";
const archivedShelfId = "__agent_constellation_archived__";
const filteredProjectRootId = "__agent_constellation_project_scope__";
const repositoryGroupPrefix = "__agent_constellation_repository_group__:";
const defaultGroupingThreshold = 30;
const defaultMinimumGroupSize = 3;

const acronymLabels = new Map([
    ["ai", "AI"],
    ["api", "API"],
    ["cli", "CLI"],
    ["cpu", "CPU"],
    ["gpu", "GPU"],
    ["gpt", "GPT"],
    ["llm", "LLM"],
    ["mcp", "MCP"],
    ["npu", "NPU"],
    ["openai", "OpenAI"],
    ["ui", "UI"],
    ["ux", "UX"],
]);

const reasoningLabels = new Map([
    ["minimal", "Minimal"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra High"],
    ["none", ""],
]);

const statusPriority = new Map(
    [
        "waiting-user",
        "waiting-plan",
        "blocked",
        "failed",
        "busy",
        "idle",
        "archived",
        "completed",
    ].map((status, index) => [status, index])
);

const attentionStatuses = new Set([
    "waiting-user",
    "waiting-plan",
    "blocked",
    "failed",
]);

const statusSearchLabels = new Map([
    ["busy", "busy working"],
    ["waiting-user", "waiting for user attention"],
    ["waiting-plan", "waiting for plan approval"],
    ["blocked", "blocked permission"],
    ["failed", "failed error interrupted"],
    ["completed", "completed done"],
    ["idle", "idle ready"],
    ["archived", "archived"],
]);

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

export function programmaticScrollBehavior({
    smooth = true,
    reducedMotion = false,
} = {}) {
    return smooth && !reducedMotion ? "smooth" : "auto";
}

export function resolveVisibleSelection(nodes, selectedId, fallbackIds = []) {
    const visibleIds = new Set((nodes ?? []).map((node) => node.id));
    if (selectedId && visibleIds.has(selectedId)) return selectedId;
    return fallbackIds.find((id) => id && visibleIds.has(id));
}

export function cardMarkerLayout(cardWidth, cardHeight) {
    const width = Math.max(120, Number(cardWidth) || 0);
    const height = Math.max(56, Number(cardHeight) || 0);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const inset = 15;
    return {
        status: { x: -halfWidth + inset, y: -halfHeight + inset },
        identity: { right: halfWidth - 4, y: -halfHeight - 7 },
        activity: { x: halfWidth - inset, y: halfHeight - inset },
        trust: { x: -halfWidth + inset, y: halfHeight - inset },
    };
}

export function describeMeaningfulConstellationChange(previous, next) {
    if (!previous || !next) return "";
    const previousNodes = new Map(
        (previous.nodes ?? [])
            .filter((node) => !node.synthetic)
            .map((node) => [node.id, node])
    );
    const nextNodes = new Map(
        (next.nodes ?? [])
            .filter((node) => !node.synthetic)
            .map((node) => [node.id, node])
    );
    const added = [...nextNodes.keys()].filter((id) => !previousNodes.has(id)).length;
    const removed = [...previousNodes.keys()].filter((id) => !nextNodes.has(id)).length;
    const statusChanges = [...nextNodes].filter(
        ([id, node]) =>
            previousNodes.has(id) && previousNodes.get(id).status !== node.status
    ).length;
    const previousScope = previous.diagnostics?.effectiveScope;
    const nextScope = next.diagnostics?.effectiveScope;
    const parts = [];
    if (previousScope && nextScope && previousScope !== nextScope) {
        parts.push(nextScope === "all" ? "All sessions view active" : "Tree view active");
    }
    if (added) parts.push(`${added} session${added === 1 ? "" : "s"} added`);
    if (removed) parts.push(`${removed} session${removed === 1 ? "" : "s"} removed`);
    if (statusChanges) {
        parts.push(
            `${statusChanges} session${statusChanges === 1 ? "" : "s"} changed status`
        );
    }
    return parts.length ? `${parts.join(". ")}.` : "";
}

function normalizedFilterValue(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveProjectFilter(projects, input) {
    const requested = typeof input === "string" ? input.trim() : "";
    if (!requested) {
        return {
            requested: "",
            status: "none",
            matched: true,
            id: undefined,
            name: undefined,
            value: "",
        };
    }
    const lookup = normalizedFilterValue(requested);
    const available = Array.isArray(projects) ? projects : [];
    const idMatches = available.filter(
        (project) => normalizedFilterValue(project?.id) === lookup
    );
    if (idMatches.length === 1) {
        const project = idMatches[0];
        return {
            requested,
            status: "resolved",
            matched: true,
            id: project.id || undefined,
            name: project.name || undefined,
            value: project.id || project.name,
        };
    }
    if (idMatches.length > 1) {
        return {
            requested,
            status: "ambiguous",
            matched: false,
            id: undefined,
            name: undefined,
            value: requested,
        };
    }
    const nameMatches = available.filter(
        (project) => normalizedFilterValue(project?.name) === lookup
    );
    if (nameMatches.length === 1) {
        const project = nameMatches[0];
        return {
            requested,
            status: "resolved",
            matched: true,
            id: project.id || undefined,
            name: project.name || undefined,
            value: project.id || project.name,
        };
    }
    return {
        requested,
        status: nameMatches.length > 1 ? "ambiguous" : "unknown",
        matched: false,
        id: undefined,
        name: undefined,
        value: requested,
    };
}

export function matchesProjectFilter(project, resolution) {
    if (!resolution?.requested) return true;
    if (!resolution.matched) return false;
    const id = normalizedFilterValue(project?.projectId ?? project?.id);
    const name = normalizedFilterValue(project?.projectName ?? project?.name);
    if (resolution.id) return id === normalizedFilterValue(resolution.id);
    return Boolean(
        resolution.name && name === normalizedFilterValue(resolution.name)
    );
}

export function visualParentId(node) {
    return node?.syntheticParentId || node?.parentId;
}

export function normalizeSearchQuery(value) {
    if (typeof value !== "string") return "";
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

export function sessionMatchesSearch(node, query) {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return true;
    if (!node || node.synthetic || node.isShelf || node.isRepositoryGroup) {
        return false;
    }
    const searchable = normalizeSearchQuery(
        [
            node.name,
            node.projectName,
            node.repository,
            node.branch,
            node.pullRequest,
            node.issue,
            node.task,
            node.provider,
            node.model,
            node.reasoningEffort,
            node.status,
            statusSearchLabels.get(node.status),
        ]
            .filter(Boolean)
            .join(" ")
    );
    return normalizedQuery
        .split(" ")
        .every((token) => searchable.includes(token));
}

export function buildLineageFocusSet(nodes, selectedId) {
    const byId = new Map((nodes ?? []).map((node) => [node.id, node]));
    if (!byId.has(selectedId)) return new Set();

    const focused = new Set();
    const visitedAncestors = new Set();
    let current = byId.get(selectedId);
    while (current && !visitedAncestors.has(current.id)) {
        visitedAncestors.add(current.id);
        focused.add(current.id);
        const parentId = visualParentId(current);
        current = parentId ? byId.get(parentId) : undefined;
    }

    const { children } = childMap([...byId.values()]);
    const queue = [selectedId];
    const visitedDescendants = new Set();
    while (queue.length) {
        const id = queue.shift();
        if (!id || visitedDescendants.has(id)) continue;
        visitedDescendants.add(id);
        focused.add(id);
        for (const child of children.get(id) ?? []) queue.push(child.id);
    }
    return focused;
}

function addVisualAncestry(ids, byId) {
    for (const id of [...ids]) {
        const visited = new Set();
        let current = byId.get(id);
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            ids.add(current.id);
            const parentId = visualParentId(current);
            current = parentId ? byId.get(parentId) : undefined;
        }
    }
    return ids;
}

export function selectConstellationVisibility(
    state,
    { search = "", focusSessionId = "" } = {}
) {
    if (!state || !Array.isArray(state.nodes) || !Array.isArray(state.edges)) return state;
    const query = normalizeSearchQuery(search);
    const focusIds = focusSessionId
        ? buildLineageFocusSet(state.nodes, focusSessionId)
        : undefined;
    if (!query && !focusIds) {
        return {
            ...state,
            visibility: {
                query: "",
                directMatchCount: 0,
                focusSessionId: "",
                noMatches: false,
            },
        };
    }

    const directMatches = new Set(
        state.nodes
            .filter(
                (node) =>
                    (!focusIds || focusIds.has(node.id)) &&
                    (!query || sessionMatchesSearch(node, query))
            )
            .map((node) => node.id)
    );
    const keep = query ? new Set(directMatches) : new Set(focusIds);
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    addVisualAncestry(keep, byId);
    const nodes = state.nodes.filter((node) => keep.has(node.id));
    const ids = new Set(nodes.map((node) => node.id));
    return {
        ...state,
        rootId: ids.has(state.rootId)
            ? state.rootId
            : nodes.find((node) => {
                  const parentId = visualParentId(node);
                  return !parentId || !ids.has(parentId);
              })?.id,
        currentSessionId: ids.has(state.currentSessionId)
            ? state.currentSessionId
            : undefined,
        nodes,
        edges: state.edges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target)
        ),
        visibility: {
            query,
            directMatchCount: directMatches.size,
            directMatchIds: [...directMatches],
            focusSessionId: focusIds?.has(focusSessionId)
                ? focusSessionId
                : "",
            focusIds: focusIds ? [...focusIds] : [],
            noMatches: Boolean(query && directMatches.size === 0),
        },
    };
}

export function buildProtectedRevealSet(
    nodes,
    {
        rootId,
        currentSessionId,
        selectedId,
        directMatchIds = [],
        focusIds = [],
    } = {}
) {
    const byId = new Map((nodes ?? []).map((node) => [node.id, node]));
    const protectedIds = new Set(
        [
            rootId,
            currentSessionId,
            selectedId,
            ...directMatchIds,
            ...focusIds,
        ].filter((id) => byId.has(id))
    );
    for (const node of byId.values()) {
        if (!node.synthetic && attentionStatuses.has(node.status)) {
            protectedIds.add(node.id);
        }
    }
    return addVisualAncestry(protectedIds, byId);
}

function filteredCounts(nodes, statuses) {
    const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
    for (const node of nodes) {
        if (!node.synthetic && Object.hasOwn(counts, node.status)) counts[node.status]++;
    }
    return counts;
}

function filteredProjects(nodes) {
    return [
        ...new Map(
            nodes
                .filter((node) => !node.synthetic)
                .map((node) => [
                    `${node.projectId ?? ""}\u0000${node.projectName ?? ""}`,
                    {
                        id: node.projectId,
                        name: node.projectName,
                    },
                ])
        ).values(),
    ].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export function filterConstellationView(
    state,
    { status = "", repository = "", project = "" } = {}
) {
    if (!state || !Array.isArray(state.nodes) || !Array.isArray(state.edges)) return state;
    const normalizedStatus = typeof status === "string" ? status.trim() : "";
    const normalizedRepository = normalizedFilterValue(repository);
    const projectResolution = resolveProjectFilter(state.projects, project);
    if (!normalizedStatus && !normalizedRepository && !projectResolution.requested) return state;

    const realMatches = state.nodes.filter(
        (node) =>
            !node.synthetic &&
            (!normalizedStatus || node.status === normalizedStatus) &&
            (!normalizedRepository ||
                normalizedFilterValue(node.repository) === normalizedRepository) &&
            matchesProjectFilter(node, projectResolution)
    );
    const projectFilter = projectResolution.requested
        ? {
              requested: projectResolution.requested,
              status: projectResolution.status,
              effectiveProjectId: projectResolution.id,
              effectiveProjectName: projectResolution.name,
          }
        : undefined;
    if (!realMatches.length) {
        return {
            ...state,
            rootId: undefined,
            currentSessionId: undefined,
            nodes: [],
            edges: [],
            counts: filteredCounts([], Object.keys(state.counts ?? {})),
            repositories: [],
            projects: [],
            diagnostics: {
                ...state.diagnostics,
                selectedRealSessionCount: 0,
                independentRealRootCount: 0,
                projectFilter,
            },
        };
    }

    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    const keep = new Set(realMatches.map((node) => node.id));
    if (projectResolution.requested) {
        if (byId.get(state.rootId)?.synthetic) keep.add(state.rootId);
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of [...keep]) {
                const node = byId.get(id);
                const parentId = visualParentId(node);
                const parent = parentId ? byId.get(parentId) : undefined;
                if (
                    parent &&
                    !keep.has(parent.id) &&
                    (parent.synthetic || matchesProjectFilter(parent, projectResolution))
                ) {
                    keep.add(parent.id);
                    changed = true;
                }
            }
        }
    } else {
        keep.add(state.rootId);
        if (state.diagnostics?.effectiveScope !== "all") {
            keep.add(state.currentSessionId);
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of [...keep]) {
                const parentId = visualParentId(byId.get(id));
                if (parentId && byId.has(parentId) && !keep.has(parentId)) {
                    keep.add(parentId);
                    changed = true;
                }
            }
        }
    }

    let nodes = state.nodes.filter((node) => keep.has(node.id));
    let rootId;
    let edges;
    if (projectResolution.requested) {
        const retainedSyntheticRoot = nodes.find(
            (node) => node.id === state.rootId && node.synthetic
        );
        const rootNode =
            retainedSyntheticRoot ??
            {
                id: filteredProjectRootId,
                name: projectResolution.name
                    ? `${projectResolution.name} sessions`
                    : "Project sessions",
                repository: "Project scope",
                projectId: projectResolution.id,
                projectName: projectResolution.name || "Project scope",
                status: "idle",
                nodeType: "project-overview",
                synthetic: true,
            };
        const retainedIds = new Set(nodes.map((node) => node.id));
        retainedIds.add(rootNode.id);
        nodes = [
            rootNode,
            ...nodes
                .filter((node) => node.id !== rootNode.id)
                .map((node) => {
                    if (node.synthetic) return node;
                    const parentId = visualParentId(node);
                    return parentId && retainedIds.has(parentId)
                        ? node
                        : { ...node, syntheticParentId: rootNode.id };
                }),
        ];
        rootId = rootNode.id;
        const nodeIds = new Set(nodes.map((node) => node.id));
        edges = state.edges.filter(
            (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
        );
        const edgeKeys = new Set(
            edges.map((edge) => `${edge.source}\u0000${edge.target}`)
        );
        for (const node of nodes) {
            if (!node.synthetic && node.syntheticParentId === rootId) {
                const key = `${rootId}\u0000${node.id}`;
                if (!edgeKeys.has(key)) {
                    edges.push({
                        source: rootId,
                        target: node.id,
                        kind: "containment",
                        synthetic: true,
                    });
                    edgeKeys.add(key);
                }
            }
        }
    } else {
        const nodeIds = new Set(nodes.map((node) => node.id));
        rootId = nodeIds.has(state.rootId)
            ? state.rootId
            : nodes.find((node) => {
                  const parentId = visualParentId(node);
                  return !parentId || !nodeIds.has(parentId);
              })?.id;
        edges = state.edges.filter(
            (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
        );
    }
    const realNodes = nodes.filter((node) => !node.synthetic);
    const realNodeIds = new Set(realNodes.map((node) => node.id));
    const independentRealRootCount = realNodes.filter(
        (node) => !node.parentId || !realNodeIds.has(node.parentId)
    ).length;
    return {
        ...state,
        rootId,
        currentSessionId: realNodeIds.has(state.currentSessionId)
            ? state.currentSessionId
            : undefined,
        nodes,
        edges,
        counts: filteredCounts(realNodes, Object.keys(state.counts ?? {})),
        repositories: [...new Set(realNodes.map((node) => node.repository))].sort(),
        projects: filteredProjects(realNodes),
        diagnostics: {
            ...state.diagnostics,
            selectedRealSessionCount: realNodes.length,
            independentRealRootCount,
            projectFilter,
        },
    };
}

function humanizeIdentifier(value) {
    if (typeof value !== "string") return "";
    const tokens = value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .split(/[-_/\\\s]+/)
        .filter(Boolean)
        .map((token) => {
            const lower = token.toLowerCase();
            if (acronymLabels.has(lower)) return acronymLabels.get(lower);
            if (/^\d+(?:\.\d+)*$/.test(token)) return token;
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        });
    return tokens
        .map((token, index) =>
            index > 0 && tokens[index - 1] === "GPT" && /^\d/.test(token)
                ? `-${token}`
                : `${index ? " " : ""}${token}`
        )
        .join("");
}

export function formatModelLabel(model, reasoningEffort) {
    const modelLabel = humanizeIdentifier(model);
    if (!modelLabel) return "";
    const effortKey =
        typeof reasoningEffort === "string" ? reasoningEffort.trim().toLowerCase() : "";
    const effortLabel = reasoningLabels.has(effortKey)
        ? reasoningLabels.get(effortKey)
        : humanizeIdentifier(reasoningEffort);
    return effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel;
}

function compareNodes(left, right) {
    const statusDelta =
        (statusPriority.get(left.status) ?? 99) - (statusPriority.get(right.status) ?? 99);
    const shelfDelta =
        left.isShelf === right.isShelf ? 0 : left.isShelf ? -1 : 1;
    const groupDelta =
        left.isRepositoryGroup === right.isRepositoryGroup
            ? 0
            : left.isRepositoryGroup
              ? -1
              : 1;
    return (
        statusDelta ||
        shelfDelta ||
        groupDelta ||
        String(left.repository ?? "").localeCompare(
            String(right.repository ?? "")
        ) ||
        String(left.name ?? "").localeCompare(String(right.name ?? "")) ||
        String(left.id).localeCompare(String(right.id))
    );
}

function ancestry(nodeId, byId) {
    const ids = [];
    const visited = new Set();
    let current = byId.get(nodeId);
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ids.push(current.id);
        const parentId = visualParentId(current);
        current = parentId ? byId.get(parentId) : undefined;
    }
    return ids;
}

function visibleTree(
    nodes,
    rootId,
    currentSessionId,
    completedExpanded,
    archivedExpanded,
    protectedIds = new Set()
) {
    const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
    const required = new Set(
        [rootId, currentSessionId, ...protectedIds].filter(Boolean)
    );
    for (const node of byId.values()) {
        if (
            !["completed", "archived"].includes(node.status) ||
            node.id === rootId ||
            node.id === currentSessionId
        ) {
            for (const id of ancestry(node.id, byId)) required.add(id);
        }
    }

    const completed = [...byId.values()].filter(
        (node) => !node.synthetic && node.status === "completed" && !required.has(node.id)
    );
    const archived = [...byId.values()].filter(
        (node) => !node.synthetic && node.status === "archived" && !required.has(node.id)
    );
    const collapsed = [
        ...(completedExpanded ? [] : completed),
        ...(archivedExpanded ? [] : archived),
    ];
    const collapsedIds = new Set(collapsed.map((node) => node.id));
    const visible = [...byId.values()].filter((node) => !collapsedIds.has(node.id));
    if (archived.length) {
        visible.push({
            id: archivedShelfId,
            parentId: rootId,
            name: `Archived (${archived.length})`,
            repository: "Archived agent shelf",
            status: "archived",
            isShelf: true,
            shelfType: "archived",
            shelfCount: archived.length,
        });
    }
    if (completed.length) {
        visible.push({
            id: completedShelfId,
            parentId: rootId,
            name: `Completed (${completed.length})`,
            repository: "Completed agent shelf",
            status: "completed",
            isShelf: true,
            shelfType: "completed",
            shelfCount: completed.length,
        });
    }
    return {
        visible,
        collapsed,
        completedCount: completed.length,
        archivedCount: archived.length,
    };
}

function highestPriorityStatus(statuses) {
    return [...statuses].sort(
        (left, right) =>
            (statusPriority.get(left) ?? 99) -
                (statusPriority.get(right) ?? 99) ||
            String(left).localeCompare(String(right))
    )[0] ?? "idle";
}

function treeMetadata(nodes) {
    const { byId, children } = childMap(nodes);
    const subtreeSessionCounts = new Map();
    const subtreeStatuses = new Map();

    function inspect(node, lineage = new Set()) {
        if (!node || lineage.has(node.id)) {
            return { count: 0, status: "idle" };
        }
        if (subtreeSessionCounts.has(node.id)) {
            return {
                count: subtreeSessionCounts.get(node.id),
                status: subtreeStatuses.get(node.id),
            };
        }
        const nextLineage = new Set(lineage).add(node.id);
        let count = node.isShelf ? Number(node.shelfCount) || 1 : 1;
        let status = node.status;
        for (const child of children.get(node.id) ?? []) {
            const childMetadata = inspect(child, nextLineage);
            count += childMetadata.count;
            status = highestPriorityStatus([status, childMetadata.status]);
        }
        subtreeSessionCounts.set(node.id, count);
        subtreeStatuses.set(node.id, status);
        return { count, status };
    }

    for (const node of byId.values()) inspect(node);
    return { byId, children, subtreeSessionCounts, subtreeStatuses };
}

export function repositoryGroupId(parentId, repository) {
    return `${repositoryGroupPrefix}${encodeURIComponent(
        parentId ?? ""
    )}:${encodeURIComponent(repository ?? "")}`;
}

export function groupDirectRepositorySiblings(
    nodes,
    rootId,
    {
        protectedIds = new Set(),
        expandedGroupIds = new Set(),
        groupingThreshold = defaultGroupingThreshold,
        minimumGroupSize = defaultMinimumGroupSize,
    } = {}
) {
    const metadata = treeMetadata(nodes);
    const { byId, children, subtreeSessionCounts, subtreeStatuses } = metadata;
    const protectedSet = new Set(protectedIds);
    const expandedSet = new Set(expandedGroupIds);
    const groupingEnabled =
        [...byId.values()].filter((node) => !node.synthetic && !node.isShelf)
            .length >= groupingThreshold;
    if (!groupingEnabled) {
        return {
            nodes: [...byId.values()],
            syntheticEdges: [],
            groupCount: 0,
            hiddenSessionCount: 0,
        };
    }

    const output = [];
    const syntheticEdges = [];
    const emitted = new Set();
    const suppressed = new Set();
    let groupCount = 0;
    let hiddenSessionCount = 0;

    function suppressSubtree(node) {
        if (!node || suppressed.has(node.id)) return;
        suppressed.add(node.id);
        for (const child of children.get(node.id) ?? []) suppressSubtree(child);
    }

    function appendNode(node) {
        if (!node || emitted.has(node.id) || suppressed.has(node.id)) return;
        emitted.add(node.id);
        output.push(node);

        const directChildren = children.get(node.id) ?? [];
        const groupsByRepository = new Map();
        for (const child of directChildren) {
            if (
                child.synthetic ||
                child.isShelf ||
                !child.repository ||
                child.repository === "No project"
            ) {
                continue;
            }
            if (!groupsByRepository.has(child.repository)) {
                groupsByRepository.set(child.repository, []);
            }
            groupsByRepository.get(child.repository).push(child);
        }
        const repositoryGroups = new Map(
            [...groupsByRepository]
                .filter(([, items]) => items.length >= minimumGroupSize)
                .sort(([left], [right]) => left.localeCompare(right))
        );
        const groupedIds = new Set(
            [...repositoryGroups.values()].flatMap((items) =>
                items.map((item) => item.id)
            )
        );
        const emittedRepositories = new Set();

        for (const child of directChildren) {
            const members = repositoryGroups.get(child.repository);
            if (!members || !groupedIds.has(child.id)) {
                appendNode(child);
                continue;
            }
            if (emittedRepositories.has(child.repository)) continue;
            emittedRepositories.add(child.repository);

            const id = repositoryGroupId(node.id, child.repository);
            const expanded = expandedSet.has(id);
            const hiddenMembers = expanded
                ? []
                : members.filter((member) => !protectedSet.has(member.id));
            const visibleMembers = expanded
                ? members
                : members.filter((member) => protectedSet.has(member.id));
            const hiddenCount = hiddenMembers.reduce(
                (sum, member) =>
                    sum + (subtreeSessionCounts.get(member.id) ?? 1),
                0
            );
            const totalCount = members.reduce(
                (sum, member) =>
                    sum + (subtreeSessionCounts.get(member.id) ?? 1),
                0
            );
            if (expanded || hiddenCount) {
                output.push({
                    id,
                    parentId: node.id,
                    name: `${child.repository} (${totalCount})`,
                    repository: child.repository,
                    status: highestPriorityStatus(
                        members.map(
                            (member) =>
                                subtreeStatuses.get(member.id) ?? member.status
                        )
                    ),
                    synthetic: true,
                    nodeType: "repository-group",
                    isRepositoryGroup: true,
                    groupExpanded: expanded,
                    groupMemberCount: members.length,
                    hiddenCount,
                    totalCount,
                });
                syntheticEdges.push({
                    source: node.id,
                    target: id,
                    kind: "repository-group",
                    synthetic: true,
                    isRepositoryGroup: true,
                });
                groupCount++;
                hiddenSessionCount += hiddenCount;
            }
            for (const member of hiddenMembers) suppressSubtree(member);
            for (const member of visibleMembers) appendNode(member);
        }
    }

    appendNode(byId.get(rootId));
    for (const node of [...byId.values()].sort(compareNodes)) {
        if (!emitted.has(node.id) && !suppressed.has(node.id)) {
            appendNode(node);
        }
    }

    return {
        nodes: output,
        syntheticEdges,
        groupCount,
        hiddenSessionCount,
    };
}

function childMap(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map();
    for (const node of nodes) {
        const parentId = visualParentId(node);
        if (!parentId || !byId.has(parentId)) continue;
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(node);
    }
    for (const items of children.values()) items.sort(compareNodes);
    return { byId, children };
}

function verticalLayout(nodes, rootId, currentSessionId, stageWidth, stageHeight) {
    const margin = 10;
    const cardWidth = Math.max(
        172,
        Math.min(stageWidth - margin * 2, stageWidth < 480 ? 220 : 236)
    );
    const cardHeight = 76;
    const rowGap = 16;
    const rowStep = cardHeight + rowGap;
    const { byId, children } = childMap(nodes);
    const ordered = [];
    let maxDepth = 0;
    const visited = new Set();

    function visit(node, depth) {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        maxDepth = Math.max(maxDepth, depth);
        ordered.push({ node, depth });
        for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
    }

    visit(byId.get(rootId), 0);
    for (const node of [...byId.values()].sort(compareNodes)) visit(node, 0);
    const indentBudget = Math.max(0, stageWidth - margin * 2 - cardWidth);
    const indentStep = maxDepth
        ? Math.min(24, indentBudget / maxDepth)
        : 0;
    const positioned = ordered.map(({ node, depth }, row) => ({
        ...node,
        depth,
        x: margin + cardWidth / 2 + depth * indentStep,
        y: margin + cardHeight / 2 + row * rowStep,
        isRoot: node.id === rootId,
        isCurrent: node.id === currentSessionId,
    }));
    const height = Math.max(
        stageHeight,
        margin * 2 + cardHeight + Math.max(0, positioned.length - 1) * rowStep
    );
    return {
        orientation: "vertical",
        nodes: positioned,
        width: stageWidth,
        height,
        cardWidth,
        cardHeight,
    };
}

function horizontalLayout(nodes, rootId, currentSessionId, stageWidth, stageHeight) {
    const cardWidth = 200;
    const cardHeight = 76;
    const columnGap = 30;
    const rowGap = 72;
    const { byId, children } = childMap(nodes);
    const positions = new Map();
    let nextLeaf = 0;
    let maxDepth = 0;

    function place(node, depth, lineage) {
        if (!node || lineage.has(node.id)) return nextLeaf++;
        maxDepth = Math.max(maxDepth, depth);
        const nextLineage = new Set(lineage).add(node.id);
        const childPositions = (children.get(node.id) ?? []).map((child) =>
            place(child, depth + 1, nextLineage)
        );
        const leaf = childPositions.length
            ? childPositions.reduce((sum, value) => sum + value, 0) / childPositions.length
            : nextLeaf++;
        positions.set(node.id, { leaf, depth });
        return leaf;
    }

    place(byId.get(rootId), 0, new Set());
    const leafCount = Math.max(1, nextLeaf);
    const width = Math.max(
        stageWidth,
        40 + leafCount * (cardWidth + columnGap)
    );
    const height = Math.max(
        stageHeight,
        36 + (maxDepth + 1) * (cardHeight + rowGap)
    );
    const horizontalStep =
        leafCount === 1 ? 0 : (width - cardWidth - 40) / (leafCount - 1);
    const positioned = [...positions.entries()].map(([id, position]) => ({
        ...byId.get(id),
        depth: position.depth,
        x:
            leafCount === 1
                ? width / 2
                : cardWidth / 2 + 20 + position.leaf * horizontalStep,
        y: 28 + cardHeight / 2 + position.depth * (cardHeight + rowGap),
        isRoot: id === rootId,
        isCurrent: id === currentSessionId,
    }));
    return {
        orientation: "horizontal",
        nodes: positioned,
        width,
        height,
        cardWidth,
        cardHeight,
    };
}

export function orientationForSize(
    width,
    height,
    { nodeCount = 0, leafCount = 0 } = {}
) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const landscapePane = safeWidth >= 900 && safeWidth / safeHeight >= 1.35;
    const boundedTree =
        (!nodeCount || nodeCount <= 10) && (!leafCount || leafCount <= 4);
    return landscapePane && boundedTree ? "horizontal" : "vertical";
}

export function layoutResponsiveConstellation(
    state,
    {
        width = 960,
        height = 600,
        completedExpanded = false,
        archivedExpanded = false,
        selectedId,
        expandedGroupIds = [],
        groupingThreshold = defaultGroupingThreshold,
        minimumGroupSize = defaultMinimumGroupSize,
    } = {}
) {
    const stageWidth = Math.max(280, Number(width) || 960);
    const stageHeight = Math.max(320, Number(height) || 600);
    const protectedIds = buildProtectedRevealSet(state.nodes ?? [], {
        rootId: state.rootId,
        currentSessionId: state.currentSessionId,
        selectedId,
        directMatchIds: state.visibility?.directMatchIds,
        focusIds: state.visibility?.focusIds,
    });
    const { visible, completedCount, archivedCount } = visibleTree(
        state.nodes ?? [],
        state.rootId,
        state.currentSessionId,
        completedExpanded,
        archivedExpanded,
        protectedIds
    );
    const grouped = groupDirectRepositorySiblings(visible, state.rootId, {
        protectedIds,
        expandedGroupIds,
        groupingThreshold,
        minimumGroupSize,
    });
    const { children } = childMap(grouped.nodes);
    const leafCount = grouped.nodes.filter(
        (node) => !(children.get(node.id)?.length)
    ).length;
    const orientation = orientationForSize(stageWidth, stageHeight, {
        nodeCount: grouped.nodes.length,
        leafCount,
    });
    const layout =
        orientation === "vertical"
            ? verticalLayout(
                  grouped.nodes,
                  state.rootId,
                  state.currentSessionId,
                  stageWidth,
                  stageHeight
              )
            : horizontalLayout(
                  grouped.nodes,
                  state.rootId,
                  state.currentSessionId,
                  stageWidth,
                  stageHeight
              );
    const ids = new Set(layout.nodes.map((node) => node.id));
    const edges = (state.edges ?? [])
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map((edge) => ({ ...edge }));
    for (const shelf of [
        { id: archivedShelfId, count: archivedCount },
        { id: completedShelfId, count: completedCount },
    ]) {
        if (shelf.count && ids.has(shelf.id) && ids.has(state.rootId)) {
            edges.push({
                source: state.rootId,
                target: shelf.id,
                kind: "shelf",
                synthetic: true,
                isShelf: true,
            });
        }
    }
    edges.push(
        ...grouped.syntheticEdges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target)
        )
    );
    return {
        ...layout,
        edges,
        completedCount,
        archivedCount,
        completedExpanded,
        archivedExpanded,
        groupCount: grouped.groupCount,
        hiddenSessionCount: grouped.hiddenSessionCount,
        protectedIds: [...protectedIds],
    };
}

export function fitWidthScale(stageWidth, contentWidth, minimum = 0.82) {
    const available = Math.max(1, Number(stageWidth) - 20);
    const content = Math.max(1, Number(contentWidth));
    return clamp(Math.min(1, available / content), minimum, 1);
}

export function applyPinchGesture({
    transform,
    startA,
    startB,
    currentA,
    currentB,
    minimumScale = 0.65,
    maximumScale = 3,
}) {
    const startMidpoint = {
        x: (startA.x + startB.x) / 2,
        y: (startA.y + startB.y) / 2,
    };
    const currentMidpoint = {
        x: (currentA.x + currentB.x) / 2,
        y: (currentA.y + currentB.y) / 2,
    };
    const startDistance = Math.hypot(startB.x - startA.x, startB.y - startA.y);
    const currentDistance = Math.hypot(
        currentB.x - currentA.x,
        currentB.y - currentA.y
    );
    if (!Number.isFinite(startDistance) || startDistance < 1) return { ...transform };
    const scale = clamp(
        transform.k * (currentDistance / startDistance),
        minimumScale,
        maximumScale
    );
    const worldX = (startMidpoint.x - transform.x) / transform.k;
    const worldY = (startMidpoint.y - transform.y) / transform.k;
    return {
        k: scale,
        x: currentMidpoint.x - worldX * scale,
        y: currentMidpoint.y - worldY * scale,
    };
}

export {
    archivedShelfId,
    completedShelfId,
    defaultGroupingThreshold,
    defaultMinimumGroupSize,
    filteredProjectRootId,
    repositoryGroupPrefix,
};
