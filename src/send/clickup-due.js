// The due-date write behind "Set due date" on a flag card. See netlify/functions/ticket-due.mjs.
//
// ClickUp sets a due date with PUT /task/{id} and { due_date: <ms>, due_date_time: false }
// (a date, not a time). Only the due date is ever sent.

import { httpJson } from "../lib/http.js";

export class DueWriteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A calendar day as ClickUp's date-only due date: midday UTC, so it is that day in any US zone. */
export function dueMs(dateKey) {
  const m = String(dateKey ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new DueWriteError("Pick a date.");
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17, 0, 0);
}

export async function setDueDate({ config, store, logger, token, taskId, date, fetchImpl, now = new Date() }) {
  const id = String(taskId ?? "");
  if (!/^[a-z0-9]+$/i.test(id)) throw new DueWriteError("Which ticket?");
  if (!token) throw new DueWriteError("CLICKUP_TOKEN is not set.", 500);
  const ms = dueMs(date);
  if (ms < now.getTime() - 2 * 86_400_000) throw new DueWriteError("That date has passed. Pick today or later.");
  if (ms > now.getTime() + 366 * 86_400_000) throw new DueWriteError("Pick a date within the next year.");

  // Only a ticket on the latest readout that is still open: this fixes a card.
  const report = await store.getLatestReport({});
  const task = [...(report?.detail?.clickup?.tasks ?? []), ...(report?.detail?.backlog?.items ?? [])].find((t) => String(t.id) === id);
  if (!task) throw new DueWriteError("That ticket is not on the latest readout. Refresh and try again.", 409);
  if (task.bucket === "done") throw new DueWriteError("That ticket is already done.", 409);

  const http = config.system.http ?? {};
  await httpJson(`${config.clickup.apiBase}/task/${id}`, {
    method: "PUT",
    headers: { authorization: token },
    body: { due_date: ms, due_date_time: false },
    logger,
    label: "clickup.task.set_due_date",
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: Math.min(http.maxAttempts ?? 3, 3),
    backoffMsSchedule: http.backoffMsSchedule,
  });
  const at = now.toISOString();
  const entry = { at, actor: "dashboard", field: "due_date", taskId: id, name: task.name, from: task.dueDate ?? null, to: ms, date };
  try {
    await store.backend.set(`clickup/writes/${at}-due.json`, entry);
  } catch (err) {
    logger?.warn?.("ticket_due.audit_failed", { err });
  }
  logger?.info?.("ticket_due.set", { date });
  return { taskId: id, dueDate: ms, date };
}
