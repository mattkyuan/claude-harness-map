// Builds demo/snapshot.json: a made-up but realistic setup for the README and
// GitHub Pages, with both harnesses so the page shows the Viewing switch. Nothing here comes from a real machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeCodexHome } from "./make-codex-home.mjs";
// Synthetic per-turn input for "Play the session": 40 prompts, the conversation growing a few thousand tokens a
// turn, one compaction at turn 28. Seeded, so the demo is the same on every build.
function demoTurns(setup) {
  let seed = 7, conv = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 40 }, (_, i) => {
    if (i === 0) return [3, setup - 3, 0];
    if (i === 27) conv = 9000;
    const fresh = Math.round(800 + rnd() * 5200);
    conv += fresh;
    return [3, fresh, setup + conv - fresh - 3];
  });
}


const HERE = path.dirname(fileURLToPath(import.meta.url));
const nodes = [], edges = [];
const add = (n) => { nodes.push({ tokens: 0, detail: {}, ...n }); return n.id; };
const link = (from, to, kind) => edges.push({ from, to, kind });

// user scope
const us = add({ id: "settings:user", label: "settings.json", kind: "settings", scope: "user", load: "config", source: "~/.claude/settings.json", detail: { allowRules: 12, denyRules: 2 } });
add({ id: "claudemd:user", label: "CLAUDE.md", kind: "claude_md", scope: "user", load: "always", tokens: 620, source: "~/.claude/CLAUDE.md", detail: { confirmedInSession: true } });
const mi = add({ id: "memory:index", label: "MEMORY.md", kind: "memory_index", scope: "user", load: "always", tokens: 410, source: "~/.claude/projects/-home-dev-acme-shop/memory/MEMORY.md" });
link(mi, add({ id: "memory:files", label: "unlinked memory files (9)", kind: "memory_files", scope: "user", load: "on_demand", tokens: 4100, source: "~/.claude/projects/-home-dev-acme-shop/memory", detail: { count: 9 } }), "indexes");
// MEMORY.md links to topic files and hubs; hubs link on. Each file hangs off the first file that links to it.
const memTree = [["hub_release.md", "memory:index", 300], ["deploy_checklist.md", "hub_release.md", 1100], ["release_process.md", "hub_release.md", 720],
  ["flaky_tests.md", "hub_release.md", 640], ["hub_api.md", "memory:index", 260], ["api_error_codes.md", "hub_api.md", 860], ["customer_tiers.md", "hub_api.md", 480],
  ["style_decisions.md", "memory:index", 420], ["oncall_notes.md", "memory:index", 380]];
for (const [nm, from, tokens] of memTree) {
  const parent = from.startsWith("memory:") ? from : `memory:file:${from}`;
  link(parent, add({ id: `memory:file:${nm}`, label: nm, kind: "memory_file", scope: "user", load: "on_demand", tokens, source: `~/.claude/projects/-home-dev-acme-shop/memory/${nm}`, parent }), "links to");
}
link(us, add({ id: "hook:user:pre", label: "PreToolUse [Bash]: guard.sh", kind: "hook", scope: "user", load: "runtime", source: "~/.claude/settings.json", detail: { event: "PreToolUse", matcher: "Bash" } }), "registers");

const plugins = { "frontend-design": ["frontend-design"], "playwright": [], "docs-helper": ["write-docs", "release-notes"] };
for (const [p, skills] of Object.entries(plugins)) {
  const pid = add({ id: `plugin:${p}`, label: p, kind: "plugin", scope: "user", load: "config", source: "~/.claude/settings.json", detail: { version: "1.0.0" } });
  link(us, pid, "enables");
  for (const s of skills) link(pid, add({ id: `skill:${p}:${s}`, label: `${p}:${s}`, kind: "skill", scope: "user", load: "on_demand", tokens: 1800 + s.length * 90, source: `~/.claude/plugins/cache/${p}/skills/${s}/SKILL.md` }), "provides");
}
add({ id: "skill:user:tdd", label: "test-driven-development", kind: "skill", scope: "user", load: "on_demand", tokens: 2400, source: "~/.claude/skills/test-driven-development/SKILL.md" });

