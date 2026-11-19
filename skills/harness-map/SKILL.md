---
name: harness-map
description: Draws a 3D map of what Claude Code or Codex loads into context on the first turn (CLAUDE.md, rules, memory, skills, plugins, MCP servers and the harness itself) and where each piece comes from. Use when the user asks what is in their context, why the first turn is so big, what a plugin or MCP server adds, or to map their setup.
argument-hint: "[serve | share]"
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --project "$PWD" --out "$HOME/.claude-harness-map/out" --open)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --project "$PWD" --out "$HOME/.claude-harness-map/out" --serve)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --project "$PWD" --out "$HOME/.claude-harness-map/out" --open --share)
---

# Harness map

A bundled scanner reads this machine's Claude Code and Codex setup and session logs, and writes an interactive page. It reads only; it changes no setting. Run it as:

```
node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --project "$PWD" --out "$HOME/.claude-harness-map/out" --open
```

Run these commands exactly as written, with no other flags: they are the only ones the skill runs without asking. The `--out` matters: the scanner's default writes into the current project. The user asked for: $ARGUMENTS

- **No arguments:** run the command above. It prints a short summary and opens the map in the browser. Tell the user the first-turn total and the two or three biggest pieces from the summary, in a sentence or a short list, and that the map is open.
- **serve:** run this, in the background:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --project "$PWD" --out "$HOME/.claude-harness-map/out" --serve
  ```

  It keeps running and opens the map in the browser, with a Rescan button and a project picker. The address it prints holds a private key: never repeat it in your reply. Say the map is open and how to stop it (stop the background command).
- **share:** run this:

  ```
  node "${CLAUDE_PLUGIN_ROOT}/scan.mjs" --project "$PWD" --out "$HOME/.claude-harness-map/out" --open --share
  ```

  It writes `harness-map-shared.html` beside the map, with names, headings and paths replaced by placeholders, so it is safe to post. Give the user that file's path, and say never to share the snapshot JSON files next to it.

Answer questions about the map from the summary and the page; do not change the user's settings, CLAUDE.md or plugins unless they ask.
