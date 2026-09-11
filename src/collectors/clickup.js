// Layer 2 collector. ClickUp sprint tickets.
//
// Deterministic. One endpoint does the core job:
//   GET /api/v2/list/{list_id}/task
// Custom fields ride along in the same call, so Task Owner and Leadership Priority cost
// no extra request. Comments do NOT ride along: they are fetched only for tasks whose
// date_updated moved since the baseline, because a comment bumps date_updated.
//
// Auth: personal API token in the Authorization header with NO Bearer prefix.

import { httpJson, paginate } from "../lib/http.js";

const FIELD_MAP_CACHE_KEY = "clickup/field-map";
const FIELD_MAP_TTL_SECONDS = 24 * 60 * 60;

function authHeaders(token) {
  // ClickUp personal tokens go on Authorization with no scheme prefix.
  return { authorization: token };
}

/* --------------------------- custom field resolution --------------------------- */

/**
 * Resolves the ids of the Task Owner and Leadership Priority fields, and builds the
 * dropdown option id -> label map.
 *
 * Dropdowns return the selected option as an id, not a label. Labels get renamed and ids
 * do not, so everything downstream keys on the id and carries the label only for display.
 */
export function buildFieldMap(fields, clickupConfig) {
  const wanted = clickupConfig.customFields ?? {};
  const result = { taskOwner: null, leadershipPriority: null, options: {}, all: [] };

  const normalize = (s) => String(s ?? "").trim().toLowerCase();

  for (const field of fields ?? []) {
    result.all.push({ id: field.id, name: field.name, type: field.type });

    for (const key of ["taskOwner", "leadershipPriority"]) {
      const spec = wanted[key];
      if (!spec || result[key]) continue;
      const byId = spec.id && spec.id === field.id;
      const byName = (spec.matchName ?? []).some((n) => normalize(n) === normalize(field.name));
      if (byId || byName) {
        result[key] = { id: field.id, name: field.name, type: field.type };
        const options = field.type_config?.options ?? [];
        result.options[field.id] = Object.fromEntries(
          options.map((opt) => [
            String(opt.id ?? opt.orderindex),
            { id: String(opt.id ?? opt.orderindex), label: opt.name ?? opt.label ?? String(opt.value ?? ""), orderindex: opt.orderindex },
          ]),
        );
      }
    }
  }
  return result;
}

export async function fetchFieldMap({ config, token, store, logger, fetchImpl, sleep, forceRefresh = false }) {
  const cu = config.clickup;
  if (!forceRefresh && store) {
    const cached = await store.getCached(FIELD_MAP_CACHE_KEY, { ttlSeconds: FIELD_MAP_TTL_SECONDS });
    if (cached) return cached;
  }

  const url = `${cu.apiBase}/list/${cu.sprintListId}/field`;
  const { body } = await httpJson(url, {
    headers: authHeaders(token),
    logger,
    label: "clickup.list.field",
    fetchImpl,
    timeoutMs: config.system.http.timeoutMs,
    maxAttempts: config.system.http.maxAttempts,
    backoffMsSchedule: config.system.http.backoffMsSchedule,
    sleep,
  });

  const map = buildFieldMap(body?.fields ?? [], cu);
  if (!map.taskOwner) {
    logger?.warn("clickup.field_missing", { field: "taskOwner", looked_for: cu.customFields?.taskOwner?.matchName });
  }
  if (!map.leadershipPriority) {
    logger?.warn("clickup.field_missing", { field: "leadershipPriority", looked_for: cu.customFields?.leadershipPriority?.matchName });
  }
  if (store) await store.setCached(FIELD_MAP_CACHE_KEY, map);
  return map;
}

/* ------------------------------ normalization ------------------------------ */

/** Buckets a task's custom status name into notStarted / inProgress / done. */
export function statusBucket(statusName, statusMap, logger) {
  const name = String(statusName ?? "").trim().toLowerCase();
  for (const bucket of ["done", "inProgress", "notStarted"]) {
    const names = (statusMap[bucket] ?? []).map((n) => String(n).trim().toLowerCase());
    if (names.includes(name)) return bucket;
  }
  logger?.warn("clickup.status_unmapped", { status: statusName, defaulted_to: "notStarted" });
  return "notStarted";
}

