// The first-turn total is recorded by the harness; each piece's size is an estimate (characters / 4).
// The harness slice is what is left: recorded total minus every piece this map can size. When the
// estimates add up to more than the recorded total, say so instead of hiding it behind a zero.
export function addRemainder({ add, session, byLoad, label, source }) {
  if (!session.firstTurnTokens) return;
  const attributed = (byLoad.always || 0) + (byLoad.deferred || 0);
  const rest = Math.max(0, session.firstTurnTokens - attributed);
  session.attribution = { recorded: session.firstTurnTokens, attributed, unattributed: rest };
  add({
    id: "harness", label, kind: "harness", scope: "session", load: "always", tokens: rest, source,
    detail: { note: "Not measured directly: the recorded first-turn total minus every piece this map can size", unattributed: true },
  });
  byLoad.always = (byLoad.always || 0) + rest;
  if (attributed > session.firstTurnTokens) {
    session.attribution.over = attributed - session.firstTurnTokens;
    session.notes.push(`Piece estimates add up to ${attributed - session.firstTurnTokens} tokens more than the recorded first turn, so sizes are approximate.`);
  }
}
