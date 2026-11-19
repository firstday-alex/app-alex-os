// "Create ClickUp ticket", a Slack message shortcut (⋯ on any message). Alex, 2026-11-19:
// "take a thread with all attachments in the original message and in the thread, put it
// into my ClickUp project for Site Backlog and fill out all applicable fields."
//
// What it does, in order:
//   1. Reads the whole thread the message belongs to (conversations.replies), as Alex
//      (SLACK_USER_TOKEN, so any channel or DM Alex can see), else as the bot.
//   2. Downloads every file posted in the thread (the original message and the replies).
//   3. One Claude call (skills/ticket-from-thread/SKILL.md) drafts the name, description
//      and fields, given the list's live custom fields and options. Images go to Claude too.
//   4. Code checks every field against the live definitions: an option, person or tag that
//      does not exist is dropped, a URL that is not in the thread is dropped. Ready to
//      Start? is always New Request.
//   5. Creates the task in Site Backlog (status backlog), sets each field, uploads every
//      file as an attachment, and puts the images in the description.
//   6. Tells Alex, only Alex (ephemeral), with the link and what was filled.
//
// It only ever creates a new task. It never edits or moves an existing one. The same
// thread twice gives the link to the ticket already made, not a second ticket. Nothing
// posts to the thread. No Slack id is stored: the dedupe key is a hash.

import crypto from "node:crypto";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { httpJson } from "../lib/http.js";
import { slackGet, slackToText } from "../collectors/standup.js";
import { ask, readSkill } from "../agents/anthropic.js";

export const TICKET_CALLBACK = "clickup_ticket";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_IMAGES_TO_CLAUDE = 6;
const MAX_IMAGE_TO_CLAUDE_BYTES = 4 * 1024 * 1024;
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NEW_REQUEST = "new request";

/** The field names the draft may fill, as the list names them. Ready to Start? is code's. */
const DROPDOWNS = { typeOfRequest: "Type of Request", taskCategory: "Task Category", rock: "ROCK", tactic: "TACTIC", experimentType: "Experiment Type" };
const TEXTS = { experimentHypothesis: "Experiment Hypothesis", testingRequirements: "Testing Requirements", deploymentNotes: "Deployment Notes", testTargeting: "🧪 Test Targeting" };
const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "fields", "openQuestions"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
    fields: {
      type: "object",
      additionalProperties: false,
      required: [...Object.keys(DROPDOWNS), ...Object.keys(TEXTS), "designReferenceUrl", "requestor", "collaborators", "priority", "tags", "dueDate"],
      properties: {
        ...Object.fromEntries(Object.keys(DROPDOWNS).map((k) => [k, nullable("string")])),
        ...Object.fromEntries(Object.keys(TEXTS).map((k) => [k, nullable("string")])),
        designReferenceUrl: nullable("string"),
        requestor: nullable("string"),
        collaborators: { type: "array", items: { type: "string" } },
        priority: nullable("string"),
        tags: { type: "array", items: { type: "string" } },
        dueDate: nullable("string"),
      },
    },
  },
};

export class TicketError extends Error {}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const strip = (s) => norm(s).replace(/[^\p{L}\p{N} ]/gu, "").trim();

/** Which thread: the message's parent when it is a reply, else the message itself. */
export function threadOf(payload) {
  const m = payload?.message ?? {};
  const channel = payload?.channel?.id ?? null;
  const ts = m.thread_ts ?? m.ts ?? null;
  return channel && ts ? { channel, ts } : null;
}

/**
 * The thread a pasted Slack message link points at: /archives/<channel>/p<ts>, with
 * ?thread_ts= when the link is to a reply. The link Slack hands a slash command may be
 * wrapped as <url> or <url|label>. Returns { channel, ts, link } or null.
 */
export function threadFromLink(text) {
  const raw = String(text ?? "").trim().replace(/^<|>$/g, "").split("|")[0];
  const m = raw.match(/^https:\/\/([a-z0-9-]+(?:\.enterprise)?)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/i);
  if (!m) return null;
  const [, domain, channel, sec, micro, query] = m;
  const threadTs = new URLSearchParams(query ?? "").get("thread_ts");
  const ts = threadTs && /^\d{10}\.\d{6}$/.test(threadTs) ? threadTs : `${sec}.${micro}`;
  return { channel, ts, link: `https://${domain}.slack.com/archives/${channel}/p${ts.replace(".", "")}` };
}

