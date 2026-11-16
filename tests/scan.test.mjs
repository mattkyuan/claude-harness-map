// Runs the scanner against a synthetic home folder and project, then checks the snapshot.
// Pins the Claude Code adapter's output shape and the privacy rules a shared map relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = "sk-test-DO-NOT-LEAK-1234567890";

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chm-home-"));
  const project = path.join(home, "code", "demo-app");
  const claude = path.join(home, ".claude");
  write(path.join(claude, "settings.json"), JSON.stringify({ env: { API_KEY: SECRET }, permissions: { allow: ["Bash(ls:*)", "mcp__files__list"], deny: ["mcp__docs"] } }));
  write(path.join(claude, "CLAUDE.md"), "# Personal\n\nKeep replies short.\n");
  write(path.join(claude, "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidy files\n---\n\nUse mcp__files__list to look around.\n");
  write(path.join(project, "CLAUDE.md"), "# Demo app\n\nSee [the rules](.claude/rules/style.md).\n\n## Testing\n\nRun the tests.\n");
  write(path.join(project, ".claude", "rules", "style.md"), "# Style\n\nTwo spaces.\n");
  write(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: {
    files: { command: "npx", args: ["files-server"], env: { TOKEN: SECRET } },
    docs: { type: "http", url: "https://docs.example.com/mcp" },
    proxied: { command: "npx", args: ["mcp-remote", "https://api.example.com/mcp"] },
  } }));
  const mem = path.join(claude, "projects", project.replace(/[^A-Za-z0-9]/g, "-"), "memory");
  write(path.join(mem, "MEMORY.md"), "- [Testing](testing.md) - how we test\n");
  write(path.join(mem, "testing.md"), "---\nname: testing\ndescription: how we test\n---\nRun it. See [[style_notes]].\n");
  write(path.join(mem, "style_notes.md"), "---\nname: style_notes\ndescription: style\n---\nTwo spaces.\n");
  return { home, project };
}

function scan({ home, project }) {
  const out = path.join(home, "out");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR;
  execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--project", project, "--out", out, "--usage-days", "0"], { env, stdio: "pipe" });
  const raw = fs.readFileSync(path.join(out, "snapshot.json"), "utf8");
  return { raw, snap: JSON.parse(raw), out };
}

test("Claude Code adapter maps config, MCP servers and memory", () => {
  const fx = fixture();
  const { snap } = scan(fx);
  const byLabel = (l) => snap.nodes.find((n) => n.label === l);
  assert.equal(snap.harness.id, "claude-code");
  assert.ok(snap.nodes.some((n) => n.kind === "claude_md" && n.scope === "user"));
  assert.ok(snap.nodes.some((n) => n.kind === "claude_md" && n.scope === "project"));
  const userSettings = snap.nodes.find((n) => n.id === "settings:user:settings.json");
  assert.deepEqual(userSettings.detail.rulesByTool, ["Bash (1 allow)", "MCP: files (1 allow)", "MCP: docs (1 deny)"], "rules are counted by tool");
  const perm = snap.edges.filter((e) => e.from === userSettings.id && ["allows", "asks", "blocks"].includes(e.kind)).map((e) => `${e.kind} ${e.to}`).sort();
  assert.deepEqual(perm, ["allows mcp:files", "blocks mcp:docs"], "settings link to the servers their rules allow or block");
  assert.ok(userSettings.detail.affects.some((t) => /2 allow, 0 ask, 1 deny/.test(t)) && userSettings.detail.affects.some((t) => /1 environment variable/.test(t)));
  assert.ok(!JSON.stringify(userSettings).includes("ls:*") && !JSON.stringify(userSettings).includes("API_KEY"), "rule text and env names stay in the file");
  assert.ok(snap.nodes.filter((n) => /^memory_/.test(n.kind)).every((n) => n.scope === "project" && n.detail.privateToYou), "auto memory sits on the project floor, marked private");
  assert.ok(snap.nodes.some((n) => n.kind === "rule"));
  assert.equal(byLabel("files")?.detail.runs, "local");
  assert.equal(byLabel("docs")?.detail.runs, "remote");
  assert.equal(byLabel("proxied")?.detail.runs, "remote");
  const memFiles = snap.nodes.filter((n) => n.kind === "memory_file").map((n) => n.label).sort();
  assert.deepEqual(memFiles, ["style_notes.md", "testing.md"]);
});

