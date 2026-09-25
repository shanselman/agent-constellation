# Contributing to Agent Constellation

Thanks for helping improve Agent Constellation.

## Before you start

- Use Node.js 24. Node.js 22.5 or newer is required for `node:sqlite`.
- Keep changes focused and include tests for behavior changes.
- Preserve zero runtime dependencies.
- Preserve read-only data access, metadata sanitization, loopback-only hosting, per-canvas tokens, same-site request checks, and the restrictive Content Security Policy.
- Do not add telemetry or external network requests.

## Set up

```console
npm ci
npm run check
```

`npm run check` runs module syntax checks, a TypeScript SDK contract check, the Node test suite, and Git whitespace checks.

## Extension development

The installable extension is `.github/extensions/agent-constellation/`. Keep `extension.mjs` focused on Copilot SDK wiring and place collection, layout, rendering, and server behavior in the existing sibling modules.

After changing extension code:

1. Reload Copilot extensions.
2. Open Agent Constellation from a project session.
3. Verify the `refresh` and `get_state` actions.
4. Check wide and narrow/tall layouts.
5. Exercise search, lineage focus and reset, keyboard navigation, pan, wheel zoom, pinch zoom, filters, the inspector, and the completed shelf as applicable.
6. Run `npm run check`.

## Pull requests

Describe the user-visible problem, the chosen fix, privacy or compatibility implications, and the validation performed. Screenshots are useful for visual changes.

By participating, you agree that your contributions are licensed under the repository's MIT License.
