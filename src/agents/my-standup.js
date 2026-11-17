// My stand-up: Alex's own Yesterday / Today / Blockers, drafted from what Alex actually
// did, ready to paste into #ecomm-team.
//
//   Yesterday: sesame street feedback + planning
//   Today: qa + wrap up ss feedback and send to review async + All-in-1 Core Bundle Next Steps
//   Blockers: need X from Y person
//
// The facts are gathered by code, each with an id:
//
//   plan      Alex's last stand-up in the channel: its Today is what Alex meant to do
//             yesterday. Alex's recent posts also go in as the style to match.
//   clickup   from the latest readout: Alex's tickets that moved, closed, were created
//             or got Alex's comment since the previous readout; and Alex's open tickets,
//             in progress first, with due dates
//   slack     Alex's own messages since the start of the previous working day, from
//             Slack search. Needs a user token (SLACK_USER_TOKEN, scope search:read):
//             the bot cannot be in every channel, and cannot see DMs at all. Only
//             messages FROM Alex are asked for.
//   notes     Alex's day notes (the Daily Speech box and /tpnote)
//   waiting   flags Alex marked "Waiting on someone": the blockers
//   reply     replies Alex owes, from the readout
//   week      this week's Quarter plan items not yet done
//   focus     Today's rock moves: the ones done on the previous working day, and the ones
//             picked for today (src/focus/moves.js)
//
// Then one Anthropic call writes the three lines, citing the fact ids behind each. Code
// drops any cited id that does not exist and flags a line that cites nothing, so every
// line can be traced to something real. Nothing is posted anywhere: Alex copies it.

import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ask, readSkill } from "./anthropic.js";
import { fetchStandups, slackGet } from "../collectors/standup.js";
import { FocusStore } from "../focus/moves.js";
import { xfSince, namedText } from "../collectors/xf.js";
import { notesForSpeech } from "../store/day-notes.js";
import { FlagLedger, activeTriage } from "../store/flag-ledger.js";
import { QuarterPlanStore } from "../store/quarter-plan.js";
import { dateKey as zonedDateKey, previousWorkingDayKey } from "../lib/time.js";
import { quarterOfKey, weekStartOf } from "../../public/quarter.js";

export const MY_STANDUP_KEY = "mystandup/latest.json";
export const MY_STANDUP_STATUS_KEY = "mystandup/status.json";
export const myStandupHistoryKey = (dateKey) => `mystandup/history/${dateKey}.json`;

const MAX_SLACK = 60;
const clip = (s, n = 280) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const LINE = {
  type: "object",
  properties: {
    text: { type: "string", description: "the line's content, without its label" },
    sources: { type: "array", items: { type: "string" }, description: "ids of the facts this line is built from" },
  },
  required: ["text", "sources"],
  additionalProperties: false,
};
const SCHEMA = {
  type: "object",
  properties: { yesterday: LINE, today: LINE, blockers: LINE },
  required: ["yesterday", "today", "blockers"],
  additionalProperties: false,
};

const mineBy = (alexId) => (t) =>
  alexId != null && (t.assignees ?? []).some((u) => String(u.id) === String(alexId));

/**
 * Everything the draft may draw on, as numbered facts. Pure apart from the reads passed in.
 *
 * @returns {{ facts: object[], style: string[], posted: object|null, since: string }}
 */
// One letter per kind, so no two kinds share an id prefix ("week" and "waiting" did).
const PREFIX = { plan: "p", clickup: "c", reply: "r", week: "k", focus: "f", slack: "s", note: "n", waiting: "w" };