// project scope
const ps = add({ id: "settings:project", label: "settings.json", kind: "settings", scope: "project", load: "config", source: "~/dev/acme-shop/.claude/settings.json" });
add({ id: "claudemd:project", label: "CLAUDE.md", kind: "claude_md", scope: "project", load: "always", tokens: 2900, source: "~/dev/acme-shop/CLAUDE.md", detail: { confirmedInSession: true } });
for (const [r, t, scoped] of [["api.md", 700, true], ["frontend.md", 520, true], ["style.md", 260, false]])
  add({ id: `rule:${r}`, label: r, kind: "rule", scope: "project", load: scoped ? "on_demand" : "always", tokens: t, source: `~/dev/acme-shop/.claude/rules/${r}`, detail: { pathScoped: scoped } });
for (const c of ["ship", "review"]) add({ id: `command:${c}`, label: c, kind: "command", scope: "project", load: "on_demand", tokens: 450, source: `~/dev/acme-shop/.claude/commands/${c}.md` });
add({ id: "agent:reviewer", label: "reviewer", kind: "agent", scope: "project", load: "on_demand", tokens: 380, source: "~/dev/acme-shop/.claude/agents/reviewer.md" });
// References between text files: an @import (loaded with CLAUDE.md), plain-text mentions, and a markdown link.
link("claudemd:project", add({ id: "import:conventions", label: "conventions.md", kind: "claude_md", scope: "project", load: "always", tokens: 640, source: "~/dev/acme-shop/docs/conventions.md", detail: { where: "imported by CLAUDE.md" } }), "imports");
for (const [from, to, kind] of [["claudemd:project", "rule:api.md", "mentions"], ["claudemd:project", "command:ship", "mentions"], ["command:ship", "agent:reviewer", "mentions"], ["rule:frontend.md", "rule:style.md", "links to"]]) link(from, to, kind);
link(ps, add({ id: "hook:project:post", label: "PostToolUse [Edit|Write]: lint.sh", kind: "hook", scope: "project", load: "runtime", source: "~/dev/acme-shop/.claude/settings.json", detail: { event: "PostToolUse", matcher: "Edit|Write" } }), "registers");
add({ id: "mcp:postgres", label: "postgres", kind: "mcp_server", scope: "project", load: "config", source: "~/dev/acme-shop/.mcp.json", detail: { transport: "stdio" } });

// local scope
add({ id: "settings:local", label: "settings.local.json", kind: "settings", scope: "local", load: "config", source: "~/dev/acme-shop/.claude/settings.local.json", detail: { outputStyle: "Concise" } });
add({ id: "mcp:sentry", label: "sentry", kind: "mcp_server", scope: "local", load: "config", source: "~/.claude.json", detail: { transport: "http" } });

// session scope: what the transcript says was injected
add({ id: "session:skill_listing", label: "skill listing (18)", kind: "skill_listing", scope: "session", load: "always", tokens: 2100, source: "transcript", detail: { count: 18 } });
add({ id: "session:output_style", label: "output style: Concise", kind: "output_style", scope: "session", load: "always", tokens: 330, source: "transcript" });
const servers = { postgres: [9, 110], sentry: [22, 140], github: [41, 130], slack: [18, 120], playwright: [24, 100], "built-in": [14, 160] };
for (const [s, [count, per]] of Object.entries(servers)) {
  const gid = add({ id: `tools:${s}`, label: `${s} tools (${count})`, kind: "tool_group", scope: "session", load: "deferred", tokens: Math.round(count * per / 4), source: "transcript", detail: { count } });
  if (s === "built-in") continue;
  if (!nodes.some((n) => n.id === `mcp:${s}`)) add({ id: `mcp:${s}`, label: s, kind: "mcp_server", scope: "session", load: "config", source: "transcript", detail: { origin: "connector or plugin, not in config files", ...(s === "slack" ? { status: "needs auth" } : {}) } });
  link(`mcp:${s}`, gid, "exposes");
}
for (const [s, t] of [["sentry", 420], ["github", 610], ["playwright", 380]])
  link(`mcp:${s}`, add({ id: `mcpinstr:${s}`, label: `${s} instructions`, kind: "mcp_instructions", scope: "session", load: "always", tokens: t, source: "transcript" }), "injects");
link("plugin:playwright", "mcp:playwright", "provides");

