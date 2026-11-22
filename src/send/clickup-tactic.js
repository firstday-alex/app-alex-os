// The TACTIC write behind Done Tickets Hygiene: sets a ticket's TACTIC field (the ClickUp
// dropdown that was called Leadership Priority; `leadershipPriority` in code,
// config/clickup.json) to one of its live options. Alex, 2026-11-22: "offer me a way to update
// any not set rock fields or tactic fields with dropdowns".
//
// Narrow on purpose, like the ROCK write (src/send/clickup-rock.js): only the TACTIC field,
// only to an option the field has in ClickUp right now, and only on tickets the latest readout
// holds. ClickUp sets a dropdown with POST /task/{id}/field/{fieldId} and { value: "<uuid>" }.
// Every write is recorded under clickup/writes/ in this app's storage.

import { httpJson } from "../lib/http.js";
import { fetchFieldMap } from "../collectors/clickup.js";

export class TacticWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_TASKS = 20;

/** The TACTIC field's live options from ClickUp: [{ id, label }], in ClickUp's order. */
export async function tacticOptions({ config, store, logger, token, fetchImpl }) {
  const map = await fetchFieldMap({ config, token, store, logger, forceRefresh: true, ...(fetchImpl ? { fetchImpl } : {}) });
  const field = map.leadershipPriority;
  if (!field) throw new TacticWriteError("No TACTIC field found on the sprint list.", 502);
  const options = [...new Map(Object.values(map.options?.[field.id] ?? {}).map((o) => [String(o.id), o])).values()]
    .sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0))
    .map((o) => ({ id: String(o.id), label: o.label ?? o.name ?? String(o.id) }));
  return { fieldId: field.id, options };
}

/**
 * @returns {{ tactic: {id, label}, set: string[], failed: {taskId, error}[] }}
 */
export async function setTactic({ config, store, logger, token, taskIds, optionId, fetchImpl, options = null }) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter((id) => /^[a-z0-9]+$/i.test(id)))];
  if (!ids.length) throw new TacticWriteError("Which ticket?");
  if (ids.length > MAX_TASKS) throw new TacticWriteError(`At most ${MAX_TASKS} tickets at a time.`);
  if (!token) throw new TacticWriteError("CLICKUP_TOKEN is not set.", 500);
  const live = options ?? (await tacticOptions({ config, store, logger, token, fetchImpl }));
  const tactic = live.options.find((o) => o.id === String(optionId ?? ""));
  if (!tactic) throw new TacticWriteError("Pick one of the TACTIC options in ClickUp.");

  const report = await store.getLatestReport({});
  const tasks = new Set((report?.detail?.clickup?.tasks ?? []).map((t) => String(t.id)));
  const unknown = ids.filter((id) => !tasks.has(id));
  if (unknown.length === ids.length) throw new TacticWriteError("None of those tickets is on the latest readout. Refresh and try again.", 409);

  const http = config.system.http ?? {};
  const set = [];
  const failed = unknown.map((taskId) => ({ taskId, error: "not on the latest readout, so left alone" }));
  for (const taskId of ids.filter((id) => !unknown.includes(id))) {
    try {
      await httpJson(`${config.clickup.apiBase}/task/${taskId}/field/${live.fieldId}`, {
        method: "POST",
        headers: { authorization: token },
        body: { value: tactic.id },
        logger,
        label: "clickup.task.set_tactic",
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
  const entry = { at, actor: "dashboard", field: "TACTIC", tactic, set, failed };
  try {
    await store.backend.set(`clickup/writes/${at}-tactic.json`, entry);
  } catch (err) {
    logger?.warn?.("ticket_tactic.audit_failed", { err });
  }
  logger?.info?.("ticket_tactic.set", { set: set.length, failed: failed.length });
  return { tactic, set, failed };
}
