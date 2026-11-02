// Alex's Impact, the daily pass. Harvest is plain code (src/impact/ledger.js); the
// regrouping is one Anthropic call a working day, which the code then holds to the rule
// that nothing is ever deleted.
//
// Runs from impact-scheduled at 9 AM Central (after the 8 AM readout has stored a fresh
// report), and when Alex presses "Reorganize now" on the tab. Without an Anthropic key, or
// when the call fails, the harvest still lands and new items are placed by rock and Big
// Swing, so the tab keeps growing either way.

import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ask, readSkill } from "./anthropic.js";
import { rocksForAdvice } from "./strategic-advisor.js";
import { fetchStandups } from "../collectors/standup.js";
import { httpJson } from "../lib/http.js";
import { dateKey as toDateKey, shiftDateKey } from "../lib/time.js";
import {
  LEDGER_KEY,
  emptyLedger,
  harvest,
  historyKey,
  itemForModel,
  itemsFromSources,
  placeDeterministic,
  placeTree,
  placedIds,
  recordRun,
  treeForModel,
} from "../impact/ledger.js";

// How far back each run looks for Alex's own commits. Overlap is harmless: a day is one item.
const BUILD_LOOKBACK_DAYS = 5;

const SUB = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string", description: "one or two sentences on the impact, resting only on the items under it" },
    itemIds: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "itemIds"],
  additionalProperties: false,
};

const IMPACT_SCHEMA = {
  type: "object",
  properties: {
    themes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string", description: "one to three sentences on the organizational impact, resting only on the items under it" },
          itemIds: { type: "array", items: { type: "string" }, description: "items that sit directly under this theme" },
          themes: { type: "array", items: SUB, description: "sub-themes, when a theme has grown enough to split" },
        },
        required: ["title", "summary", "itemIds", "themes"],
        additionalProperties: false,
      },
    },
    changeNote: { type: "string", description: "one or two sentences: what was added and what moved, in plain words" },
  },
  required: ["themes", "changeNote"],
  additionalProperties: false,
};

/**
 * Alex's commits to the MOS repo over the lookback, one entry per day. Read only. Without
 * a GitHub token, or on failure, this is empty and the run goes on.
 */
export async function fetchBuilds({ config, env = process.env, logger, fetchImpl, now = new Date() }) {
  const repo = config.system?.github?.repo;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) return [];
  const tz = config.system?.timezone;
  const since = new Date(now.getTime() - BUILD_LOOKBACK_DAYS * 86_400_000).toISOString();
  const http = config.system?.http ?? {};
  try {
    const { body } = await httpJson(`https://api.github.com/repos/${repo}/commits?since=${since}&per_page=100`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "turnpups-mos" },
      logger,
      label: "github.commits",
      fetchImpl,
      timeoutMs: http.timeoutMs ?? 30000,
      maxAttempts: http.maxAttempts ?? 3,
      backoffMsSchedule: http.backoffMsSchedule ?? [1000, 2000],
    });
    return buildsFromCommits(body ?? [], { repo, timeZone: tz });
  } catch (err) {
    logger?.warn?.("impact.builds_unavailable", { err: err.message });
    return [];
  }
}

/** GitHub commits, grouped by the day they were made, newest first. Pure. */
export function buildsFromCommits(commits, { repo, timeZone }) {
  const days = new Map();
  for (const c of commits) {
    const when = c?.commit?.author?.date ?? c?.commit?.committer?.date;
    const subject = String(c?.commit?.message ?? "").split("\n")[0].trim();
    if (!when || !subject || /^merge\b/i.test(subject)) continue;
    const key = toDateKey(new Date(when), timeZone);
    if (!days.has(key)) days.set(key, { dateKey: key, date: new Date(when).toISOString(), subjects: [] });
    days.get(key).subjects.push(subject);
  }
  return [...days.values()]
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
    .map((d) => ({
      ...d,
      subjects: d.subjects.reverse(), // oldest first reads as the day went
      url: `https://github.com/${repo}/commits?since=${d.dateKey}&until=${shiftDateKey(d.dateKey, 1)}`,
    }));
}

/**
 * The daily pass. Harvests, then (when `reorganize`) asks Claude to regroup, then stores
 * the ledger and a dated copy of the themes. Returns { ledger, run }.
 */
