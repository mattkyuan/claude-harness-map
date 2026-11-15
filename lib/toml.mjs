// A small TOML reader: enough for harness config files (tables, dotted and quoted keys, strings,
// numbers, booleans, arrays, inline tables). Not a full TOML implementation; anything it cannot read
// is skipped rather than guessed.

function parseValue(src, i) {
  const ws = () => { while (i < src.length && /[ \t\r\n]/.test(src[i])) i++; };
  const skipComments = () => { for (;;) { ws(); if (src[i] === "#") { while (i < src.length && src[i] !== "\n") i++; } else return; } };
  ws();
  const c = src[i];
  if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
    const q = src.slice(i, i + 3), end = src.indexOf(q, i + 3);
    const raw = src.slice(i + 3, end < 0 ? src.length : end).replace(/^\r?\n/, "");
    return [q === '"""' ? unescape(raw) : raw, end < 0 ? src.length : end + 3];
  }
  if (c === '"') {
    let j = i + 1, out = "";
    while (j < src.length && src[j] !== '"') { if (src[j] === "\\") { out += src.slice(j, j + 2); j += 2; } else out += src[j++]; }
    return [unescape(out), j + 1];
  }
  if (c === "'") { const end = src.indexOf("'", i + 1); return [src.slice(i + 1, end), end + 1]; }
  if (c === "[") {
    const arr = []; i++;
    for (;;) {
      skipComments();
      if (src[i] === "]") return [arr, i + 1];
      const [v, j] = parseValue(src, i); arr.push(v); i = j;
      skipComments();
      if (src[i] === ",") i++;
      else if (src[i] === "]") return [arr, i + 1];
      else return [arr, i];
    }
  }
  if (c === "{") {
    const obj = {}; i++;
    for (;;) {
      ws();
      if (src[i] === "}") return [obj, i + 1];
      const km = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=/.exec(src.slice(i));
      if (!km) return [obj, src.indexOf("}", i) + 1 || src.length];
      i += km[0].length;
      const [v, j] = parseValue(src, i); setPath(obj, splitKey(km[1]), v); i = j;
      ws();
      if (src[i] === ",") i++;
    }
  }
  const m = /^[^\s,\]}#]+/.exec(src.slice(i));
  const tok = m ? m[0] : "";
  const v = tok === "true" ? true : tok === "false" ? false : /^[+-]?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/.test(tok) ? Number(tok.replace(/_/g, "")) : tok;
  return [v, i + tok.length];
}

function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) =>
    e[0] === "u" || e[0] === "U" ? String.fromCodePoint(parseInt(e.slice(1), 16)) : ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[e] ?? e));
}

function splitKey(k) {
  const parts = [];
  for (const m of k.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s]+)/g)) parts.push(m[1] !== undefined ? unescape(m[1]) : m[2] ?? m[3]);
  return parts;
}

function setPath(obj, keys, v) {
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return;
    o = Object.hasOwn(o, k) && typeof o[k] === "object" ? o[k] : (o[k] = Object.create(null));
  }
  const last = keys[keys.length - 1];
  if (last !== "__proto__" && last !== "constructor" && last !== "prototype") o[last] = v;
}

export function parseToml(src) {
  const root = Object.create(null);
  let table = root, i = 0;
  while (i < src.length) {
    while (i < src.length && /[ \t\r\n]/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src[i] === "[") {
      const arrayTable = src[i + 1] === "[";
      const end = src.indexOf(arrayTable ? "]]" : "]", i);
      const keys = splitKey(src.slice(i + (arrayTable ? 2 : 1), end).trim());
      i = end + (arrayTable ? 2 : 1);
      table = root;
      for (const [n, k] of keys.entries()) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") { table = Object.create(null); break; }
        if (arrayTable && n === keys.length - 1) {
          const list = Array.isArray(table[k]) ? table[k] : (table[k] = []);
          list.push((table = Object.create(null)));
        } else {
          table = Object.hasOwn(table, k) && typeof table[k] === "object" ? (Array.isArray(table[k]) ? table[k][table[k].length - 1] : table[k]) : (table[k] = Object.create(null));
        }
      }
      continue;
    }
    const km = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\-"' ]+?)\s*=/.exec(src.slice(i));
    if (!km) { while (i < src.length && src[i] !== "\n") i++; continue; }
    i += km[0].length;
    const [v, j] = parseValue(src, i);
    setPath(table, splitKey(km[1].trim()), v);
    i = j;
    while (i < src.length && src[i] !== "\n") i++;
  }
  return root;
}
