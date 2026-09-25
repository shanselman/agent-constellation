const completedShelfId = "__agent_constellation_completed__";

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

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
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

function visualParentId(node) {
    return node?.syntheticParentId || node?.parentId;
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
            nodes: [],
            edges: [],
            counts: filteredCounts([], Object.keys(state.counts ?? {})),
            repositories: [],
            projects: [],
            diagnostics: {
                ...state.diagnostics,
                selectedRealSessionCount: 0,
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

    const nodes = state.nodes.filter((node) => keep.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const rootId = nodeIds.has(state.rootId)
        ? state.rootId
        : nodes.find((node) => {
              const parentId = visualParentId(node);
              return !parentId || !nodeIds.has(parentId);
          })?.id;
    const realNodes = nodes.filter((node) => !node.synthetic);
    return {
        ...state,
        rootId,
        nodes,
        edges: state.edges.filter(
            (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)
        ),
        counts: filteredCounts(realNodes, Object.keys(state.counts ?? {})),
        repositories: [...new Set(realNodes.map((node) => node.repository))].sort(),
        projects: filteredProjects(realNodes),
        diagnostics: {
            ...state.diagnostics,
            selectedRealSessionCount: realNodes.length,
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
    return (
        statusDelta ||
        shelfDelta ||
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

function visibleTree(nodes, rootId, currentSessionId, completedExpanded) {
    const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
    const required = new Set([rootId, currentSessionId]);
    for (const node of byId.values()) {
        if (node.status !== "completed" || node.id === rootId || node.id === currentSessionId) {
            for (const id of ancestry(node.id, byId)) required.add(id);
        }
    }

    const collapsible = [...byId.values()].filter(
        (node) => !node.synthetic && node.status === "completed" && !required.has(node.id)
    );
    const collapsed = completedExpanded ? [] : collapsible;
    const collapsedIds = new Set(collapsed.map((node) => node.id));
    const visible = [...byId.values()].filter((node) => !collapsedIds.has(node.id));
    if (collapsible.length) {
        visible.push({
            id: completedShelfId,
            parentId: rootId,
            name: `Completed (${collapsible.length})`,
            repository: "Completed agent shelf",
            status: "completed",
            isShelf: true,
            completedCount: collapsible.length,
        });
    }
    return { visible, collapsed, completedCount: collapsible.length };
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
    const cardWidth = stageWidth < 500 ? 172 : 200;
    const cardHeight = 72;
    const margin = 10;
    const columnGap = stageWidth < 500 ? 34 : 54;
    const rowGap = 18;
    const columnStep = cardWidth + columnGap;
    const rowStep = cardHeight + rowGap;
    const { byId, children } = childMap(nodes);
    const positioned = [];
    let row = 0;
    let maxDepth = 0;
    const visited = new Set();

    function visit(node, depth) {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        maxDepth = Math.max(maxDepth, depth);
        const y = margin + cardHeight / 2 + row * rowStep;
        positioned.push({
            ...node,
            depth,
            x: margin + cardWidth / 2 + depth * columnStep,
            y,
            isRoot: node.id === rootId,
            isCurrent: node.id === currentSessionId,
        });
        if (node.id !== rootId) row++;
        for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
    }

    visit(byId.get(rootId), 0);
    for (const node of [...byId.values()].sort(compareNodes)) visit(node, 0);
    const width = Math.max(
        stageWidth,
        margin * 2 + cardWidth + maxDepth * columnStep
    );
    const height = Math.max(
        stageHeight,
        margin * 2 + cardHeight + Math.max(0, positioned.length - 1) * rowStep
    );
    return {
        orientation: "vertical",
        nodes: positioned,
        width,
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

export function orientationForSize(width, height) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    return safeWidth < 780 || safeHeight / safeWidth > 1.18
        ? "vertical"
        : "horizontal";
}

export function layoutResponsiveConstellation(
    state,
    {
        width = 960,
        height = 600,
        completedExpanded = false,
    } = {}
) {
    const stageWidth = Math.max(320, Number(width) || 960);
    const stageHeight = Math.max(320, Number(height) || 600);
    const { visible, completedCount } = visibleTree(
        state.nodes ?? [],
        state.rootId,
        state.currentSessionId,
        completedExpanded
    );
    const orientation = orientationForSize(stageWidth, stageHeight);
    const layout =
        orientation === "vertical"
            ? verticalLayout(
                  visible,
                  state.rootId,
                  state.currentSessionId,
                  stageWidth,
                  stageHeight
              )
            : horizontalLayout(
                  visible,
                  state.rootId,
                  state.currentSessionId,
                  stageWidth,
                  stageHeight
              );
    const ids = new Set(layout.nodes.map((node) => node.id));
    const edges = (state.edges ?? [])
        .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
        .map((edge) => ({ ...edge }));
    if (completedCount && ids.has(completedShelfId) && ids.has(state.rootId)) {
        edges.push({
            source: state.rootId,
            target: completedShelfId,
            kind: "shelf",
            synthetic: true,
            isShelf: true,
        });
    }
    return {
        ...layout,
        edges,
        completedCount,
        completedExpanded,
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

export { completedShelfId };
