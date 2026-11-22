// The assignee write behind the "nobody assigned" quick action. See
// netlify/functions/ticket-assignee.mjs for what it may and may not do.
//
// ClickUp adds assignees with PUT /task/{id} and { assignees: { add: [ids], rem: [] } }.
// Only `add` is ever sent. (Until 2026-11-17 this set the Project Owner field; that field
// was retired and the assignees are now who a ticket belongs to.)

import { httpJson } from "../lib/http.js";
import { sprintDriftFromStore } from "../delta/assignee-drift.js";
import { zonedParts, shiftDateKey } from "../lib/time.js";

export class AssigneeWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_TASKS = 20;

/**
 * @returns {{ assignee: {id, name}, set: string[], failed: {taskId, error}[] }}
 */
export async function setAssignee({ config, store, logger, token, taskIds, assigneeId, fetchImpl }) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter((id) => /^[a-z0-9]+$/i.test(id)))];
  if (!ids.length) throw new AssigneeWriteError("Which ticket?");
  if (ids.length > MAX_TASKS) throw new AssigneeWriteError(`At most ${MAX_TASKS} tickets at a time.`);
  const roster = [...(config.people?.team ?? []), ...(config.people?.alex ? [config.people.alex] : [])];
  const person = roster.find((p) => p.clickupUserId != null && String(p.clickupUserId) === String(assigneeId));
  if (!person) throw new AssigneeWriteError("Pick someone on the team roster.");
  if (!token) throw new AssigneeWriteError("CLICKUP_TOKEN is not set.", 500);

  // Only tickets the latest readout shows with nobody assigned: this is a fix for that
  // card, not a general way to reassign work.
  const report = await store.getLatestReport({});
  const tasks = new Map((report?.detail?.clickup?.tasks ?? []).map((t) => [String(t.id), t]));
  const unknown = ids.filter((id) => !tasks.has(id) || (tasks.get(id).assignees ?? []).length);
  if (unknown.length === ids.length) throw new AssigneeWriteError("None of those tickets is on the latest readout with nobody assigned. Refresh and try again.", 409);

  const http = config.system.http ?? {};
  const set = [];
  const failed = unknown.map((taskId) => ({ taskId, error: "not on the latest readout with nobody assigned, so left alone" }));
  for (const taskId of ids.filter((id) => !unknown.includes(id))) {
    try {
      await httpJson(`${config.clickup.apiBase}/task/${taskId}`, {
        method: "PUT",
        headers: { authorization: token },
        body: { assignees: { add: [Number(person.clickupUserId)], rem: [] } },
        logger,
        label: "clickup.task.add_assignee",
        fetchImpl,
        timeoutMs: http.timeoutMs,
        maxAttempts: Math.min(http.maxAttempts ?? 3, 3),
        backoffMsSchedule: http.backoffMsSchedule,
      });
      set.push(taskId);
    } catch (err) {
      failed.push({ taskId, error: err.message });
    }
  }

  const at = new Date().toISOString();
  const entry = { at, actor: "dashboard", field: "assignees", assignee: { id: String(person.clickupUserId), name: person.name }, set, failed };
  try {
    await store.backend.set(`clickup/writes/${at}-assignee.json`, entry);
  } catch (err) {
    logger?.warn?.("ticket_assignee.audit_failed", { err });
  }
  logger?.info?.("ticket_assignee.set", { set: set.length, failed: failed.length });
  return { assignee: entry.assignee, set, failed };
}

/**
 * Put a done ticket back on the people it had when it first came onto the sprint: add them,
 * and take off whoever is on it now who was not then. Only a ticket the reassignment check
 * flags right now (src/delta/assignee-drift.js), so it cannot be used to reassign anything
 * else. Alex, 2026-11-22: "prompt me if i want to update it back to the original".
 */
export async function restoreAssignees({ config, store, logger, token, taskId, fetchImpl, now = new Date() }) {
  const id = String(taskId ?? "");
  if (!/^[a-z0-9]+$/i.test(id)) throw new AssigneeWriteError("Which ticket?");
  if (!token) throw new AssigneeWriteError("CLICKUP_TOKEN is not set.", 500);
  const drift = await sprintDriftFromStore({ store, config, now, zonedParts, shiftDateKey });
  const t = drift.tickets.find((x) => x.id === id);
  if (!t) throw new AssigneeWriteError("That ticket is not flagged as reassigned any more. Refresh and look again.", 409);
  const was = new Set(t.was.map((u) => u.id));
  const nowIds = new Set(t.now.map((u) => u.id));
  const add = [...was].filter((u) => !nowIds.has(u)).map(Number);
  const rem = [...nowIds].filter((u) => !was.has(u)).map(Number);
  const http = config.system.http ?? {};
  await httpJson(`${config.clickup.apiBase}/task/${id}`, {
    method: "PUT",
    headers: { authorization: token },
    body: { assignees: { add, rem } },
    logger,
    label: "clickup.task.restore_assignees",
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: Math.min(http.maxAttempts ?? 3, 3),
    backoffMsSchedule: http.backoffMsSchedule,
  });
  const at = new Date().toISOString();
  const entry = { at, actor: "dashboard", field: "assignees", action: "restore", taskId: id, name: t.name, was: t.was, before: t.now, added: add.map(String), removed: rem.map(String) };
  try {
    await store.backend.set(`clickup/writes/${at}-assignee-restore.json`, entry);
  } catch (err) {
    logger?.warn?.("ticket_assignee.audit_failed", { err });
  }
  logger?.info?.("ticket_assignee.restored", { taskId: id, added: add.length, removed: rem.length });
  return { taskId: id, assignees: t.was, added: add.map(String), removed: rem.map(String) };
}
