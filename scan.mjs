#!/usr/bin/env node
// claude-harness-map scanner: maps what a coding agent harness (Claude Code, Codex) loads into context.
// Reads names, sizes and scopes. The only file text it keeps is markdown headings
// (for the structure view; --no-outline turns them off). Never copies other file
// contents, env values, permission rules or full hook commands into the snapshot.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { HOME, HOME_REAL, readJson, tilde, untilde, outlineOf, redactUrls } from "./lib/util.mjs";
import { createGraph } from "./lib/graph.mjs";
import { shareSnapshot } from "./lib/share.mjs";
import { recentProjects } from "./lib/recent.mjs";
import { startServer } from "./lib/serve.mjs";
import * as claudeCode from "./adapters/claude-code.mjs";
import * as codex from "./adapters/codex.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS = { [claudeCode.id]: claudeCode, [codex.id]: codex };
// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: claude-harness-map [--project <dir>] [--session <file.jsonl>] [--out <dir>]
       claude-harness-map --from <snapshot.json> [--out <dir>]
  --harness   claude-code or codex (default: every harness set up on this machine, with a switch in the page)
  --project   project directory to map (default: current directory); repeat it to map several, with a Project picker in the page
  --recent    also map the N folders you used most recently (default 4 without --project, 0 with it)
  --session   transcript to read (default: newest for the project)
  --out       output directory (default: ./out)
  --from      render an existing snapshot instead of scanning
  --no-outline  do not record markdown headings (file structure view)
  --share     write harness-map-shared.html, safe to post: names, headings and paths replaced, numbers kept
  --serve     open the map on a local address (127.0.0.1) with a Rescan button; --port picks the port (default 8766)
  --open      open the map in your browser even when not run in a terminal (for agents)
  --no-open   do not open the map in your browser when the scan finishes
  --window    context window size, e.g. 200k or 1m (default: autoCompactWindow from settings, else 1m)`);
  process.exit(0);
}
// --project can be given several times; the page then gets a Project picker.
const projectArgs = args.flatMap((a, i) => (a === "--project" && args[i + 1] ? [args[i + 1]] : []));
// Paths stay as given (harnesses record sessions by the path they saw); one folder reached two ways is mapped once.
const realKey = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
let projectDirs = [...new Map((projectArgs.length ? projectArgs : [process.env.PWD && realKey(process.env.PWD) === realKey(process.cwd()) ? process.env.PWD : process.cwd()]).map((p) => path.resolve(p)).map((p) => [realKey(p), p])).values()];
const outDir = path.resolve(opt("out", path.join(process.cwd(), "out")));

const sessionId = (p) => `session ${crypto.createHash("sha1").update(p).digest("hex").slice(0, 8)}`;
// The output folder holds your full snapshot: a new one gets a .gitignore so it stays out of any repo it lands in.
function ensureOut() {
  if (fs.existsSync(outDir)) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, ".gitignore"), "# Written by claude-harness-map: these files describe your setup.\n*\n");
}
function render(snapshot, file = "harness-map.html") {
  // The output folder holds your full snapshot: keep it out of any repo it lands in.
  ensureOut();
  const viewer = fs.readFileSync(path.join(HERE, "viewer", "index.html"), "utf8");
  // Escape for a <script> context, and use a replacer function so "$&" or "$'"
  // in a file name is not treated as a replacement pattern.
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const json = JSON.stringify(snapshot).replace(/</g, "\\u003c").replace(/\/\*/g, "/\\u002a").replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");
  const html = viewer.replace("/*__SNAPSHOT__*/null", () => json);
  fs.writeFileSync(path.join(outDir, file), html);
  return path.join(outDir, file);
}

const SHARE = args.includes("--share");
// A shared page carries only what shareSnapshot keeps. The full snapshot files stay local, as the compare baseline.
// Shared pages name projects "project 1", "project 2" so the picker still works without naming folders.
function forPage(snap) {
  if (!SHARE) return snap;
  const list = Array.isArray(snap) ? snap : [snap];
  const order = [...new Set(list.map((s) => s.project))];
  const out = list.map((s) => ({ ...shareSnapshot(s), project: order.length > 1 ? `project ${order.indexOf(s.project) + 1}` : "a project" }));
  return Array.isArray(snap) ? out : out[0];
}
const PAGE = SHARE ? "harness-map-shared.html" : "harness-map.html";
const SERVE = args.includes("--serve");
if (SERVE && (SHARE || opt("from", null))) { console.error("--serve shows your own map: run it without --share or --from."); process.exit(1); }

if (opt("from", null)) {
  const out = render(forPage(JSON.parse(fs.readFileSync(path.resolve(opt("from")), "utf8"))), opt("name", PAGE));
  console.log(`Rendered ${out}`);
  process.exit(0);
}

const OUTLINE = !args.includes("--no-outline");
// --harness picks one adapter. Without it, every harness set up on this machine is mapped into one page.
const wanted = opt("harness", "auto");
let adapters;
if (wanted === "auto") {
  adapters = Object.values(ADAPTERS).filter((a) => a.detect());
  if (!adapters.length) adapters = [claudeCode];
  if (opt("session", null) && adapters.length > 1) { console.error("--session reads one harness's transcript: add --harness <id>."); process.exit(1); }
} else {
  if (!ADAPTERS[wanted]) { console.error(`Unknown --harness. Known: ${Object.keys(ADAPTERS).join(", ")}`); process.exit(1); }
  adapters = [ADAPTERS[wanted]];
}
// Without --project, the picker also gets the folders you used most recently (--recent N, default 4; 0 turns it off).
// With --project, only --recent adds them.
const recentN = Number(opt("recent", projectArgs.length ? "0" : "4"));
if (recentN > 0 && !opt("session", null)) {
  const found = recentProjects(adapters, { limit: recentN, exclude: projectDirs });
  if (!projectArgs.length && (projectDirs[0] === HOME || projectDirs[0] === HOME_REAL) && found.length) projectDirs = [];
  projectDirs = [...projectDirs, ...found];
  if (found.length) console.log(`Recent projects added: ${found.map(tilde).join(", ")}`);
}
if (opt("session", null) && projectDirs.length > 1) { console.error("--session reads one transcript: map one --project with it."); process.exit(1); }

// Ids carry file paths: write them with ~ for the home folder, like sources, so a shared map does not name the account.
const idOut = (id) => (typeof id === "string" ? id.split(HOME_REAL + path.sep).join("~" + path.sep).split(HOME + path.sep).join("~" + path.sep) : id);
// Claude Code names a project's folders by its path with every other character turned into "-"
// (~/.claude/projects/-Users-you-code-app/...). Write that as <project>, and the home part as ~.
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
function pathOut(str, projectDir) {
  if (typeof str !== "string") return str;
  let out = redactUrls(idOut(str));
  for (const p of new Set([projectDir, realKey(projectDir)])) out = out.split(encode(p)).join("<project>");
  for (const h of new Set([HOME, HOME_REAL])) out = out.split(encode(h)).join("~");
  return out;
}
// A file inside the project is shown by its path in the project; the project folder is named once, in the title row.
function sourceOut(src, projectDir) {
  const out = pathOut(src, projectDir), base = tilde(projectDir) + path.sep;
  return typeof out === "string" && out.startsWith(base) ? out.slice(base.length) : out;
}
ensureOut();

// ---------- progress and summary ----------
// Progress goes to stderr, redrawn on one line in a terminal; the summary goes to stdout.
const TTY = !!process.stderr.isTTY;
const k = (n) => (!Number.isFinite(n) ? "n/a" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function progress(label) {
  const t0 = Date.now();
  const draw = (m) => TTY && process.stderr.write(`\r\x1b[K${label}: ${m}`);
  if (TTY) draw("starting"); else process.stderr.write(`${label}...\n`);
  return { update: draw, done: () => process.stderr.write(`${TTY ? "\r\x1b[K✓ " : ""}${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`) };
}
function summary(snap) {
  const s = snap.session || {}, by = snap.totals?.byLoad || {}, count = (kind) => snap.nodes.filter((n) => n.kind === kind).length;
  const when = s.startedAt ? new Date(s.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const lines = [`  ${snap.harness.name}${when ? ` · last session ${when}` : ""}${s.model ? ` · ${s.model}` : ""}`];
  if (Number.isFinite(s.firstTurnTokens)) lines.push(`    ${k(s.firstTurnTokens)} tokens before you type${s.contextWindow ? ` (${Math.round(100 * s.firstTurnTokens / s.contextWindow)}% of a ${k(s.contextWindow)} window)` : ""}`);
  else lines.push("    no session found: totals cover config files only");
  lines.push(`    ${[`${k(by.always || 0)} sent every turn`, by.deferred ? `${k(by.deferred)} tool names only` : "", `${k(by.on_demand || 0)} loaded on demand`].filter(Boolean).join(" · ")}`);
  const parts = [[count("mcp_server"), "MCP server"], [count("skill") + count("skill_entry") ? Math.max(count("skill"), count("skill_entry")) : 0, "skill"], [count("settings"), "settings file"], [count("hook"), "hook"]]
    .filter(([n]) => n).map(([n, w]) => `${n.toLocaleString("en-US")} ${w}${n > 1 ? "s" : ""}`);
  lines.push(`    ${snap.nodes.length.toLocaleString("en-US")} pieces${parts.length ? `: ${parts.join(", ")}` : ""}`);
  return lines.join("\n");
}
// Open the map in the default browser: in a terminal outside CI, or anywhere with --open (an agent runs the scan
// without a terminal). Never with --no-open.
const OPEN = !args.includes("--no-open") && (args.includes("--open") || (!!process.stdout.isTTY && !process.env.CI));
function openInBrowser(target) {
  // Windows: hand the address to the URL handler directly, never through cmd.exe, which would parse & | ^ in it.
  const win = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe");
  const [cmd, argv] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? [win, ["url.dll,FileProtocolHandler", target]] : ["xdg-open", [target]];
  try { const p = spawn(cmd, argv, { detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); return true; } catch { return false; }
}

async function scanOne(adapter, projectDir) {
  const graph = createGraph();
  const { nodes, edges } = graph;
  const bar = progress(`${adapter.name} · ${tilde(projectDir)}`);
  const { session, byLoad } = await adapter.scan({ projectDir, opt, graph, progress: bar.update });
  bar.done();
  const snapshot = {
    version: 1,
    harness: { id: adapter.id, name: adapter.name },
    generatedAt: new Date().toISOString(),
    project: tilde(projectDir),
    platform: process.platform,
    session,
    totals: { byLoad, nodes: nodes.length },
    nodes,
    edges,
  };
  if (OUTLINE) {
    const OUTLINED = new Set(["claude_md", "agents_md", "rule", "memory_index", "skill", "command", "agent"]);
    for (const n of nodes) {
      if (!OUTLINED.has(n.kind) || !/\.md$/i.test(n.source || "")) continue;
      const o = outlineOf(untilde(n.source));
      if (o && o.length > 1) n.outline = o;
    }
  }
  // Pieces read from the session log name it plainly: its path holds the folder the session ran in, often a worktree.
  const log = session.transcript;
  for (const n of nodes) { n.label = redactUrls(n.label); n.id = pathOut(n.id, projectDir); if (n.parent) n.parent = pathOut(n.parent, projectDir); n.source = log && n.source === log ? "the last session's log" : sourceOut(n.source, projectDir); }
  for (const e of edges) { e.from = pathOut(e.from, projectDir); e.to = pathOut(e.to, projectDir); }
  // The log is kept only as a short fingerprint, enough to tell whether two scans read the same session.
  if (log) session.transcript = sessionId(log);

  // Keep the last snapshot of the same project and harness so the viewer can show what changed.
  // Claude Code keeps the original file name; other harnesses get their own.
  // With several projects, each project and harness keeps its own file, named by folder and a short hash of its path.
  const base = adapter.id === "claude-code" ? "snapshot" : `snapshot-${adapter.id}`;
  const slug = projectDirs.length > 1 ? `-${path.basename(projectDir).replace(/[^A-Za-z0-9_-]/g, "_")}-${crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 6)}` : "";
  const prevFile = path.join(outDir, `${base}${slug}.json`);
  const prev = readJson(prevFile);
  if (prev && prev.project === snapshot.project && (prev.harness?.id || "claude-code") === adapter.id && Array.isArray(prev.nodes)) {
    snapshot.previous = {
      generatedAt: prev.generatedAt,
      firstTurnTokens: prev.session?.firstTurnTokens ?? null,
      transcript: prev.session?.transcript ?? null,
      nodes: Object.fromEntries(prev.nodes.map((n) => [pathOut(n.id, projectDir), { tokens: n.tokens, label: n.label, kind: n.kind }])),
    };
  }
  fs.writeFileSync(prevFile, JSON.stringify({ ...snapshot, previous: undefined }, null, 2));
  return snapshot;
}

async function scanAll() {
  const snapshots = [];
  for (const dir of projectDirs) for (const a of adapters) snapshots.push(await scanOne(a, dir));
  for (const dir of [...new Set(snapshots.map((x) => x.project))]) console.log(`\nMapped ${dir}\n${snapshots.filter((x) => x.project === dir).map(summary).join("\n\n")}`);
  // One harness: the page holds its snapshot. Several: the page holds all of them and shows a switch.
  return render(forPage(snapshots.length === 1 ? snapshots[0] : snapshots), PAGE);
}
const page = await scanAll();
if (SERVE) {
  // A folder picked in the page joins the projects (once, by its real path) and the map is scanned again.
  const addProject = async (dir) => {
    const known = projectDirs.find((p) => realKey(p) === realKey(dir));
    if (!known) { projectDirs = [...projectDirs, dir]; await scanAll(); }
    return tilde(known || dir);
  };
  const { url } = await startServer({ port: Number(opt("port", "8766")), pagePath: page, rescan: scanAll, addProject });
  console.log(`\nServing the map at ${url}\nThe address holds a private key: keep it to yourself. Opening it once is enough; the page then remembers it until the server stops. Press Ctrl+C to stop.`);
  // The browser is opened on the keyed address, so it arrives signed in; the page swaps the key for a cookie at once.
  if (OPEN && openInBrowser(url)) console.log("Opened it in your browser.");
} else {
  const link = pathToFileURL(page).href;
  console.log(`\nOpen the map: ${link}`);
  if (OPEN && openInBrowser(link)) console.log("Opened it in your browser.");
  if (!SHARE) console.log("Tip: --serve opens it with Rescan and a project picker.");
  if (SHARE) console.log("This page is safe to share. The snapshot JSON files next to it are the full local copy: do not share those.");
}