export function standupFacts({ config, now, report, standups, slack, notes, waiting, plan, focus }) {
  const tz = config.system.timezone;
  const today = zonedDateKey(now, tz);
  const alex = config.people?.alex ?? {};
  const facts = [];
  const add = (kind, text, extra = {}) => {
    const id = `${PREFIX[kind] ?? kind[0]}${facts.filter((f) => f.kind === kind).length + 1}`;
    facts.push({ id, kind, text, ...extra });
  };

  // Alex's own stand-ups, newest first.
  const mine = (standups?.days ?? []).flatMap((d) => d.posts.filter((p) => p.name === alex.name).map((p) => ({ ...p, dateKey: d.dateKey })));
  const posted = mine.find((p) => p.dateKey === today) ?? null;
  const last = mine.find((p) => p.dateKey < today) ?? null;
  if (last?.today) add("plan", `On ${last.dateKey} Alex said Today: ${clip(last.today, 400)}`, { date: last.dateKey });
  if (last?.blockers) add("plan", `On ${last.dateKey} Alex said Blockers: ${clip(last.blockers, 300)}`, { date: last.dateKey });
  const style = mine
    .filter((p) => p.dateKey !== today)
    .slice(0, 5)
    .map((p) => [`Yesterday: ${p.yesterday ?? ""}`, `Today: ${p.today ?? ""}`, `Blockers: ${p.blockers ?? ""}`].join("\n"));

  // ClickUp: what moved on Alex's tickets since the previous readout, and what is open.
  const isMine = mineBy(alex.clickupUserId);
  const changes = report?.detail?.clickup?.changes ?? {};
  const seen = new Set();
  const moved = (t, what) => {
    if (seen.has(`${t.id}:${what}`)) return;
    seen.add(`${t.id}:${what}`);
    add("clickup", `${what}: "${clip(t.name, 120)}"`, { url: t.url ?? null });
  };
  for (const t of changes.closed ?? []) if (isMine(t)) moved(t, "Closed");
  for (const t of changes.statusChanges ?? []) if (isMine(t)) moved(t, `Moved ${t.from} → ${t.to}`);
  for (const t of changes.newTasks ?? []) if (isMine(t)) moved(t, "New ticket");
  const since = xfSince(now, config).getTime();
  for (const t of report?.detail?.clickup?.tasks ?? []) {
    const c = t.lastComment;
    if (c && String(c.userId) === String(alex.clickupUserId) && Number(c.date) >= since) {
      add("clickup", `Alex commented on "${clip(t.name, 120)}": ${clip(c.text, 200)}`, { url: t.url ?? null });
    }
  }
  const open = (report?.detail?.clickup?.tasks ?? []).filter((t) => isMine(t) && t.bucket !== "done" && !t.archived);
  const rank = (t) => (t.bucket === "inProgress" ? 0 : 1);
  for (const t of open.sort((a, b) => rank(a) - rank(b) || Number(a.dueDate ?? Infinity) - Number(b.dueDate ?? Infinity)).slice(0, 15)) {
    const due = t.dueDate ? zonedDateKey(new Date(Number(t.dueDate)), tz) : null;
    add("clickup", `Open, ${t.status}${due ? `, due ${due}${due < today ? " (overdue)" : due === today ? " (today)" : ""}` : ""}: "${clip(t.name, 120)}"`, { url: t.url ?? null });
  }

  // Replies Alex owes, and this week's planned work.
  for (const f of (report?.flags ?? []).filter((f) => f.rule === "nextstep.reply_owed" && !f.triage).slice(0, 6)) add("reply", clip(f.message, 220));
  const week = weekStartOf(today);
  for (const p of (plan?.items ?? []).filter((p) => p.week === week && !p.done)) add("week", `Planned this week: ${clip(p.text, 160)}`);

  // Today's rock moves: what Alex finished on the previous working day, and picked for today.
  const rockOf = (m) => (m.impact?.rockTitle ? ` (moves ${m.impact.rockTitle})` : "");
  for (const m of (focus?.yesterday?.picks ?? []).filter((m) => m.doneAt)) add("focus", `Done ${focus.yesterday.dateKey}, a rock move Alex picked: ${clip(m.text, 160)}${rockOf(m)}`);
  for (const m of (focus?.yesterday?.picks ?? []).filter((m) => !m.doneAt)) add("focus", `Picked for ${focus.yesterday.dateKey} and not marked done: ${clip(m.text, 160)}${rockOf(m)}`);
  for (const m of (focus?.today?.picks ?? []).filter((m) => !m.doneAt)) add("focus", `Picked as today's rock move: ${clip(m.text, 160)}${rockOf(m)}`);

  // Slack, Alex's own words.
  for (const m of (slack?.messages ?? []).slice(0, MAX_SLACK)) add("slack", `${m.day} in ${m.where}: ${clip(m.text)}`, { url: m.url ?? null, date: m.day });

  for (const n of notes ?? []) add("note", `${n.dateKey ?? ""} note: ${clip(n.text, 400)}`);
  for (const w of waiting ?? []) add("waiting", `Waiting on ${w.waitingOn} (since ${w.at.slice(0, 10)}): ${clip(w.what, 200)}`);

  return { facts, style, posted, today, since: new Date(since).toISOString() };
}

