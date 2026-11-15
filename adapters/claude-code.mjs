// Claude Code adapter: reads Claude Code's config scopes, memory, plugins and transcripts into the shared graph.
// Every harness adapter exports { id, name, scan }. scan() fills the graph and returns { session, byLoad }.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, tok, exists, size, readJson, ls, tilde, untilde, hookProgram, modelName } from "../lib/util.mjs";
import { runsFromConfig } from "../lib/mcp.mjs";
import { addRemainder } from "../lib/totals.mjs";

export const id = "claude-code";
export const name = "Claude Code";
// True when this machine has a Claude Code setup to map.
export const detect = () => exists(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"));
// Folders Claude Code was used in, with when: project paths from ~/.claude.json, dated by their newest session log.
export function recentProjects() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
  const paths = Object.keys(readJson(path.join(HOME, ".claude.json"))?.projects || {});
  const out = [];
  for (const dir of paths) {
    const logs = path.join(claudeDir, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    let at = 0;
    for (const e of ls(logs)) if (e.name.endsWith(".jsonl")) { try { at = Math.max(at, fs.statSync(path.join(logs, e.name)).mtimeMs); } catch {} }
    if (at) out.push({ dir, at });
  }
  return out;
}

// Auto memory belongs to one project but is stored in your home folder, outside the repo: drawn on the
// project floor and marked private to you.
const PRIVATE_MEMORY = { privateToYou: true, storedIn: "your home folder, not the repo" };

export async function scan({ projectDir, opt, graph }) {
const { nodes, edges, notes, ids, add, link } = graph;
// Settings files with permission rules, linked to the MCP servers those rules name once every server is on the map.
const permSources = [];
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
// The Claude desktop app's data folder, per platform (it holds extensions and app-synced skills).
const DESKTOP = process.platform === "darwin" ? path.join(HOME, "Library", "Application Support", "Claude")
  : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Claude")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "Claude");

const projectKey = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

// ---------- connector names ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTERS = new Set("A An The This These That Use Using When Before After If Do Don't Call Read Make Keep For Also Only Not Never Always Here There It Its You Your Each Every Once Then With Without Save Create Prefer Apply Start Otherwise Treat Rows Choose Set Note Return Returns MCP API URL ID IDs SQL HTTP JSON".split(" "));
const CATEGORIES = [
  ["Email", ["draft", "thread", "spam", "inbox", "reply", "forward"]],
  ["Calendar", ["calendar", "event", "events", "calendars"]],
  ["Drive", ["drive", "drives", "file", "files", "folder", "revisions"]],
  ["Papers", ["article", "articles", "citation", "pubmed", "journal"]],
  ["Chat", ["channel", "channels", "canvas", "dm"]],
  ["UI library", ["screens", "flows", "sections", "components"]],
];
const GENERIC = new Set("get list create update delete search find read write query batch add remove set send fetch save run by to of the for and with from id ids info details schema type types all".split(" "));
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function connectorName(tools, instructions) {
  // 1. Most tools share a product prefix: notion-search, slack_send_message.
  const firsts = tools.map((t) => t.split(/[-_]/)[0].toLowerCase());
  const counts = {};
  for (const f of firsts) counts[f] = (counts[f] || 0) + 1;
  const [topFirst, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  if (topFirst && tools.length >= 3 && topCount / tools.length >= 0.6 && topFirst.length > 2) return { name: titleCase(topFirst), from: "tool names" };
  // 2. Instructions open with "Name: ..." or keep naming the product.
  const body = instructions.replace(/^##[^\n]*\n/, "");
  const lead = body.match(/^([A-Z][\w.]*(?: [A-Z][\w.]*){0,2}):/);
  if (lead) return { name: lead[1], from: "instructions" };
  const caps = {};
  for (const w of body.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []) if (!STARTERS.has(w)) caps[w] = (caps[w] || 0) + 1;
  const [topCap, capCount] = Object.entries(caps).sort((a, b) => b[1] - a[1])[0] || [];
  if (topCap && capCount >= 2) return { name: topCap, from: "instructions" };
  // 3. What the tools do.
  const words = new Set(tools.flatMap((t) => t.toLowerCase().split(/[-_]/)));
  for (const [name, keys] of CATEGORIES) if (keys.filter((k) => words.has(k)).length >= 2) return { name, from: "tool vocabulary" };
  // 4. A non-generic word pair repeated across tools: query_open_targets_graphql.
  const pairs = {};
  for (const t of tools) {
    const w = t.toLowerCase().split(/[-_]/);
    for (let i = 0; i + 1 < w.length; i++) if (!GENERIC.has(w[i]) && !GENERIC.has(w[i + 1])) pairs[`${w[i]} ${w[i + 1]}`] = (pairs[`${w[i]} ${w[i + 1]}`] || 0) + 1;
  }
  const [topPair, pairCount] = Object.entries(pairs).sort((a, b) => b[1] - a[1])[0] || [];
  if (topPair && pairCount >= 3) return { name: topPair.split(" ").map(titleCase).join(" "), from: "tool names" };
  return null;
}

function git(...a) {
  try { return execFileSync("git", ["-C", projectDir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
// A linked worktree shares memory with its primary checkout.
function primaryCheckout() {
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return projectDir;
  return path.basename(common) === ".git" ? path.dirname(common) : projectDir;
}

// Provenance: pieces that came with a plugin carry its name ("engineering:debug",
// "plugin:engineering:slack"). Link each one to its plugin, creating a node for plugins the
// desktop app or claude.ai installed, which Claude Code's own config does not list.
function pluginNode(short) {
  const existing = nodes.find((n) => n.kind === "plugin" && (n.label === short || n.id === `plugin:${short}`));
  if (existing) return existing.id;
  return add({ id: `plugin:${short}`, label: short, kind: "plugin", scope: "session", load: "config", source: "desktop app or claude.ai",
    detail: { origin: "installed outside Claude Code's config (desktop app or claude.ai)" } });
}
function linkPlugins(skills) {
  const fromServer = (id) => /^mcp:plugin:([^:]+):/.exec(id)?.[1];
  for (const n of [...nodes]) {
    const p = n.kind === "mcp_server" ? fromServer(n.id)
      : ["skill", "command", "agent"].includes(n.kind) && n.scope === "session" && n.label.includes(":") ? n.label.split(":")[0] : null;
    if (!p) continue;
    const pid = pluginNode(p);
    if (!edges.some((e) => e.from === pid && e.to === n.id)) link(pid, n.id, "provides");
  }
  // Skills the session listed but that are not files here: count them, and their share of the listing, per plugin.
  const byPlugin = new Map();
  for (const nm of skills.names || []) {
    if (!nm.includes(":")) continue;
    const p = nm.split(":")[0];
    let v = byPlugin.get(p); if (!v) byPlugin.set(p, (v = { names: [], chars: 0 }));
    v.names.push(nm);
    v.chars += (Object.hasOwn(skills.perName || {}, nm) && skills.perName[nm]) || 0;
  }
  for (const [p, v] of byPlugin) {
    const pid = pluginNode(p), pn = nodes.find((n) => n.id === pid);
    pn.detail = { ...pn.detail, listedSkills: v.names.length, listingTokens: tok(v.chars) };
    link(pid, "session:skill_listing", `adds ${v.names.length} skills to`);
  }
}
function linkReferences() {
  const TEXT = new Set(["claude_md", "rule", "skill", "command", "agent", "output_style", "memory_index", "memory_file"]);
  const abs = (p) => (p && p.startsWith("~") ? HOME + p.slice(1) : p);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const byFile = new Map();
  for (const n of nodes) { const r = TEXT.has(n.kind) && real(abs(n.source)); if (r) byFile.set(r, n.id); }
  const have = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const edge = (from, to, kind) => { const k = `${from}>${to}`; if (from !== to && !have.has(k)) { have.add(k); link(from, to, kind); } };
  const strip = (t) => t.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const resolve = (from, p) => real(p.startsWith("~/") ? path.join(HOME, p.slice(2)) : path.resolve(path.dirname(from), p));
  // Imports are followed only inside the project and the Claude config folder, and big files are not read.
  const roots = [real(projectDir), real(CLAUDE)].filter(Boolean).map((r) => r + path.sep);
  const inRoots = (t) => roots.some((r) => t.startsWith(r));
  const MAX_READ = 2 * 1024 * 1024;
  const queue = nodes.filter((n) => TEXT.has(n.kind)).map((n) => [n, 0]);
  let visits = 0;
  while (queue.length && visits++ < 5000) {
    const [n, depth] = queue.shift();
    const file = real(abs(n.source));
    if (!file || !fs.statSync(file).isFile() || fs.statSync(file).size > MAX_READ) continue;
    let txt; try { txt = strip(fs.readFileSync(file, "utf8")); } catch { continue; }
    let repoRefs = 0;
    // @imports: CLAUDE.md files and what they import, up to Claude Code's five hops.
    if (["claude_md", "memory_index"].includes(n.kind)) {
      for (const m of txt.matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/)?[\w.\-\/]+)/g)) {
        const t = resolve(file, m[1]);
        if (!t || !inRoots(t) || !/\.md$/i.test(t) || !fs.statSync(t).isFile()) continue;
        let id = byFile.get(t);
        if (!id && depth < 5) {
          id = add({ id: `import:${t}`, label: path.basename(t), kind: "claude_md", scope: n.scope, load: n.load, tokens: tok(size(t)), source: t, detail: { where: `imported by ${n.label}` } });
          byFile.set(t, id);
          queue.push([nodes[nodes.length - 1], depth + 1]);
        }
        if (id) edge(n.id, id, "imports");
      }
    }
    for (const m of txt.matchAll(/\]\(([^)\s]+?)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue; // web and other URLs
      let p; try { p = decodeURIComponent(m[1]); } catch { continue; }
      const t = resolve(file, p);
      if (!t) continue;
      const id = byFile.get(t);
      if (id) edge(n.id, id, "links to");
      else if (t.startsWith(projectDir + path.sep)) repoRefs++;
    }
    if (repoRefs) n.detail = { ...n.detail, repoFilesLinked: repoRefs };
  }
  // Plain-text mentions: a file name that only one piece on the map has ("frontend.md"), or /name for a command or skill.
  const names = new Map(), slash = new Map();
  for (const n of nodes) {
    if (!TEXT.has(n.kind) || n.kind === "memory_file") continue;
    const b = path.basename(abs(n.source) || "");
    if (b.length >= 6 && b !== "SKILL.md") names.set(b, names.has(b) ? null : n.id);
    if (["command", "skill"].includes(n.kind)) slash.set(n.label, slash.has(n.label) ? null : n.id);
  }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = [...names].filter(([, id]) => id).map(([b, id]) => [new RegExp(`(^|[^\\w./-])${esc(b)}(?![\\w-])`), id]);
  const slashRe = [...slash].filter(([, id]) => id).map(([l, id]) => [new RegExp(`(^|[\\s\`(])/${esc(l)}(?![\\w:-])`), id]);
  for (const n of nodes) {
    if (!TEXT.has(n.kind)) continue;
    const f = real(abs(n.source));
    if (!f || size(f) > MAX_READ) continue;
    let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const [re, id] of [...nameRe, ...slashRe]) if (re.test(txt)) edge(n.id, id, "mentions");
  }
}
// Frontmatter "paths:" makes a rule load only when matching files are touched.
function hasPathsFrontmatter(file) {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 2000);
    const m = head.match(/^---\n([\s\S]*?)\n---/);
    return !!(m && /^paths\s*:/m.test(m[1]));
  } catch { return false; }
}

// ---------- config scopes ----------
const primary = primaryCheckout();
// True only when dir/.git is a plain file whose gitdir points into this repo's .git/worktrees.
function isOwnWorktree(dir) {
  try {
    const p = path.join(dir, ".git");
    if (!fs.lstatSync(p).isFile()) return false;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(p, "utf8"));
    if (!m) return false;
    const gitdir = fs.realpathSync(path.resolve(dir, m[1].trim()));
    return gitdir.startsWith(fs.realpathSync(path.join(primary, ".git", "worktrees")) + path.sep);
  } catch { return false; }
}
const scopes = {
  managed: process.platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32" ? "C:\\ProgramData\\ClaudeCode" : "/etc/claude-code",
  user: CLAUDE,
  project: path.join(projectDir, ".claude"),
};

function scanSettings(file, scope) {
  const s = readJson(file);
  if (!s) return;
  const id = add({
    id: `settings:${scope}:${path.basename(file)}`, label: path.basename(file), kind: "settings", scope,
    load: "config", source: file,
    detail: {
      allowRules: s.permissions?.allow?.length || 0,
      askRules: s.permissions?.ask?.length || 0,
      denyRules: s.permissions?.deny?.length || 0,
      envVars: s.env ? Object.keys(s.env).length : 0,
      affects: settingsAffects(s),
      rulesByTool: rulesByTool(s.permissions),
      outputStyle: typeof s.outputStyle === "string" ? (/^[\w .-]{1,40}$/.test(s.outputStyle) ? s.outputStyle : "custom style") : undefined,
      model: modelName(s.model) || undefined,
      autoCompactWindow: Number.isFinite(s.autoCompactWindow) ? s.autoCompactWindow : undefined,
    },
  });
  if (s.permissions) permSources.push({ id, perm: s.permissions });
  for (const [event, groups] of Object.entries(s.hooks || {})) {
    (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => {
      // Keep only the program name. Skip leading VAR=value assignments, which can carry secrets.
      const label = `${event}${g.matcher ? ` [${g.matcher}]` : ""}: ${h.command ? hookProgram(h.command) : String(h.type || "hook")}`;
      const hid = add({
        id: `hook:${scope}:${event}:${gi}:${hi}`, label, kind: "hook", scope, load: "runtime",
        source: file, detail: { event, matcher: g.matcher || "*", type: h.type },
      });
      link(id, hid, "registers");
    }));
  }
  for (const [name, on] of Object.entries(s.enabledPlugins || {})) {
    if (!on) continue;
    const pid = add({ id: `plugin:${name}`, label: name.split("@")[0], kind: "plugin", scope, load: "config", source: file, detail: { marketplace: name.split("@")[1] } });
    link(id, pid, "enables");
  }
}

