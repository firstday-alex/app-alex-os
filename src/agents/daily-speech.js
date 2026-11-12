// Daily Speech. Agentic. On demand only: one Anthropic call when Alex presses the button
// on the Daily Speech tab. Nothing else invokes it.
//
// Writes the day's top-line storyline Alex says out loud to the team: a headline, the
// beats (the win, across the business, the stakes, today) and a closing line. The model
// sees what the latest readout, the last few days of stand-ups, the Impact record and the
// cross-functional (XF) list and the site changelog sheet hold, and nothing else. XF is what people outside the team
// said to Alex or the team since the previous working day (src/collectors/xf.js).
//
// The model's story is judgement. Whether its numbers are real is not: code checks every
// figure in the speech against the context it was given and lists any it cannot find, so
// Alex sees a made-up number before saying it to the room.

import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ask, readSkill } from "./anthropic.js";
import { rocksForAdvice } from "./strategic-advisor.js";
import { sprintTickets, testForIdeation } from "./ideation.js";
import { fetchStandups } from "../collectors/standup.js";
import { fetchXf } from "../collectors/xf.js";
import { collectChangelog, changelogConfigured, changeForSpeech } from "../collectors/changelog.js";
import { LEDGER_KEY } from "../impact/ledger.js";
import { notesForSpeech } from "../store/day-notes.js";

export const SPEECH_KEY = "speech/latest.json";
export const SPEECH_STATUS_KEY = "speech/status.json";
export const speechHistoryKey = (dateKey) => `speech/history/${dateKey}.json`;

const DAY_MS = 86_400_000;
const SHIPPED_LOOKBACK_DAYS = 7;
const STANDUP_DAYS = 3;
const MAX_SHIPPED = 60;

const SPEECH_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "the one line to remember, under 15 words" },
    beats: {
      type: "array",
      description: "in order: the win, across the business (only when the XF list has something worth saying), the stakes, today",
      items: {
        type: "object",
        properties: {
          label: { type: "string", enum: ["The win", "Across the business", "The stakes", "Today"] },
          text: { type: "string", description: "two to four spoken sentences" },
        },
        required: ["label", "text"],
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
  required: ["headline", "beats", "close", "facts"],
  additionalProperties: false,
};

const BEAT_ORDER = ["The win", "Across the business", "The stakes", "Today"];
const REQUIRED_BEATS = ["The win", "The stakes", "Today"];
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
    who: firstNames(t.assignees?.length ? t.assignees : t.taskOwners),
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

/** Keeps a well-formed speech, or explains why there is none. */
export function cleanSpeech(parsed) {
  const headline = String(parsed?.headline ?? "").trim();
  const close = String(parsed?.close ?? "").trim();
  const byLabel = new Map((parsed?.beats ?? []).filter((b) => b?.text?.trim()).map((b) => [b.label, b.text.trim()]));
  const beats = BEAT_ORDER.filter((l) => byLabel.has(l)).map((label) => ({ label, text: byLabel.get(label) }));
  if (!headline || !REQUIRED_BEATS.every((l) => byLabel.has(l))) return null;
  const facts = (parsed?.facts ?? []).filter((f) => f?.claim && f?.source).map((f) => ({ claim: String(f.claim), source: String(f.source) }));
  return { headline, beats, close, facts };
}

/** The speech as one block of text, to read or paste. */
export function speechText(s) {
  return [s.headline, "", ...s.beats.map((b) => b.text), ...(s.close ? ["", s.close] : [])].join("\n");
}

// ------------------------------------------------------------------- the call

/** Gathers the context, makes the call, checks the numbers and stores it. */
export async function writeSpeech({ store, config, env = process.env, logger, now = new Date() }) {
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
    maxTokens: 8000,
    effort: "medium",
    outputFormat: betaJSONSchemaOutputFormat(SPEECH_SCHEMA, "daily_speech"),
    messages: [
      {
        role: "user",
        content: [
          `Today is ${report.dateKey}. Write the storyline Alex will say to the team this morning.`,
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
          `SHIPPED IN THE LAST ${SHIPPED_LOOKBACK_DAYS} DAYS (from Alex's Impact record)`,
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
  const speech = cleanSpeech(result.parsed);
  if (!speech) return { error: "The answer did not come back with a headline and all three beats. Try again." };

  const stored = {
    ...speech,
    text: speechText(speech),
    unverified: unverifiedNumbers(speechText(speech), contextText),
    generatedAt: new Date().toISOString(),
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
