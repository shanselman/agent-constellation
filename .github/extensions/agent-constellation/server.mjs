import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
    filterConstellationState,
    sanitizeText,
    stateFingerprint,
} from "./data.mjs";
import { resolveProjectFilter } from "./layout.mjs";
import { renderConstellationHtml } from "./renderer.mjs";

const layoutModule = readFileSync(new URL("./layout.mjs", import.meta.url), "utf8");

class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function writeJson(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(body));
}

function writeText(response, status, body) {
    response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    response.end(body);
}

function requestCookie(request, name) {
    for (const cookie of String(request.headers.cookie ?? "").split(";")) {
        const separator = cookie.indexOf("=");
        if (separator < 0) continue;
        if (cookie.slice(0, separator).trim() === name) {
            try {
                return decodeURIComponent(cookie.slice(separator + 1).trim());
            } catch {
                return "";
            }
        }
    }
    return "";
}

function requireToken(actual, expected) {
    const actualBuffer = Buffer.from(typeof actual === "string" ? actual : "");
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        throw new RequestError(403, "Invalid canvas session");
    }
}

export function requireLocalRequest(request) {
    const host = String(request.headers.host ?? "");
    let hostname;
    try {
        hostname = new URL(`http://${host}`).hostname;
    } catch {
        throw new RequestError(400, "Invalid host");
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
        throw new RequestError(403, "Canvas is available only on loopback");
    }
}

function requireSameSiteRequest(request) {
    const fetchSite = String(request.headers["sec-fetch-site"] ?? "");
    if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
        throw new RequestError(403, "Cross-site canvas requests are not allowed");
    }
}

function requirePageSession(request, entry) {
    requireToken(requestCookie(request, entry.cookieName), entry.pageToken);
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 8_192) throw new RequestError(413, "Request body too large");
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return {};
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        throw new RequestError(400, "Invalid JSON body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new RequestError(400, "JSON body must be an object");
    }
    return body;
}

function publishState(entry) {
    const payload = `event: state\ndata: ${JSON.stringify(entry.state)}\n\n`;
    for (const client of [...entry.clients]) {
        try {
            client.write(payload);
        } catch {
            entry.clients.delete(client);
        }
    }
}

function applyProjectScope(state, projectScope) {
    if (!projectScope.requested) return state;
    const lookup = projectScope.id || projectScope.requested;
    const resolution = resolveProjectFilter(state.projects, lookup);
    if (!projectScope.id && resolution.matched && resolution.id) {
        projectScope.id = resolution.id;
    }
    projectScope.status = resolution.status;
    projectScope.name = resolution.name;
    return filterConstellationState(state, {
        project: projectScope.id || projectScope.requested,
    });
}

export async function refreshConstellationServer(entryOrPromise, { publish = true } = {}) {
    const entry = await entryOrPromise;
    if (!entry) throw new Error("Canvas server is not open");
    if (entry.refreshPromise) return entry.refreshPromise;
    entry.refreshPromise = Promise.resolve(entry.dataProvider({ scope: entry.scope }))
        .then((next) => applyProjectScope(next, entry.projectScope))
        .then((next) => {
            const fingerprint = stateFingerprint(next);
            const changed = fingerprint !== entry.fingerprint;
            entry.state = next;
            entry.fingerprint = fingerprint;
            if (publish && changed) publishState(entry);
            return entry.state;
        })
        .finally(() => {
            entry.refreshPromise = undefined;
        });
    return entry.refreshPromise;
}

export async function setConstellationScope(entryOrPromise, scope) {
    const entry = await entryOrPromise;
    if (!entry) throw new Error("Canvas server is not open");
    if (!["tree", "all"].includes(scope)) {
        throw new RequestError(400, "Scope must be tree or all");
    }
    if (entry.refreshPromise) await entry.refreshPromise;
    entry.scope = scope;
    return refreshConstellationServer(entry);
}