test("a snapshot never carries secrets or the home folder path", () => {
  const fx = fixture();
  const { raw, out } = scan(fx);
  assert.ok(!raw.includes(SECRET), "env values must not be written");
  assert.ok(!raw.includes(fx.home), "home folder must be written as ~");
  assert.ok(!fs.readFileSync(path.join(out, "harness-map.html"), "utf8").includes(SECRET));
});

test("an unknown harness is refused", () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--harness", "nope"], { stdio: "pipe" }));
});

// ---------- Codex ----------
const PROMPT_TEXT = "BASE-PROMPT-TEXT-MUST-NOT-APPEAR";

function codexFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "chm-codex-"));
  const project = path.join(home, "code", "demo-app");
  const codex = path.join(home, ".codex");
  write(path.join(codex, "config.toml"), [
    'model = "demo-model"',
    `[projects."${project}"]`, 'trust_level = "trusted"',
    "[mcp_servers.files]", 'command = "npx"', 'args = ["files-server"]', `env = { TOKEN = "${SECRET}" }`,
    "[mcp_servers.docs]", 'url = "https://docs.example.com/mcp"',
    "[mcp_servers.off]", 'command = "off-server"', "enabled = false",
    '[plugins."helper@market"]', "enabled = true",
    "",
  ].join("\n"));
  write(path.join(codex, "AGENTS.md"), "# Personal\n\nKeep replies short.\n");
  write(path.join(codex, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `TOKEN=${SECRET} /opt/gate.sh --strict` }] }] } }));
  write(path.join(project, "AGENTS.md"), "# Demo app\n\n## Testing\n\nRun the tests.\n");
  write(path.join(home, ".agents", "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: Tidy files\n---\nBody.\n");
  const msg = (role, text) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  const lines = [
    { type: "session_meta", payload: { cwd: project, originator: "codex_exec", base_instructions: { text: PROMPT_TEXT + " ".repeat(4000) } } },
    msg("developer", `<skills_instructions>\n## Skills\n### Skill roots\n- \`r0\` = \`${home}/.agents/skills\`\n### Available skills\n- tidy: Tidy files (file: r0/tidy/SKILL.md)\n</skills_instructions>`),
    msg("developer", "<permissions instructions>\nsandboxed\n</permissions instructions>"),
    msg("user", "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# Personal\n\nKeep replies short.\n\n# Demo app\n\n## Testing\n\nRun the tests.\n</INSTRUCTIONS>"),
    msg("user", `<environment_context>\n  <cwd>${project}</cwd>\n</environment_context>`),
    { type: "turn_context", payload: { model: "demo-model", effort: "medium" } },
    msg("user", "hello"),
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9000, cached_input_tokens: 4000 }, model_context_window: 258400 } } },
  ];
  write(path.join(codex, "sessions", "2026", "01", "01", "rollout-2026-01-01T00-00-00-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { home, project };
}

function scanCodex({ home, project }) {
  const out = path.join(home, "out");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CODEX_HOME;
  execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--harness", "codex", "--project", project, "--out", out], { env, stdio: "pipe" });
  const raw = fs.readFileSync(path.join(out, "snapshot-codex.json"), "utf8");
  return { raw, snap: JSON.parse(raw), out };
}

test("Codex adapter maps config.toml, AGENTS.md, skills and the first turn", () => {
  const { snap } = scanCodex(codexFixture());
  const byLabel = (l) => snap.nodes.find((n) => n.label === l);
  assert.equal(snap.harness.id, "codex");
  assert.equal(byLabel("files")?.detail.runs, "local");
  assert.equal(byLabel("docs")?.detail.runs, "remote");
  assert.equal(byLabel("off")?.detail.status, "disabled");
  assert.ok(snap.nodes.some((n) => n.kind === "plugin" && n.label === "helper"));
  const agents = snap.nodes.filter((n) => n.kind === "agents_md");
  assert.deepEqual(agents.map((n) => [n.scope, n.load, n.detail.confirmedInSession]).sort(), [["project", "always", true], ["user", "always", true]]);
  assert.equal(snap.session.firstTurnTokens, 9000);
  assert.deepEqual(snap.session.firstTurnUsage, { uncached: 5000, cacheWrite: 0, cacheRead: 4000 });
  assert.equal(snap.session.contextWindow, 258400);
  assert.ok(byLabel("skill listing (1)"));
  assert.ok(snap.nodes.some((n) => n.kind === "skill_entry" && n.label === "tidy" && n.detail.from === "~/.agents/skills"));
  assert.ok(snap.nodes.some((n) => n.kind === "harness_block" && n.label === "permissions instructions"));
  assert.equal(byLabel("PreToolUse [Bash]: gate.sh")?.kind, "hook");
  // Attributed pieces plus the remainder add up to the recorded first turn.
  assert.equal(snap.totals.byLoad.always, 9000);
});

test("a Codex snapshot never carries secrets, prompt text or the home folder path", () => {
  const fx = codexFixture();
  const { raw, out } = scanCodex(fx);
  for (const s of [SECRET, PROMPT_TEXT, fx.home]) assert.ok(!raw.includes(s), `snapshot leaks ${s.slice(0, 12)}`);
  const html = fs.readFileSync(path.join(out, "harness-map.html"), "utf8");
  assert.ok(!html.includes(SECRET) && !html.includes(PROMPT_TEXT));
});

test("with both set up, one page holds both harnesses and keeps a snapshot for each", () => {
  const fx = codexFixture();
  write(path.join(fx.home, ".claude", "CLAUDE.md"), "# Personal\n");
  const out = path.join(fx.home, "out");
  const env = { ...process.env, HOME: fx.home, USERPROFILE: fx.home };
  delete env.CODEX_HOME; delete env.CLAUDE_CONFIG_DIR;
  execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--project", fx.project, "--out", out, "--usage-days", "0"], { env, stdio: "pipe" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "snapshot.json"), "utf8")).harness.id, "claude-code");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "snapshot-codex.json"), "utf8")).harness.id, "codex");
  const html = fs.readFileSync(path.join(out, "harness-map.html"), "utf8");
  assert.ok(html.includes('"id":"claude-code"') && html.includes('"id":"codex"'));
});

test("when piece estimates exceed the recorded first turn, the snapshot says so", () => {
  const fx = codexFixture();
  const roll = path.join(fx.home, ".codex", "sessions", "2026", "01", "01", "rollout-2026-01-01T00-00-00-x.jsonl");
  fs.writeFileSync(roll, fs.readFileSync(roll, "utf8").replace('"input_tokens":9000', '"input_tokens":100'));
  const { snap } = scanCodex(fx);
  assert.equal(snap.session.attribution.recorded, 100);
  assert.ok(snap.session.attribution.over > 0);
  assert.ok(snap.session.notes.some((n) => /more than the recorded first turn/.test(n)));
  assert.equal(snap.nodes.find((n) => n.id === "harness").tokens, 0);
});

test("a rescan of the same session records it, so the page can warn that nothing could have changed", () => {
  const fx = codexFixture();
  scanCodex(fx);
  const { out } = scanCodex(fx);
  // The comparison is embedded in the page only; the saved snapshot file leaves it out.
  const html = fs.readFileSync(path.join(out, "harness-map.html"), "utf8");
  const snap = JSON.parse(html.match(/const SNAPSHOT = (.*);\n/)[1]);
  assert.match(snap.session.transcript, /^session [0-9a-f]{8}$/, "the session log is kept as a fingerprint, not a path");
  assert.ok(!snap.nodes.some((n) => /\.jsonl$/.test(n.source || "")), "pieces read from the log name it plainly");
  assert.equal(snap.previous.transcript, snap.session.transcript);
  assert.ok(snap.session.startedAt === undefined || !Number.isNaN(Date.parse(snap.session.startedAt)));
});

test("--share hides names, headings and paths but keeps the numbers", () => {
  const fx = fixture();
  const out = path.join(fx.home, "out");
  const env = { ...process.env, HOME: fx.home, USERPROFILE: fx.home };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--project", fx.project, "--out", out, "--usage-days", "0", "--share"], { env, stdio: "pipe" });
  const html = fs.readFileSync(path.join(out, "harness-map-shared.html"), "utf8");
  const shared = JSON.parse(html.match(/const SNAPSHOT = (.*);\n/)[1]);
  const full = JSON.parse(fs.readFileSync(path.join(out, "snapshot.json"), "utf8"));
  // Scanned names could only reach nodes, edges and the project; session notes are fixed wording.
  const page = JSON.stringify({ nodes: shared.nodes, edges: shared.edges, project: shared.project });
  assert.ok(!html.includes(SECRET) && !html.includes(fx.home));
  for (const name of ["style_notes", "testing.md", "tidy", "files", "docs", "proxied", "demo-app", "Testing", ".claude/rules", SECRET]) {
    assert.ok(!page.includes(name), `shared page names ${name}`);
  }
  assert.equal(shared.shared, true);
  assert.equal(shared.nodes.length, full.nodes.length);
  assert.equal(shared.edges.length, full.edges.length);
  assert.deepEqual(shared.totals, full.totals);
  assert.ok(shared.nodes.every((n) => !n.outline && (n.source === undefined || n.kind === "harness")));
  assert.equal(shared.nodes.find((n) => n.label === "MCP server 1")?.detail.runs, "local");
  assert.ok(shared.nodes.some((n) => n.label === "CLAUDE.md"), "generic harness file names stay");
});

test("several --project folders go into one page with a snapshot each, and --share numbers them", () => {
  const fx = fixture();
  const other = path.join(fx.home, "code", "second-app");
  write(path.join(other, "CLAUDE.md"), "# Second\n\nHello.\n");
  const out = path.join(fx.home, "out");
  const env = { ...process.env, HOME: fx.home, USERPROFILE: fx.home };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  const run = (...extra) => execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--project", fx.project, "--project", other, "--out", out, "--usage-days", "0", ...extra], { env, stdio: "pipe" });
  run();
  const embedded = (f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8").match(/const SNAPSHOT = (.*);\n/)[1]);
  const page = embedded("harness-map.html");
  assert.deepEqual(page.map((s) => s.project).sort(), ["~/code/demo-app", "~/code/second-app"]);
  const files = fs.readdirSync(out).filter((f) => /^snapshot-.*\.json$/.test(f));
  assert.equal(files.length, 2, "one snapshot file per project");
  run("--share");
  const shared = embedded("harness-map-shared.html");
  assert.deepEqual(shared.map((s) => s.project).sort(), ["project 1", "project 2"]);
  assert.ok(!JSON.stringify(shared).includes("second-app"));
  assert.throws(() => run("--session", path.join(fx.home, "x.jsonl")));
});

test("a plain scan adds the folders Claude Code was used in most recently, folding worktrees into their repo", () => {
  const fx = fixture();
  const other = path.join(fx.home, "code", "recent-app"), gone = path.join(fx.home, "code", "deleted-app");
  const worktree = path.join(other, ".claude", "worktrees", "feature-x");
  write(path.join(other, "CLAUDE.md"), "# Recent\n");
  fs.mkdirSync(worktree, { recursive: true });
  write(path.join(fx.home, ".claude.json"), JSON.stringify({ projects: { [worktree]: {}, [gone]: {}, [fx.home]: {} } }));
  for (const dir of [worktree, gone, fx.home]) write(path.join(fx.home, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), "s.jsonl"), "{}\n");
  const out = path.join(fx.home, "out");
  const env = { ...process.env, HOME: fx.home, USERPROFILE: fx.home };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--out", out, "--usage-days", "0"], { env, stdio: "pipe", cwd: fx.project });
  const page = JSON.parse(fs.readFileSync(path.join(out, "harness-map.html"), "utf8").match(/const SNAPSHOT = (.*);\n/)[1]);
  // The current folder first, then the worktree's repo; the deleted folder and the home folder are left out.
  assert.deepEqual(page.map((s) => s.project), ["~/code/demo-app", "~/code/recent-app"]);
  execFileSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--out", out, "--usage-days", "0", "--recent", "0"], { env, stdio: "pipe", cwd: fx.project });
  const single = JSON.parse(fs.readFileSync(path.join(out, "harness-map.html"), "utf8").match(/const SNAPSHOT = (.*);\n/)[1]);
  assert.equal(single.project, "~/code/demo-app");
});

test("a CLAUDE.md the session loaded from a worktree sits on the project floor, not the session floor", () => {
  const fx = fixture();
  const wt = path.join(fx.project, ".claude", "worktrees", "feature-x");
  write(path.join(wt, "CLAUDE.md"), "# Demo app\n\nWorktree copy.\n");
  const log = [
    { type: "attachment", timestamp: "2026-11-01T09:00:00.000Z", attachment: { type: "instructions", files: [{ path: path.join(wt, "CLAUDE.md"), type: "Project", content: "# Demo app\n\nWorktree copy.\n" }] } },
    { type: "assistant", message: { model: "demo", usage: { input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } } },
  ];
  write(path.join(fx.home, ".claude", "projects", wt.replace(/[^A-Za-z0-9]/g, "-"), "s.jsonl"), log.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { snap } = scan(fx);
  const md = snap.nodes.filter((n) => n.kind === "claude_md" && n.scope !== "user");
  assert.ok(md.every((n) => n.scope === "project"), JSON.stringify(md.map((n) => n.scope)));
  const copy = md.find((n) => n.detail.confirmedInSession);
  assert.equal(copy.source, ".claude/worktrees/feature-x/CLAUDE.md");
  assert.match(md.find((n) => n.load === "on_demand").detail.note, /worktree/);
});

// Raw requests, so the test can send the Host header a rebinding page would.
function request(port, { method = "GET", pathname = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject); req.end();
  });
}