// What a settings file changes, as counts, modes and tool names. Rule text (commands, paths, URLs), env names and
// values and helper commands never leave the file.
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
function ruleTool(rule) {
  const t = String(rule).split("(")[0].trim();
  if (t.startsWith("mcp__")) { const server = t.split("__")[1]; return server && TOOL_NAME.test(server) ? `MCP: ${server}` : "MCP"; }
  return TOOL_NAME.test(t) ? t : "other";
}
function rulesByTool(perm) {
  const by = {};
  for (const verdict of ["allow", "ask", "deny"]) for (const r of Array.isArray(perm?.[verdict]) ? perm[verdict] : []) {
    const t = ruleTool(r);
    (by[t] ||= { allow: 0, ask: 0, deny: 0 })[verdict]++;
  }
  const rows = Object.entries(by).sort((a, b) => (b[1].allow + b[1].ask + b[1].deny) - (a[1].allow + a[1].ask + a[1].deny));
  const fmt = ([t, c]) => `${t} (${["allow", "ask", "deny"].filter((v) => c[v]).map((v) => `${c[v]} ${v}`).join(", ")})`;
  return rows.length ? rows.slice(0, 12).map(fmt).concat(rows.length > 12 ? [`${rows.length - 12} more tools`] : []) : undefined;
}
// Values are written into the map only when they look like a mode or name: anything else could be text the user
// never meant to publish.
const SAFE_VALUE = /^[\w.\[\]-]{1,40}$/;
function settingsAffects(s) {
  const out = [], p = s.permissions || {}, n = (a) => (Array.isArray(a) ? a.length : 0);
  const rules = n(p.allow) + n(p.ask) + n(p.deny);
  if (rules) out.push(`Permission rules: ${n(p.allow)} allow, ${n(p.ask)} ask, ${n(p.deny)} deny. Allow skips the approval prompt, ask always prompts, deny blocks the tool call`);
  if (typeof p.defaultMode === "string" && SAFE_VALUE.test(p.defaultMode)) out.push(`Starts sessions in ${p.defaultMode} mode`);
  if (n(p.additionalDirectories)) out.push(`Lets the agent work in ${n(p.additionalDirectories)} folder${n(p.additionalDirectories) > 1 ? "s" : ""} outside the project`);
  if (p.disableBypassPermissionsMode) out.push("Turns off bypass-permissions mode");
  const hooks = Object.keys(s.hooks || {}).filter((k) => TOOL_NAME.test(k));
  if (hooks.length) out.push(`Runs hooks on ${hooks.join(", ")}`);
  const plugins = Object.values(s.enabledPlugins || {}).filter(Boolean).length;
  if (plugins) out.push(`Turns on ${plugins} plugin${plugins > 1 ? "s" : ""}`);
  if (s.enableAllProjectMcpServers === true) out.push("Approves every MCP server in the project's .mcp.json");
  if (n(s.enabledMcpjsonServers)) out.push(`Approves ${n(s.enabledMcpjsonServers)} project MCP server${n(s.enabledMcpjsonServers) > 1 ? "s" : ""}`);
  if (n(s.disabledMcpjsonServers)) out.push(`Turns off ${n(s.disabledMcpjsonServers)} project MCP server${n(s.disabledMcpjsonServers) > 1 ? "s" : ""}`);
  if (typeof s.model === "string" && SAFE_VALUE.test(s.model)) out.push(`Picks the model: ${s.model}`);
  if (typeof s.outputStyle === "string" && /^[\w .-]{1,40}$/.test(s.outputStyle)) out.push(`Picks the output style: ${s.outputStyle}`);
  if (s.env && Object.keys(s.env).length) out.push(`Sets ${Object.keys(s.env).length} environment variable${Object.keys(s.env).length > 1 ? "s" : ""} for the session and its tools`);
  if (s.sandbox?.enabled === true) out.push("Runs shell commands in a sandbox");
  if (s.statusLine) out.push("Draws a custom status line");
  if (s.apiKeyHelper) out.push("Gets the API key from a helper program");
  if (s.includeCoAuthoredBy === false || s.attribution) out.push("Changes commit attribution");
  if (Number.isFinite(s.cleanupPeriodDays)) out.push(`Keeps session logs ${s.cleanupPeriodDays} days`);
  return out.length ? out : undefined;
}

