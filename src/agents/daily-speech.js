// Daily wins (the Daily Speech tab). Agentic: one Anthropic call after the 8 AM readout and
// when Alex presses the button.
//
// Alex, 2026-11-19: "I need a list of wins from most important to least and why they are
// important and who I can give kudos to for what parts... every day should be a celebration
// and important for me to manage up... the accomplishments so far in the sprint... ones I
// don't check before next day can I carry over?"
//
// Code decides WHAT the wins are: every sprint ticket done (or ready to ship) and every
// change to the live site in the last week, plus anything from an earlier list Alex has not
// ticked yet (carried over). Claude only ranks them, says why each matters, and splits the
// kudos. Code then keeps only wins it handed over (titles are code's, never the model's),
// keeps kudos only for that win's own assignees, adds back any win the model left out, and
// checks every figure against the data. Ticked wins ("Called out") are kept in
// speech/celebrated.json and left off later lists.

import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ask, readSkill } from "./anthropic.js";
import { rocksForAdvice } from "./strategic-advisor.js";
import { sprintTickets, testForIdeation } from "./ideation.js";
import { fetchStandups } from "../collectors/standup.js";
import { fetchXf } from "../collectors/xf.js";
import { collectChangelog, changelogConfigured, changeForSpeech } from "../collectors/changelog.js";
import { LEDGER_KEY } from "../impact/ledger.js";
import { notesForSpeech } from "../store/day-notes.js";
import { createHash } from "node:crypto";

export const SPEECH_KEY = "speech/latest.json";
export const SPEECH_STATUS_KEY = "speech/status.json";
export const CELEBRATED_KEY = "speech/celebrated.json";
export const speechHistoryKey = (dateKey) => `speech/history/${dateKey}.json`;

const DAY_MS = 86_400_000;
const SHIPPED_LOOKBACK_DAYS = 7;
const STANDUP_DAYS = 3;
const MAX_SHIPPED = 60;

const SPEECH_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "the one line to remember about the sprint so far, under 15 words" },
    wins: {
      type: "array",
      description: "EVERY win you were given, most important first, each once",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "the win's key exactly as given" },
          why: { type: "string", description: "one or two sentences: why it matters, tied to the rock, a test or a number from the data" },
          kudos: {
            type: "array",
            description: "who to thank and for which part; only names from that win's who list",
            items: {
              type: "object",
              properties: { name: { type: "string" }, for: { type: "string", description: "the part they did, a few words" } },
              required: ["name", "for"],
              additionalProperties: false,
            },
          },
        },
        required: ["key", "why", "kudos"],
        additionalProperties: false,
      },
    },
    close: { type: "string", description: "one short line to send people off" },
    facts: {
      type: "array",
      description: "every number, test and result used, each with where it came from",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          source: { type: "string" },
        },
        required: ["claim", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "wins", "close", "facts"],
  additionalProperties: false,
};

const firstNames = (list) => [...new Set((list ?? []).map((u) => String(u?.username ?? u?.name ?? "").split(/\s+/)[0]).filter(Boolean))];
const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/**
 * What went to production in the last week, from the changelog sheet, newest first. Read
 * live so a change logged after the 8 AM readout still makes the speech; the readout's own
 * copy stands in when the sheet cannot be read.
 */
