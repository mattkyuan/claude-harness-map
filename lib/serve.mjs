// --serve: the map on a local address with a Rescan button. Listens on 127.0.0.1 only, and every request needs
// a random token printed once in the terminal, so other pages open in your browser cannot read the map or start scans.
// It serves the generated page, runs the scan again on request, lists folder names for the folder picker and maps a
// folder you pick. It never serves file contents.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tilde, untilde } from "./util.mjs";

// Constant-time compare on bytes: two strings of equal length can still differ in byte length (é is two bytes).
const same = (a, b) => {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = (req, name) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];

// Folder names under a folder, for the picker's suggestions. Names only, never files or what is in them.
function listDirs(raw) {
  const dir = path.resolve(untilde(String(raw || "~")));
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 300);
  return { dir: tilde(dir), entries };
}
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > limit) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// A page that forwards the browser to the keyed address, in a folder only you can read. The browser is opened on this
// file, so the key never appears on a command line where another user could see it in a process list.
function openerFile(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-map-"));
  const file = path.join(dir, "open.html");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${url}"><title>Opening the map</title>`, { mode: 0o600 });
  // Gone once the browser has read it.
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 30000).unref();
  return file;
}

export function startServer({ port, pagePath, rescan, addProject }) {
  const token = crypto.randomBytes(24).toString("base64url");
  let running = null;
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); } catch (e) {
      console.error(`Request failed: ${e?.message || e}`);
      if (!res.headersSent) { res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("Bad request."); }
    }
  });
  async function handle(req, res) {
    const addr = server.address();
    const hosts = [`127.0.0.1:${addr.port}`, `localhost:${addr.port}`];
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
    const send = (code, type, body) => { res.writeHead(code, { ...headers, "Content-Type": type }); res.end(body); };
    // A page on another site that points a name of its own at 127.0.0.1 still sends its own Host: refuse it.
    if (!hosts.includes(req.headers.host)) return send(403, "text/plain", "Wrong host.");
    const url = new URL(req.url.replace(/^\/+/, "/"), `http://${req.headers.host}`);
    const cookieName = `harness_map_${addr.port}`;
    const enter = (where) => { res.writeHead(303, { ...headers, Location: where, "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` }); res.end(); };
    if (req.method === "GET" && url.pathname === "/") {
      // The printed address carries the key once: it is swapped for a cookie and the address is cleaned, so the key
      // does not stay in the address bar or browser history.
      if (url.searchParams.has("token")) {
        if (!same(url.searchParams.get("token"), token)) return send(403, "text/plain", "Open the address printed in the terminal.");
        url.searchParams.delete("token");
        return enter(`/${url.search}`);
      }
      if (!same(cookieOf(req, cookieName), token)) return send(403, "text/plain", "Open the address printed in the terminal.");
      let html;
      try { html = fs.readFileSync(pagePath, "utf8"); } catch { return send(500, "text/plain", "The page has not been written yet."); }
      return send(200, "text/html; charset=utf-8", html.replace("/*__SERVE__*/null", () => JSON.stringify({ token })));
    }
    // Everything past the page needs the key in a header. A custom header cannot be sent cross-site without a
    // preflight this server never answers.
    if (!same(req.headers["x-harness-token"], token)) return send(403, "text/plain", "Bad token.");
    if (req.headers.origin && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return send(403, "text/plain", "Wrong origin.");
    const json = (code, obj) => send(code, "application/json", JSON.stringify(obj));
    if (req.method === "GET" && url.pathname === "/dirs") {
      try { return json(200, listDirs(url.searchParams.get("path"))); } catch { return json(404, { entries: [] }); }
    }
    if (req.method === "POST" && url.pathname === "/project") {
      let dir;
      try { dir = untilde(String(JSON.parse(await readBody(req)).dir || "").trim()); } catch { return json(400, { error: "Send a folder path." }); }
      if (!path.isAbsolute(dir)) return json(400, { error: "Use a full path, starting with ~ or /." });
      dir = path.resolve(dir);
      try { if (!fs.statSync(dir).isDirectory()) throw 0; } catch { return json(404, { error: "No folder at that path." }); }
      try {
        if (running) await running.catch(() => {});
        const project = await (running = addProject(dir).finally(() => { running = null; }));
        return json(200, { project });
      } catch (e) {
        console.error(`Mapping the folder failed: ${e?.message || e}`);
        return json(500, { error: "The scan failed: see the terminal." });
      }
    }
    if (req.method === "POST" && url.pathname === "/rescan") {
      try {
        running ||= rescan().finally(() => { running = null; });
        await running;
        return send(200, "application/json", JSON.stringify({ ok: true }));
      } catch (e) {
        console.error(`Rescan failed: ${e?.message || e}`);
        return send(500, "application/json", JSON.stringify({ ok: false }));
      }
    }
    send(404, "text/plain", "Not found.");
  }
  return new Promise((resolve, reject) => {
    const listen = (p) => {
      server.once("error", (e) => (e.code === "EADDRINUSE" && p !== 0 ? listen(0) : reject(e)));
      server.listen(p, "127.0.0.1", () => resolve({ server, token, url: `http://127.0.0.1:${server.address().port}/?token=${token}`, openerFile: () => openerFile(`http://127.0.0.1:${server.address().port}/?token=${token}`) }));
    };
    listen(port);
  });
}