function customFieldValue(task, fieldId) {
  if (!fieldId) return undefined;
  const field = (task.custom_fields ?? []).find((f) => f.id === fieldId);
  return field?.value;
}

/**
 * One task, flattened to only what the delta and the checks need.
 *
 * A missing custom field is null, never an error. The spec is explicit: treat as null,
 * flag as unassigned or no priority, do not error.
 */
export function normalizeTask(task, { fieldMap, statusMap, logger }) {
  const ownerFieldId = fieldMap.taskOwner?.id ?? null;
  const priorityFieldId = fieldMap.leadershipPriority?.id ?? null;

  const rawOwner = customFieldValue(task, ownerFieldId);
  const owners = Array.isArray(rawOwner)
    ? rawOwner.map((u) => ({ id: String(u.id ?? u), username: u.username ?? u.email ?? null }))
    : rawOwner
      ? [{ id: String(rawOwner.id ?? rawOwner), username: rawOwner.username ?? null }]
      : [];

  const rawPriority = customFieldValue(task, priorityFieldId);
  const optionId = rawPriority == null ? null : String(rawPriority.id ?? rawPriority);
  const optionTable = priorityFieldId ? (fieldMap.options?.[priorityFieldId] ?? {}) : {};
  const leadershipPriority = optionId
    ? { optionId, label: optionTable[optionId]?.label ?? null }
    : null;

  const statusName = task.status?.status ?? null;

  return {
    id: task.id,
    name: task.name ?? null,
    url: task.url ?? null,
    listId: task.list?.id ?? null,
    listName: task.list?.name ?? null,
    status: statusName,
    statusType: task.status?.type ?? null,
    bucket: statusBucket(statusName, statusMap, logger),
    assignees: (task.assignees ?? []).map((u) => ({ id: String(u.id), username: u.username ?? null })),
    taskOwners: owners,
    leadershipPriority,
    priority: task.priority?.priority ?? null,
    dueDate: task.due_date ? Number(task.due_date) : null,
    dateUpdated: task.date_updated ? Number(task.date_updated) : null,
    dateClosed: task.date_closed ? Number(task.date_closed) : null,
    dateCreated: task.date_created ? Number(task.date_created) : null,
    archived: Boolean(task.archived),
    closed: Boolean(task.date_closed) || task.status?.type === "closed",
    commentCount: null, // filled in below only for tasks that moved
  };
}

/* -------------------------------- collection -------------------------------- */

export async function fetchTaskPages({ config, token, logger, fetchImpl, sleep }) {
  const cu = config.clickup;
  const q = cu.taskQuery ?? {};
  const http = config.system.http;

  const result = await paginate({
    label: "clickup.list.task",
    maxPages: http.maxPages,
    logger,
    fetchPage: async (page) => {
      const params = new URLSearchParams({
        page: String(page),
        include_closed: String(q.include_closed ?? true),
        subtasks: String(q.subtasks ?? false),
        include_timl: String(q.include_timl ?? true),
        order_by: "updated",
      });
      const url = `${cu.apiBase}/list/${cu.sprintListId}/task?${params}`;
      const { body } = await httpJson(url, {
        headers: authHeaders(token),
        logger,
        label: "clickup.list.task",
        fetchImpl,
        timeoutMs: http.timeoutMs,
        maxAttempts: http.maxAttempts,
        backoffMsSchedule: http.backoffMsSchedule,
        sleep,
      });
      return body ?? {};
    },
    extract: (body) => body.tasks ?? [],
    isLastPage: (body) => body.last_page === true,
  });

  return result;
}

/**
 * Comments for tasks that moved. A comment bumps date_updated, so comparing
 * date_updated against the baseline catches new comments cheaply. Capped per run so a
 * board-wide edit cannot blow through the rate limit.
 */