export async function changesForSpeech({ config, env, logger, now, report, fetchImpl }) {
  let changelog = null;
  if (config.system?.changelog?.spreadsheetId && changelogConfigured(config, env)) {
    changelog = await collectChangelog({ config, env, logger, now, fetchImpl }).catch((err) => {
      logger?.warn?.("speech.changelog_unavailable", { err: err.message });
      return null;
    });
  }
  changelog ??= report?.detail?.changelog?.entries ? report.detail.changelog : null;
  if (!changelog) return null;
  const since = new Date(now.getTime() - SHIPPED_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  return changelog.entries.filter((e) => e.date >= since).map(changeForSpeech);
}

/** The store tiles as plain facts: the number, and how it compares with each other window. */
export function storeForSpeech(shopify) {
  if (!shopify?.tiles?.length) return null;
  return {
    window: shopify.primaryWindow?.label ?? null,
    tiles: shopify.tiles
      .filter((t) => t.available)
      .map((t) => ({
        label: t.label,
        value: t.format === "percent" ? `${(t.value * 100).toFixed(2)}%` : Math.round(t.value * 100) / 100,
        vs: (t.comparisons ?? []).filter((c) => c.changePct != null).map((c) => ({ window: c.label, changePct: c.changePct })),
      })),
  };
}

/** What the Impact record says was shipped in the last week, newest first. */
export function recentlyShipped(ledger, now = new Date()) {
  const since = now.getTime() - SHIPPED_LOOKBACK_DAYS * DAY_MS;
  return Object.values(ledger?.items ?? {})
    .filter((i) => i.kind !== "build" && i.date && new Date(i.date).getTime() >= since)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, MAX_SHIPPED)
    .map((i) => ({ kind: i.kind, title: i.title, who: firstNames((i.who ?? []).map((name) => ({ name }))), rock: i.rock ?? i.bigSwing ?? null, status: i.status ?? null, date: String(i.date).slice(0, 10), facts: i.facts ?? undefined }));
}

/** A sprint ticket as the speech needs it: what, who, where it stands. */
export function ticketForSpeech(t) {
  return {
    name: t.plainName ?? t.name,
    status: t.status,
    who: firstNames(t.assignees),
    bigSwing: t.bigSwing?.label ?? null,
    signal: t.signal ?? null,
    due: iso(t.dueDate),
    closed: iso(t.dateClosed),
  };
}

// ---------------------------------------------------------------- number check

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?%?/g;

/** Every number in a piece of text, as written. */
export function numbersIn(text) {
  return String(text ?? "").match(NUMBER) ?? [];
}

const toValue = (s) => Number(String(s).replace(/[$,%]/g, ""));
const decimals = (s) => (String(s).replace(/[$,%]/g, "").split(".")[1] ?? "").length;

/**
 * The figures in the speech that do not appear anywhere in the context, allowing for the
 * rounding a person does out loud: 12% matches 11.8 or 0.118, $4,200 matches 4213.55.
 * Counts under ten are skipped: "three tests" is a count of a list, not a figure to look up.
 */
export function unverifiedNumbers(speechText, contextText) {
  const known = numbersIn(contextText).map(toValue).filter(Number.isFinite);
  const out = [];
  for (const written of new Set(numbersIn(speechText))) {
    const n = toValue(written);
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && n < 10 && !written.includes("%") && !written.includes("$")) continue;
    // Within half the speech's last digit, or within 5% for a rounded-off big number.
    const step = Math.max(0.5 * 10 ** -decimals(written), n >= 100 ? n * 0.05 : 0);
    const matches = (c) => [c, c * 100, Math.abs(c), Math.abs(c * 100)].some((v) => Math.abs(v - n) <= step + 1e-9);
    if (!known.some(matches)) out.push(written);
  }
  return out;
}

// ------------------------------------------------------------------- the wins

// Ticket statuses that count as a win this sprint, and how a win's stage reads.
const WIN_STAGE = new Map([
  ["done (this sprint)", "done"],
  ["done", "done"],
  ["ready for deploy", "ready to ship"],
]);
const CARRY_DAYS = 14;
const fullNames = (list) => [...new Set((list ?? []).map((u) => String(u?.username ?? u?.name ?? "").trim()).filter(Boolean))];
const first = (name) => String(name ?? "").trim().split(/\s+/)[0].toLowerCase();
const hash = (text) => createHash("sha1").update(String(text)).digest("hex").slice(0, 12);

/**
 * The sprint's wins so far, as code sees them: done or ready-to-ship sprint tickets, and
 * live-site changes from the changelog. Anything already called out is left off. A win from
 * an earlier list that is not ticked and no longer shows up here (the ticket moved on, the
 * change aged out) is carried over for up to two weeks.
 */