function scanClaudeMd(file, scope) {
  if (!exists(file)) return null;
  return add({ id: `claudemd:${file}`, label: path.basename(file), kind: "claude_md", scope, load: "always", tokens: tok(size(file)), source: file });
}

function scanRules(dir, scope) {
  for (const e of ls(dir)) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { scanRules(f, scope); continue; }
    if (!e.name.endsWith(".md")) continue;
    const scoped = hasPathsFrontmatter(f);
    add({ id: `rule:${f}`, label: e.name, kind: "rule", scope, load: scoped ? "on_demand" : "always", tokens: tok(size(f)), source: f, detail: { pathScoped: scoped } });
  }
}

function scanSkills(dir, scope, ns = "") {
  for (const e of ls(dir)) {
    const f = path.join(dir, e.name, "SKILL.md");
    if (!exists(f)) continue;
    const label = ns ? `${ns}:${e.name}` : e.name;
    add({ id: `skill:${scope}:${label}`, label, kind: "skill", scope, load: "on_demand", tokens: tok(size(f)), source: f });
  }
}

// Commands and agents can sit in subfolders; a command's subfolder becomes its namespace.
function scanMdDir(dir, scope, kind, prefix = "") {
  for (const e of ls(dir)) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { scanMdDir(f, scope, kind, `${prefix}${e.name}:`); continue; }
    if (!e.name.endsWith(".md")) continue;
    const label = prefix + e.name.replace(/\.md$/, "");
    add({ id: `${kind}:${scope}:${label}`, label, kind, scope, load: "on_demand", tokens: tok(size(f)), source: f });
  }
}

