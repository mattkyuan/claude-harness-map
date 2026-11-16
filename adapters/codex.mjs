// Codex adapter: reads Codex's config.toml, AGENTS.md files, skills, hooks and session rollouts into the shared graph.
// Same contract as every adapter: scan() fills the graph and returns { session, byLoad }.
// Keeps names, sizes and verdicts only. Config values (commands, args, env, URLs) are never copied.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, tok, exists, size, ls, tilde, hookProgram, modelName } from "../lib/util.mjs";
import { parseToml } from "../lib/toml.mjs";
import { runsFromConfig } from "../lib/mcp.mjs";
import { addRemainder } from "../lib/totals.mjs";

export const id = "codex";
export const name = "Codex";
// True when this machine has a Codex setup to map.
export const detect = () => exists(process.env.CODEX_HOME || path.join(HOME, ".codex"));
// Folders Codex was used in, with when: each session rollout's working folder, dated by the file.
export function recentProjects() {
  const root = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "sessions"), out = [];
  const walk = (d, depth) => {
    for (const e of ls(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        let fd;
        try {
          fd = fs.openSync(p, "r");
          const buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0);
          const cwd = buf.toString("utf8", 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
          if (cwd) out.push({ dir: JSON.parse(`"${cwd}"`), at: fs.fstatSync(fd).mtimeMs });
        } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
      }
    }
  };
  walk(root, 0);
  return out;
}