test("--serve needs its key and its own host, and rescans on request", async () => {
  const f = fixture();
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home };
  delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(process.execPath, [path.join(ROOT, "scan.mjs"), "--project", f.project, "--out", path.join(f.home, "out"), "--usage-days", "0", "--serve", "--port", "0"], { env });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (c) => { out += c; const m = out.match(/Serving the map at (\S+)/); if (m) resolve(new URL(m[1])); });
      child.on("exit", () => reject(new Error(`server exited: ${out}`)));
    });
    const port = Number(url.port), token = url.searchParams.get("token");
    const own = { Host: `127.0.0.1:${port}` };
    assert.equal((await request(port, { headers: own })).status, 403, "no key, no page");
    assert.equal((await request(port, { pathname: `/?token=${token}`, headers: { Host: `evil.example:${port}` } })).status, 403, "another host is refused");
    const enter = await request(port, { pathname: `/?token=${token}&project=x`, headers: own });
    assert.equal(enter.status, 303, "the key in the address is swapped for a cookie");
    assert.equal(enter.headers.location, "/?project=x", "and the address is cleaned");
    const cookie = enter.headers["set-cookie"][0].split(";")[0];
    assert.match(enter.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    const page = await request(port, { headers: { ...own, Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.equal((await request(port, { pathname: `/?token=${"%C3%A9".repeat(32)}`, headers: own })).status, 403, "a key of the right length in other bytes is refused, not a crash");
    assert.equal((await request(port, { pathname: "//", headers: own })).status, 403, "an odd path is refused, not a crash");
    assert.ok(page.body.includes(`const SERVE = {"token":"${token}"}`), "the page carries the key for its Rescan button");
    assert.equal((await request(port, { method: "POST", pathname: "/rescan", headers: own })).status, 403, "rescan needs the key");
    assert.equal((await request(port, { method: "POST", pathname: "/rescan", headers: { ...own, "X-Harness-Token": token, Origin: "https://evil.example" } })).status, 403, "rescan from another site is refused");
    const before = fs.statSync(path.join(f.home, "out", "harness-map.html")).mtimeMs;
    const r = await request(port, { method: "POST", pathname: "/rescan", headers: { ...own, "X-Harness-Token": token, Origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 200);
    assert.ok(fs.statSync(path.join(f.home, "out", "harness-map.html")).mtimeMs > before, "rescan rewrote the page");
    assert.equal((await request(port, { pathname: "/snapshot.json", headers: { ...own, "X-Harness-Token": token } })).status, 404, "no other file is served");
    // Folder picker: names only, with the key; a picked folder is mapped and joins the page.
    const key = { ...own, "X-Harness-Token": token };
    assert.equal((await request(port, { pathname: "/dirs?path=~/code", headers: own })).status, 403, "listing needs the key");
    const dirs = await request(port, { pathname: "/dirs?path=~/code", headers: key });
    assert.deepEqual(JSON.parse(dirs.body), { dir: "~/code", entries: ["demo-app"] });
    fs.mkdirSync(path.join(f.home, "code", "other-app"));
    const post = (dir) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ dir });
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/project", headers: { ...key, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      req.on("error", reject); req.end(body);
    });
    assert.equal((await post("code/other-app")).status, 400, "a relative path is refused");
    assert.equal((await post("~/code/missing")).status, 404);
    const added = await post("~/code/other-app/");
    assert.equal(added.status, 200);
    assert.equal(JSON.parse(added.body).project, "~/code/other-app");
    const after = await request(port, { headers: { ...own, Cookie: cookie } });
    assert.ok(after.body.includes('"project":"~/code/other-app"') && after.body.includes('"project":"~/code/demo-app"'), "both projects are in the page");
    assert.equal(JSON.parse((await post("~/code/other-app")).body).project, "~/code/other-app", "picking it again maps it once");
    assert.ok(fs.readFileSync(path.join(f.home, "out", "harness-map.html"), "utf8").includes("const SERVE = /*__SERVE__*/null"), "the file on disk holds no key");
  } finally { child.kill(); }
});