export async function fetchCommentsForChanged({ config, token, tasks, baselineTasks, logger, fetchImpl, sleep }) {
  const cu = config.clickup;
  const http = config.system.http;
  const cap = cu.rules?.commentFetchCapPerRun ?? 60;
  if (cu.rules?.fetchCommentsOnlyWhenUpdated === false) return { comments: {}, fetched: 0, skipped: 0 };

  const baselineById = new Map((baselineTasks ?? []).map((t) => [t.id, t]));
  const moved = tasks.filter((task) => {
    const before = baselineById.get(task.id);
    if (!before) return true; // brand new task, fetch once
    return (task.dateUpdated ?? 0) > (before.dateUpdated ?? 0);
  });

  const target = moved.slice(0, cap);
  if (moved.length > cap) {
    logger?.warn("clickup.comment_fetch_capped", { moved: moved.length, cap });
  }

  const comments = {};
  for (const task of target) {
    try {
      const url = `${cu.apiBase}/task/${task.id}/comment`;
      const { body } = await httpJson(url, {
        headers: authHeaders(token),
        logger,
        label: "clickup.task.comment",
        fetchImpl,
        timeoutMs: http.timeoutMs,
        maxAttempts: http.maxAttempts,
        backoffMsSchedule: http.backoffMsSchedule,
        sleep,
      });
      const list = body?.comments ?? [];
      comments[task.id] = {
        count: list.length,
        ids: list.map((c) => String(c.id)),
        latest: list.length
          ? {
              id: String(list[0].id),
              user: list[0].user?.username ?? null,
              date: list[0].date ? Number(list[0].date) : null,
              text: String(list[0].comment_text ?? "").slice(0, 280),
            }
          : null,
      };
    } catch (err) {
      // One task's comments failing must not sink the whole collector.
      logger?.warn("clickup.comment_fetch_failed", { taskId: task.id, err });
      comments[task.id] = { count: null, ids: [], latest: null, error: true };
    }
  }

  return { comments, fetched: target.length, skipped: tasks.length - target.length };
}

export async function fetchTeamMembers({ config, token, logger, fetchImpl, sleep }) {
  const http = config.system.http;
  try {
    const { body } = await httpJson(`${config.clickup.apiBase}/team`, {
      headers: authHeaders(token),
      logger,
      label: "clickup.team",
      fetchImpl,
      timeoutMs: http.timeoutMs,
      maxAttempts: http.maxAttempts,
      backoffMsSchedule: http.backoffMsSchedule,
      sleep,
    });
    const members = (body?.teams ?? []).flatMap((team) =>
      (team.members ?? []).map((m) => ({ id: String(m.user?.id), username: m.user?.username ?? null, email: m.user?.email ?? null })),
    );
    return members;
  } catch (err) {
    logger?.warn("clickup.team_fetch_failed", { err });
    return [];
  }
}

/**
 * The collector. Returns a snapshot, or throws. Callers treat a throw as "this section is
 * missing" and still render the rest of the readout.
 */
export async function collectClickUp({ config, token, store, logger, fetchImpl, sleep, baseline = null, now = new Date() }) {
  if (!token) throw new Error("CLICKUP_TOKEN is not set");

  const fieldMap = await fetchFieldMap({ config, token, store, logger, fetchImpl, sleep });
  const { items: rawTasks, pages, truncated } = await fetchTaskPages({ config, token, logger, fetchImpl, sleep });

  const tasks = rawTasks.map((task) =>
    normalizeTask(task, { fieldMap, statusMap: config.clickup.statusMap, logger }),
  );

  const { comments, fetched } = await fetchCommentsForChanged({
    config,
    token,
    tasks,
    baselineTasks: baseline?.items ?? null,
    logger,
    fetchImpl,
    sleep,
  });

  const baselineById = new Map((baseline?.items ?? []).map((t) => [t.id, t]));
  for (const task of tasks) {
    const fresh = comments[task.id];
    if (fresh) task.commentCount = fresh.count;
    // A task we did not re-fetch has not moved, so its comment count is unchanged.
    else task.commentCount = baselineById.get(task.id)?.commentCount ?? null;
  }

  const members = (config.people?.team ?? []).some((p) => p.clickupUserId != null)
    ? config.people.team.map((p) => ({ id: String(p.clickupUserId), username: p.name, fromConfig: true }))
    : await fetchTeamMembers({ config, token, logger, fetchImpl, sleep });

  return {
    source: "clickup",
    takenAt: now.toISOString(),
    listId: config.clickup.sprintListId,
    fieldMap: { taskOwner: fieldMap.taskOwner, leadershipPriority: fieldMap.leadershipPriority, options: fieldMap.options },
    items: tasks,
    comments,
    members,
    meta: { pages, truncated, commentsFetched: fetched, taskCount: tasks.length },
  };
}