const sum = (load) => nodes.filter((n) => n.load === load).reduce((a, n) => a + n.tokens, 0);
const firstTurn = 41200;
add({ id: "harness", label: "harness (system prompt, tool schemas)", kind: "harness", scope: "session", load: "always", tokens: firstTurn - sum("always") - sum("deferred"), source: "Claude Code", detail: { note: "First-turn total minus everything this map can attribute" } });

// Structure view: headings with section sizes, and the memory folder's biggest files.
const set = (id, k, v) => { nodes.find((n) => n.id === id)[k] = v; };
set("claudemd:project", "outline", [
  { level: 1, title: "acme-shop", tokens: 40 }, { level: 2, title: "Setup", tokens: 380 }, { level: 2, title: "Architecture", tokens: 720 },
  { level: 3, title: "API layer", tokens: 410 }, { level: 3, title: "Storefront", tokens: 290 }, { level: 2, title: "Testing", tokens: 560 },
  { level: 2, title: "Git conventions", tokens: 240 }, { level: 2, title: "Deploy", tokens: 260 },
]);
set("claudemd:user", "outline", [
  { level: 1, title: "Preferences", tokens: 20 }, { level: 2, title: "Response style", tokens: 310 }, { level: 2, title: "Commits", tokens: 290 },
]);
set("skill:user:tdd", "outline", [
  { level: 0, title: "(frontmatter)", tokens: 60 }, { level: 1, title: "Test-driven development", tokens: 120 }, { level: 2, title: "When to use", tokens: 400 },
  { level: 2, title: "Red, green, refactor", tokens: 1100 }, { level: 2, title: "Common mistakes", tokens: 720 },
]);
set("memory:files", "files", [
  ["db_migrations", 590], ["old_vendor_notes", 540], ["q3_retro", 510], ["perf_baseline", 470],
].map(([name, tokens]) => ({ name: name + ".md", tokens })));

// A previous scan, so "compare to last scan" has something to show.
const previous = {
  generatedAt: "2026-10-25T09:00:00.000Z", firstTurnTokens: 38900,
  nodes: Object.fromEntries(nodes
    .filter((n) => !["tools:sentry", "mcp:sentry", "mcpinstr:sentry", "rule:frontend.md"].includes(n.id))
    .map((n) => [n.id, { tokens: n.id === "claudemd:project" ? 2100 : n.id === "session:skill_listing" ? 2600 : n.tokens, label: n.label, kind: n.kind }])
    .concat([["rule:legacy.md", { tokens: 900, label: "legacy.md", kind: "rule" }]])),
};

const snapshot = {
  previous,
  version: 1, harness: { id: "claude-code", name: "Claude Code" }, generatedAt: "2026-11-01T09:00:00.000Z", project: "~/dev/acme-shop (demo data)", platform: "linux",
  session: { transcript: "demo", firstTurnTokens: firstTurn, model: "demo", turns: demoTurns(firstTurn), notes: ["Synthetic demo data"] },
  totals: { byLoad: { always: sum("always"), on_demand: sum("on_demand"), deferred: sum("deferred") }, nodes: nodes.length },
  nodes, edges,
};
// Codex: scan a made-up home with the real adapter, then pin the fields that vary from run to run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chm-demo-"));
let codex;
try {
  const project = makeCodexHome(tmp);
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
  delete env.CODEX_HOME;
  execFileSync(process.execPath, [path.join(HERE, "..", "scan.mjs"), "--harness", "codex", "--project", project, "--out", path.join(tmp, "out")], { env, stdio: "pipe" });
  codex = JSON.parse(fs.readFileSync(path.join(tmp, "out", "snapshot-codex.json"), "utf8"));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
Object.assign(codex, { generatedAt: snapshot.generatedAt, project: snapshot.project, platform: snapshot.platform });
Object.assign(codex.session, { transcript: "demo", startedAt: "2026-11-01T08:40:00.000Z", notes: [...(codex.session.notes || []), "Synthetic demo data"] });
if (JSON.stringify(codex).includes(tmp)) throw new Error("demo Codex snapshot still names the temp folder");

fs.writeFileSync(path.join(HERE, "snapshot.json"), JSON.stringify([snapshot, codex], null, 2));
console.log(`Demo: Claude Code ${nodes.length} nodes, ${edges.length} edges; Codex ${codex.nodes.length} nodes, ${codex.edges.length} edges`);
