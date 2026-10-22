// Today's 3. On a busy morning, the three things to do first.
//
// A ranking, not a judgement: the same flags, ordered by how much each one costs to leave.
// Severity first (a P1 outranks any amount of age), then how long it has been left, then
// whether it touches a rock, because the rocks are what leadership is tracking. Only
// open flags that ask for action count: context (store moves), hygiene and anything
// already handled are not candidates.
//
// The dashboard ranks with a copy of this function so it can re-rank as flags are
// handled during the day. The two must agree; the test pins the order.

import { isContext } from "./flags.js";

const BASE = { p1: 100, attention: 50, prompt: 40 };

export function priorityScore(flag) {
  const base = BASE[flag.severity];
  if (base == null) return null;
  const age = Math.min(flag.openDays ?? 0, 10) * 3;
  const escalated = flag.escalated ? 10 : 0;
  const rock = flag.layer === 1 || flag.subject?.type === "priority" || flag.rule === "intelligems.ready_for_call" ? 15 : 0;
  return base + age + escalated + rock;
}

/** The top `n` open, actionable flags, highest score first; ties keep the readout's order. */
export function topFlags(flags, n = 3) {
  return flags
    .map((flag, index) => ({ flag, index, score: flag.triage || isContext(flag) ? null : priorityScore(flag) }))
    .filter((x) => x.score != null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, n)
    .map((x) => x.flag);
}