/**
 * Alex's own Slack messages since `since`, from search. Null when there is no user token,
 * so the page can say how to add one. Channel names only; a DM is "a DM". No Slack id is
 * kept: mentions become names through users.info on the bot token.
 */
export async function alexSlack({ config, env = process.env, logger, fetchImpl, since }) {
  const userToken = env.SLACK_USER_TOKEN;
  const alexId = config.people?.alex?.slackUserId;
  if (!userToken) return null;
  if (!alexId) return { messages: [], note: "Alex's Slack user id is not in config/people.json, so Alex's messages cannot be searched." };
  const tz = config.system.timezone;
  // Slack's after: is exclusive and by day, so ask from the day before and trim by time.
  const after = zonedDateKey(new Date(since.getTime() - 86400000), tz);
  const ctx = { token: userToken, config, logger, fetchImpl };
  const found = [];
  for (let page = 1; page <= 3; page++) {
    const body = await slackGet("search.messages", { query: `from:<@${alexId}> after:${after}`, sort: "timestamp", sort_dir: "asc", count: "100", page: String(page) }, ctx);
    found.push(...(body.messages?.matches ?? []));
    if (page >= (body.messages?.paging?.pages ?? 1)) break;
  }
  const names = new Map();
  const nameOf = (id) => names.get(id) ?? null;
  const ids = new Set(found.flatMap((m) => [...String(m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1])));
  for (const id of ids) {
    try {
      const u = await slackGet("users.info", { user: id }, { ...ctx, token: env.SLACK_BOT_TOKEN ?? userToken });
      names.set(id, u.user?.real_name || u.user?.profile?.display_name || null);
    } catch {
      names.set(id, null);
    }
  }
  const messages = found
    .filter((m) => Number(m.ts) * 1000 >= since.getTime() && String(m.text ?? "").trim())
    .map((m) => ({
      day: zonedDateKey(new Date(Number(m.ts) * 1000), tz),
      where: m.channel?.is_im || m.channel?.is_mpim ? "a DM" : m.channel?.name ? `#${m.channel.name}` : "Slack",
      text: namedText(m.text, nameOf),
      url: m.permalink ?? null,
    }));
  return { messages, note: null };
}

/** The draft's three lines, with sources that exist, and a word on any line that has none. */
export function checkDraft(parsed, facts) {
  const ids = new Set(facts.map((f) => f.id));
  const out = {};
  const unsupported = [];
  for (const k of ["yesterday", "today", "blockers"]) {
    const line = parsed?.[k];
    if (!line || typeof line.text !== "string") return null;
    const sources = [...new Set((line.sources ?? []).filter((s) => ids.has(s)))];
    const text = line.text.trim().replace(/^(yesterday|today|blockers)\s*:\s*/i, "");
    const empty = k === "blockers" && /^(none|nothing|no blockers|n\/a)\.?$/i.test(text);
    if (!sources.length && !empty) unsupported.push(k);
    out[k] = { text, sources };
  }
  return { ...out, unsupported };
}

export const standupText = (d) => `Yesterday: ${d.yesterday.text}\nToday: ${d.today.text}\nBlockers: ${d.blockers.text}`;