export function winCandidates({ tasks = [], production = [], celebrated = {}, previous = [], now = new Date() }) {
  const out = new Map();
  for (const t of sprintTickets(tasks)) {
    const stage = WIN_STAGE.get(String(t.status ?? "").toLowerCase());
    if (!stage) continue;
    out.set(`task:${t.id}`, {
      key: `task:${t.id}`,
      kind: "ticket",
      title: t.plainName ?? t.name,
      stage,
      rock: t.bigSwing?.label ?? null,
      tactic: t.leadershipPriority?.label ?? null,
      who: fullNames(t.assignees),
      date: iso(t.dateDone ?? t.dateClosed ?? t.dateUpdated),
      url: t.url ?? null,
    });
  }
  for (const c of production ?? []) {
    const key = `change:${hash(`${c.date}|${c.change}`)}`;
    out.set(key, {
      key,
      kind: "change",
      title: c.change,
      stage: c.result ? `live: ${c.result}` : "live on the site",
      rock: null,
      tactic: null,
      who: [],
      date: c.date ?? null,
      url: c.page ?? null,
      details: c.details,
      additionalMonthlyRevenue: c.additionalMonthlyRevenue,
    });
  }
  const cutoff = now.getTime() - CARRY_DAYS * DAY_MS;
  for (const w of previous ?? []) {
    if (!w?.key || out.has(w.key) || celebrated[w.key]) continue;
    if (Date.parse(w.firstSeen ?? 0) < cutoff) continue;
    const { why, kudos, rank, ...rest } = w;
    out.set(w.key, { ...rest, carried: true });
  }
  return [...out.values()].filter((w) => !celebrated[w.key]);
}

/**
 * The ranked list, kept honest: only wins code handed over, in the model's order, with
 * code's own title, kudos only for that win's own people (by first name), and every win the
 * model skipped added at the end so nothing done this sprint goes missing. Carried wins keep
 * the day they were first listed.
 */
export function cleanWins(parsed, candidates, previous = [], now = new Date()) {
  const headline = String(parsed?.headline ?? "").trim();
  if (!headline) return null;
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const firstSeen = new Map((previous ?? []).filter((w) => w?.key).map((w) => [w.key, w.firstSeen]));
  const seen = new Set();
  const wins = [];
  const make = (c, why, kudos) => ({
    ...c,
    why,
    kudos,
    firstSeen: firstSeen.get(c.key) ?? now.toISOString(),
  });
  for (const w of parsed?.wins ?? []) {
    const c = byKey.get(w?.key);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    const allowed = new Map(c.who.map((n) => [first(n), n]));
    const kudos = [];
    for (const k of w.kudos ?? []) {
      const name = allowed.get(first(k?.name));
      if (name && k.for?.trim() && !kudos.some((x) => x.name === name)) kudos.push({ name, for: k.for.trim() });
    }
    wins.push(make(c, String(w.why ?? "").trim(), kudos));
  }
  for (const c of candidates) if (!seen.has(c.key)) wins.push(make(c, c.why ?? "", []));
  const facts = (parsed?.facts ?? []).filter((f) => f?.claim && f?.source).map((f) => ({ claim: String(f.claim), source: String(f.source) }));
  return { headline, wins: wins.map((w, i) => ({ ...w, rank: i + 1 })), close: String(parsed?.close ?? "").trim(), facts };
}

/** The list as text, to paste in Slack or send up. */
export function speechText(s) {
  const lines = [s.headline, ""];
  for (const w of s.wins ?? []) {
    lines.push(`${w.rank}. ${w.title}${w.rock ? ` (${w.rock})` : ""}`);
    if (w.why) lines.push(`   ${w.why}`);
    if (w.kudos?.length) lines.push(`   Kudos: ${w.kudos.map((k) => `${k.name.split(/\s+/)[0]} for ${k.for}`).join("; ")}`);
  }
  if (s.close) lines.push("", s.close);
  return lines.join("\n");
}

// ------------------------------------------------------------------- the call

