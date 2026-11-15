// --share: a copy of a snapshot that is safe to post. A normal scan already keeps no secrets, commands,
// URLs or file text, but its names (memory files, skills, servers, plugins, hooks), headings and paths
// still describe your setup. This keeps every number and the shape of the map, and replaces those names
// with "<kind> <n>".

// File names the harness defines, which say nothing about the user.
const GENERIC = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", "MEMORY.md", "settings.json", "settings.local.json", "config.toml", "hooks.json"]);
const KIND_NAME = {
  memory_file: "memory file", memory_files: "memory files", rule: "rule", command: "command", agent: "subagent", skill: "skill",
  skill_entry: "skill", plugin: "plugin", mcp_server: "MCP server", mcp_instructions: "MCP instructions", tool_group: "tool names",
  mcp_usage: "MCP calls", hook: "hook", output_style: "output style", claude_md: "instruction file", agents_md: "instruction file",
  memory_index: "memory index", settings: "settings file", harness_block: "harness note",
};
// Every value below is either a number, a flag, or one of a fixed set the scanner writes itself. A string that only
// looks harmless is not enough: a hook event, MCP type or model name can be anything the user typed.
const num = (x) => (Number.isFinite(x) ? x : 0);
const oneOf = (set, v, other) => (set.has(v) ? v : other);
const day = (t) => (typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : undefined);
const KINDS = new Set([...Object.keys(KIND_NAME), "harness", "harness_block", "skill_listing"]);
const SCOPES = new Set(["managed", "user", "project", "local", "session"]);
const LOADS = new Set(["always", "deferred", "on_demand", "config", "runtime"]);
const EDGE_KINDS = new Set(["called", "configures", "describes", "enables", "exposes", "indexes", "injects", "lists", "provides", "registers", "uses", "imports", "links", "links to", "mentions", "allows", "asks", "blocks"]);
const edgeKind = (k) => EDGE_KINDS.has(k) || /^adds \d{1,4} skills? to$/.test(k);
const TRANSPORTS = new Set(["stdio", "http", "sse", "ws", "streamable-http", "sdk"]);
const STATUSES = new Set(["disabled", "project not trusted", "needs auth", "connecting at start"]);
const RUNS = new Set(["local", "remote", "unknown"]);
const HOOK_TYPES = new Set(["command", "prompt", "agent", "http", "mcp", "callback"]);
const ROLES = new Set(["developer", "user", "system"]);
const HOOK_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
  "SessionStart", "SessionEnd", "PreCompact", "PostCompact", "Notification", "PermissionRequest", "Setup", "TeammateIdle", "TaskCompleted",
  "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "Elicitation", "ElicitationResult"]);
const TOOLS = new Set(["*", "Bash", "Edit", "Write", "Read", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit",
  "TodoWrite", "Skill", "shell", "apply_patch", "exec_command", "local_shell"]);
