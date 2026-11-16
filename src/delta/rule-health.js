// Rule check: which kinds of flag get acted on, and which sit there ignored.
//
// A flag that nobody acts on is noise, and noise is what makes the real P1s easy to miss.
// This counts, for each rule over the last two weeks of official readouts, how many
// distinct flags it raised and what became of each one:
//
//   acted      Alex marked it Done or Waiting on someone
//   dismissed  Alex marked it Not a problem
//   cleared    it stopped being raised without Alex touching it (the team fixed it);
//              `fast` of those were gone within two readouts
//   ignored    still raised today, untouched, and open a working week or more
//
// Verdicts:
//   needs you      Alex acts on a fair share of them
//   ignored        never acted on, and most sit untouched or get marked not a problem.
//                  Suggested for Hygiene: still listed, never in the queue, never
//                  escalated. The numbers go with the suggestion so the call is Alex's,
//                  and a quieted rule can be brought back at any time.
//   clears itself  never acted on, and most are gone within two days anyway. Shown, not
//                  suggested: the team may be fixing them because the readout asked.
//   mixed          anything else, or too few to say
//
// Plain counting over stored reports. Nothing here decides; it only reports and suggests.

import { isContext } from "./flags.js";

export const RULE_HEALTH_DEFAULTS = { lookbackDays: 14, minRaised: 3, ignoredAfterWorkingDays: 5 };

const ACTED = new Set(["done", "waiting"]);

/** A flag raised at P2 by its rule, so moving it to Hygiene means something. */
const atAttention = (f) => f.severity === "attention" || f.originalSeverity === "attention" || f.quieted === true;

/**
 * @param {object} args
 * @param {Array<{dateKey:string, flags:object[]}>} args.history  past official readouts, any order
 * @param {object[]} args.today        today's annotated flags (age and triage on them)
 * @param {string} args.dateKey
 * @param {Set<string>|string[]} [args.quiet]  rules already moved to Hygiene
 * @param {object} [args.opts]
 */
export function ruleHealth({ history = [], today = [], dateKey, quiet = [], opts = {} }) {
  const o = { ...RULE_HEALTH_DEFAULTS, ...opts };
  const quietSet = new Set(quiet);
  const days = [...history].filter((r) => r?.dateKey && r.dateKey < dateKey).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const all = [...days, { dateKey, flags: today }];

  const keys = new Map(); // key -> { rule, statuses:Set, attention:boolean }
  for (const day of all) {
    for (const f of day.flags ?? []) {
      if (isContext(f) || !f.rule) continue;
      const key = f.key ?? String(f.id ?? "").replace(/^(\d{4}-\d{2}-\d{2}|nodate):/, "");
      if (!keys.has(key)) keys.set(key, { rule: f.rule, statuses: new Set(), attention: false, seen: 0 });
      const k = keys.get(key);
      k.seen += 1;
      if (f.triage?.status) k.statuses.add(f.triage.status);
      if (atAttention(f)) k.attention = true;
    }
  }
  const todayByKey = new Map(today.filter((f) => f.key).map((f) => [f.key, f]));

  const rules = new Map();
  for (const [key, k] of keys) {
    if (!rules.has(k.rule)) rules.set(k.rule, { rule: k.rule, raised: 0, acted: 0, dismissed: 0, cleared: 0, fast: 0, ignored: 0, open: 0, canQuiet: false });
    const r = rules.get(k.rule);
    r.raised += 1;
    if (k.attention) r.canQuiet = true;
    const acted = [...k.statuses].some((s) => ACTED.has(s));
    const now = todayByKey.get(key);
    if (acted) r.acted += 1;
    else if (k.statuses.has("dismissed")) r.dismissed += 1;
    else if (!now) {
      r.cleared += 1;
      if (k.seen <= 2) r.fast += 1;
    }
    else if (!now.triage && (now.openDays ?? 0) >= o.ignoredAfterWorkingDays) r.ignored += 1;
    else r.open += 1;
  }

  const out = [...rules.values()].map((r) => {
    const quieted = quietSet.has(r.rule);
    let verdict = "mixed";
    if (r.raised >= o.minRaised) {
      if (r.acted >= Math.max(1, r.raised / 4)) verdict = "needs you";
      else if (r.acted === 0 && r.ignored + r.dismissed >= Math.max(2, r.raised / 2)) verdict = "ignored";
      else if (r.acted === 0 && r.fast >= r.raised * 0.6) verdict = "clears itself";
    }
    return { ...r, quiet: quieted, canQuiet: r.canQuiet || quieted, verdict, suggest: verdict === "ignored" && !quieted && r.canQuiet };
  });
  const rank = { ignored: 0, "clears itself": 1, mixed: 2, "needs you": 3 };
  out.sort((a, b) => b.suggest - a.suggest || rank[a.verdict] - rank[b.verdict] || b.raised - a.raised || a.rule.localeCompare(b.rule));

  return {
    since: days[0]?.dateKey ?? dateKey,
    readouts: all.length,
    rules: out,
    suggested: out.filter((r) => r.suggest).length,
  };
}

/**
 * Moves a quieted rule's P2 flags to Hygiene before ages and escalation are worked out, so
 * a quiet rule never climbs back to P1 by age. P1s are never touched.
 */
export function applyQuietRules(flags, quiet) {
  const set = new Set(quiet);
  if (!set.size) return flags;
  return flags.map((f) => (set.has(f.rule) && f.severity === "attention" && !isContext(f) ? { ...f, severity: "info", quieted: true } : f));
}

/** "Quiet: 0 of 9 acted on. 6 sat a week or more untouched, 1 cleared on its own." */
export function ruleHealthLine(r) {
  const parts = [`${r.acted} of ${r.raised} acted on`];
  if (r.ignored) parts.push(`${r.ignored} sat a working week or more untouched`);
  if (r.dismissed) parts.push(`${r.dismissed} marked not a problem`);
  if (r.cleared) parts.push(`${r.cleared} cleared without you${r.fast ? ` (${r.fast} within two days)` : ""}`);
  if (r.open) parts.push(`${r.open} open under a week`);
  return parts.join(", ");
}