/** Gathers the context, makes the call, checks the numbers and stores it. */
export async function writeSpeech({ store, config, env = process.env, logger, now = new Date(), trigger = "button" }) {
  const report = await store.getLatestReport();
  if (!report) return { error: "There is no readout in storage yet, so there is nothing to tell the story from." };
  const detail = report.detail ?? {};

  const ledger = await store.backend.get(LEDGER_KEY).catch(() => null);
  const standups = await fetchStandups({ config, token: env.SLACK_BOT_TOKEN, logger, days: STANDUP_DAYS })
    .then((s) => s.days.map((d) => ({ date: d.dateKey, posts: d.posts.map(({ name, yesterday, today, blockers }) => ({ name, yesterday, today, blockers })) })))
    .catch((err) => {
      logger?.warn?.("speech.standups_unavailable", { err: err.message });
      return null;
    });
  const dayNotes = await notesForSpeech(store.backend, { now, config }).catch((err) => {
    logger?.warn?.("speech.notes_unavailable", { err: err.message });
    return [];
  });
  const xf = await fetchXf({ config, token: env.SLACK_BOT_TOKEN, logger, now, report }).catch((err) => {
    logger?.warn?.("speech.xf_unavailable", { err: err.message });
    return { since: null, channelsRead: [], items: [], notes: [`Cross-functional mentions could not be read. ${err.message}`] };
  });

  const production = await changesForSpeech({ config, env, logger, now, report });
  const [celebratedDoc, previousSpeech] = await Promise.all([
    store.backend.get(CELEBRATED_KEY).catch(() => null),
    store.backend.get(SPEECH_KEY).catch(() => null),
  ]);
  const celebrated = celebratedDoc?.items ?? {};
  const previous = previousSpeech?.wins ?? [];
  const candidates = winCandidates({ tasks: detail.clickup?.tasks ?? [], production: production ?? [], celebrated, previous, now });

  const context = {
    production: production ?? [],
    rocks: rocksForAdvice(detail.leadership?.queue ?? []),
    store: storeForSpeech(detail.shopify),
    tests: (detail.intelligems?.tests ?? []).map(testForIdeation),
    shippedThisWeek: recentlyShipped(ledger, now),
    weekInReview: detail.weekly?.lines ?? null,
    sprint: sprintTickets(detail.clickup?.tasks ?? []).map(ticketForSpeech),
    xf: xf.items.map(({ url, ...item }) => item),
    notes: dayNotes.map((n) => ({ at: n.at, text: n.text })),
  };
  const contextText = JSON.stringify(context, null, 2) + JSON.stringify(standups ?? []);

  const result = await ask({
    system: readSkill("daily-speech"),
    config,
    env,
    logger,
    maxTokens: 12000,
    effort: "medium",
    outputFormat: betaJSONSchemaOutputFormat(SPEECH_SCHEMA, "daily_speech"),
    messages: [
      {
        role: "user",
        content: [
          `Today is ${report.dateKey}. Rank the sprint's wins for Alex, most important first, say why each matters, and who to thank for which part.`,
          "",
          `THE WINS (${candidates.length}; rank every one, by key; "carried": true means Alex has not called it out yet from an earlier day)`,
          candidates.length ? JSON.stringify(candidates.map(({ url, ...c }) => c), null, 2) : "None yet this sprint.",
          "",
          "THE ROCKS",
          JSON.stringify(context.rocks, null, 2),
          "",
          "THE STORE",
          context.store ? JSON.stringify(context.store, null, 2) : "Not available this run.",
          "",
          "THE INTELLIGEMS TESTS",
          JSON.stringify(context.tests, null, 2),
          "",
          `CHANGES TO PRODUCTION IN THE LAST ${SHIPPED_LOOKBACK_DAYS} DAYS (from the firstday.com changelog sheet, newest first; what actually changed on the live site)`,
          production == null ? "Not available this run." : production.length ? JSON.stringify(production, null, 2) : "Nothing logged.",
          "",
          `SHIPPED IN THE LAST ${SHIPPED_LOOKBACK_DAYS} DAYS (from Overall Impact record)`,
          context.shippedThisWeek.length ? JSON.stringify(context.shippedThisWeek, null, 2) : "Nothing recorded.",
          "",
          "ALEX'S NOTES FROM THE DAY (typed or pasted by Alex, oldest first; often what other teams said)",
          context.notes.length ? JSON.stringify(context.notes, null, 2) : "No notes.",
          "",
          `CROSS-FUNCTIONAL (XF): what people outside the team said to Alex or the team since ${xf.since ? xf.since.slice(0, 10) : "the previous working day"}, newest first`,
          context.xf.length ? JSON.stringify(context.xf, null, 2) : "Nothing from outside the team in this window.",
          "",
          "THE WEEK IN REVIEW",
          context.weekInReview?.length ? context.weekInReview.join("\n") : "Not available.",
          "",
          `THE STAND-UPS (last ${STANDUP_DAYS} days, from Slack, newest day first)`,
          standups ? JSON.stringify(standups, null, 2) : "Not available this run.",
          "",
          `THE SPRINT (${context.sprint.length} tickets)`,
          JSON.stringify(context.sprint, null, 2),
        ].join("\n"),
      },
    ],
  });

  if (result.refused) return { error: "The model declined to answer.", category: result.category };
  if (result.response?.stop_reason === "max_tokens") return { error: "The answer ran past its length limit before finishing. Try again." };
  const speech = cleanWins(result.parsed, candidates, previous, now);
  if (!speech) return { error: "The answer came back without a headline. Try again." };

  const stored = {
    ...speech,
    text: speechText(speech),
    unverified: unverifiedNumbers(speechText(speech), contextText + JSON.stringify(candidates)),
    generatedAt: new Date().toISOString(),
    // "morning": written by itself after the 8 AM readout; "button": Alex pressed it.
    trigger,
    dateKey: report.dateKey ?? null,
    reportRunId: report.runId ?? null,
    model: result.response?.model ?? null,
    readStandups: Boolean(standups),
    readImpact: Boolean(ledger),
    readStore: Boolean(context.store),
    readChangelog: production != null,
    productionChanges: production?.length ?? 0,
    notesUsed: dayNotes.length,
    xf: { since: xf.since, channelsRead: xf.channelsRead, items: xf.items, notes: xf.notes },
  };
  await store.backend.set(SPEECH_KEY, stored);
  if (stored.dateKey) await store.backend.set(speechHistoryKey(stored.dateKey), stored);
  logger?.info?.("speech.written", { unverified: stored.unverified.length, xf: xf.items.length });
  return stored;
}

