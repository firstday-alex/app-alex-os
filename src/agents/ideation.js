// Ideation. Agentic. On demand only: one Anthropic call when Alex clicks the button on
// the Ideation tab. Nothing else invokes it.
//
// For every ticket in the current sprint it returns a verdict (successful, unsuccessful,
// or too early to call), the root cause of why, and three other ways to approach it. The
// model sees each ticket's own description and comment thread, the Intelligems tests and
// the rocks, read fresh at the click, and nothing else. A verdict with no evidence behind
// it is "too early", never a guess.

import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ask, readSkill } from "./anthropic.js";
import { rocksForAdvice } from "./strategic-advisor.js";
import { httpJson } from "../lib/http.js";
import { fetchStandups } from "../collectors/standup.js";

export const IDEATION_KEY = "ideation/latest.json";
export const VERDICTS = ["successful", "unsuccessful", "too_early"];

// "complete" is last sprint's work, moved there when the sprint rolled over. "backlog" was
// never in the sprint.
const NOT_THIS_SPRINT = new Set(["complete", "backlog"]);
const DESCRIPTION_CHARS = 3000;
const COMMENT_CHARS = 600;
const COMMENTS_PER_TICKET = 15;
// The metrics a test is decided on. The rest of the Intelligems payload is noise here.
const TEST_METRICS = ["conversion_rate", "net_revenue_per_visitor", "net_revenue_per_order", "add_to_cart_rate"];

const IDEA = {
  type: "object",
  properties: {
    title: { type: "string", description: "the idea in a few words" },
    how: { type: "string", description: "one or two sentences: what to do, and why it gets around the root cause" },
  },
  required: ["title", "how"],
  additionalProperties: false,
};

const IDEATION_SCHEMA = {
  type: "object",
  properties: {
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "the ticket id exactly as given" },
          verdict: { type: "string", enum: VERDICTS },
          rootCause: { type: "string", description: "why it worked, why it did not, or why it cannot be called yet. One to three sentences." },
          evidence: { type: "string", description: "what in the ticket, its comments or a test result the verdict rests on, quoted or named. Empty only when verdict is too_early and there is nothing to point at." },
          ideas: { type: "array", items: IDEA, description: "exactly three other ways to approach it" },
        },
        required: ["id", "verdict", "rootCause", "evidence", "ideas"],
        additionalProperties: false,
      },
    },
  },
  required: ["tickets"],
  additionalProperties: false,
};

/** The tickets in this sprint: everything on the sprint list except last sprint's complete ones. */
export function sprintTickets(tasks = []) {
  return tasks.filter((t) => !t.archived && !NOT_THIS_SPRINT.has(String(t.status ?? "").toLowerCase()));
}

/** A test trimmed to what a verdict needs: who is winning on the decision metrics, and on how much data. */
export function testForIdeation(test) {
  return {
    id: test.id,
    name: test.name,
    status: test.status ?? null,
    daysRunning: test.daysRunning ?? null,
    verdict: test.verdict ?? null,
    groups: (test.groups ?? []).map((g) => ({
      name: g.name,
      isControl: Boolean(g.isControl),
      orders: g.orders ?? null,
      visitors: g.visitors ?? null,
      metrics: Object.fromEntries(
        TEST_METRICS.filter((m) => g.metrics?.[m]?.configured !== false && g.metrics?.[m]).map((m) => {
          const x = g.metrics[m];
          return [m, { value: x.value ?? null, upliftPct: x.upliftPct ?? null, probBeatControl: x.probBeatControl ?? null }];
        }),
      ),
    })),
  };
}

const people = (list) => (list ?? []).map((u) => u.username).filter(Boolean);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** One ticket as the model sees it. `extra` is the description and comment thread, when they could be read. */
export function ticketForIdeation(task, extra = {}) {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    owner: people(task.taskOwners),
    assignees: people(task.assignees),
    bigSwing: task.bigSwing?.label ?? null,
    leadershipPriority: task.leadershipPriority?.label ?? null,
    dueDate: iso(task.dueDate),
    created: iso(task.dateCreated),
    lastUpdated: iso(task.dateUpdated),
    inStatusSince: task.statusAge?.since ?? null,
    previousStatus: task.statusAge?.previousStatus ?? null,
    signal: task.signal ?? null,
    description: extra.description ?? null,
    comments: extra.comments ?? (task.lastComment ? [{ user: task.lastComment.user, date: iso(task.lastComment.date), text: task.lastComment.text }] : []),
  };
}

/**
 * Reads one ticket's description and comment thread from ClickUp. Read only. A failure
 * leaves that ticket with what the readout already holds, rather than sinking the run.
 */
async function fetchTicketExtra(task, { config, token, logger, fetchImpl }) {
  const cu = config.clickup;
  const http = config.system.http;
  const opts = (label) => ({
    headers: { authorization: token },
    logger,
    label,
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: http.maxAttempts,
    backoffMsSchedule: http.backoffMsSchedule,
  });
  const extra = {};
  try {
    const { body } = await httpJson(`${cu.apiBase}/task/${task.id}?include_markdown_description=true`, opts("clickup.task.detail"));
    const text = String(body?.markdown_description || body?.description || "").trim();
    extra.description = text ? text.slice(0, DESCRIPTION_CHARS) : null;
  } catch (err) {
    logger?.warn?.("ideation.description_failed", { taskId: task.id, err });
  }
  try {
    const { body } = await httpJson(`${cu.apiBase}/task/${task.id}/comment`, opts("clickup.task.comment"));
    // ClickUp returns newest first. The model reads a thread oldest first.
    extra.comments = (body?.comments ?? [])
      .slice(0, COMMENTS_PER_TICKET)
      .reverse()
      .map((c) => ({
        user: c.user?.username ?? null,
        date: iso(c.date ? Number(c.date) : null),
        text: String(c.comment_text ?? "").trim().slice(0, COMMENT_CHARS),
      }));
  } catch (err) {
    logger?.warn?.("ideation.comments_failed", { taskId: task.id, err });
  }
  return extra;
}