// Fixed sentences the scanner writes; anything else is dropped.
const FIXED_TEXT = /^[A-Z][\w ,.;:'()+-]{0,160}$/;
const FLAGS = ["unattributed", "confirmedInSession", "loadedInSession", "pathScoped", "privateToYou"];
const COUNTS = ["usedInDays", "calls", "sessionsUsing", "schemaLookups", "sessions", "resultTokensTotal", "count", "allowRules", "askRules",
  "denyRules", "envVars", "listedSkills", "listingTokens", "autoCompactWindow"];
// Plain sentences built from counts and modes; the model name and output style are dropped in shared pages.
const shareAffects = (list) => list.filter((t) => !/^Picks the (model|output style)/.test(t));
// Shared pages name models only when they are a public model family; gateways, ARNs and custom names are not.
const shareModel = (m) => (typeof m === "string" && /^(claude|gpt|o\d|codex|gemini|opus|sonnet|haiku|fable)[\w.\[\]-]{0,50}$/i.test(m) ? m : m ? "custom model" : null);

function shareDetail(d = {}) {
  const out = {};
  for (const k of FLAGS) if (typeof d[k] === "boolean") out[k] = d[k];
  for (const k of COUNTS) if (Number.isFinite(d[k])) out[k] = d[k];
  if (d.transport != null) out.transport = oneOf(TRANSPORTS, d.transport, "other");
  if (d.status != null && STATUSES.has(d.status)) out.status = d.status;
  if (d.runs != null) out.runs = oneOf(RUNS, d.runs, "unknown");
  if (d.event != null) out.event = oneOf(HOOK_EVENTS, d.event, "other");
  if (d.type != null) out.type = oneOf(HOOK_TYPES, d.type, "other");
  if (d.role != null) out.role = oneOf(ROLES, d.role, "other");
  if (typeof d.lastUsed === "string") out.lastUsed = day(d.lastUsed);
  if (typeof d.note === "string" && FIXED_TEXT.test(d.note)) out.note = d.note;
  if (typeof d.storedIn === "string" && FIXED_TEXT.test(d.storedIn.replace(/^your/, "Your"))) out.storedIn = d.storedIn;
  // "Runs" keeps its verdict and the generic reason, without the plugin or file that set it.
  if (typeof d.runsWhy === "string") { const w = d.runsWhy.replace(/\s*\(.*$/, ""); if (/^[\w ,.;:'+-]{0,140}$/.test(w)) out.runsWhy = w; }
  if (Array.isArray(d.affects)) {
    out.affects = shareAffects(d.affects.filter((t) => typeof t === "string").map((t) => t.replace(/\s+/g, " ")))
      .map((t) => (/^Runs hooks on /.test(t) ? "Runs hooks" : t))
      .filter((t) => /^[\w .,:;'()+-]{1,160}$/.test(t));
  }
  if (typeof d.matcher === "string" && d.matcher.split("|").every((t) => TOOLS.has(t))) out.matcher = d.matcher;
  return out;
}

export function shareSnapshot(snap) {
  const harness = snap.harness?.id === "codex" ? { id: "codex", name: "Codex" } : { id: "claude-code", name: "Claude Code" };
  const ids = new Map(), counters = {};
  const newId = (old) => { if (!ids.has(old)) ids.set(old, `n${ids.size + 1}`); return ids.get(old); };
  const nameFor = (n) => {
    if (n.kind === "harness") return "harness (system prompt, tool schemas)";
    if (n.kind === "skill_listing") return `skill listing (${num(n.detail?.count)})`;
    if (GENERIC.has(n.label)) return n.label;
    const k = KIND_NAME[n.kind] || "piece";
    counters[k] = (counters[k] || 0) + 1;
    return `${k} ${counters[k]}`;
  };
  const labelOf = new Map();
  const nodes = snap.nodes.map((n) => {
    const label = nameFor(n);
    labelOf.set(n.id, label);
    return {
      id: newId(n.id), label, kind: oneOf(KINDS, n.kind, "piece"), scope: oneOf(SCOPES, n.scope, "session"), load: oneOf(LOADS, n.load, "config"), tokens: num(n.tokens),
      ...(n.parent ? { parent: newId(n.parent) } : {}),
      source: n.kind === "harness" ? harness.name : undefined,
      detail: shareDetail(n.detail),
    };
  });
  const edges = snap.edges.filter((e) => edgeKind(e.kind) && ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: newId(e.from), to: newId(e.to), kind: e.kind }));
  const s = snap.session || {};
  const session = {
    firstTurnTokens: Number.isFinite(s.firstTurnTokens) ? s.firstTurnTokens : null,
    firstTurnUsage: s.firstTurnUsage && { uncached: num(s.firstTurnUsage.uncached), cacheWrite: num(s.firstTurnUsage.cacheWrite), cacheRead: num(s.firstTurnUsage.cacheRead) },
    model: shareModel(s.model), startedAt: day(s.startedAt),
    contextWindow: Number.isFinite(s.contextWindow) ? s.contextWindow : undefined,
    contextWindowFrom: typeof s.contextWindowFrom === "string" && /^[\w .-]{0,60}$/.test(s.contextWindowFrom) ? s.contextWindowFrom : undefined,
    attribution: s.attribution && { recorded: num(s.attribution.recorded), attributed: num(s.attribution.attributed), unattributed: num(s.attribution.unattributed), ...(s.attribution.over ? { over: num(s.attribution.over) } : {}) },
    hookEvents: s.hookEvents && Object.entries(s.hookEvents).reduce((o, [k, v]) => { const e = oneOf(HOOK_EVENTS, k, "other"); o[e] = (o[e] || 0) + num(v); return o; }, {}),
    turns: Array.isArray(s.turns) ? s.turns.map((t) => (Array.isArray(t) ? t.slice(0, 3).map((x) => (Number.isFinite(x) ? x : 0)) : [0, 0, 0])) : undefined,
    notes: (s.notes || []).filter((t) => typeof t === "string" && FIXED_TEXT.test(t)),
  };
  let previous;
  if (snap.previous) {
    previous = {
      generatedAt: day(snap.previous.generatedAt), firstTurnTokens: Number.isFinite(snap.previous.firstTurnTokens) ? snap.previous.firstTurnTokens : null,
      sameSession: !!snap.previous.transcript && snap.previous.transcript === s.transcript,
      nodes: Object.fromEntries(Object.entries(snap.previous.nodes || {}).map(([id, v]) => [newId(id), {
        tokens: num(v.tokens), kind: oneOf(KINDS, v.kind, "piece"), label: labelOf.get(id) || `removed ${KIND_NAME[v.kind] || "piece"}`,
      }])),
    };
  }
  return {
    version: num(snap.version) || 1, harness, generatedAt: day(snap.generatedAt), project: "a project",
    platform: oneOf(new Set(["darwin", "linux", "win32"]), snap.platform, "other"),
    shared: true, session, totals: { nodes: nodes.length, byLoad: Object.fromEntries(Object.entries(snap.totals?.byLoad || {}).filter(([l]) => LOADS.has(l)).map(([l, v]) => [l, num(v)])) },
    nodes, edges, ...(previous ? { previous } : {}),
  };
}
