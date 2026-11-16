// One line per person instead of one per ticket.
//
// Most of a morning's flags are the same few sprint checks (overdue, not started, carried
// over, no owner, stuck in a status) spread across a handful of people. Listed one by one
// they bury the P1s; grouped they read "Akansha: 4 overdue, 1 carried over", which is one
// conversation, not five. Only those routine sprint checks at P2 are grouped. A P1 (an
// escalated one included), a test, a rock and anything waiting on Alex's own reply stay
// on their own.
//
// Shared by the dashboard (public/app.js) and the readout (src/render/report.js), so the
// two group the same flags under the same names. Plain functions, no DOM.

/** The routine sprint checks, and how each reads in a group's summary. */
export const ROUTINE_RULES = {
  "nextstep.overdue": "overdue",
  "nextstep.due_not_started": "due soon, not started",
  "nextstep.commitment_at_risk": "not started midweek",
  "nextstep.carried_over": "carried over",
  "nextstep.too_much_in_progress": "in progress at once",
  "nextstep.idle": "nothing in progress",
  "nextstep.bounced_back": "bounced back",
  "nextstep.question_unanswered": "question unanswered",
  "clickup.no_task_owner": "no owner",
  "clickup.stale_in_status": "stuck in a status",
  "clickup.stalled": "untouched",
};

// The order the summary lists them in: the commitments first, the hygiene last.
const SUMMARY_ORDER = Object.keys(ROUTINE_RULES);

export const YOU = "You";
export const NOBODY = "Nobody assigned";

/** A routine check at P2, so it can share a line with the person's others. */
export const isRoutine = (flag) => flag?.layer === 2 && flag.severity === "attention" && Object.hasOwn(ROUTINE_RULES, flag.rule);

const firstName = (name) => String(name ?? "").trim().split(/[\s,]+/)[0] || null;

/**
 * Who to talk to about a flag: the person the check named, else whoever is assigned to
 * the ticket. Alex's own items group under "You", since nobody needs nudging for them.
 *
 * @param {object} flag
 * @param {object} [opts]
 * @param {Map<string, object>} [opts.tasks]   ticket id -> ticket, for checks that name nobody
 * @param {string} [opts.alexName]             Alex's name, to recognise Alex's own items
 */
export function personOf(flag, { tasks = new Map(), alexName = null } = {}) {
  const v = flag.values ?? {};
  let who = null;
  if (typeof v.who === "string" && v.who && v.who !== "the owner") who = v.who;
  else if (Array.isArray(v.assignees) && v.assignees.length) who = v.assignees[0];
  else if (typeof v.assignees === "string" && v.assignees) who = v.assignees;
  else if (typeof v.owner === "string" && v.owner) who = v.owner;
  else if (flag.subject?.type === "person" && flag.subject.label) who = flag.subject.label;
  else {
    const task = tasks.get(String(flag.subject?.id ?? "").split(":")[0]);
    const person = task?.assignees?.[0] ?? task?.taskOwners?.[0];
    who = person?.username ?? person?.name ?? null;
  }
  const first = firstName(who);
  if (!first) return NOBODY;
  if (first.toLowerCase() === "you") return YOU;
  if (alexName && first.toLowerCase() === firstName(alexName)?.toLowerCase()) return YOU;
  return first;
}

/** How many tickets a flag stands for: one, or the list a per-person check carries. */
export function ticketCount(flag) {
  if (Array.isArray(flag.values?.tickets) && flag.values.tickets.length) return flag.values.tickets.length;
  if (flag.rule === "nextstep.too_much_in_progress") return Number(flag.values?.count) || 1;
  return 1;
}

/** "4 overdue, 1 carried over, 2 no owner". */
export function groupSummary(flags) {
  const counts = new Map();
  for (const f of flags) counts.set(f.rule, (counts.get(f.rule) ?? 0) + (f.rule === "nextstep.idle" ? 1 : ticketCount(f)));
  return SUMMARY_ORDER.filter((r) => counts.has(r))
    .map((r) => (r === "nextstep.idle" ? ROUTINE_RULES[r] : `${counts.get(r)} ${ROUTINE_RULES[r]}`))
    .join(", ");
}

/**
 * Splits flags into per-person groups and the flags that stay on their own. A person with
 * a single routine flag keeps it as it is: a group of one is just a longer line.
 *
 * Order is kept: each group sits where its first flag was, and its flags keep their order.
 *
 * @returns {{ items: Array<{kind:'flag', flag:object} | {kind:'group', person:string, flags:object[], summary:string}>, groups: object[] }}
 */
export function groupByPerson(flags, opts = {}) {
  const byPerson = new Map();
  for (const f of flags) {
    if (!isRoutine(f)) continue;
    const p = personOf(f, opts);
    if (!byPerson.has(p)) byPerson.set(p, []);
    byPerson.get(p).push(f);
  }
  const grouped = new Map([...byPerson].filter(([, list]) => list.length > 1));
  const items = [];
  const placed = new Set();
  for (const f of flags) {
    const p = isRoutine(f) ? personOf(f, opts) : null;
    if (p && grouped.has(p)) {
      if (placed.has(p)) continue;
      placed.add(p);
      const list = grouped.get(p);
      items.push({ kind: "group", person: p, flags: list, summary: groupSummary(list) });
    } else {
      items.push({ kind: "flag", flag: f });
    }
  }
  return { items, groups: items.filter((i) => i.kind === "group") };
}

/** "Akansha · 6 sprint items: 4 overdue, 1 carried over, 1 no owner". */
export function groupLine(group) {
  const n = group.flags.length;
  const who = group.person === YOU ? "Yours" : group.person;
  return `${who} · ${n} sprint item${n === 1 ? "" : "s"}: ${group.summary}`;
}
