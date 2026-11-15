// Shared MCP helpers: where a server runs, judged from its config. Only the verdict is kept.
// Where a server's process runs, from its config. Only the verdict is kept, never the URL or command.
export const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export function runsFromConfig(cfg, why) {
  if (!cfg) return {};
  if (!cfg.url) {
    // A stdio command can be a thin proxy (mcp-remote and the like) to a server elsewhere.
    // Check every URL in the command, its args and its env values by parsed host, not by string prefix.
    const vals = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : []), ...Object.values(cfg.env && typeof cfg.env === "object" ? cfg.env : {})].map(String);
    let remote = /mcp[-_](remote|proxy)/i.test(vals.join(" ")), unparsed = false;
    const indirect = vals.slice(1).some((v) => /\$\{?[A-Za-z_]|%[A-Za-z_]+%/.test(v));
    // Parse from every "http(s):" start (slashes or backslashes), bounded per value. A token that will not
    // parse, or whose authority holds a backslash or userinfo, counts as remote: the label fails closed.
    for (const raw of vals) {
      const v = raw.slice(0, 4096);
      let seen = 0;
      for (const m of v.matchAll(/\bhttps?:[\\/]+[^\s"'`<>]*/gi)) {
        if (++seen > 50) { remote = true; break; }
        const tok = m[0].replace(/[)\]}.,;|]+$/, "");
        if (/^https?:[\\/]*[^/?#]*\\/i.test(tok)) { remote = true; continue; }
        let u = null; try { u = new URL(tok); } catch { remote = true; continue; }
        if (u.username || u.password || !LOOPBACK.has(u.hostname)) remote = true;
        // A second scheme inside this token gets its own check.
        const inner = tok.slice(5).search(/https?:[\\/]/i);
        if (inner >= 0) { let w = null; try { w = new URL(tok.slice(5 + inner)); } catch { remote = true; } if (w && !LOOPBACK.has(w.hostname)) remote = true; }
      }
    }
    if (remote) return { runs: "remote", runsWhy: `local command that proxies to a remote server (${why})` };
    if (unparsed) return { runs: "unknown", runsWhy: `command holds a URL that could not be read (${why})` };
    if (indirect) return { runs: "unknown", runsWhy: `command reads its target from a variable (${why})` };
    return { runs: "local", runsWhy: `stdio process on your machine (${why})` };
  }
  let host = ""; try { host = new URL(cfg.url).hostname; } catch {}
  return LOOPBACK.has(host) ? { runs: "local", runsWhy: `HTTP server on this machine (${why})` } : { runs: "remote", runsWhy: `HTTP server on another host (${why})` };
}