// A run still marked running after this long has died; the morning write may go ahead.
const RUNNING_FOR_AT_MOST_MS = 10 * 60 * 1000;

/**
 * The morning speech: written by itself straight after the 8 AM readout, so it is ready
 * when Alex opens the tab. One Anthropic call per working day, with the same figure check
 * as the button. Skipped, never overwritten, when today's readout already has a speech
 * (a retry, or Alex was up first), when one is being written, or when it is turned off
 * with config.system.dailySpeech.writeAfterReadout = false. Never throws: a failed speech
 * must not fail the readout.
 *
 * @returns {Promise<{written:boolean, reason?:string, error?:string}>}
 */
export async function morningSpeech({ store, config, env = process.env, logger, now = new Date(), report, write = writeSpeech }) {
  try {
    if (config.system?.dailySpeech?.writeAfterReadout === false) return { written: false, reason: "turned off" };
    if (!env.ANTHROPIC_API_KEY) return { written: false, reason: "no ANTHROPIC_API_KEY" };
    const [latest, status] = await Promise.all([store.backend.get(SPEECH_KEY), store.backend.get(SPEECH_STATUS_KEY)]);
    if (report?.dateKey && latest?.dateKey === report.dateKey) return { written: false, reason: "already written for this readout" };
    if (status?.state === "running" && now.getTime() - new Date(status.startedAt).getTime() < RUNNING_FOR_AT_MOST_MS) {
      return { written: false, reason: "one is already being written" };
    }
    const startedAt = new Date().toISOString();
    await store.backend.set(SPEECH_STATUS_KEY, { state: "running", startedAt, trigger: "morning" });
    const result = await write({ store, config, env, logger, now, trigger: "morning" });
    await store.backend.set(
      SPEECH_STATUS_KEY,
      result.error ? { state: "failed", startedAt, error: result.error, trigger: "morning" } : { state: "done", startedAt, finishedAt: result.generatedAt, trigger: "morning" },
    );
    if (result.error) {
      logger?.warn?.("speech.morning_failed", { error: result.error });
      return { written: false, error: result.error };
    }
    logger?.info?.("speech.morning_written", { dateKey: result.dateKey, unverified: result.unverified?.length ?? 0 });
    return { written: true };
  } catch (err) {
    logger?.error?.("speech.morning_crashed", { err });
    await store.backend.set(SPEECH_STATUS_KEY, { state: "failed", startedAt: new Date().toISOString(), error: err.message, trigger: "morning" }).catch(() => {});
    return { written: false, error: err.message };
  }
}
