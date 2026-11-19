// The plugin manifest and skill sit where Claude Code looks for them, and the skill runs the bundled scanner with an
// output folder outside the user's project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
  const runs = [...skill.matchAll(/^node .*$/gm)].map((m) => m[0]);
  assert.ok(runs.length > 0);
  for (const r of runs) {
    assert.match(r, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scan\.mjs" /);
    assert.match(r, /--out "\$HOME\/\.claude-harness-map\/out"/);
  }
  assert.ok(!skill.includes("—"), "no em dashes");
});