test("values from config and logs cannot carry secrets or names into the map", async () => {
  const { hookProgram, modelName, redactUrls } = await import("../lib/util.mjs");
  assert.equal(hookProgram('AUTH="Bearer sk-test-SECRET123" ./notify.sh'), "notify.sh", "a quoted env value is skipped whole");
  assert.equal(hookProgram('TOKEN="top secret" /bin/true'), "true");
  assert.equal(modelName("arn:aws:bedrock:us-east-1:123456789012:acme"), "custom model");
  assert.equal(redactUrls("https://user:pw@host/sse?key=abc"), "<url>");

  const f = fixture();
  write(path.join(f.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `API_KEY="Bearer ${SECRET}" ./notify.sh` }] }] } }));
  write(path.join(f.project, ".mcp.json"), JSON.stringify({ mcpServers: { "https://user:hunter2@host/sse?key=abc": { type: "sk-secret-type", url: "https://host/sse" } } }));
  const { raw, snap } = scan(f);
  assert.ok(!raw.includes(SECRET) && !raw.includes("hunter2") && !raw.includes("key=abc"), "no secret, credential or query string in the snapshot");
  assert.ok(snap.nodes.some((n) => n.label === "PreToolUse [Bash]: notify.sh"));

  const { shareSnapshot } = await import("../lib/share.mjs");
  const shared = JSON.stringify(shareSnapshot({
    ...snap,
    session: { ...snap.session, model: "arn:aws:bedrock:us-east-1:123456789012:acme-gw", hookEvents: { "Client Acme launch": 2, PreToolUse: 1 }, startedAt: "2026-11-14T17:44:44.791Z" },
    nodes: [...snap.nodes, { id: "harness:x", label: "Acme merger with Globex", kind: "harness_block", scope: "session", load: "always", tokens: 5, detail: { role: "developer", event: "Acme" } }],
  }));
  for (const leak of ["123456789012", "Acme", "Globex", "sk-secret-type", "17:44"]) assert.ok(!shared.includes(leak), `shared page keeps ${leak}`);
});