/**
 * Keeps only answers about tickets that were asked about, each with a known verdict and
 * exactly three ideas. Anything else is dropped rather than shown.
 */
export function cleanAnswer(parsed, tickets) {
  const asked = new Map(tickets.map((t) => [String(t.id), t]));
  const seen = new Set();
  const out = [];
  for (const a of parsed?.tickets ?? []) {
    const id = String(a?.id ?? "");
    if (!asked.has(id) || seen.has(id) || !VERDICTS.includes(a.verdict)) continue;
    const ideas = (a.ideas ?? []).filter((i) => i?.title && i?.how).slice(0, 3);
    if (ideas.length < 3 || !a.rootCause) continue;
    seen.add(id);
    out.push({ id, verdict: a.verdict, rootCause: a.rootCause, evidence: a.evidence ?? "", ideas });
  }
  const missing = [...asked.keys()].filter((id) => !seen.has(id));
  return { tickets: out, missing };
}

/** Runs the analysis and stores it. Returns what was stored. */
export async function ideate({ store, config, env = process.env, logger, fetchImpl }) {
  const report = await store.getLatestReport();
  if (!report) return { error: "There is no report in storage yet, so there is no sprint to look at." };
  const detail = report.detail ?? {};
  const tasks = sprintTickets(detail.clickup?.tasks ?? []);
  if (!tasks.length) return { error: "The current sprint has no tickets outside complete." };

  const token = env.CLICKUP_TOKEN;
  const extras = token
    ? await Promise.all(tasks.map((t) => fetchTicketExtra(t, { config, token, logger, fetchImpl })))
    : tasks.map(() => ({}));
  const tickets = tasks.map((t, i) => ticketForIdeation(t, extras[i]));
  // What people said in stand-up this past week. Optional: without it the analysis runs
  // on ClickUp alone, and says so.
  const standups = await fetchStandups({ config, token: env.SLACK_BOT_TOKEN, logger, days: 7 })
    .then((s) => s.days.map((d) => ({ date: d.dateKey, posts: d.posts.map(({ name, yesterday, today, blockers }) => ({ name, yesterday, today, blockers })) })))
    .catch((err) => {
      logger?.warn?.("ideation.standups_unavailable", { err: err.message });
      return null;
    });
  const tests = (detail.intelligems?.tests ?? []).map(testForIdeation);
  const rocks = rocksForAdvice(detail.leadership?.queue ?? []);

  const result = await ask({
    system: readSkill("ideation"),
    config,
    env,
    logger,
    maxTokens: 32000,
    outputFormat: betaJSONSchemaOutputFormat(IDEATION_SCHEMA, "ideation"),
    messages: [
      {
        role: "user",
        content: [
          `Today is ${report.dateKey}. Alex wants every ticket in the current sprint judged: successful, unsuccessful or too early to call, the root cause of why, and three other ways to approach it.`,
          "",
          "THE ROCKS",
          JSON.stringify(rocks, null, 2),
          "",
          "THE INTELLIGEMS TESTS",
          JSON.stringify(tests, null, 2),
          "",
          "THE STAND-UPS (last 7 days, from Slack, newest day first)",
          standups ? JSON.stringify(standups, null, 2) : "Not available this run.",
          "",
          `THE SPRINT TICKETS (${tickets.length})`,
          JSON.stringify(tickets, null, 2),
          "",
          "Answer for every ticket, using its id exactly as given.",
        ].join("\n"),
      },
    ],
  });

  if (result.refused) return { error: "The model declined to answer.", category: result.category };
  if (result.response?.stop_reason === "max_tokens") return { error: "The answer ran past its length limit before finishing. Try again." };
  if (!result.parsed) return { error: "The answer did not come back in the expected shape. Try again." };

  const { tickets: answers, missing } = cleanAnswer(result.parsed, tickets);
  const byId = new Map(tasks.map((t) => [String(t.id), t]));
  const stored = {
    generatedAt: new Date().toISOString(),
    reportRunId: report.runId ?? null,
    dateKey: report.dateKey ?? null,
    model: result.response?.model ?? null,
    usage: {
      inputTokens: result.response?.usage?.input_tokens ?? null,
      outputTokens: result.response?.usage?.output_tokens ?? null,
    },
    readTicketDetail: Boolean(token),
    readStandups: Boolean(standups),
    tickets: answers.map((a) => {
      const t = byId.get(a.id);
      return { ...a, name: t.name, url: t.url ?? null, status: t.status, bigSwing: t.bigSwing?.label ?? null, owner: people(t.taskOwners), assignees: people(t.assignees) };
    }),
    missing: missing.map((id) => ({ id, name: byId.get(id)?.name ?? id })),
  };
  await store.backend.set(IDEATION_KEY, stored);
  logger?.info?.("ideation.answered", { tickets: answers.length, missing: missing.length });
  return stored;
}
