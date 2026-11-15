// A made-up Codex setup for the demo page: realistic sizes, invented names. make-demo.mjs scans it
// with the real Codex adapter, so the demo always shows what the scanner produces today.
import fs from "node:fs";
import path from "node:path";

export function makeCodexHome(home) {
const project = path.join(home, "dev", "acme-shop"), codex = path.join(home, ".codex");
const w = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const para = (n) => ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ").repeat(n);
w(path.join(codex, "config.toml"), [
  'model = "gpt-demo"', 'model_reasoning_effort = "medium"',
  `[projects."${project}"]`, 'trust_level = "trusted"',
  '[mcp_servers.github]', 'url = "https://api.example.com/mcp"',
  '[mcp_servers.postgres]', 'command = "npx"', 'args = ["pg-mcp"]',
  '[mcp_servers.browser]', 'command = "npx"', 'args = ["browser-mcp"]',
  '[mcp_servers.tracing]', 'command = "npx"', 'args = ["mcp-remote", "https://tracing.example.com/mcp"]',
  '[mcp_servers.old-search]', 'command = "search-mcp"', 'enabled = false',
  ...["design-kit", "data-tools", "docs-helper", "release-bot"].flatMap((p) => [`[plugins."${p}@market"]`, "enabled = true"]), ""].join("\n"));
w(path.join(codex, "AGENTS.md"), "# Personal\n\n## Style\n" + para(20) + "\n## Git\n" + para(10));
w(path.join(codex, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] } }));
w(path.join(project, "AGENTS.md"), "# Acme shop\n\n## Setup\n" + para(30) + "\n## Testing\n" + para(40) + "\n## Deploy\n" + para(20));
w(path.join(project, "web", "AGENTS.md"), "# Frontend\n\n" + para(25));
w(path.join(project, ".codex", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "./scripts/lint.sh" }] }] } }));
const userSkills = ["release-notes", "pr-review", "changelog", "triage", "screenshot"], repoSkills = ["db-migrate", "seed-data"];
for (const s of userSkills) w(path.join(home, ".agents", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s} helper\n---\n` + para(40));
for (const s of repoSkills) w(path.join(project, ".agents", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: ${s}\n---\n` + para(30));
const roots = [["r0", `${home}/.agents/skills`], ["r1", `${codex}/skills/.system`], ["r2", `${codex}/plugins/cache/market/design-kit/1.0.0/skills`], ["r3", `${codex}/plugins/cache/market/data-tools/1.0.0/skills`], ["r4", `${project}/.agents/skills`]];
const entry = (r, n) => `- ${n}: ${"Does a useful thing for the user when asked about it. ".repeat(3)} (file: ${r}/${n}/SKILL.md)`;
const entries = [...userSkills.map((n) => entry("r0", n)), ...["imagegen", "skill-creator", "openai-docs"].map((n) => entry("r1", n)),
  ...Array.from({ length: 14 }, (_, i) => entry("r2", `design-kit:skill-${i}`)), ...Array.from({ length: 9 }, (_, i) => entry("r3", `data-tools:skill-${i}`)), ...repoSkills.map((n) => entry("r4", n))];
const skillsText = `<skills_instructions>\n## Skills\n${para(6)}\n### Skill roots\n${roots.map(([r, d]) => `- \`${r}\` = \`${d}\``).join("\n")}\n### Available skills\n${entries.join("\n")}\n</skills_instructions>`;
const agentsText = `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${fs.readFileSync(path.join(codex, "AGENTS.md"), "utf8")}\n${fs.readFileSync(path.join(project, "AGENTS.md"), "utf8")}\n</INSTRUCTIONS>`;
const msg = (role, text) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const lines = [
  { type: "session_meta", payload: { cwd: project, originator: "codex_exec", base_instructions: { text: para(380) } } },
  msg("developer", skillsText), msg("developer", "<permissions instructions>\n" + para(5) + "\n</permissions instructions>"),
  msg("developer", "<collaboration_mode>" + para(18) + "</collaboration_mode>"), msg("developer", "<multi_agent_role>" + para(40) + "</multi_agent_role>"),
  msg("user", agentsText), msg("user", `<environment_context>\n  <cwd>${project}</cwd>\n</environment_context>`),
  { type: "turn_context", payload: { model: "gpt-demo", effort: "medium" } }, msg("user", "hello"),
  { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 21400, cached_input_tokens: 12800 }, model_context_window: 258400 } } },
];
w(path.join(codex, "sessions", "2026", "11", "14", "rollout-2026-11-14T09-00-00-demo.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
return project;
}
