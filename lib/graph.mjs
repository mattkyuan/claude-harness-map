// The graph every adapter fills: nodes, edges, and the add/link helpers that keep ids unique.
import { tilde } from "./util.mjs";

export function createGraph() {
  const nodes = [];
  const edges = [];
  const notes = [];
  const ids = new Set();
  function add(n) {
    if (ids.has(n.id)) return n.id;
    ids.add(n.id);
    nodes.push({ tokens: 0, detail: {}, ...n, source: tilde(n.source) });
    return n.id;
  }
  const link = (from, to, kind) => { if (ids.has(from) && ids.has(to)) edges.push({ from, to, kind }); };
  return { nodes, edges, notes, ids, add, link };
}
