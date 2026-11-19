// The plugin manifest and skill sit where Claude Code looks for them, and the skill runs the bundled scanner with an
// output folder outside the user's project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the plugin manifest and skill are where Claude Code looks for them", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "harness-map");
  assert.equal(plugin.version, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  const skill = fs.readFileSync(path.join(ROOT, "skills", "harness-map", "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)[1];
  assert.match(fm, /^name: harness-map$/m);
  assert.match(fm, /^description: .{40,}/m);
  // Every scan the skill runs is the bundled one, and writes outside the project it is run in.
  const runs = [...skill.matchAll(/^ *(node .*)$/gm)].map((m) => m[1]);
  assert.ok(runs.length > 0);
  for (const r of runs) {
    assert.match(r, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scan\.mjs" /);
    assert.match(r, /--out "\$HOME\/\.claude-harness-map\/out"/);
  }
  // What runs without asking is exactly the commands the skill gives, with no wildcard that could add a flag.
  const grants = [...fm.matchAll(/^  - (.+)$/gm)].map((m) => m[1]);
  assert.ok(grants.length > 0);
  for (const g of grants) {
    assert.ok(!g.includes("*"), `no wildcard: ${g}`);
    const cmd = /^Bash\((.*)\)$/.exec(g)?.[1];
    assert.ok(cmd && runs.includes(cmd), `granted only as the skill writes it: ${g}`);
  }
  assert.ok(!skill.includes("—"), "no em dashes");
});

// --name names the page file inside --out. A path there (../, an absolute path) would let the scanner write its page
// anywhere the user can write, so it is refused before anything is written.
test("--name is refused unless it is a plain file name ending in .html", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-name-"));
  const out = path.join(tmp, "out");
  const scan = (name) => spawnSync(process.execPath, [path.join(ROOT, "scan.mjs"), "--from", path.join(ROOT, "demo", "snapshot.json"), "--out", out, "--name", name, "--no-open"], { encoding: "utf8" });
  for (const bad of ["../escape.html", path.join(tmp, "abs.html"), "sub/page.html", "page.txt", ".zshrc"]) {
    const r = scan(bad);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /--name/, bad);
  }
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f !== "out"), [], "nothing written beside the output folder");
  assert.equal(scan("my-map.html").status, 0);
  assert.ok(fs.existsSync(path.join(out, "my-map.html")));
});