// Directories that never hold instructions worth mapping, or that duplicate the tree.
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", "dist", "build", "out",
  ".next", ".nuxt", ".svelte-kit", "target", "vendor", "coverage", ".cache", ".turbo", ".gradle", "Pods", "DerivedData"]);
const MAX_DIRS = 20000;

// CLAUDE.md files in parent directories load at startup; ones in subdirectories
// load when Claude reads files there. Walk both, since every repo is laid out differently.
function scanInstructionTree() {
  // Ancestors: from the project's parent up to (not including) the filesystem root.
  let dir = path.dirname(projectDir);
  while (dir !== path.dirname(dir)) {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
      const f = path.join(dir, name);
      if (exists(f) && f !== path.join(HOME, ".claude", "CLAUDE.md")) {
        add({ id: `claudemd:${f}`, label: `${tilde(dir)}/${name}`, kind: "claude_md", scope: name === "CLAUDE.local.md" ? "local" : "project", load: "always", tokens: tok(size(f)), source: f, detail: { where: "parent directory" } });
      }
    }
    dir = path.dirname(dir);
  }
  // Descendants: breadth-first, skipping dependency, build and worktree folders.
  const queue = [projectDir];
  let seen = 0;
  while (queue.length) {
    const d = queue.shift();
    if (++seen > MAX_DIRS) { notes.push(`Stopped crawling subfolders after ${MAX_DIRS} directories.`); break; }
    for (const e of ls(d)) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name === "worktrees" && path.basename(d) === ".claude") continue;
        // A linked worktree of THIS repo is another copy of this checkout: skip it, at any depth.
        if (isOwnWorktree(f)) continue;
        if (d !== projectDir && e.name === ".claude") {
          // Nested .claude folders in a monorepo package.
          const rel = path.relative(projectDir, d);
          scanSkills(path.join(f, "skills"), "project", rel);
          scanMdDir(path.join(f, "commands"), "project", "command", `${rel}:`);
          scanMdDir(path.join(f, "agents"), "project", "agent", `${rel}:`);
          scanRules(path.join(f, "rules"), "project");
          continue;
        }
        queue.push(f);
      } else if (d !== projectDir && (e.name === "CLAUDE.md" || e.name === "CLAUDE.local.md")) {
        const rel = path.relative(projectDir, f);
        add({ id: `claudemd:${f}`, label: rel, kind: "claude_md", scope: e.name === "CLAUDE.local.md" ? "local" : "project", load: "on_demand", tokens: tok(size(f)), source: f, detail: { where: "subfolder", note: "Loads when Claude reads files in this folder" } });
      }
    }
  }
}

function addMcp(name, cfg, scope, source) {
  return add({
    id: `mcp:${name}`, label: name, kind: "mcp_server", scope, load: "config", source,
    detail: { transport: cfg?.type || (cfg?.url ? "http" : "stdio"), ...runsFromConfig(cfg, "set in your config") },
  });
}
// Label every MCP server local, remote or unknown. Unknown stays unknown rather than a guess.
function classifyRuns() {
  const desk = DESKTOP;
  const deskCfg = readJson(path.join(desk, "claude_desktop_config.json"))?.mcpServers || {};
  const extNames = new Set();
  try {
    for (const d of fs.readdirSync(path.join(desk, "Claude Extensions"))) {
      const m = readJson(path.join(desk, "Claude Extensions", d, "manifest.json"));
      // Desktop extensions surface under their display name with spaces as underscores; match that exactly.
      if (m) for (const x of [m.name, m.display_name]) if (typeof x === "string") extNames.add(x.replace(/ /g, "_"));
    }
  } catch {}
  const pluginCfg = (plugin, server) => {
    const inst = readJson(path.join(CLAUDE, "plugins", "installed_plugins.json"))?.plugins || {};
    for (const [k, v] of Object.entries(inst)) {
      if (k.split("@")[0] !== plugin) continue;
      const ip = (Array.isArray(v) ? v[0] : v)?.installPath;
      const m = ip && readJson(path.join(ip, ".mcp.json"));
      const c = m && (m.mcpServers || m)[server];
      if (c) return c;
    }
    return null;
  };
  const BUILTIN = /^(ccd_|Claude_)|^(claude-in-chrome|computer-use|terminal|scheduled-tasks|mcp-registry|visualize)$/;
  for (const n of nodes) {
    if (n.kind !== "mcp_server" || n.detail?.runs) continue;
    const d = n.detail || (n.detail = {}), label = n.label, plug = /^plugin:([^:]+):(.+)$/.exec(label);
    let v = null;
    if (d.connectorId || UUID.test(label)) v = { runs: "remote", runsWhy: "claude.ai connector, hosted by its provider" };
    else if (plug && pluginCfg(plug[1], plug[2])) v = runsFromConfig(pluginCfg(plug[1], plug[2]), `plugin ${plug[1]}`);
    else if (Object.hasOwn(deskCfg, label)) v = runsFromConfig(deskCfg[label], "Claude desktop config");
    // Transcript evidence (a sign-in prompt) beats any guess from the name.
    else if (d.status === "needs auth") v = { runs: "remote", runsWhy: "asks you to sign in, which only remote servers do" };
    else if (!plug && extNames.has(label)) v = { runs: "local", runsWhy: "Claude desktop extension, runs on your machine" };
    else if (!plug && BUILTIN.test(label)) v = { runs: "local", runsWhy: "built into the Claude desktop app (judged by name)" };
    Object.assign(d, v || { runs: "unknown", runsWhy: "no config found that says where it runs" });
  }
}

// managed
scanSettings(path.join(scopes.managed, "managed-settings.json"), "managed");
scanClaudeMd(path.join(scopes.managed, "CLAUDE.md"), "managed");

// user
scanSettings(path.join(CLAUDE, "settings.json"), "user");
scanClaudeMd(path.join(CLAUDE, "CLAUDE.md"), "user");
scanRules(path.join(CLAUDE, "rules"), "user");
scanSkills(path.join(CLAUDE, "skills"), "user");
scanMdDir(path.join(CLAUDE, "agents"), "user", "agent");
scanMdDir(path.join(CLAUDE, "commands"), "user", "command");

// ~/.claude.json holds credentials and history: read only MCP server names.
const claudeJson = readJson(path.join(HOME, ".claude.json"));
for (const [n, c] of Object.entries(claudeJson?.mcpServers || {})) addMcp(n, c, "user", "~/.claude.json");
for (const [n, c] of Object.entries(claudeJson?.projects?.[projectDir]?.mcpServers || {})) addMcp(n, c, "local", "~/.claude.json");

