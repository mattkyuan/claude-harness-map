// Helpers shared by every harness adapter and the CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
// The home folder can also be reached by its resolved path (a symlinked home, or macOS /var -> /private/var).
export const HOME_REAL = (() => { try { return fs.realpathSync(HOME); } catch { return HOME; } })();
export const tok = (chars) => Math.round(chars / 4);
export const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
export const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
export const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
export const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
// Only the home folder itself or a path inside it: /Users/sam must not turn /Users/samuel/x into ~uel/x.
export const tilde = (p) => {
  if (!p) return p;
  for (const h of [HOME, HOME_REAL]) if (p === h || p.startsWith(h + path.sep)) return "~" + p.slice(h.length);
  return p;
};
export const untilde = (p) => (p && p.startsWith("~") ? HOME + p.slice(1) : p);


// Headings with token sizes, so big files can be opened up in the viewer. Headings are the only text kept.
export function outlineOf(file) {
  let text;
  try { if (fs.statSync(file).size > 2_000_000) return null; text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const sections = [];
  let cur = { level: 0, title: "(before first heading)", chars: 0 };
  let fence = false;
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) { sections.push({ level: 0, title: "(frontmatter)", tokens: tok(fm[0].length) }); text = text.slice(fm[0].length); }
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (h) {
      if (cur.chars || cur.level) sections.push({ level: cur.level, title: cur.title, tokens: tok(cur.chars) });
      cur = { level: h[1].length, title: h[2].slice(0, 80), chars: line.length + 1 };
    } else cur.chars += line.length + 1;
  }
  sections.push({ level: cur.level, title: cur.title, tokens: tok(cur.chars) });
  return sections.filter((s) => s.tokens > 0 || s.level).slice(0, 80);
}


// ---------- values that reach the map from config or session logs ----------
// A hook's program name, never its arguments or the VAR=value assignments before it (those can carry secrets).
// Quotes are honored, so TOKEN="a b" ./x.sh gives "x.sh", not "b". Anything that does not look like a program name
// is written as "command".
export function hookProgram(cmd) {
  const words = [];
  let cur = "", q = null, any = false;
  for (const ch of String(cmd || "")) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) words.push(cur); cur = ""; any = false; continue; }
    cur += ch;
  }
  if (cur || any) words.push(cur);
  const skip = new Set(["env", "sudo", "exec", "command", "nohup"]);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !skip.has(w) && !w.startsWith("-"));
  const base = first ? first.split(/[\\/]/).pop() : "";
  return /^[\w.+-]{1,60}$/.test(base) ? base : "command";
}
// A model name as the map shows it: a plain model id, or "custom model" for anything else (an ARN, a URL, a path).
export const modelName = (m) => (typeof m === "string" && /^[A-Za-z][\w.\[\]-]{0,60}$/.test(m) ? m : m ? "custom model" : null);
// Names that look like a URL, an email or carry a query string are cut down to "<url>", so a server registered
// under its address never writes that address (or a key in it) into the map.
export const redactUrls = (s) => (typeof s === "string" ? s.replace(/[a-z][\w+.-]*:\/\/[^\s"'<>]*/gi, "<url>").replace(/[^\s"'<>/@]+@[^\s"'<>/]+\.[a-z]{2,}/gi, "<email>").replace(/\?[^\s"'<>]*=[^\s"'<>]*/g, "?<query>") : s);