const readToml = (f) => { try { return parseToml(fs.readFileSync(f, "utf8")); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

export async function scan({ projectDir, opt, graph, progress = () => {} }) {
progress("reading config.toml, AGENTS.md and skills");
  const { nodes, notes, ids, add, link } = graph;
  const CODEX = process.env.CODEX_HOME || path.join(HOME, ".codex");

  let gitRoot = projectDir;
  try { gitRoot = execFileSync("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || projectDir; } catch {}

  // ---------- config.toml (user, then project when trusted) ----------
  const userCfg = readToml(path.join(CODEX, "config.toml")) || Object.create(null);
  const trusted = userCfg.projects?.[gitRoot]?.trust_level === "trusted" || userCfg.projects?.[projectDir]?.trust_level === "trusted";
  const projCfgFile = path.join(gitRoot, ".codex", "config.toml");
  const projCfg = exists(projCfgFile) ? readToml(projCfgFile) : null;

  function scanConfig(cfg, file, scope, active) {
    if (!cfg) return null;
    const sid = add({
      id: `settings:${scope}:config.toml`, label: "config.toml", kind: "settings", scope, load: "config", source: file,
      detail: {
        model: modelName(cfg.model) || undefined,
        reasoningEffort: typeof cfg.model_reasoning_effort === "string" ? cfg.model_reasoning_effort : undefined,
        mcpServers: cfg.mcp_servers ? Object.keys(cfg.mcp_servers).length : 0,
        affects: codexAffects(cfg),
        ...(active ? {} : { note: "Project config loads only when the project is trusted" }),
      },
    });
    for (const [nm, s] of Object.entries(cfg.mcp_servers || {})) {
      if (!s || typeof s !== "object") continue;
      const off = s.enabled === false;
      const mid = add({
        id: `mcp:${nm}`, label: nm, kind: "mcp_server", scope, load: "config", source: file,
        detail: { transport: s.url ? "http" : "stdio", ...runsFromConfig(s, "set in config.toml"), ...(off ? { status: "disabled" } : {}), ...(active ? {} : { status: "project not trusted" }) },
      });
      link(sid, mid, "configures");
    }
    for (const [full, p] of Object.entries(cfg.plugins || {})) {
      if (!p || p.enabled === false) continue;
      const [short, market] = full.split("@");
      const pid = add({ id: `plugin:${full}`, label: short, kind: "plugin", scope, load: "config", source: file, detail: { marketplace: market } });
      link(sid, pid, "enables");
    }
    return sid;
  }
  scanConfig(userCfg, path.join(CODEX, "config.toml"), "user", true);
  scanConfig(projCfg, projCfgFile, "project", trusted);

  // ---------- hooks.json ----------
  function scanHooks(file, scope) {
    let h; try { h = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    const fid = add({ id: `settings:${scope}:hooks.json`, label: "hooks.json", kind: "settings", scope, load: "config", source: file, detail: { events: Object.keys(h.hooks || {}), affects: Object.keys(h.hooks || {}).length ? [`Runs hooks on ${Object.keys(h.hooks).join(", ")}`] : undefined } });
    for (const [event, groups] of Object.entries(h.hooks || {})) {
      (Array.isArray(groups) ? groups : []).forEach((g, gi) => (g.hooks || []).forEach((hk, hi) => {
        // Program name only. Leading VAR=value assignments can carry secrets.
        const cmd = Array.isArray(hk.command) ? hk.command[0] : hk.command;
        const hid = add({
          id: `hook:${scope}:${event}:${gi}:${hi}`, label: `${event}${g.matcher ? ` [${g.matcher}]` : ""}: ${cmd ? hookProgram(cmd) : String(hk.type || "hook")}`,
          kind: "hook", scope, load: "runtime", source: file, detail: { event, matcher: g.matcher || "*", type: hk.type },
        });
        link(fid, hid, "registers");
      }));
    }
  }
  scanHooks(path.join(CODEX, "hooks.json"), "user");
  scanHooks(path.join(gitRoot, ".codex", "hooks.json"), "project");

  // ---------- AGENTS.md: global, then one per directory from the git root down to the project ----------
  const fallbacks = Array.isArray(userCfg.project_doc_fallback_filenames) ? userCfg.project_doc_fallback_filenames.map(String) : [];
  const pick = (dir, names) => names.map((n) => path.join(dir, n)).find((f) => exists(f) && size(f) > 0);
  const agentsFiles = [];
  const globalDoc = pick(CODEX, ["AGENTS.override.md", "AGENTS.md"]);
  if (globalDoc) agentsFiles.push({ file: globalDoc, scope: "user" });
  const rel = path.relative(gitRoot, projectDir);
  const chain = [gitRoot];
  if (rel && !rel.startsWith("..")) for (const part of rel.split(path.sep)) chain.push(path.join(chain[chain.length - 1], part));
  for (const dir of chain) {
    const f = pick(dir, ["AGENTS.override.md", "AGENTS.md", ...fallbacks]);
    if (f) agentsFiles.push({ file: f, scope: "project" });
  }
  for (const a of agentsFiles) {
    add({ id: `agentsmd:${a.file}`, label: path.basename(a.file), kind: "agents_md", scope: a.scope, load: "always", tokens: tok(size(a.file)), source: a.file });
  }

  // ---------- skills on disk ----------
  function scanSkills(dir, scope, from) {
    for (const e of ls(dir)) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const f = path.join(dir, e.name, "SKILL.md");
      if (exists(f)) add({ id: `skill:${scope}:${e.name}`, label: e.name, kind: "skill", scope, load: "on_demand", tokens: tok(size(f)), source: f, detail: { from } });
    }
  }
  scanSkills(path.join(HOME, ".agents", "skills"), "user", "~/.agents/skills");
  scanSkills(path.join(CODEX, "skills"), "user", "Codex home");
  for (const dir of chain) scanSkills(path.join(dir, ".agents", "skills"), "project", ".agents/skills in the repo");

  // ---------- newest native rollout for this project ----------
  // Native Codex rollouts open with developer messages; sessions imported from other tools do not.
  function firstLine(f) {
    let fd; try { fd = fs.openSync(f, "r"); const buf = Buffer.alloc(262144); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.toString("utf8", 0, n).split("\n")[0]; }
    catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function rollouts() {
    const out = [], root = path.join(CODEX, "sessions");
    const walk = (d, depth) => { for (const e of ls(d)) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walk(p, depth + 1); else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(p); } };
    walk(root, 0);
    return out.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.f);
  }
  function inProject(cwd) { return typeof cwd === "string" && (cwd === projectDir || cwd.startsWith(projectDir + path.sep)); }
  function readRollout(f) {
    const lines = (readText(f) || "").split("\n");
    let meta = null, prefix = [], usage = null, model = null, effort = null, sawTurn = false, native = null;
    for (const line of lines) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const p = r.payload || {};
      if (r.type === "session_meta" && !meta) { meta = p; continue; }
      if (r.type === "turn_context" && !sawTurn) { sawTurn = true; model = p.model || null; effort = p.effort || null; continue; }
      if (r.type === "response_item" && p.type === "message" && !sawTurn) {
        if (native === null) native = p.role === "developer";
        for (const c of p.content || []) if (typeof c.text === "string") prefix.push({ role: p.role, text: c.text });
      }
      if (r.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) { usage = { ...p.info.last_token_usage, window: p.info.model_context_window }; break; }
    }
    return { meta, prefix, usage, model, effort, native };
  }
  let picked = null;
  const forced = opt("session", null);
  if (forced) picked = { file: path.resolve(forced), ...readRollout(path.resolve(forced)) };
  else for (const f of (progress("finding the last session rollout"), rollouts())) {
    let meta; try { meta = JSON.parse(firstLine(f) || "null")?.payload; } catch { continue; }
    if (!inProject(meta?.cwd)) continue;
    const r = readRollout(f);
    if (r.native && r.usage) { picked = { file: f, ...r }; break; }
  }

  const session = { transcript: tilde(picked?.file || null), firstTurnTokens: null, model: null, notes };
  if (picked?.usage) {
    const u = picked.usage, cached = u.cached_input_tokens || 0;
    session.firstTurnTokens = u.input_tokens || 0;
    session.firstTurnUsage = { uncached: Math.max(0, (u.input_tokens || 0) - cached), cacheWrite: u.cache_write_input_tokens || 0, cacheRead: cached };
    session.model = modelName(picked.model);
    const ts = picked.meta?.timestamp;
    if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) session.startedAt = new Date(ts).toISOString();
    if (Number.isFinite(u.window)) { session.contextWindow = u.window; session.contextWindowFrom = "session rollout"; }
    const src = picked.file;

    // The system prompt Codex sends ahead of everything else.
    const base = picked.meta?.base_instructions?.text;
    if (typeof base === "string" && base.length) add({ id: "harness:base", label: "system prompt", kind: "harness", scope: "session", load: "always", tokens: tok(base.length), source: src, detail: { note: "Codex's base instructions, recorded at session start" } });

    // Messages Codex adds before your first prompt. Only their size and tag are kept.
    for (const m of picked.prefix) {
      const t = m.text;
      if (t.startsWith("# AGENTS.md instructions")) {
        const loaded = [];
        for (const a of agentsFiles) {
          const body = (readText(a.file) || "").trim();
          if (body && t.includes(body.slice(0, 400))) loaded.push(a.file);
        }
        for (const n of nodes) {
          if (n.kind !== "agents_md") continue;
          if (loaded.some((f) => tilde(f) === n.source)) n.detail.confirmedInSession = true;
          else { n.load = "on_demand"; n.detail.loadedInSession = false; n.detail.note = "Found on disk, but the last session did not load it"; }
        }
        continue;
      }
      if (t.startsWith("<skills_instructions>")) {
        const lines = t.split("\n");
        const roots = Object.create(null);
        for (const l of lines) { const r = l.match(/^- `(r\d+)` = `(.+)`$/); if (r) roots[r[1]] = r[2]; }
        const entries = lines.filter((l) => /^- [^`].*\(file: r\d+\//.test(l));
        const lid = add({ id: "session:skill_listing", label: `skill listing (${entries.length})`, kind: "skill_listing", scope: "session", load: "always", tokens: tok(t.length), source: src, detail: { count: entries.length, note: "Name and description of every skill, sent every session" } });
        session.skillsListed = { count: entries.length, chars: t.length, names: [] };
        for (const l of entries) {
          const nm = l.slice(2, l.indexOf(": ") > 0 ? l.indexOf(": ") : l.indexOf(" (file:")).trim();
          const root = roots[l.match(/\(file: (r\d+)\//)[1]] || "";
          const plug = root.match(/plugins\/cache\/[^/]+\/([^/]+)\//);
          const from = plug ? `plugin ${plug[1]}` : root.includes(`${path.sep}.system`) ? "built into Codex" : root.startsWith(path.join(HOME, ".agents")) ? "~/.agents/skills" : "repo";
          session.skillsListed.names.push(nm);
          const eid = add({ id: `skill_entry:${from}:${nm}`, label: nm, kind: "skill_entry", scope: "session", load: "always", tokens: tok(l.length + 1), source: src, detail: { from } });
          link(lid, eid, "lists");
        }
        continue;
      }
      // Codex marks its own blocks with lowercase tags (<environment_context>, <permissions instructions>); any other
      // opening is not named. Shared pages rename these anyway.
      const tag = t.match(/^<([a-z][a-z_ ]{1,39})>/)?.[1] || (m.role === "developer" ? "developer note" : "context note");
      const tid = `harness:${tag.replace(/\s+/g, "_")}`;
      if (ids.has(tid)) { const n = nodes.find((x) => x.id === tid); n.tokens += tok(t.length); continue; }
      add({ id: tid, label: tag.replace(/_/g, " "), kind: "harness_block", scope: "session", load: "always", tokens: tok(t.length), source: src, detail: { role: m.role, note: "Added by Codex before your first prompt" } });
    }
  } else {
    notes.push("No Codex session found for this project: totals cover config files only.");
  }

  // ---------- totals ----------
  const byLoad = {};
  for (const n of nodes) if (n.kind !== "skill_entry") byLoad[n.load] = (byLoad[n.load] || 0) + n.tokens;
  addRemainder({ add, session, byLoad, label: "harness (tool schemas, wrappers)", source: "Codex" });
  delete session.skillsListed; // names are on the skill entries already; keep the session object to counts
  return { session, byLoad };
}

// What config.toml changes, as modes and counts. Paths, commands, env values and URLs stay in the file.
function codexAffects(c) {
  const out = [], str = (v) => typeof v === "string" && /^[\w.-]{1,40}$/.test(v);
  if (str(c.approval_policy)) out.push(`Asks for approval: ${c.approval_policy}`);
  if (str(c.sandbox_mode)) out.push(`Sandbox: ${c.sandbox_mode}`);
  if (c.sandbox_workspace_write?.network_access === true) out.push("Lets sandboxed commands use the network");
  if (Array.isArray(c.sandbox_workspace_write?.writable_roots) && c.sandbox_workspace_write.writable_roots.length) out.push(`Lets the agent write in ${c.sandbox_workspace_write.writable_roots.length} extra folder(s)`);
  if (str(c.model)) out.push(`Picks the model: ${modelName(c.model)}`);
  if (str(c.model_reasoning_effort)) out.push(`Reasoning effort: ${c.model_reasoning_effort}`);
  const mcp = c.mcp_servers ? Object.keys(c.mcp_servers).length : 0;
  if (mcp) out.push(`Connects ${mcp} MCP server${mcp > 1 ? "s" : ""}`);
  const trusted = Object.values(c.projects || {}).filter((p) => p?.trust_level === "trusted").length;
  if (trusted) out.push(`Trusts ${trusted} project folder${trusted > 1 ? "s" : ""}, so their own config loads`);
  if (c.tools?.web_search === true || c.web_search === "live" || c.web_search === "cached") out.push("Turns on web search");
  if (c.shell_environment_policy) out.push("Controls which environment variables reach shell commands");
  if (c.profiles && Object.keys(c.profiles).length) out.push(`Defines ${Object.keys(c.profiles).length} profile(s)`);
  if (c.notify) out.push("Runs a program when a turn finishes");
  return out.length ? out : undefined;
}