// project + local
scanSettings(path.join(projectDir, ".claude", "settings.json"), "project");
scanSettings(path.join(projectDir, ".claude", "settings.local.json"), "local");
scanClaudeMd(path.join(projectDir, "CLAUDE.md"), "project");
scanClaudeMd(path.join(projectDir, ".claude", "CLAUDE.md"), "project");
scanClaudeMd(path.join(projectDir, "CLAUDE.local.md"), "local");
scanRules(path.join(projectDir, ".claude", "rules"), "project");
scanSkills(path.join(projectDir, ".claude", "skills"), "project");
scanMdDir(path.join(projectDir, ".claude", "agents"), "project", "agent");
scanMdDir(path.join(projectDir, ".claude", "commands"), "project", "command");
for (const [n, c] of Object.entries(readJson(path.join(projectDir, ".mcp.json"))?.mcpServers || {})) addMcp(n, c, "project", path.join(projectDir, ".mcp.json"));
scanInstructionTree();

// installed plugins (version info only)
const installed = readJson(path.join(CLAUDE, "plugins", "installed_plugins.json"))?.plugins || {};
for (const [name, entries] of Object.entries(installed)) {
  const e = Array.isArray(entries) ? entries[0] : entries;
  const id = `plugin:${name}`;
  if (!ids.has(id)) add({ id, label: name.split("@")[0], kind: "plugin", scope: ["managed", "user", "project", "local"].includes(e?.scope) ? e.scope : "user", load: "config", source: "~/.claude/plugins", detail: { enabled: false } });
  const n = nodes.find((x) => x.id === id);
  n.detail.version = e?.version;
  // Skills a plugin ships load their descriptions into the listing.
  if (e?.installPath) {
    for (const s of ls(path.join(e.installPath, "skills"))) {
      const f = path.join(e.installPath, "skills", s.name, "SKILL.md");
      if (!exists(f)) continue;
      const sid = add({ id: `skill:${name.split("@")[0]}:${s.name}`, label: `${name.split("@")[0]}:${s.name}`, kind: "skill", scope: n.scope, load: "on_demand", tokens: tok(size(f)), source: f });
      link(id, sid, "provides");
    }
  }
}

