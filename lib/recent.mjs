// Recent projects: folders each harness was last used in, folded to their main checkout and newest first.
// Adapters report raw { dir, at } pairs; this folds worktrees into the repo they belong to, drops folders
// that are gone or are scratch space, and merges the harnesses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, HOME_REAL } from "./util.mjs";

const real = (d) => { try { return fs.realpathSync(d); } catch { return d; } };

const SCRATCH = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", path.join(HOME, ".claude"), path.join(HOME, ".codex")]
  .flatMap((d) => { try { return [d, fs.realpathSync(d)]; } catch { return [d]; } })
  // A home folder inside temp space (a test fixture) keeps its own projects.
  .filter((d) => !(HOME + path.sep).startsWith(d + path.sep));

// A worktree's .git is a file pointing into the main repo's .git/worktrees/<name>: map it back to that repo.
export function mainCheckout(dir) {
  const cut = dir.match(/^(.*?)\/\.(claude|codex)\/worktrees\//);
  if (cut) return cut[1];
  try {
    const dotgit = path.join(dir, ".git");
    if (fs.statSync(dotgit).isFile()) {
      const m = fs.readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
      const w = m && m[1].match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
      if (w) return path.resolve(dir, w[1]);
    }
  } catch {}
  return dir;
}

export function recentProjects(adapters, { limit = 4, exclude = [] } = {}) {
  const best = new Map();
  const skip = new Set(exclude.map((d) => real(path.resolve(d))));
  for (const a of adapters) {
    let raw = [];
    try { raw = a.recentProjects?.() || []; } catch {}
    for (const { dir, at } of raw) {
      if (typeof dir !== "string" || !path.isAbsolute(dir) || !Number.isFinite(at)) continue;
      const main = mainCheckout(path.resolve(dir)), key = real(main);
      if (key === HOME_REAL || skip.has(key) || SCRATCH.some((s) => main === s || main.startsWith(s + path.sep))) continue;
      try { if (!fs.statSync(main).isDirectory()) continue; } catch { continue; }
      if (!best.has(key) || best.get(key).at < at) best.set(key, { dir: main, at });
    }
  }
  return [...best.values()].sort((x, y) => y.at - x.at).slice(0, Math.max(0, limit)).map((b) => b.dir);
}
