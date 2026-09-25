# Agent Constellation

[![CI](https://github.com/shanselman/agent-constellation/actions/workflows/ci.yml/badge.svg)](https://github.com/shanselman/agent-constellation/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/shanselman/agent-constellation)](https://github.com/shanselman/agent-constellation/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Agent Constellation is a live, animated family tree and mission-control view for GitHub Copilot sessions.** It can show one coordinator family or an explicit all-sessions overview across independent projects while keeping recorded lineage distinct from display-only grouping.

![Agent Constellation showing a coordinator, descendant sessions, model badges, and a completed-agent shelf](docs/agent-constellation.png)

## Why this exists

Copilot can coordinate work across several project sessions, but a text list makes it hard to answer basic operational questions:

- Which session created which descendant?
- What is still working?
- Which session needs a user response or plan approval?
- Which agents have completed and can get out of the way?
- Which repository, branch, model, and reasoning effort belong to each session?

Agent Constellation makes those relationships visible. The current session is marked, parent-child edges show the family tree, restrained motion indicates active work, and a details inspector exposes sanitized metadata for a selected session. Every status also has a distinct shape or symbol, so color is never the only cue.

## Highlights

### Live family tree and mission control

The default `tree` scope follows the topmost accessible ancestor of the current session and includes that session's descendants, preserving the original family-tree behavior. The opt-in `all` scope retains every discovered sanitized app session and recorded parent-child relationship. Independent real roots are placed under a synthetic **All sessions** overview node with dashed containment connections that are explicitly labeled as grouping—not lineage.

Cards show the session name, project, repository, current status, and—when available—the selected model and reasoning effort. Real-session counts exclude the synthetic overview node. Scope diagnostics report requested/effective scope, selected and discovered real-session counts, independent real-root count, source availability, and partial relationship/project limitations.

Repositoryless sessions are labeled conservatively. A session becomes **Home chat** under **My Copilot** only when app metadata positively identifies its session type as `general_chat`; arbitrary repositoryless CLI or fallback sessions remain **Standalone session** under **No project**.

Statuses include:

- **Busy** with elapsed working time
- **Waiting for user**
- **Waiting for plan approval**
- **Blocked** on a permission decision
- **Failed**
- **Idle**
- **Completed**
- **Archived**

The status strip, cards, and inspector reuse the same semantics: busy is a filled circle, idle a hollow circle, completed a check, user attention a diamond, plan approval a clock, blocked an octagon, failed a cross, and archived a striped square. Visible text remains alongside every marker.

Completed and archived descendants collapse into separate **Completed** and **Archived** shelves so a large constellation remains readable. Sessions needing attention sort first, followed by busy work, idle work, and the two shelves. Expand either shelf when you need to inspect finished or historical work.

### Responsive side-pane layout

The layout is designed for the normal right-hand pane first, not for a full-screen diagram. At 280, 320, 480, and 700 pixels, cards use a bounded stacked layout: depth is shown with a small capped indent, connections stay in the left gutter, and the content width never grows beyond the pane. Tall panes use the same bounded layout.

At 960 pixels or wider, a small landscape tree may use the horizontal family-tree view when it has at most 10 visible nodes and four leaves. Dense all-session overviews remain stacked even at that width, preventing ultra-wide canvases and long sideways navigation. The status strip scrolls independently when needed, while toolbar labels, filters, and the inspector compact progressively at 720, 520, and 360 pixels.

### Theme and accessibility behavior

The renderer uses the canvas theme contract instead of app-internal styles:

| Purpose | Canvas tokens |
|---|---|
| Surfaces and borders | `--background-color-default`, `--border-color-default` |
| Primary and secondary text | `--text-color-default`, `--text-color-muted` |
| Keyboard focus | `--color-focus-outline` |
| Status accents | `--true-color-blue`, `--true-color-blue-muted`, `--true-color-red`, and semantic true-color peers with fallbacks |
| Typography | `--font-sans`, `--font-mono`, type-ramp and weight tokens |

Keyboard focus gets an explicit ring around the complete SVG card and is restored to the same session after live renderer refreshes when that session remains visible. Arrow keys move directionally between cards. Automatic live-region messages ignore timestamp-only refreshes and announce only additions, removals, scope changes, or status changes.

Windows high-contrast and other forced-color modes replace decorative surfaces, edges, markers, and focus with system `Canvas`, `CanvasText`, `Highlight`, and `HighlightText` colors. The `CURRENT` badge specifically uses `HighlightText` over `Highlight`. Reduced-motion mode removes pulsing halos and flowing edge dashes in addition to suppressing transitions and attention animations.

### Model and reasoning badges

When Copilot exposes model metadata, cards and the inspector display a conservative human-readable label such as `GPT-5.6 Sol Fast · High`. Missing provider or model fields are handled without hiding the session.

### Local-model leaf semantics

A leaf icon means the session has explicit local-runtime metadata. The classifier intentionally recognizes only:

- Providers named `ollama`, `winml`, or `local`
- Model identifiers beginning with `ollama/`, `ollama:`, `winml/`, `winml:`, `local/`, or `local:`

Model names such as `llama`, `phi`, `mistral`, or `qwen` are **not** assumed to be local without that explicit metadata. Explicit local-runtime sessions show both the leaf and a visible `LOCAL` card prefix; the inspector labels the runtime as **Local runtime** or **Demo local runtime**.

For demonstrations, the canvas accepts an isolated `demoLocalModel: true` open input. It decorates only the current session in the returned canvas state and does not alter stored Copilot session data or affect other open Agent Constellation instances.

### Real-time updates

Each open canvas gets its own dependency-free HTTP server bound to an ephemeral `127.0.0.1` port. Server-Sent Events push state changes to the canvas, with lightweight polling as a fallback. Manual refresh and the agent-callable `refresh` action are also available.

Scope and selector state are isolated per canvas instance. The in-canvas **Tree / All sessions** selector refreshes that instance through its existing authenticated loopback server, preserves valid status/project/repository filters, and never creates a user-global preference or changes another open canvas.

## Privacy and local security

Agent Constellation is deliberately local-first:

- Reads Copilot's local SQLite databases in **read-only** mode.
- Reads only a bounded tail of local session event metadata.
- Returns sanitized identifiers and operational metadata—not prompts, chat messages, secrets, tool arguments, or repository file contents.
- Uses project names, repository labels, and session-type metadata without returning raw machine paths or session titles.
- Binds its renderer server to `127.0.0.1` only.
- Requires an unguessable per-canvas bootstrap token, then stores it in an `HttpOnly`, `SameSite=Strict` cookie.
- Rejects non-loopback hosts, cross-site requests, oversized request bodies, and unexpected refresh payloads.
- Uses a restrictive Content Security Policy and loads no CDN assets.
- Has zero runtime npm dependencies and makes no external network requests.

The inspector reports when a local data source is unavailable and the resulting status or relationship information is partial.

## Install

The stable extension folder URL is:

```text
https://github.com/shanselman/agent-constellation/tree/main/.github/extensions/agent-constellation
```

### User scope

User scope makes the extension available across your Copilot projects.

1. Open the GitHub Copilot command palette.
2. Search for **Install extension**.
3. Choose user scope.
4. Paste the repository folder URL above.

You can also ask Copilot naturally:

> Install the Agent Constellation extension at user scope from https://github.com/shanselman/agent-constellation/tree/main/.github/extensions/agent-constellation

### Project scope

Project scope commits the extension under a repository's `.github/extensions/` directory so everyone using that project can discover it. Install the same folder URL and choose project scope, or copy the `agent-constellation` folder into:

```text
.github/extensions/agent-constellation/
```

A project-scoped extension with the same name takes precedence over a user-scoped installation.

## Use

Start from a Copilot project session, then ask:

> Open Agent Constellation

Copilot opens the canvas for the current session family. You can also request an initial filter:

> Open Agent Constellation filtered to busy sessions.

Scope is contextual and explicit:

```json
{ "scope": "tree" }
```

is the backward-compatible default for individual-session views.

```json
{ "scope": "all" }
```

opens the cross-project overview, such as from My Copilot home. A project-scoped caller can combine `scope: "all"` with a safe project identifier/name and/or repository filter:

```json
{ "scope": "all", "project": "agent-constellation", "repository": "shanselman/agent-constellation" }
```

Project identifiers and names resolve case-insensitively. When a stable project ID is available, the canvas keeps that ID for later refreshes so a friendly-name change does not broaden the view. Unknown, deleted, or ambiguous project names fail closed to an empty scoped state; they never reset to **All projects**. The same resolver is used by the open input, in-canvas project selector, refresh/SSE state, and the `get_state` action's additive `project` filter.

When a retained project's recorded parent belongs to another project, the real `parentId` remains unchanged for diagnostics, while the filtered view adds an explicit synthetic containment connection to its retained overview root. This keeps every selected session—including attention states—reachable in both horizontal and vertical layouts without inventing lineage. A server-scoped project canvas disables the misleading **All projects** choice because clearing a client-side selector cannot widen its server-enforced boundary.

The extension does not infer a new default from where it happens to be opened; callers should provide explicit scope and project/repository context when available.

For an explicit local-model UI demonstration:

> Open Agent Constellation with `demoLocalModel` set to `true`.

### Controls and gestures

- **Refresh** reloads local session metadata.
- **View** switches only the current canvas between **Tree** and **All sessions**.
- **Current** centers the current session.
- **Width** fits the tree to a readable minimum card scale.
- **+ / -** zooms.
- **Filter** narrows by status, project, or repository.
- **Click or press Enter/Space** on a session to open its inspector.
- **Arrow keys** move focus directionally between session cards.
- **Click the Completed or Archived shelf** to expand or collapse those descendants.
- **Drag empty canvas space** to pan.
- **Pinch** with two touch or pointer contacts to zoom and pan around the moving midpoint.
- **Ctrl + wheel** zooms around the pointer.
- **Double-click empty canvas space** to zoom in.
- **Escape** closes the inspector.

Animations honor `prefers-reduced-motion`; no completion confetti or persistent success animation is used, so completed work remains calm in large constellations.

## Update or reinstall

Re-run the install flow with the same repository folder URL to fetch the latest version. If the extension is already loaded, reload extensions or begin a new Copilot session so discovery uses the updated files.

If you have both user- and project-scoped copies, update the project copy first because it shadows the user copy for that repository.

## Architecture

The installable extension lives entirely in [`.github/extensions/agent-constellation/`](.github/extensions/agent-constellation/):

| File | Responsibility |
|---|---|
| `extension.mjs` | Declares the canvas, open schema, actions, and lifecycle with the Copilot SDK. |
| `data.mjs` | Reads local sources, derives statuses and relationships, sanitizes project/session metadata, normalizes tree/all scopes, filters state, and isolates demo decoration. |
| `layout.mjs` | Produces deterministic bounded-stack/horizontal layouts, density-aware orientation, attention-first ordering, completed/archived shelves, shared card-marker slots, meaningful-change summaries, explicit synthetic containment, model labels, fit scaling, and pinch transforms. |
| `renderer.mjs` | Generates the accessible, right-pane-first, theme-aware canvas UI and per-view scope/project/repository controls. |
| `server.mjs` | Hosts the token-protected loopback page, JSON state, per-instance scope endpoint, refresh endpoint, and SSE stream. |
| `agent-constellation.test.mjs` | Covers multi-project collection, sanitization, identity labels, real/synthetic relationships, scope isolation, responsive layout, gestures, local-model semantics, renderer accessibility, and loopback protections. |
| `copilot-extension.json` | Identifies the folder as a shareable/installable Copilot extension. |

### Local data sources

When present under `COPILOT_HOME` (normally `~/.copilot`), the extension combines:

- `data.db` for project-session, workspace, relationship, activity, model, and reasoning metadata
- `session-store.db` for repository, branch, and reference fallbacks
- `session-state/<session-id>/events.jsonl` for bounded operational timing and human-gate inference

The extension tolerates missing tables, columns, databases, and event files. It degrades to the metadata that is available and reports limitations in the canvas.

## Limitations

- Agent Constellation visualizes recorded **Copilot app sessions**. In-process task subagents are not separate app sessions and therefore do not appear as individual cards.
- The default remains the current session's accessible ancestor/descendant tree. Unrelated sessions appear only when `scope: "all"` is explicitly requested or selected in that canvas.
- Synthetic all-sessions containment communicates display grouping only; it cannot recover lineage missing from local relationship metadata.
- Project and relationship metadata can be partial for older or evolving app schemas. Diagnostics identify those limitations rather than guessing.
- Copilot's local app data schema can evolve. The collector uses guarded reads and fallbacks, but a future schema change may temporarily reduce available metadata.
- Statuses are inferred from local app state and recent event metadata; unavailable sources reduce precision.
- Local-model classification requires explicit provider or runtime-prefixed model metadata.
- The canvas is a local operational view, not a durable historical analytics store.
- Canvas extensions require a GitHub Copilot build with extension canvas support.

## Development

Requirements:

- Node.js 24 (Node.js 22.5 or newer is required for `node:sqlite`)
- npm
- Git

Install development dependencies and run every check:

```console
npm ci
npm run check
```

Individual commands:

```console
npm test
npm run check:types
npm run check:syntax
npm run check:diff
```

The TypeScript check compiles a small SDK contract fixture so changes to canvas declarations, action handlers, or open/close callback types fail early. The implementation modules are also parsed with `node --check` and exercised through the Node test suite.

To exercise the extension in this repository, reload Copilot extensions, open **Agent Constellation**, invoke its `refresh` and `get_state` actions, and verify invalid open/action inputs are rejected by the SDK schema.

The extension intentionally has **no runtime dependencies**. Keep renderer assets self-contained, use the documented canvas theme tokens, and preserve the loopback, token, sanitization, and read-only database guarantees.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Focused bug fixes, compatibility improvements, accessibility work, tests, and carefully bounded visualization enhancements are welcome.

## Roadmap

Potential future work, guided by stable Copilot data surfaces:

- Additional relationship and attention cues without increasing visual noise
- More compact controls for very narrow panes
- Optional snapshot/export workflows that preserve the privacy model
- Compatibility updates as public session metadata evolves

## Provenance

The initial public `v1.0.0` implementation was imported byte-for-byte from `shanselman/hanselprojects` at merge commit [`c4142fa`](https://github.com/shanselman/hanselprojects/commit/c4142fa35870550d2d7776a30d2e3f95162c1dcf), then packaged here with public documentation, checks, and release metadata.

## License

[MIT](LICENSE)