// auto memory: index always loaded, topic files on demand
const memDir = path.join(CLAUDE, "projects", projectKey(primary), "memory");
const memIndex = path.join(memDir, "MEMORY.md");
let memIndexId = null;
if (exists(memIndex)) {
  memIndexId = add({ id: "memory:index", label: "MEMORY.md", kind: "memory_index", scope: "project", load: "always", tokens: tok(size(memIndex)), source: memIndex, detail: { ...PRIVATE_MEMORY } });
  const all = ls(memDir).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md");
  const names = new Set(all.map((e) => e.name));
  // [[slug]] links name a file by its frontmatter name, or by its file name without .md.
  const bySlug = new Map();
  for (const e of all) {
    bySlug.set(e.name.slice(0, -3), e.name);
    try { const m = /^name:\s*["']?([^\s"']+)/m.exec(fs.readFileSync(path.join(memDir, e.name), "utf8").slice(0, 600)); if (m) bySlug.set(m[1], e.name); } catch {}
  }
  // Follow MEMORY.md's links, then the linked files' own links, both [text](file.md) and [[slug]]. Only file names are kept, never link text.
  // Each file hangs off the first file that links to it, so the viewer can unfold the tree one level at a time.
  const linksIn = (file) => {
    let txt = ""; try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
    const out = [];
    for (const m of txt.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
      const nm = path.basename(decodeURIComponent(m[1]));
      if (names.has(nm) && !out.includes(nm)) out.push(nm);
    }
    for (const m of txt.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const nm = bySlug.get(m[1].trim());
      if (nm && !out.includes(nm)) out.push(nm);
    }
    return out;
  };
  const reached = new Map(); // name -> node id
  const queue = [[memIndex, memIndexId]];
  while (queue.length && reached.size < 2000) {
    const [file, fromId] = queue.shift();
    for (const nm of linksIn(file)) {
      if (reached.has(nm)) { link(fromId, reached.get(nm), "links to"); continue; }
      const f = path.join(memDir, nm);
      const id = add({ id: `memory:file:${nm}`, label: nm, kind: "memory_file", scope: "project", load: "on_demand", tokens: tok(size(f)), source: f, parent: fromId, detail: { ...PRIVATE_MEMORY } });
      reached.set(nm, id);
      link(fromId, id, "links to");
      queue.push([f, id]);
    }
  }
  const files = all.filter((e) => !reached.has(e.name));
  // Files nothing links to: group them into one node so hundreds of tiny nodes do not drown the picture.
  const sized = files.map((e) => ({ name: e.name, tokens: tok(size(path.join(memDir, e.name))) })).sort((a, b) => b.tokens - a.tokens);
  const total = sized.reduce((a, f) => a + f.tokens * 4, 0);
  if (files.length) {
  const gid = add({
    id: "memory:files", label: `unlinked memory files (${files.length})`, kind: "memory_files", scope: "project", load: "on_demand",
    tokens: tok(total), source: memDir, detail: { count: files.length, linkedFromIndex: reached.size, note: "Read only when a task calls for them", ...PRIVATE_MEMORY },
    files: sized.slice(0, 40),
  });
  link(memIndexId, gid, "indexes");
  }
}

// ---------- session transcript ----------
function newestTranscript() {
  // The project's own folder plus folders for paths inside it (worktrees under .claude/worktrees and the like),
  // so a project worked on in worktrees is measured from its latest session, not an old one in the main checkout.
  const prefixes = [...new Set([projectKey(projectDir), projectKey(primary)])];
  const dirs = ls(path.join(CLAUDE, "projects")).filter((e) => e.isDirectory() && prefixes.some((p) => e.name === p || e.name.startsWith(p + "--"))).map((e) => path.join(CLAUDE, "projects", e.name));
  let best = null;
  for (const d of dirs) for (const e of ls(d)) {
    if (!e.name.endsWith(".jsonl")) continue;
    const f = path.join(d, e.name);
    const m = fs.statSync(f).mtimeMs;
    if (!best || m > best.m) best = { f, m };
  }
  return best?.f || null;
}

const transcript = opt("session", null) ? path.resolve(opt("session")) : newestTranscript();
const session = { transcript: tilde(transcript), firstTurnTokens: null, model: null, notes };

const SCOPE_OF_TYPE = { Managed: "managed", User: "user", AutoMem: "project", Project: "project", Local: "local" };
function scanTranscript(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const tools = new Map(); // name -> chars
  const mcpBlocks = new Map(); // server -> chars
  const pending = new Set(), needsAuth = new Set();
  const hookEvents = {};
  let skills = null, style = null, instr = null;
  let sawAssistant = false;
  // Input tokens of the first request after each prompt you typed: how the same setup is sent again every turn,
  // with the conversation growing behind it. Numbers only.
  const turns = [];
  let awaitingTurn = true;
  const isPrompt = (c) => typeof c === "string" || (Array.isArray(c) && c.some((b) => b?.type === "text") && !c.some((b) => b?.type === "tool_result"));
  for (const line of lines) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!session.startedAt && typeof r.timestamp === "string" && !Number.isNaN(Date.parse(r.timestamp))) session.startedAt = new Date(r.timestamp).toISOString();
    if (r.type === "user" && !r.isMeta && !r.isSidechain && isPrompt(r.message?.content)) awaitingTurn = true;
    if (r.type === "assistant" && !r.isSidechain && awaitingTurn && r.message?.usage && turns.length < 400) {
      const u = r.message.usage;
      turns.push([u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0]);
      awaitingTurn = false;
    }
    if (r.type === "assistant" && !sawAssistant && r.message?.usage) {
      const u = r.message.usage;
      session.firstTurnTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      // How much of the first request was already cached (identical prefix from an earlier request) versus new.
      session.firstTurnUsage = { uncached: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
      session.model = modelName(r.message.model);
      sawAssistant = true;
      continue;
    }
    const a = r.type === "attachment" ? r.attachment : null;
    if (!a) continue;
    if (a.type?.startsWith("hook")) { const ev = /^[A-Z][A-Za-z]{2,40}$/.test(a.hookEvent || "") ? a.hookEvent : "other"; hookEvents[ev] = (hookEvents[ev] || 0) + 1; }
    if (sawAssistant) continue; // everything below describes the first turn's context
    if (a.type === "instructions" && !instr) instr = (a.files || []).map((f) => ({ path: f.path, type: f.type, chars: (f.content || "").length }));
    if (a.type === "skill_listing" && !skills) {
      // Characters per skill, so a plugin's share of the listing can be measured. Only names are kept.
      const lines = String(a.content || "").split("\n"), names = Array.isArray(a.names) ? a.names.map(String) : [];
      const perName = Object.create(null);
      for (const nm of names) { const line = lines.find((l) => l.startsWith(`- ${nm}:`)); perName[nm] = line ? line.length + 1 : 0; }
      skills = { count: Number.isFinite(a.skillCount) ? a.skillCount : names.length, chars: (a.content || "").length, names, perName };
    }
    if (a.type === "output_style_instructions" && !style) style = { name: a.style?.name, chars: (a.style?.prompt || "").length };
    if (a.type === "deferred_tools_delta") {
      (a.addedNames || []).forEach((n, i) => tools.set(n, (a.addedLines?.[i] || n).length));
      (a.removedNames || []).forEach((n) => tools.delete(n));
      (a.pendingMcpServers || []).forEach((s) => pending.add(s));
      (a.needsAuthMcpServers || []).forEach((s) => needsAuth.add(s));
    }
    if (a.type === "mcp_instructions_delta") (a.addedNames || []).forEach((n, i) => mcpBlocks.set(n, a.addedBlocks?.[i] || ""));
  }
  return { tools, mcpBlocks, pending, needsAuth, skills, style, instr, hookEvents, turns };
}

if (transcript && exists(transcript)) {
  const t = scanTranscript(transcript);
  // Confirm which instruction files the harness actually injected.
  for (const f of t.instr || []) {
    const n = nodes.find((x) => x.id === `claudemd:${f.path}`) || nodes.find((x) => x.source === tilde(f.path));
    if (n) { n.tokens = tok(f.chars); n.detail.confirmedInSession = true; }
    // The session log says which layer each file belongs to (a project file loaded from a worktree is still Project).
    else add({ id: `claudemd:${f.path}`, label: path.basename(f.path), kind: "claude_md", scope: SCOPE_OF_TYPE[f.type] || "session", load: "always", tokens: tok(f.chars), source: f.path, detail: { type: f.type, confirmedInSession: true } });
  }
  // Parent-folder CLAUDE.md files the session did not load (for example above a
  // worktree) are on disk but not in context: trust the transcript over the walk.
  if (t.instr?.length) {
    const loaded = new Set(t.instr.map((f) => tilde(f.path)));
    for (const n of nodes) {
      if (n.kind === "claude_md" && n.load === "always" && !loaded.has(n.source)) {
        n.load = "on_demand";
        n.detail.loadedInSession = false;
        // A session in a worktree loads that checkout's copy of the same file.
        const copy = [...loaded].some((l) => l.startsWith(path.dirname(n.source) + "/.claude/worktrees/") && l.endsWith("/" + path.basename(n.source)));
        n.detail.note = copy ? "The last session ran in a worktree and loaded that checkout's copy instead" : "Found on disk, but the last session did not load it";
      }
    }
  }
  if (t.skills) session.skillsListed = t.skills;
  if (t.skills) add({ id: "session:skill_listing", label: `skill listing (${t.skills.count})`, kind: "skill_listing", scope: "session", load: "always", tokens: tok(t.skills.chars), source: transcript, detail: { count: t.skills.count, note: "Name and description of every skill, sent every session" } });
  if (t.style) add({ id: "session:output_style", label: `output style: ${t.style.name}`, kind: "output_style", scope: "session", load: "always", tokens: tok(t.style.chars), source: transcript });

  // Group deferred tools by MCP server (mcp__<server>__<tool>); others are built-in.
  const groups = new Map();
  for (const [name, chars] of t.tools) {
    const m = name.match(/^mcp__(.+?)__/);
    const g = m ? m[1] : "built-in";
    const cur = groups.get(g) || { count: 0, chars: 0 };
    cur.count++; cur.chars += chars;
    groups.set(g, cur);
  }
  for (const [g, v] of groups) {
    const server = g === "built-in" ? null : g;
    const gid = add({
      id: `tools:${g}`, label: `${g} tools (${v.count})`, kind: "tool_group", scope: "session", load: "deferred",
      tokens: tok(v.chars), source: transcript, detail: { count: v.count, note: "Names only until the model searches for a schema" },
    });
    if (server) {
      const sid = ids.has(`mcp:${server}`) ? `mcp:${server}` : add({ id: `mcp:${server}`, label: server, kind: "mcp_server", scope: "session", load: "config", source: transcript, detail: { origin: "connector or plugin, not in config files" } });
      link(sid, gid, "exposes");
    }
  }
  for (const [s, text] of t.mcpBlocks) {
    const sid = ids.has(`mcp:${s}`) ? `mcp:${s}` : add({ id: `mcp:${s}`, label: s, kind: "mcp_server", scope: "session", load: "config", source: transcript, detail: {} });
    const iid = add({ id: `mcpinstr:${s}`, label: `${s} instructions`, kind: "mcp_instructions", scope: "session", load: "always", tokens: tok(text.length), source: transcript });
    link(sid, iid, "injects");
  }
  const ensureMcp = (s) => {
    if (!ids.has(`mcp:${s}`)) add({ id: `mcp:${s}`, label: s, kind: "mcp_server", scope: "session", load: "config", source: transcript, detail: {} });
    return nodes.find((x) => x.id === `mcp:${s}`);
  };
  for (const s of t.needsAuth) ensureMcp(s).detail.status = "needs auth";
  for (const s of t.pending) { const n = ensureMcp(s); n.detail.status ||= "connecting at start"; }
  // claude.ai connectors arrive named by UUID. Infer a readable name; only the name is kept.
  const toolsByServer = new Map();
  for (const name of t.tools.keys()) {
    const m = name.match(/^mcp__(.+?)__(.+)$/);
    if (m) (toolsByServer.get(m[1]) || toolsByServer.set(m[1], []).get(m[1])).push(m[2]);
  }
  for (const n of nodes) {
    if (n.kind !== "mcp_server" || !UUID.test(n.label)) continue;
    const id = n.label;
    const guess = connectorName(toolsByServer.get(id) || [], t.mcpBlocks.get(id) || "");
    if (!guess) continue;
    const label = `${guess.name} (${id.slice(0, 4)})`;
    n.label = label;
    n.detail.connectorId = id;
    n.detail.nameInferredFrom = guess.from;
    for (const pfx of ["tools", "mcpinstr"]) {
      const c = nodes.find((x) => x.id === `${pfx}:${id}`);
      if (c) c.label = c.label.replace(id, label);
    }
  }
  session.hookEvents = t.hookEvents;
  if (t.turns.length) session.turns = t.turns;
} else {
  session.notes.push("No transcript found: totals cover config files only.");
}

// ---------- totals ----------
const byLoad = {};
for (const n of nodes) byLoad[n.load] = (byLoad[n.load] || 0) + n.tokens;
// Deferred tool names and on-demand bodies are not all in the first turn; "always" + deferred names are.
addRemainder({ add, session, byLoad, label: "harness (system prompt, tool schemas)", source: "Claude Code" });

// After every server and skill exists: link each to the plugin it came with.
// ---------- references between text files ----------
// Every markdown piece in the map is read for what it points at: @path imports (Claude Code loads these along with
// the file), [text](path) links and [[slug]] links. A target that is already on the map gets an edge. An @import that
// is not on the map yet becomes a node, since its text is loaded too. Links to other repo files are only counted.
// Only paths and counts are kept, never link text.
linkReferences();
linkPlugins(session.skillsListed || {});
classifyRuns();
await scanUsage(Number(opt("usage-days", 30)));
addSkillEntries(session.skillsListed);
linkSkillsToServers();

// ---------- skills that name an MCP server's tools ----------
// A skill file that spells out mcp__<server>__<tool> tells Claude to use that server. Only the edge is kept.
function linkSkillsToServers() {
  const norm = (x) => x.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
  const byKey = new Map(), clash = new Set();
  for (const n of nodes) if (n.kind === "mcp_server") { const k = norm(n.id.slice(4)); byKey.has(k) ? clash.add(k) : byKey.set(k, n); }
  for (const k of clash) byKey.delete(k);
  // Every SKILL.md we can read, by its frontmatter name and its folder name.
  const roots = [path.join(CLAUDE, "skills"), path.join(projectDir, ".claude", "skills"), path.join(CLAUDE, "plugins", "cache"),
    path.join(DESKTOP, "local-agent-mode-sessions", "skills-plugin")];
  const fileOf = new Map();
  let visits = 0;
  const walk = (d, depth) => {
    if (depth > 8 || ++visits > 20000) return;
    for (const e of ls(d)) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name === "SKILL.md") {
        const head = (() => { try { return fs.readFileSync(f, "utf8").slice(0, 600); } catch { return ""; } })();
        const nm = /^name:\s*["']?([^"'\n]+)/m.exec(head)?.[1]?.trim();
        for (const k of [nm, path.basename(d)]) if (k && !fileOf.has(k)) fileOf.set(k, f);
      }
    }
  };
  for (const r of roots) walk(r, 0);
  const have = new Set(edges.map((e) => `${e.from}>${e.to}`));
  let linked = 0;
  for (const n of nodes) {
    if (n.kind !== "skill_entry" && n.kind !== "skill") continue;
    const f = n.kind === "skill" && n.source?.endsWith("SKILL.md") ? n.source : fileOf.get(n.label) || fileOf.get(n.label.split(":").pop());
    if (!f || size(f) > 2e6) continue;
    let text = ""; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const servers = new Set();
    for (const m of text.matchAll(/mcp__([A-Za-z0-9_-]+?)__/g)) { const sv = byKey.get(norm(m[1])); if (sv) servers.add(sv.id); }
    for (const sid of servers) if (!have.has(`${n.id}>${sid}`)) { link(n.id, sid, "uses"); have.add(`${n.id}>${sid}`); linked++; }
  }
  if (linked) session.notes.push(`${linked} skill-to-server links from tool names in skill files.`);
}