test("the scan reports progress, then a plain summary, and never opens a browser outside a terminal", () => {
  const f = fixture();
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home };
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--project", f.project, "--out", path.join(f.home, "out"), "--usage-days", "0", "--harness", "claude-code"], { env, encoding: "utf8" });
  assert.match(r.stderr, /Claude Code · ~\/code\/demo-app \(\d+\.\ds\)/, "progress names the harness and project, then the time");
  assert.match(r.stdout, /Mapped ~\/code\/demo-app\n  Claude Code/);
  assert.match(r.stdout, /\d+ pieces: 3 MCP servers/);
  assert.match(r.stdout, /Open the map: file:\/\//);
  assert.ok(!r.stdout.includes("Opened it in your browser"), "no browser without a terminal");
});

test("--serve opens the browser through a private file, so the key is never on a command line", async () => {
  const { startServer } = await import("../lib/serve.mjs");
  const page = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chm-page-")), "p.html");
  fs.writeFileSync(page, "<script>const SERVE = /*__SERVE__*/null;</script>");
  const { server, token, openerFile } = await startServer({ port: 0, pagePath: page, rescan: async () => {}, addProject: async () => "" });
  try {
    const file = openerFile();
    assert.ok(!file.includes(token), "the path handed to the browser does not carry the key");
    assert.equal(fs.statSync(file).mode & 0o077, 0, "only you can read the file");
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, "or list its folder");
    assert.ok(fs.readFileSync(file, "utf8").includes(`?token=${token}`), "it forwards to the keyed address");
  } finally { server.close(); }
});