export async function writeMyStandup({ store, config, env = process.env, logger, now = new Date(), fetchImpl, trigger = "button" }) {
  const tz = config.system.timezone;
  const report = await store.getLatestReport();
  const since = xfSince(now, config);
  const notes = [];

  const standups = await fetchStandups({ config, token: env.SLACK_BOT_TOKEN, logger, fetchImpl, now, days: 10 }).catch((err) => {
    notes.push(`Your stand-ups in the channel could not be read: ${err.message}`);
    return null;
  });
  const slack = await alexSlack({ config, env, logger, fetchImpl, since }).catch((err) => {
    notes.push(`Your Slack messages could not be searched: ${err.message}`);
    return { messages: [], note: null };
  });
  if (slack === null) notes.push("Your Slack messages are not read yet: add a Slack user token with search:read (SLACK_USER_TOKEN). Until then it works from ClickUp, your notes and your last stand-up.");
  else if (slack.note) notes.push(slack.note);
  const dayNotes = await notesForSpeech(store.backend, { now, config }).catch(() => []);

  let waiting = [];
  try {
    const { entries } = await new FlagLedger(store.backend, logger).read();
    const today = zonedDateKey(now, tz);
    const subjects = new Map((report?.flags ?? []).map((f) => [f.key, f]));
    waiting = Object.entries(entries)
      .map(([key, e]) => ({ key, t: activeTriage(e.triage, today) }))
      .filter(({ t }) => t?.status === "waiting")
      .map(({ key, t }) => ({ waitingOn: t.waitingOn, at: t.at, what: subjects.get(key)?.subject?.label ?? subjects.get(key)?.message ?? key }));
  } catch (err) {
    logger?.warn?.("mystandup.ledger_unavailable", { err });
  }

  let plan = null;
  try {
    plan = await new QuarterPlanStore(store.backend, logger).read(quarterOfKey(zonedDateKey(now, tz)));
  } catch {
    plan = null;
  }

  let focus = null;
  try {
    const moves = new FocusStore(store.backend, logger);
    const todayKey = zonedDateKey(now, tz);
    focus = { today: await moves.read(todayKey), yesterday: await moves.read(previousWorkingDayKey(todayKey, config.system.schedule?.workingWeekdays)) };
  } catch {
    focus = null;
  }

  const gathered = standupFacts({ config, now, report, standups, slack, notes: dayNotes, waiting, plan, focus });
  if (!gathered.facts.length) return { error: "Nothing to go on: no ClickUp activity, notes, Slack or earlier stand-up of yours was found.", notes };

  const yesterdayKey = previousWorkingDayKey(gathered.today, config.system.schedule?.workingWeekdays);
  const result = await ask({
    system: readSkill("my-standup"),
    config,
    env,
    logger,
    maxTokens: 4000,
    effort: "low",
    outputFormat: betaJSONSchemaOutputFormat(SCHEMA, "my_standup"),
    messages: [
      {
        role: "user",
        content: [
          `Today is ${gathered.today}. "Yesterday" means ${yesterdayKey}, the previous working day.`,
          "",
          "HOW ALEX WRITES STAND-UPS (recent posts, newest first; match this voice and length)",
          gathered.style.length ? gathered.style.join("\n\n") : "No earlier posts found. Use the example in your instructions.",
          "",
          "THE FACTS (cite their ids)",
          gathered.facts.map((f) => `[${f.id}] ${f.text}`).join("\n"),
        ].join("\n"),
      },
    ],
  });

  if (result.refused) return { error: "The model declined to answer." };
  const draft = checkDraft(result.parsed, gathered.facts);
  if (!draft) return { error: "The answer did not come back with all three lines. Try again." };

  const stored = {
    ...draft,
    text: standupText(draft),
    facts: gathered.facts,
    posted: gathered.posted ? { yesterday: gathered.posted.yesterday, today: gathered.posted.today, blockers: gathered.posted.blockers } : null,
    read: {
      standups: Boolean(standups),
      slack: slack === null ? "no token" : slack.messages.length,
      clickup: Boolean(report),
      readoutDate: report?.dateKey ?? null,
      notes: dayNotes.length,
      waiting: waiting.length,
    },
    notes,
    since: gathered.since,
    dateKey: gathered.today,
    generatedAt: new Date().toISOString(),
    trigger,
    model: result.response?.model ?? null,
  };
  await store.backend.set(MY_STANDUP_KEY, stored);
  await store.backend.set(myStandupHistoryKey(stored.dateKey), stored);
  logger?.info?.("mystandup.written", { facts: gathered.facts.length, unsupported: draft.unsupported.length });
  return stored;
}

/** After the 8 AM readout, like the morning speech. Never throws, never overwrites today's. */
export async function morningStandup({ store, config, env = process.env, logger, now = new Date(), write = writeMyStandup }) {
  try {
    if (config.system?.myStandup?.writeAfterReadout === false) return { written: false, reason: "turned off" };
    if (!env.ANTHROPIC_API_KEY) return { written: false, reason: "no ANTHROPIC_API_KEY" };
    const today = zonedDateKey(now, config.system.timezone);
    const latest = await store.backend.get(MY_STANDUP_KEY);
    if (latest?.dateKey === today) return { written: false, reason: "already written today" };
    const out = await write({ store, config, env, logger, now, trigger: "morning" });
    return out.error ? { written: false, error: out.error } : { written: true };
  } catch (err) {
    logger?.warn?.("mystandup.morning_failed", { err });
    return { written: false, error: err.message };
  }
}
