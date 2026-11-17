// The Task Owner write behind the "no Task Owner" quick action. See
// netlify/functions/ticket-owner.mjs for what it may and may not do.
//
// ClickUp's people field takes { value: { add: [ids], rem: [] } } on
// POST /task/{id}/field/{field id}. Only `add` is ever sent.

import { httpJson } from "../lib/http.js";
import { fetchFieldMap } from "../collectors/clickup.js";

export class OwnerWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_TASKS = 20;

/**
 * @returns {{ owner: {id, name}, set: string[], failed: {taskId, error}[] }}
 */
export async function setTaskOwner({ config, store, logger, token, taskIds, ownerId, fetchImpl }) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter((id) => /^[a-z0-9]+$/i.test(id)))];
  if (!ids.length) throw new OwnerWriteError("Which ticket?");
  if (ids.length > MAX_TASKS) throw new OwnerWriteError(`At most ${MAX_TASKS} tickets at a time.`);
  const roster = [...(config.people?.team ?? []), ...(config.people?.alex ? [config.people.alex] : [])];
  const person = roster.find((p) => p.clickupUserId != null && String(p.clickupUserId) === String(ownerId));
  if (!person) throw new OwnerWriteError("Pick someone on the team roster.");
  if (!token) throw new OwnerWriteError("CLICKUP_TOKEN is not set.", 500);

  // Only tickets the latest readout shows with no Task Owner: this is a fix for that
  // card, not a general way to reassign work.
  const report = await store.getLatestReport({});
  const tasks = new Map((report?.detail?.clickup?.tasks ?? []).map((t) => [String(t.id), t]));
  const unknown = ids.filter((id) => !tasks.has(id) || (tasks.get(id).taskOwners ?? []).length);
  if (unknown.length === ids.length) throw new OwnerWriteError("None of those tickets is on the latest readout without a Task Owner. Refresh and try again.", 409);

  const fieldMap = await fetchFieldMap({ config, token, store, logger, fetchImpl });
  const fieldId = fieldMap.taskOwner?.id;
  if (!fieldId) throw new OwnerWriteError("The Task Owner field was not found on the sprint list.", 500);

  const http = config.system.http ?? {};
  const set = [];
  const failed = unknown.map((taskId) => ({ taskId, error: "not on the latest readout without a Task Owner, so left alone" }));
  for (const taskId of ids.filter((id) => !unknown.includes(id))) {
    try {
      await httpJson(`${config.clickup.apiBase}/task/${taskId}/field/${fieldId}`, {
        method: "POST",
        headers: { authorization: token },
        body: { value: { add: [Number(person.clickupUserId)], rem: [] } },
        logger,
        label: "clickup.task.set_owner",
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
  const entry = { at, actor: "dashboard", field: "Task Owner", owner: { id: String(person.clickupUserId), name: person.name }, set, failed };
  try {
    await store.backend.set(`clickup/writes/${at}-owner.json`, entry);
  } catch (err) {
    logger?.warn?.("ticket_owner.audit_failed", { err });
  }
  logger?.info?.("ticket_owner.set", { set: set.length, failed: failed.length });
  return { owner: entry.owner, set, failed };
}
