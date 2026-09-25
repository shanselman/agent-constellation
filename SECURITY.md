# Security

## Reporting a vulnerability

Please report suspected vulnerabilities through this repository's **Security** tab using a private vulnerability report. Do not open a public issue for an unpatched vulnerability or include user data, tokens, prompts, messages, or local database contents in a report.

Include the affected version, reproduction steps, expected impact, and the smallest safe proof of concept you can provide. Maintainers will acknowledge the report and coordinate a fix and disclosure when appropriate.

## Security boundaries

Agent Constellation reads local Copilot metadata and serves a local canvas. Changes must preserve read-only database access, bounded event reads, metadata sanitization, loopback-only binding, per-canvas authentication, same-site request checks, a restrictive Content Security Policy, and zero runtime network dependencies.