// ---------- skill listing, one line per skill ----------
// The listing node already carries the total; these are its breakdown, so they are added after totals.
function addSkillEntries(sk) {
  if (!sk?.names?.length || !ids.has("session:skill_listing")) return;
  const files = nodes.filter((n) => n.kind === "skill" || n.kind === "command");
  for (const nm of sk.names) {
    const chars = (Object.hasOwn(sk.perName || {}, nm) && sk.perName[nm]) || 0;
    const plugin = nm.includes(":") ? nm.split(":")[0] : undefined;
    const id = add({
      id: `skillentry:${nm}`, label: nm, kind: "skill_entry", scope: "session", load: "always", tokens: tok(chars), source: transcript,
      detail: { plugin, note: "This skill's name and description in the listing sent every session" },
    });
    link("session:skill_listing", id, "lists");
    if (plugin) link(pluginNode(plugin), id, "provides");
    const base = nm.split(":").pop();
    const f = files.find((n) => n.label === nm || n.label === base || path.basename(path.dirname(n.source || "")) === base);
    if (f) link(id, f.id, "describes");
  }
}

// ---------- MCP usage over recent transcripts ----------
// Counts, per server, schema lookups (ToolSearch select), calls, and the size of what calls returned.
// Only counts and dates are kept: no tool inputs, no results.
async function scanUsage(days) {
  if (!days) return;
  const servers = nodes.filter((n) => n.kind === "mcp_server");
  const norm = (x) => x.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
  // Tool names spell plugin servers with "_" where ids use ":", so keys fold punctuation. Two servers that
  // fold to the same key are ambiguous, so neither gets usage rather than a guess.
  const byKey = new Map(), clash = new Set();
  for (const n of servers) { const k = norm(n.id.slice(4)); if (byKey.has(k)) clash.add(k); else byKey.set(k, n); }
  for (const k of clash) byKey.delete(k);
  const serverOf = (tool) => { const m = /^mcp__(.+?)__/.exec(tool); return m && byKey.get(norm(m[1])); };
  const cut = Date.now() - days * 864e5, prefix = projectKey(primary);
  const files = [];
  const walk = (d) => { for (const e of ls(d)) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".jsonl") && fs.statSync(f).mtimeMs >= cut) files.push(f); } };
  // This project and its worktrees (".claude/worktrees/x" encodes as "--claude-worktrees-x"), not other repos sharing a prefix.
  for (const e of ls(path.join(CLAUDE, "projects"))) if (e.isDirectory() && (e.name === prefix || e.name.startsWith(prefix + "--"))) walk(path.join(CLAUDE, "projects", e.name));
  const u = new Map(); // node id -> stats
  const stat = (n) => u.get(n.id) || u.set(n.id, { calls: 0, lookups: 0, resultChars: 0, sessions: new Set(), tools: new Set(), last: 0 }).get(n.id);
  const readline = (await import("node:readline")).createInterface;
  for (const f of files) {
    const pending = new Map(); // tool_use id -> node
    const rl = readline({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const hasMcp = line.includes("mcp__"), hasResult = pending.size && line.includes('"tool_use_id"');
      if (!hasMcp && !hasResult) continue;
      if (hasResult && !hasMcp) { let hit = false; for (const id of pending.keys()) if (line.includes(id)) { hit = true; break; } if (!hit) continue; }
      let m; try { m = JSON.parse(line); } catch { continue; }
      const t = Date.parse(m.timestamp) || 0, content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use") {
          const n = typeof b.name === "string" && serverOf(b.name);
          if (n) { const st = stat(n); st.calls++; st.sessions.add(f); st.tools.add(b.name); st.last = Math.max(st.last, t); pending.set(b.id, n); }
          else if (b.name === "ToolSearch" && typeof b.input?.query === "string" && b.input.query.startsWith("select:")) {
            for (const nm of b.input.query.slice(7).split(",")) { const sn = serverOf(nm.trim()); if (sn) { const st = stat(sn); st.lookups++; st.last = Math.max(st.last, t); } }
          }
        } else if (b?.type === "tool_result" && pending.has(b.tool_use_id)) {
          const n = pending.get(b.tool_use_id); pending.delete(b.tool_use_id);
          const c = b.content, len = typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((a, x) => a + (typeof x?.text === "string" ? x.text.length : 0), 0) : 0;
          stat(n).resultChars += len;
        }
      }
    }
  }
  for (const n of servers) {
    const st = u.get(n.id);
    n.detail = { ...n.detail, usedInDays: days, calls: st?.calls || 0, sessionsUsing: st?.sessions.size || 0 };
    if (!st) continue;
    n.detail.lastUsed = st.last ? new Date(st.last).toISOString().slice(0, 10) : undefined;
    if (!st.calls && !st.lookups) continue;
    const id = add({
      id: `usage:${n.id.slice(4)}`, label: `${n.label} use (${st.calls} calls)`, kind: "mcp_usage", scope: n.scope, load: "on_demand",
      tokens: tok(st.calls ? st.resultChars / Math.max(1, st.sessions.size) : 0), source: `${files.length} transcripts, last ${days} days`,
      detail: { calls: st.calls, schemaLookups: st.lookups, sessions: st.sessions.size, toolsUsed: st.tools.size, resultTokensTotal: tok(st.resultChars), perSession: "tokens shown are results per session that used it", lastUsed: n.detail.lastUsed },
    });
    link(n.id, id, "called");
  }
  session.notes.push(`MCP usage counted from ${files.length} transcripts in the last ${days} days.`);
}
delete session.skillsListed; // used for linking only, never written out

