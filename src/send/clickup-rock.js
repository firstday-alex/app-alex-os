// The ROCK write behind "Set ROCK" on a flag card: sets a ticket's ROCK field (the ClickUp
// dropdown that was called Big Swing; `bigSwing` in code, config/clickup.json) to one of
// the live rocks. See netlify/functions/ticket-rock.mjs for what it may and may not do.
//
// ClickUp sets a dropdown custom field with POST /task/{id}/field/{fieldId} and
// { value: "<option uuid>" }. Only that one field is ever written.

import { httpJson } from "../lib/http.js";

export class RockWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_TASKS = 20;

/** The rocks a ticket can be put on: active ones in the latest readout with a ClickUp ROCK option. */
export function rockChoices(report) {
  return (report?.detail?.leadership?.queue ?? [])
    .filter((r) => r.state === "active")
    .map((r) => ({ id: r.id, title: r.title, bau: Boolean(r.bau), optionId: (r.clickupBigSwingOptionIds ?? [])[0] ?? r.clickupBigSwingOptionId ?? null }))
    .filter((r) => r.optionId);
}

/**
 * @returns {{ rock: {id, title}, set: string[], failed: {taskId, error}[] }}
 */
export async function setRock({ config, store, logger, token, taskIds, rockId, fetchImpl }) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter((id) => /^[a-z0-9]+$/i.test(id)))];
  if (!ids.length) throw new RockWriteError("Which ticket?");
  if (ids.length > MAX_TASKS) throw new RockWriteError(`At most ${MAX_TASKS} tickets at a time.`);
  const fieldId = config.clickup?.customFields?.bigSwing?.id;
  if (!fieldId) throw new RockWriteError("The ROCK field id is not in config/clickup.json.", 500);
  if (!token) throw new RockWriteError("CLICKUP_TOKEN is not set.", 500);

  const report = await store.getLatestReport({});
  const rock = rockChoices(report).find((r) => r.id === String(rockId ?? ""));
  if (!rock) throw new RockWriteError("Pick one of the live rocks.");

  // Only tickets on the latest readout: this fixes a card, it is not a bulk editor.
  const tasks = new Set((report?.detail?.clickup?.tasks ?? []).map((t) => String(t.id)));
  const unknown = ids.filter((id) => !tasks.has(id));
  if (unknown.length === ids.length) throw new RockWriteError("None of those tickets is on the latest readout. Refresh and try again.", 409);

  const http = config.system.http ?? {};
  const set = [];
  const failed = unknown.map((taskId) => ({ taskId, error: "not on the latest readout, so left alone" }));
  for (const taskId of ids.filter((id) => !unknown.includes(id))) {
    try {
      await httpJson(`${config.clickup.apiBase}/task/${taskId}/field/${fieldId}`, {
        method: "POST",
        headers: { authorization: token },
        body: { value: rock.optionId },
        logger,
        label: "clickup.task.set_rock",
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
  const entry = { at, actor: "dashboard", field: "ROCK", rock: { id: rock.id, title: rock.title, optionId: rock.optionId }, set, failed };
  try {
    await store.backend.set(`clickup/writes/${at}-rock.json`, entry);
  } catch (err) {
    logger?.warn?.("ticket_rock.audit_failed", { err });
  }
  logger?.info?.("ticket_rock.set", { set: set.length, failed: failed.length });
  return { rock: { id: rock.id, title: rock.title, optionId: rock.optionId }, set, failed };
}
