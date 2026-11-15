# Plan: claude-harness-map v0.1

Status: in progress, 2026-11-14.

## Goal

Answer "what is in Claude Code's context before I type, and where did each piece come from?" as an interactive 3D map that anyone can run on their own machine.

## Why two data sources

Config files alone undercount badly. On the author's machine, files on disk came to about 8k tokens and config named 2 MCP servers, while the first turn of a real session was about 108k tokens across about 20 servers. Session transcripts (`~/.claude/projects/<key>/*.jsonl`) record what was actually injected: `instructions`, `skill_listing`, `deferred_tools_delta`, `mcp_instructions_delta`, `output_style_instructions`, and the first assistant turn's `usage`. The transcript format is internal and undocumented, so the scanner treats every field as optional.

## Shape

- `scan.mjs`: zero-dependency Node script. Reads config (managed, user, project, local scopes) plus the newest transcript for the project, writes `out/snapshot.json` and `out/harness-map.html` (viewer with the snapshot inlined, so it opens from `file://`).
- `viewer/index.html`: one static page, `3d-force-graph` from a pinned CDN URL, no build step.
- `demo/snapshot.json`: synthetic fixture for the README and GitHub Pages.

## Model

Each node: `id, label, kind, scope, load, tokens, source, detail`.

- **scope** (vertical floor): managed, user, project, local, session.
- **load** (ring radius): `always` (inner), `on_demand` (middle: path-scoped rules, memory files, skill bodies), `deferred` (outer: tool names only until searched).
- **tokens**: chars / 4 estimate. The gap between the transcript's first-turn total and the summed estimates becomes one `harness` node (system prompt, tool schemas).
- Edges: plugin to the servers and skills it provides, server to its tool group, memory index to memory files.

A flat stacked bar of token cost by load state sits above the 3D view, since 3D is poor at comparing quantities.

## Privacy rules (public tool)

- Allowlist only: names, sizes, scopes, counts. Never file contents, env values, permission rules or full hook commands (basename only).
- `~/.claude.json` holds tokens and history: read only `mcpServers` and `projects[<path>].mcpServers` keys.
- `out/` is gitignored. The README and Pages demo use the synthetic fixture only.
- No hardcoded user paths. Project key = absolute path with `/` and `.` replaced by `-`. A worktree's memory resolves to its primary checkout.

## Out of v0.1

Live watching, session timeline replay, `@import` resolution in CLAUDE.md, a `--redact` mode for shareable screenshots.