// Context window: the transcript rarely says, so take a flag, then autoCompactWindow from settings
// (Claude Code compacts against it), else assume 1M (current models).
{
  const flag = opt("window", "");
  const parsed = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(flag.trim());
  if (parsed) {
    session.contextWindow = Math.round(Number(parsed[1]) * ({ k: 1e3, m: 1e6 }[parsed[2].toLowerCase()] || 1));
    session.contextWindowFrom = "--window flag";
  } else {
    // Settings precedence: managed beats local beats project beats user.
    const rank = { managed: 0, local: 1, project: 2, user: 3 };
    const set = nodes.filter((n) => n.kind === "settings" && n.detail?.autoCompactWindow > 0)
      .sort((a, b) => (rank[a.scope] ?? 9) - (rank[b.scope] ?? 9))[0];
    session.contextWindow = set ? set.detail.autoCompactWindow : 1e6;
    session.contextWindowFrom = set ? `autoCompactWindow in ${set.scope} settings` : "default";
  }
}

// Allows, asks and blocks lines: a settings file to each MCP server its rules name. Rules name a server the way the
// tool names do (mcp__<server>__<tool>): plugin servers as plugin_<plugin>_<server>, claude.ai connectors as
// claude_ai_<Name>, which the map shows by name.
{
  const servers = nodes.filter((n) => n.kind === "mcp_server");
  const flat = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  const serverFor = (name) => {
    if (ids.has(`mcp:${name}`)) return `mcp:${name}`;
    const want = flat(name.replace(/^claude_ai_/, ""));
    const hit = servers.find((n) => flat(n.id.replace(/^mcp:/, "")) === want)
      || servers.find((n) => flat(String(n.label).replace(/\s*\([0-9a-f]{4}\)$/, "")) === want);
    return hit?.id;
  };
  for (const { id, perm } of permSources) {
    const seen = new Set();
    for (const [verdict, kind] of [["allow", "allows"], ["ask", "asks"], ["deny", "blocks"]]) {
      for (const r of Array.isArray(perm[verdict]) ? perm[verdict] : []) {
        const t = String(r).split("(")[0].trim();
        if (!t.startsWith("mcp__")) continue;
        const to = serverFor(t.split("__")[1] || "");
        if (to && !seen.has(`${kind}:${to}`)) { seen.add(`${kind}:${to}`); link(id, to, kind); }
      }
    }
  }
}
return { session, byLoad };
}