export async function massageImpact({ store, config, env = process.env, logger, fetchImpl, now = new Date(), reorganize = true }) {
  const today = toDateKey(now, config.system?.timezone);
  const ledger = (await store.backend.get(LEDGER_KEY)) ?? emptyLedger();
  const report = await store.getLatestReport();
  const builds = await fetchBuilds({ config, env, logger, fetchImpl, now });

  const incoming = itemsFromSources({ report, builds, config });
  const added = harvest(ledger, incoming, { now, testsCollected: Boolean(report?.sections?.intelligems?.present) });
  const run = { at: now.toISOString(), dateKey: today, added: added.length, reportRunId: report?.runId ?? null, reorganized: false, error: null };

  // Place new items in plain code first, so the tab is complete even if the call fails.
  ledger.themes = placeDeterministic(ledger, added);

  const total = Object.keys(ledger.items).length;
  if (reorganize && total && env.ANTHROPIC_API_KEY) {
    try {
      const proposal = await proposeThemes({ ledger, added, report, config, env, logger, today });
      if (proposal.error) run.error = proposal.error;
      else {
        ledger.themes = placeTree(proposal.themes, ledger, ledger.themes);
        ledger.changeNote = proposal.changeNote || null;
        ledger.reorganizedAt = now.toISOString();
        ledger.model = proposal.model ?? null;
        run.reorganized = true;
        run.usage = proposal.usage ?? null;
      }
    } catch (err) {
      logger?.error?.("impact.reorganize_failed", { err });
      run.error = err.message;
    }
  } else if (reorganize && !env.ANTHROPIC_API_KEY) {
    run.error = "ANTHROPIC_API_KEY is not set, so new items were placed by rock and Big Swing without regrouping.";
  }

  // The invariant, checked rather than trusted: every item is somewhere.
  const placed = new Set(placedIds(ledger.themes));
  const lost = Object.keys(ledger.items).filter((id) => !placed.has(id));
  if (lost.length) {
    logger?.error?.("impact.items_unplaced", { count: lost.length });
    ledger.themes = placeTree(ledger.themes, ledger, ledger.themes);
  }

  ledger.updatedAt = now.toISOString();
  recordRun(ledger, run);
  await store.backend.set(LEDGER_KEY, ledger);
  await store.backend.set(historyKey(today), { at: ledger.updatedAt, changeNote: ledger.changeNote, themes: ledger.themes });
  logger?.info?.("impact.stored", { items: total, added: added.length, reorganized: run.reorganized });
  return { ledger, run };
}

/** One call: the whole ledger and the current themes in, a regrouped tree out. */
async function proposeThemes({ ledger, added, report, config, env, logger, today }) {
  const items = Object.values(ledger.items)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .map(itemForModel);
  const rocks = rocksForAdvice(report?.detail?.leadership?.queue ?? []).map(({ title, state, status, owner, kpi }) => ({ title, state, status, owner, kpi }));
  const standups = await fetchStandups({ config, token: env.SLACK_BOT_TOKEN, logger, days: 3 })
    .then((s) => s.days.map((d) => ({ date: d.dateKey, posts: d.posts.map(({ name, yesterday }) => ({ name, yesterday })) })))
    .catch(() => null);

  const result = await ask({
    system: readSkill("impact-curator"),
    config,
    env,
    logger,
    effort: "medium",
    maxTokens: 24000,
    outputFormat: betaJSONSchemaOutputFormat(IMPACT_SCHEMA, "impact"),
    messages: [
      {
        role: "user",
        content: [
          `Today is ${today}. Regroup Alex's impact record. ${added.length} new item(s) today: ${added.join(", ") || "none"}.`,
          "",
          "THE ROCKS (what leadership cares about this quarter)",
          JSON.stringify(rocks),
          "",
          "THE STAND-UPS (last 3 days, context for the summaries only; not items)",
          standups ? JSON.stringify(standups) : "Not available this run.",
          "",
          "THE CURRENT THEMES",
          JSON.stringify(treeForModel(ledger.themes)),
          "",
          `EVERY ITEM (${items.length}), newest first`,
          JSON.stringify(items),
          "",
          "Return the full tree. Every item id must appear exactly once.",
        ].join("\n"),
      },
    ],
  });

  if (result.refused) return { error: "The model declined to answer." };
  if (result.response?.stop_reason === "max_tokens") return { error: "The regrouping ran past its length limit; yesterday's themes were kept." };
  if (!result.parsed?.themes) return { error: "The regrouping did not come back in the expected shape; yesterday's themes were kept." };
  return {
    themes: result.parsed.themes,
    changeNote: result.parsed.changeNote,
    model: result.response?.model ?? null,
    usage: { inputTokens: result.response?.usage?.input_tokens ?? null, outputTokens: result.response?.usage?.output_tokens ?? null },
  };
}