// ---------- the CLI as a person runs it: in a terminal, with a browser to open ----------
// A stand-in for `open` / `xdg-open` that records what it was handed, and copies a file it was pointed at, since the
// serve opener deletes itself.
function fakeBrowser() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "chm-bin-"));
  const log = path.join(bin, "opened.json");
  const name = process.platform === "darwin" ? "open" : "xdg-open";
  fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs = require("fs"), { fileURLToPath } = require("url");
const args = process.argv.slice(2), seen = { args, files: {} };
for (const a of args) if (a.startsWith("file:")) try { seen.files[a] = fs.readFileSync(fileURLToPath(a), "utf8").slice(0, 4000); } catch {}
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen));
`, { mode: 0o755 });
  return { bin, log, opened: () => (fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : null) };
}
// Runs scan.mjs with a pseudo-terminal on stdout, the way it runs when a person types the command.
function inTerminal(args, env) {
  const cmd = [process.execPath, path.join(ROOT, "scan.mjs"), ...args];
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const argv = process.platform === "darwin" ? ["-q", "/dev/null", ...cmd] : ["-qec", cmd.map(q).join(" "), "/dev/null"];
  const child = spawn("script", argv, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  return { child, output: () => out, stop: () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} } };
}
const waitFor = async (check, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) { const v = check(); if (v) return v; }
  throw new Error("timed out");
};
function terminalEnv(f, b) {
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, PATH: `${b.bin}${path.delimiter}${process.env.PATH}` };
  delete env.CLAUDE_CONFIG_DIR; delete env.CI;
  return env;
}
const unixOnly = { skip: process.platform === "win32" ? "needs script(1) and a PATH browser opener" : false };

test("in a terminal, a scan opens the map it wrote", unixOnly, async () => {
  const f = fixture(), b = fakeBrowser(), out = path.join(f.home, "out");
  const run = inTerminal(["--project", f.project, "--out", out, "--usage-days", "0"], terminalEnv(f, b));
  try {
    await waitFor(() => run.output().includes("Opened it in your browser."));
    const seen = await waitFor(b.opened);
    assert.deepEqual(seen.args, [pathToFileURL(path.join(out, "harness-map.html")).href], "the browser is handed the page, and only the page");
    assert.match(run.output(), /✓ Claude Code · ~\/code\/demo-app \(\d+\.\ds\)/, "progress ends with a tick and the time");
  } finally { run.stop(); }
});

test("in a terminal, --no-open opens nothing", unixOnly, async () => {
  const f = fixture(), b = fakeBrowser();
  const run = inTerminal(["--project", f.project, "--out", path.join(f.home, "out"), "--usage-days", "0", "--no-open"], terminalEnv(f, b));
  try {
    await waitFor(() => run.output().includes("Open the map:"));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(b.opened(), null);
    assert.ok(!run.output().includes("Opened it in your browser."));
  } finally { run.stop(); }
});

test("in a terminal, --serve opens the map through the private file, and following it signs the browser in", unixOnly, async () => {
  const f = fixture(), b = fakeBrowser();
  const run = inTerminal(["--project", f.project, "--out", path.join(f.home, "out"), "--usage-days", "0", "--serve", "--port", "0"], terminalEnv(f, b));
  try {
    await waitFor(() => run.output().includes("Opened it in your browser."));
    const url = new URL(run.output().match(/Serving the map at (\S+)/)[1]);
    const token = url.searchParams.get("token"), port = Number(url.port);
    const seen = await waitFor(b.opened);
    assert.equal(seen.args.length, 1);
    assert.ok(seen.args[0].startsWith("file:") && !seen.args[0].includes(token), "the browser's command line holds a file, never the key");
    // Follow the opener the way a browser would: its refresh target, then the redirect, then the page.
    const target = new URL(seen.files[seen.args[0]].match(/url=([^"]+)"/)[1]);
    assert.equal(target.href, url.href, "the file forwards to the printed address");
    const own = { Host: `127.0.0.1:${port}` };
    const enter = await request(port, { pathname: `${target.pathname}${target.search}`, headers: own });
    assert.equal(enter.status, 303);
    const page = await request(port, { pathname: enter.headers.location, headers: { ...own, Cookie: enter.headers["set-cookie"][0].split(";")[0] } });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('"project":"~/code/demo-app"'), "and lands on this project's map");
    await waitFor(() => !fs.existsSync(fileURLToPath(seen.args[0])), 35000);
  } finally { run.stop(); }
});

test("the generated page's script parses, so a broken placeholder or escape cannot ship", () => {
  const f = fixture();
  const { out } = scan(f);
  for (const page of [path.join(out, "harness-map.html"), path.join(ROOT, "docs", "index.html")]) {
    const html = fs.readFileSync(page, "utf8");
    const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1, `${path.basename(page)} has its one module script`);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chm-js-")), "page.mjs");
    fs.writeFileSync(file, scripts[0]);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${path.basename(page)}: ${r.stderr}`);
  }
});