export async function startConstellationServer({
    dataProvider,
    initialRepository = "",
    initialProject = "",
    initialStatus = "",
    initialScope = "tree",
    pollIntervalMs = 2_000,
    logger,
} = {}) {
    if (typeof dataProvider !== "function") throw new Error("A data provider is required");
    const scope = initialScope === "all" ? "all" : "tree";
    const projectScope = {
        requested: sanitizeText(initialProject, 180),
        id: undefined,
        name: undefined,
        status: "none",
    };
    const initialState = applyProjectScope(
        await dataProvider({ scope }),
        projectScope
    );
    const entry = {
        server: undefined,
        url: "",
        openUrl: "",
        pageToken: randomBytes(24).toString("hex"),
        cookieName: `agent_constellation_${randomBytes(6).toString("hex")}`,
        clients: new Set(),
        heartbeat: undefined,
        poller: undefined,
        refreshPromise: undefined,
        dataProvider,
        scope,
        projectScope,
        state: initialState,
        fingerprint: stateFingerprint(initialState),
    };

    const server = createServer(async (request, response) => {
        try {
            requireLocalRequest(request);
            const url = new URL(request.url ?? "/", entry.url || "http://127.0.0.1/");
            const pageToken = url.searchParams.get("pageToken");
            if (pageToken) {
                requireToken(pageToken, entry.pageToken);
                response.writeHead(302, {
                    location: url.pathname || "/",
                    "set-cookie": `${entry.cookieName}=${encodeURIComponent(entry.pageToken)}; HttpOnly; SameSite=Strict; Path=/`,
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                });
                response.end();
                return;
            }
            requireSameSiteRequest(request);

            if (request.method === "GET" && url.pathname === "/") {
                requirePageSession(request, entry);
                const html = renderConstellationHtml({
                    stateUrl: `${entry.url}state`,
                    eventsUrl: `${entry.url}events`,
                    refreshUrl: `${entry.url}refresh`,
                    scopeUrl: `${entry.url}scope`,
                    initialRepository: sanitizeText(initialRepository, 180),
                    initialProject:
                        entry.projectScope.id || entry.projectScope.requested,
                    initialStatus: sanitizeText(initialStatus, 30),
                    initialScope: entry.scope,
                });
                response.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store",
                    "content-security-policy":
                        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'",
                    "referrer-policy": "no-referrer",
                    "x-content-type-options": "nosniff",
                });
                response.end(html);
                return;
            }

            if (request.method === "GET" && url.pathname === "/layout.mjs") {
                requirePageSession(request, entry);
                response.writeHead(200, {
                    "content-type": "text/javascript; charset=utf-8",
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                });
                response.end(layoutModule);
                return;
            }

            if (request.method === "GET" && url.pathname === "/state") {
                requirePageSession(request, entry);
                writeJson(response, 200, entry.state);
                return;
            }

            if (request.method === "GET" && url.pathname === "/events") {
                requirePageSession(request, entry);
                response.writeHead(200, {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache, no-store",
                    connection: "keep-alive",
                    "x-content-type-options": "nosniff",
                });
                entry.clients.add(response);
                response.write(`event: state\ndata: ${JSON.stringify(entry.state)}\n\n`);
                request.on("close", () => entry.clients.delete(response));
                return;
            }

            if (request.method === "POST" && url.pathname === "/refresh") {
                requirePageSession(request, entry);
                const body = await readJsonBody(request);
                if (Object.keys(body).length) throw new RequestError(400, "Refresh body must be empty");
                writeJson(response, 200, await refreshConstellationServer(entry));
                return;
            }

            if (request.method === "POST" && url.pathname === "/scope") {
                requirePageSession(request, entry);
                const body = await readJsonBody(request);
                if (
                    Object.keys(body).some((key) => key !== "scope") ||
                    !["tree", "all"].includes(body.scope)
                ) {
                    throw new RequestError(400, "Scope body must specify tree or all");
                }
                writeJson(response, 200, await setConstellationScope(entry, body.scope));
                return;
            }

            if (!["GET", "HEAD", "POST"].includes(request.method ?? "")) {
                writeText(response, 405, "Method not allowed");
                return;
            }
            writeText(response, 404, "Not found");
        } catch (error) {
            if (error instanceof RequestError) {
                writeText(response, error.status, error.message);
                return;
            }
            await logger?.("Agent Constellation request failed", { level: "error", ephemeral: true });
            writeText(response, 500, "Unexpected canvas error");
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.url = `http://127.0.0.1:${port}/`;
    entry.openUrl = `${entry.url}?pageToken=${encodeURIComponent(entry.pageToken)}`;
    entry.heartbeat = setInterval(() => {
        for (const client of [...entry.clients]) {
            try {
                client.write(": keep-alive\n\n");
            } catch {
                entry.clients.delete(client);
            }
        }
    }, 25_000);
    entry.heartbeat.unref?.();
    entry.poller = setInterval(() => {
        void refreshConstellationServer(entry).catch(async () => {
            await logger?.("Agent Constellation background refresh unavailable", {
                level: "warning",
                ephemeral: true,
            });
        });
    }, Math.max(500, pollIntervalMs));
    entry.poller.unref?.();
    return entry;
}

export async function stopConstellationServer(entryOrPromise) {
    const entry = await entryOrPromise;
    if (!entry) return;
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    if (entry.poller) clearInterval(entry.poller);
    for (const client of [...entry.clients]) client.end();
    entry.clients.clear();
    if (entry.server?.listening) {
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
}

export async function getOrCreateConstellationServer(servers, instanceId, options) {
    const existing = servers.get(instanceId);
    if (existing) return existing;
    const pending = startConstellationServer(options);
    servers.set(instanceId, pending);
    try {
        const entry = await pending;
        servers.set(instanceId, entry);
        return entry;
    } catch (error) {
        if (servers.get(instanceId) === pending) servers.delete(instanceId);
        throw error;
    }
}

export async function closeConstellationServer(servers, instanceId) {
    const entry = servers.get(instanceId);
    if (!entry) return false;
    servers.delete(instanceId);
    await stopConstellationServer(entry);
    return true;
}