/** Hands the work to the background function; Slack wants an answer within three seconds. */
export async function handOffTicket(body, { logger, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = env.URL ?? env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  const res = await fetchImpl(`${base}/.netlify/functions/slack-ticket-background`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mos-internal": env.DASHBOARD_COOKIE_SECRET ?? "" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  logger?.info?.("ticket.handed_off", { status: res.status });
  if (!res.ok) throw new Error(`the background job answered HTTP ${res.status}`);
}

/** A stable, id-free key for a thread, so the same one twice finds the ticket already made. */
export const threadKey = (channel, ts) => crypto.createHash("sha256").update(`${channel}:${ts}`).digest("hex").slice(0, 16);

// ─── Slack ──────────────────────────────────────────────────────────────────────────

/**
 * The thread's messages, oldest first. Tries each token in turn: Alex's user token can read
 * anything Alex can; the bot only channels it is in.
 */
export async function readThread({ channel, ts, tokens, config, logger, fetchImpl }) {
  let lastErr = null;
  for (const token of tokens.filter(Boolean)) {
    try {
      const messages = [];
      let cursor;
      do {
        const body = await slackGet("conversations.replies", { channel, ts, limit: "200", ...(cursor ? { cursor } : {}) }, { token, config, logger, fetchImpl });
        messages.push(...(body.messages ?? []));
        cursor = body.response_metadata?.next_cursor || null;
      } while (cursor && messages.length < 1000);
      return { messages, token };
    } catch (err) {
      lastErr = err;
      logger?.warn?.("ticket.thread_read_failed", { err: err.slackError ?? err.message });
    }
  }
  throw new TicketError(`I could not read that thread: ${lastErr?.message ?? "no Slack token is set"}. Ecom OS reads threads with SLACK_USER_TOKEN, which needs the user scopes channels:history, groups:history, im:history and mpim:history.`);
}

/** Names for every author and mention, from users.info; an id never leaves this function. */
async function namesFor(messages, { token, config, logger, fetchImpl }) {
  const ids = new Set();
  for (const m of messages) {
    if (m.user) ids.add(m.user);
    for (const x of String(m.text ?? "").matchAll(/<@([A-Z0-9]+)>/g)) ids.add(x[1]);
  }
  const names = new Map();
  for (const m of messages) {
    const p = m.user_profile;
    if (m.user && p) names.set(m.user, p.real_name || p.display_name || p.name);
  }
  await Promise.all(
    [...ids].filter((id) => !names.has(id)).slice(0, 30).map(async (id) => {
      try {
        const body = await slackGet("users.info", { user: id }, { token, config, logger, fetchImpl });
        const n = body.user?.real_name || body.user?.profile?.real_name || body.user?.profile?.display_name || body.user?.name;
        if (n) names.set(id, n);
      } catch {
        // users:read missing: the name stays "someone"
      }
    }),
  );
  return names;
}

/** The thread as plain lines for Claude and the description: who, when, what, which files. */
export function threadLines(messages, names, { timeZone }) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return messages.map((m, i) => {
    const text = slackToText(String(m.text ?? "").replace(/<@([A-Z0-9]+)>/g, (w, id) => (names.has(id) ? `@${names.get(id)}` : "@someone"))).trim();
    const who = (m.user && names.get(m.user)) || m.username || m.bot_profile?.name || "Someone";
    const files = (m.files ?? []).filter((f) => f.mode !== "tombstone").map((f) => f.name || f.title || "file");
    return {
      n: i + 1,
      who,
      at: m.ts ? fmt.format(new Date(Number(m.ts) * 1000)) : "",
      text,
      files,
    };
  });
}

/** Every file posted in the thread, downloaded. Over the limits, a file is listed but not copied. */
export async function downloadFiles(messages, { token, logger, fetchImpl = globalThis.fetch }) {
  const out = [];
  let total = 0;
  for (const m of messages) {
    for (const f of m.files ?? []) {
      if (f.mode === "tombstone" || f.mode === "external") continue;
      const entry = { name: f.name || f.title || `file-${out.length + 1}`, mimetype: f.mimetype || "application/octet-stream", size: f.size ?? null, permalink: f.permalink ?? null, buffer: null, skipped: null };
      out.push(entry);
      const url = f.url_private_download || f.url_private;
      if (out.length > MAX_FILES) entry.skipped = `more than ${MAX_FILES} files`;
      else if (!url) entry.skipped = "Slack gave no download link";
      else if ((f.size ?? 0) > MAX_FILE_BYTES) entry.skipped = "over 25 MB";
      else if (total + (f.size ?? 0) > MAX_TOTAL_BYTES) entry.skipped = "the thread's files are over 80 MB in all";
      if (entry.skipped) continue;
      try {
        const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
        const type = res.headers.get("content-type") ?? "";
        // Without files:read Slack answers with its sign-in page, not the file.
        if (!res.ok || (/text\/html/.test(type) && !/html/.test(entry.mimetype))) throw new Error(res.ok ? "Slack sent a sign-in page (the token needs files:read)" : `HTTP ${res.status}`);
        entry.buffer = Buffer.from(await res.arrayBuffer());
        total += entry.buffer.length;
      } catch (err) {
        entry.skipped = `could not download: ${err.message}`;
        logger?.warn?.("ticket.file_download_failed", { err: err.message });
      }
    }
  }
  return out;
}

// ─── ClickUp ────────────────────────────────────────────────────────────────────────

function cu(config, token, logger, fetchImpl) {
  const http = config.system.http ?? {};
  return (path, { method = "GET", body, label } = {}) =>
    httpJson(`${config.clickup.apiBase}${path}`, {
      method,
      headers: { authorization: token },
      body,
      logger,
      label: label ?? `clickup.${method.toLowerCase()}`,
      fetchImpl,
      timeoutMs: http.timeoutMs,
      maxAttempts: Math.min(http.maxAttempts ?? 3, 3),
      backoffMsSchedule: http.backoffMsSchedule,
    }).then((r) => r.body);
}

/** The list's live fields, its members and its space's tags. */
export async function listContext({ listId, config, token, logger, fetchImpl }) {
  const get = cu(config, token, logger, fetchImpl);
  const [list, fields, members] = await Promise.all([
    get(`/list/${listId}`),
    get(`/list/${listId}/field`),
    get(`/list/${listId}/member`).catch(() => ({ members: [] })),
  ]);
  const tags = list?.space?.id ? await get(`/space/${list.space.id}/tag`).then((b) => b.tags ?? []).catch(() => []) : [];
  return {
    list: { id: String(list.id), name: list.name, statuses: (list.statuses ?? []).map((s) => s.status) },
    fields: fields.fields ?? [],
    members: (members.members ?? []).map((m) => ({ id: String(m.id), name: m.username ?? "" })).filter((m) => m.name),
    tags: tags.map((t) => t.name).filter(Boolean),
  };
}

const fieldByName = (fields, name) => fields.find((f) => norm(f.name) === norm(name)) ?? fields.find((f) => strip(f.name) === strip(name));
const optionOf = (field, name) => {
  if (!field || name == null) return null;
  const opts = field.type_config?.options ?? [];
  return opts.find((o) => norm(o.name) === norm(name)) ?? opts.find((o) => strip(o.name) === strip(name)) ?? null;
};

/** A person on the list by full name, or by a first name only one member has. */
export function memberByName(members, name) {
  if (!name) return null;
  const exact = members.filter((m) => norm(m.name) === norm(name));
  if (exact.length === 1) return exact[0];
  const first = norm(name).split(" ")[0];
  const byFirst = members.filter((m) => norm(m.name).split(" ")[0] === first);
  return byFirst.length === 1 && norm(name).split(" ").length === 1 ? byFirst[0] : exact[0] ?? null;
}

/**
 * The draft checked against the list. Returns what to write and what was dropped and why,
 * so nothing the model made up reaches ClickUp.
 */
export function checkDraft(draft, ctx, { threadText, today }) {
  const f = draft?.fields ?? {};
  const set = [];
  const dropped = [];
  const want = (key, label, value, ok, why) => (value == null || value === "" || (Array.isArray(value) && !value.length) ? null : ok ? true : (dropped.push(`${label} "${Array.isArray(value) ? value.join(", ") : value}": ${why}`), false));

  for (const [key, label] of Object.entries(DROPDOWNS)) {
    const field = fieldByName(ctx.fields, label);
    const opt = optionOf(field, f[key]);
    if (want(key, label, f[key], field && opt, field ? "not an option on this list" : "no such field on this list")) set.push({ id: field.id, name: field.name, value: opt.id, shown: opt.name });
  }
  const ready = fieldByName(ctx.fields, "Ready to Start?");
  const newRequest = ready?.type_config?.options?.find((o) => norm(o.name) === NEW_REQUEST);
  if (newRequest) set.push({ id: ready.id, name: ready.name, value: newRequest.id, shown: newRequest.name });

  for (const [key, label] of Object.entries(TEXTS)) {
    const field = fieldByName(ctx.fields, label);
    const text = typeof f[key] === "string" ? f[key].trim() : null;
    if (want(key, label, text, Boolean(field), "no such field on this list")) set.push({ id: field.id, name: field.name, value: text.slice(0, 5000), shown: text.length > 60 ? `${text.slice(0, 57)}…` : text });
  }

  const urlField = fieldByName(ctx.fields, "Design Reference URL");
  const url = typeof f.designReferenceUrl === "string" ? f.designReferenceUrl.trim() : null;
  if (want("designReferenceUrl", "Design Reference URL", url, urlField && /^https?:\/\/\S+$/.test(url ?? "") && threadText.includes(url.replace(/[>|].*$/, "")), urlField ? "not a link from the thread" : "no such field")) {
    set.push({ id: urlField.id, name: urlField.name, value: url, shown: url });
  }

  const requestorField = fieldByName(ctx.fields, "Requestor");
  const requestor = memberByName(ctx.members, f.requestor);
  if (want("requestor", "Requestor", f.requestor, requestorField && requestor, requestorField ? "not a member of this list in ClickUp" : "no such field")) {
    set.push({ id: requestorField.id, name: requestorField.name, value: { add: [Number(requestor.id)], rem: [] }, shown: requestor.name });
  }
  const collabField = fieldByName(ctx.fields, "Other Task Collaborators");
  const collabs = [];
  for (const n of f.collaborators ?? []) {
    const m = memberByName(ctx.members, n);
    if (m && !collabs.some((c) => c.id === m.id)) collabs.push(m);
    else if (!m) dropped.push(`Collaborator "${n}": not a member of this list in ClickUp`);
  }
  if (collabField && collabs.length) set.push({ id: collabField.id, name: collabField.name, value: { add: collabs.map((c) => Number(c.id)), rem: [] }, shown: collabs.map((c) => c.name).join(", ") });

  const tags = [];
  for (const t of f.tags ?? []) {
    const hit = ctx.tags.find((x) => norm(x) === norm(t));
    if (hit && !tags.includes(hit)) tags.push(hit);
    else if (!hit) dropped.push(`Tag "${t}": not a tag in this space (no new tags are made)`);
  }

  const priority = PRIORITY[norm(f.priority)] ?? null;
  let dueDate = null;
  if (f.dueDate) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(f.dueDate) ? new Date(`${f.dueDate}T17:00:00Z`) : null;
    if (d && !Number.isNaN(d.getTime()) && f.dueDate >= today) dueDate = d.getTime();
    else dropped.push(`Due date "${f.dueDate}": not a date from today on`);
  }

  const name = String(draft?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "Request from Slack";
  return { name, set, tags, priority, dueDate, dropped };
}

/** The attribution line, the draft, the open questions and where it came from. */
export function descriptionOf(draft, { people, date, link, files }) {
  const lines = [`_Created by Claude from a Slack thread${people.length ? ` with ${people.join(", ")}` : ""} (${date}), at Alex's request._`, ""];
  lines.push(String(draft?.description ?? "").trim());
  const open = (draft?.openQuestions ?? []).map((q) => String(q).trim()).filter(Boolean);
  if (open.length && !/##\s*open questions/i.test(draft?.description ?? "")) lines.push("", "## Open questions before starting", ...open.map((q) => `- ${q}`));
  if (link) lines.push("", "## Source", `[The Slack thread](${link})`);
  if (files.length) {
    lines.push("", "## Files from the thread");
    for (const f of files) {
      if (f.uploaded?.url && /^image\//.test(f.mimetype)) lines.push(`![${f.name}](${f.uploaded.url})`);
      else if (f.uploaded?.url) lines.push(`- [${f.name}](${f.uploaded.url})`);
      else lines.push(`- ${f.name}${f.skipped ? ` (not copied: ${f.skipped}${f.permalink ? `; [open in Slack](${f.permalink})` : ""})` : ""}`);
    }
  }
  return lines.join("\n").slice(0, 60000);
}

async function uploadFile({ config, token, taskId, file, fetchImpl = globalThis.fetch }) {
  const form = new FormData();
  form.append("attachment", new Blob([file.buffer], { type: file.mimetype }), file.name);
  const res = await fetchImpl(`${config.clickup.apiBase}/task/${taskId}/attachment`, { method: "POST", headers: { authorization: token }, body: form, signal: AbortSignal.timeout(120000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.err ?? `HTTP ${res.status}`);
  return { url: body.url ?? null };
}

// ─── The whole thing ───────────────────────────────────────────────────────────────

/**
 * @returns {{ text: string }} what to tell Alex.
 */
export async function ticketFromThread({ channel, ts, link, config, env = process.env, store, logger, fetchImpl, now = new Date(), askImpl = ask }) {
  const clickupToken = env.CLICKUP_TOKEN;
  if (!clickupToken) throw new TicketError("CLICKUP_TOKEN is not set.");
  const listId = String(config.clickup?.ticketFromSlack?.listId ?? config.clickup?.backlogListId ?? "");
  if (!listId) throw new TicketError("No list to put it in: set clickup.backlogListId in config/clickup.json.");

  const key = `clickup/from-slack/${threadKey(channel, ts)}.json`;
  const earlier = await store.backend.get(key).catch(() => null);
  if (earlier?.url) return { text: `This thread is already a ticket: <${earlier.url}|${earlier.name}> (made ${earlier.at.slice(0, 10)}). Add anything new there as a comment.`, existing: earlier };

  const tz = config.system.timezone;
  const { messages, token: slackToken } = await readThread({ channel, ts, tokens: [env.SLACK_USER_TOKEN?.startsWith("xoxp-") ? env.SLACK_USER_TOKEN : null, env.SLACK_BOT_TOKEN], config, logger, fetchImpl });
  if (!messages.length) throw new TicketError("That thread came back empty.");
  const names = await namesFor(messages, { token: slackToken, config, logger, fetchImpl });
  const lines = threadLines(messages, names, { timeZone: tz });
  const [files, ctx] = await Promise.all([downloadFiles(messages, { token: slackToken, logger, fetchImpl }), listContext({ listId, config, token: clickupToken, logger, fetchImpl })]);

  const threadText = lines.map((l) => l.text).join("\n");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const options = (label) => (fieldByName(ctx.fields, label)?.type_config?.options ?? []).map((o) => o.name);
  const images = files.filter((f) => f.buffer && CLAUDE_IMAGE_TYPES.has(f.mimetype) && f.buffer.length <= MAX_IMAGE_TO_CLAUDE_BYTES).slice(0, MAX_IMAGES_TO_CLAUDE);

  const result = await askImpl({
    system: readSkill("ticket-from-thread"),
    config,
    env,
    logger,
    maxTokens: 8000,
    effort: "medium",
    outputFormat: betaJSONSchemaOutputFormat(SCHEMA, "clickup_ticket"),
    messages: [
      {
        role: "user",
        content: [
          ...images.flatMap((f) => [
            { type: "text", text: `Image posted in the thread: ${f.name}` },
            { type: "image", source: { type: "base64", media_type: f.mimetype, data: f.buffer.toString("base64") } },
          ]),
          {
            type: "text",
            text: [
              `Today is ${today}. The ticket goes in ClickUp list "${ctx.list.name}".`,
              "",
              "THE THREAD (oldest first):",
              ...lines.map((l) => `[${l.n}] ${l.who} (${l.at}): ${l.text || "(no text)"}${l.files.length ? `\n    files: ${l.files.join(", ")}` : ""}`),
              "",
              "THE FIELDS YOU MAY FILL, with the only values each accepts:",
              ...Object.entries(DROPDOWNS).map(([k, label]) => `- ${k} (${label}): ${JSON.stringify(options(label))}`),
              ...Object.entries(TEXTS).map(([k, label]) => `- ${k} (${label}): free text`),
              "- designReferenceUrl: a link copied exactly from the thread, or null",
              `- requestor, collaborators: names from this list's members: ${JSON.stringify(ctx.members.map((m) => m.name))}`,
              `- tags: only from: ${JSON.stringify(ctx.tags)}`,
              `- priority: one of ${JSON.stringify(Object.keys(PRIORITY))}, or null`,
              "- dueDate: YYYY-MM-DD only if the thread names a date, else null",
            ].join("\n"),
          },
        ],
      },
    ],
  });
  if (result.refused || !result.parsed) throw new TicketError(result.refused ? "Claude declined to draft this one." : "Claude's draft came back unreadable. Try again.");
  const draft = result.parsed;
  const checked = checkDraft(draft, ctx, { threadText, today });

  const people = [...new Set(lines.map((l) => l.who).filter((w) => w !== "Someone"))];
  const date = lines[0]?.at?.replace(/,.*$/, "") ?? today;
  const post = cu(config, clickupToken, logger, fetchImpl);
  const status = ctx.list.statuses.find((s) => norm(s) === "backlog") ?? ctx.list.statuses[0];
  const task = await post(`/list/${listId}/task`, {
    method: "POST",
    label: "clickup.task.create_from_slack",
    body: {
      name: checked.name,
      markdown_content: descriptionOf(draft, { people, date, link, files: [] }),
      ...(status ? { status } : {}),
      ...(checked.priority ? { priority: checked.priority } : {}),
      ...(checked.tags.length ? { tags: checked.tags } : {}),
      ...(checked.dueDate ? { due_date: checked.dueDate, due_date_time: false } : {}),
    },
  });

  // Each field on its own, so one refused value does not lose the rest.
  const filled = [];
  for (const s of checked.set) {
    try {
      await post(`/task/${task.id}/field/${s.id}`, { method: "POST", label: "clickup.task.set_field", body: { value: s.value } });
      filled.push(`${s.name}: ${s.shown}`);
    } catch (err) {
      checked.dropped.push(`${s.name}: ClickUp refused it (${err.message})`);
    }
  }

  for (const f of files.filter((x) => x.buffer)) {
    try {
      f.uploaded = await uploadFile({ config, token: clickupToken, taskId: task.id, file: f, fetchImpl });
    } catch (err) {
      f.skipped = `ClickUp refused the upload (${err.message})`;
      logger?.warn?.("ticket.upload_failed", { err: err.message });
    }
  }
  if (files.length) {
    await post(`/task/${task.id}`, { method: "PUT", label: "clickup.task.add_files_to_description", body: { markdown_content: descriptionOf(draft, { people, date, link, files }) } }).catch((err) => logger?.warn?.("ticket.description_update_failed", { err: err.message }));
  }

  const at = new Date().toISOString();
  const record = { at, name: checked.name, url: task.url, taskId: task.id };
  await store.backend.set(key, record).catch(() => {});
  await store.backend
    .set(`clickup/writes/${at}-ticket.json`, { at, actor: "slack-shortcut", action: "create task", listId, taskId: task.id, url: task.url, filled, tags: checked.tags, priority: checked.priority, dropped: checked.dropped, files: files.map((f) => ({ name: f.name, copied: Boolean(f.uploaded), skipped: f.skipped })) })
    .catch((err) => logger?.warn?.("ticket.audit_failed", { err }));
  logger?.info?.("ticket.created_from_slack", { fields: filled.length, files: files.filter((f) => f.uploaded).length, dropped: checked.dropped.length });

  const copied = files.filter((f) => f.uploaded).length;
  const empty = [...Object.values(DROPDOWNS), ...Object.values(TEXTS), "Design Reference URL", "Requestor"].filter((label) => !filled.some((x) => x.startsWith(`${fieldByName(ctx.fields, label)?.name ?? label}:`)));
  const text = [
    `Made <${task.url}|${checked.name}> in ${ctx.list.name} (status ${status ?? "default"}).`,
    filled.length ? `*Filled:* ${filled.join(" · ")}` : null,
    checked.tags.length ? `*Tags:* ${checked.tags.join(", ")}` : null,
    checked.priority ? `*Priority:* ${Object.keys(PRIORITY).find((k) => PRIORITY[k] === checked.priority)}` : null,
    files.length ? `*Files:* ${copied} of ${files.length} attached${files.some((f) => f.skipped) ? ` (not copied: ${files.filter((f) => f.skipped).map((f) => `${f.name}, ${f.skipped}`).join("; ")})` : ""}` : null,
    empty.length ? `*Left empty (the thread didn't say):* ${empty.join(", ")}` : null,
    checked.dropped.length ? `*Dropped, not on the list:* ${checked.dropped.join("; ")}` : null,
  ].filter(Boolean).join("\n");
  return { text, task: record, filled, dropped: checked.dropped };
}
