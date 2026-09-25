const completedShelfId = "__agent_constellation_completed__";
const repositoryClusterPrefix = "__agent_constellation_repository__:";
const collapsedSubtreePrefix = "__agent_constellation_subtree__:";
const attentionStatuses = new Set([
    "waiting-user",
    "waiting-plan",
    "blocked",
    "failed",
]);

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
    const summaryDelta =
        Boolean(left.isCluster || left.isCollapsedSummary) ===
        Boolean(right.isCluster || right.isCollapsedSummary)
            ? 0
            : left.isCluster || left.isCollapsedSummary
              ? -1
              : 1;
    return (
        statusDelta ||
        shelfDelta ||
        summaryDelta ||
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
        current = current.parentId ? byId.get(current.parentId) : undefined;
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
        (node) => node.status === "completed" && !required.has(node.id)
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

function treeMetadata(nodes) {
    const { byId, children } = childMap(nodes);
    const subtreeSessionCounts = new Map();
    const subtreeStatus = new Map();

    function inspect(node, lineage = new Set()) {
        if (!node || lineage.has(node.id)) {
            return { sessionCount: 0, status: "idle" };
        }
        if (subtreeSessionCounts.has(node.id)) {
            return {
                sessionCount: subtreeSessionCounts.get(node.id),
                status: subtreeStatus.get(node.id),
            };
        }
        lineage.add(node.id);
        let sessionCount = node.isShelf ? Number(node.completedCount) || 1 : 1;
        let status = node.status;
        for (const child of children.get(node.id) ?? []) {
            const childMetadata = inspect(child, lineage);
            sessionCount += childMetadata.sessionCount;
            status = highestPriorityStatus([status, childMetadata.status]);
        }
        lineage.delete(node.id);
        subtreeSessionCounts.set(node.id, sessionCount);
        subtreeStatus.set(node.id, status);
        return { sessionCount, status };
    }

    for (const node of byId.values()) inspect(node);
    return { byId, children, subtreeSessionCounts, subtreeStatus };
}

function highestPriorityStatus(statuses) {
    return [...statuses].sort(
        (left, right) =>
            (statusPriority.get(left) ?? 99) - (statusPriority.get(right) ?? 99) ||
            String(left).localeCompare(String(right))
    )[0] ?? "idle";
}

function summaryId(prefix, parentId, repository = "") {
    return `${prefix}${encodeURIComponent(parentId)}:${encodeURIComponent(repository)}`;
}

function descendants(node, children) {
    const result = [];
    const queue = [...(children.get(node.id) ?? [])];
    const visited = new Set([node.id]);
    for (let index = 0; index < queue.length; index++) {
        const current = queue[index];
        if (!current || visited.has(current.id)) continue;
        visited.add(current.id);
        result.push(current);
        queue.push(...(children.get(current.id) ?? []));
    }
    return result;
}

function scalableTree(
    nodes,
    rootId,
    currentSessionId,
    {
        selectedId,
        collapsedNodeIds = [],
        expandedClusterIds = [],
        clusterThreshold = 30,
        minimumClusterChildren = 3,
    }
) {
    const metadata = treeMetadata(nodes);
    const { byId, children, subtreeSessionCounts, subtreeStatus } = metadata;
    const protectedSeeds = new Set(
        [rootId, currentSessionId, selectedId].filter(Boolean)
    );
    for (const node of byId.values()) {
        if (attentionStatuses.has(node.status)) protectedSeeds.add(node.id);
    }
    const protectedIds = new Set();
    for (const id of protectedSeeds) {
        const visited = new Set();
        let current = byId.get(id);
        while (current && !visited.has(current.id) && !protectedIds.has(current.id)) {
            visited.add(current.id);
            protectedIds.add(current.id);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
    }

    const collapsed = new Set(collapsedNodeIds);
    const expandedClusters = new Set(expandedClusterIds);
    const hiddenByCollapse = new Map();
    const keptIds = new Set();

    function retain(node, collapseOwner) {
        if (!node || keptIds.has(node.id)) return;
        keptIds.add(node.id);
        const owner = collapseOwner || (collapsed.has(node.id) ? node.id : undefined);
        for (const child of children.get(node.id) ?? []) {
            if (owner && !protectedIds.has(child.id)) {
                const hidden = hiddenByCollapse.get(owner) ?? {
                    count: 0,
                    statuses: [],
                };
                hidden.count += subtreeSessionCounts.get(child.id) ?? 1;
                hidden.statuses.push(subtreeStatus.get(child.id) ?? child.status);
                hiddenByCollapse.set(owner, hidden);
                continue;
            }
            retain(child, owner);
        }
    }

    retain(byId.get(rootId));
    for (const node of [...byId.values()].sort(compareNodes)) {
        if (!keptIds.has(node.id) && !node.parentId) retain(node);
    }

    const visibleChildren = new Map();
    for (const [parentId, items] of children) {
        const visible = items.filter((item) => keptIds.has(item.id));
        if (visible.length) visibleChildren.set(parentId, visible);
    }

    const output = [];
    const syntheticEdges = [];
    const emittedRealIds = new Set();
    const suppressedIds = new Set();
    const emittingIds = new Set();
    let clusterCount = 0;
    let hiddenSessionCount = 0;
    const clusteringEnabled = byId.size >= clusterThreshold;

    function appendCollapsedSummary(node) {
        const hidden = hiddenByCollapse.get(node.id);
        if (!hidden?.count) return;
        const id = summaryId(collapsedSubtreePrefix, node.id);
        output.push({
            id,
            parentId: node.id,
            name: `${hidden.count} hidden`,
            repository: node.repository,
            status: highestPriorityStatus(hidden.statuses),
            isCollapsedSummary: true,
            hiddenCount: hidden.count,
            collapsedParentId: node.id,
        });
        syntheticEdges.push({
            source: node.id,
            target: id,
            isCollapsedSummary: true,
        });
        hiddenSessionCount += hidden.count;
    }

    function appendNode(node) {
        if (!node || emittingIds.has(node.id) || emittedRealIds.has(node.id)) return;
        emittingIds.add(node.id);
        emittedRealIds.add(node.id);
        output.push({
            ...node,
            descendantCount: Math.max(
                0,
                (subtreeSessionCounts.get(node.id) ?? 1) - 1
            ),
            hiddenDescendantCount: hiddenByCollapse.get(node.id)?.count ?? 0,
        });
        appendCollapsedSummary(node);

        const directChildren = visibleChildren.get(node.id) ?? [];
        const repositoryGroups = new Map();
        if (clusteringEnabled) {
            for (const child of directChildren) {
                if (
                    child.isShelf ||
                    protectedIds.has(child.id) ||
                    !child.repository
                ) {
                    continue;
                }
                if (!repositoryGroups.has(child.repository)) {
                    repositoryGroups.set(child.repository, []);
                }
                repositoryGroups.get(child.repository).push(child);
            }
        }
        const clusters = new Map(
            [...repositoryGroups]
                .filter(([, items]) => items.length >= minimumClusterChildren)
                .map(([repository, items]) => [repository, items])
        );
        const clusteredChildIds = new Set(
            [...clusters.values()].flatMap((items) => items.map((item) => item.id))
        );
        const emittedRepositories = new Set();

        for (const child of directChildren) {
            const cluster = clusters.get(child.repository);
            if (!cluster || !clusteredChildIds.has(child.id)) {
                appendNode(child);
                continue;
            }
            if (emittedRepositories.has(child.repository)) continue;
            emittedRepositories.add(child.repository);
            const id = summaryId(repositoryClusterPrefix, node.id, child.repository);
            const statuses = cluster.map(
                (item) => subtreeStatus.get(item.id) ?? item.status
            );
            const count = cluster.reduce(
                (sum, item) => sum + (subtreeSessionCounts.get(item.id) ?? 1),
                0
            );
            const expanded = expandedClusters.has(id);
            output.push({
                id,
                parentId: node.id,
                name: `${count} sessions`,
                repository: child.repository,
                status: highestPriorityStatus(statuses),
                isCluster: true,
                clusterExpanded: expanded,
                clusterMemberCount: cluster.length,
                hiddenCount: count,
            });
            syntheticEdges.push({
                source: node.id,
                target: id,
                isCluster: true,
            });
            clusterCount++;
            if (expanded) {
                for (const member of cluster) appendNode(member);
            } else {
                for (const member of cluster) {
                    suppressedIds.add(member.id);
                    for (const descendant of descendants(member, children)) {
                        suppressedIds.add(descendant.id);
                    }
                }
                hiddenSessionCount += count;
            }
        }
        emittingIds.delete(node.id);
    }

    appendNode(byId.get(rootId));
    for (const node of [...byId.values()].sort(compareNodes)) {
        if (
            keptIds.has(node.id) &&
            !emittedRealIds.has(node.id) &&
            !suppressedIds.has(node.id) &&
            (!node.parentId || !byId.has(node.parentId))
        ) {
            appendNode(node);
        }
    }

    return {
        nodes: output,
        syntheticEdges,
        clusterCount,
        hiddenSessionCount,
    };
}

function childMap(nodes) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map();
    for (const node of nodes) {
        if (!node.parentId || !byId.has(node.parentId)) continue;
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node);
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
    for (const node of [...byId.values()].sort(compareNodes)) {
        if (visited.has(node.id)) continue;
        if (positioned.length) row++;
        visit(node, 0);
    }
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
    const visiting = new Set();
    let nextLeaf = 0;
    let maxDepth = 0;

    function place(node, depth) {
        if (!node || visiting.has(node.id)) return nextLeaf++;
        if (positions.has(node.id)) return positions.get(node.id).leaf;
        visiting.add(node.id);
        maxDepth = Math.max(maxDepth, depth);
        const childPositions = (children.get(node.id) ?? []).map((child) =>
            place(child, depth + 1)
        );
        const leaf = childPositions.length
            ? childPositions.reduce((sum, value) => sum + value, 0) / childPositions.length
            : nextLeaf++;
        positions.set(node.id, { leaf, depth });
        visiting.delete(node.id);
        return leaf;
    }

    place(byId.get(rootId), 0);
    for (const node of [...byId.values()].sort(compareNodes)) {
        if (!positions.has(node.id)) place(node, 0);
    }
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
        selectedId,
        collapsedNodeIds = [],
        expandedClusterIds = [],
        clusterThreshold = 30,
        minimumClusterChildren = 3,
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
    const scaled = scalableTree(
        visible,
        state.rootId,
        state.currentSessionId,
        {
            selectedId,
            collapsedNodeIds,
            expandedClusterIds,
            clusterThreshold,
            minimumClusterChildren,
        }
    );
    const orientation = orientationForSize(stageWidth, stageHeight);
    const layout =
        orientation === "vertical"
            ? verticalLayout(
                  scaled.nodes,
                  state.rootId,
                  state.currentSessionId,
                  stageWidth,
                  stageHeight
              )
            : horizontalLayout(
                  scaled.nodes,
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
        edges.push({ source: state.rootId, target: completedShelfId, isShelf: true });
    }
    edges.push(
        ...scaled.syntheticEdges.filter(
            (edge) => ids.has(edge.source) && ids.has(edge.target)
        )
    );
    return {
        ...layout,
        edges,
        completedCount,
        completedExpanded,
        clusterCount: scaled.clusterCount,
        hiddenSessionCount: scaled.hiddenSessionCount,
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

export { collapsedSubtreePrefix, completedShelfId, repositoryClusterPrefix };
