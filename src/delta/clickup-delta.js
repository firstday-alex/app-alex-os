// Layer 2 delta. Two snapshots in, a change list out.
//
// The readout has to show everything Not Started, everything In Progress, and the day
// over day changes. The harder requirement is the last one in the spec: enough signal to
// tell "stalled, needs a question" apart from "picked up, just waiting". That is what
// classifyMovement does, and it is the reason the delta carries a per-task signal rather
// than just a list of changed fields.

import { statusAge, isStale, stalenessThreshold } from "../store/status-ledger.js";

const DAY_MS = 86400000;

function idsOf(list) {
  return (list ?? []).map((u) => String(u.id)).sort();
}

function sameIdSet(a, b) {
  const x = idsOf(a);
  const y = idsOf(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function label(users) {
  const names = (users ?? []).map((u) => u.username ?? u.id);
  return names.length ? names.join(", ") : "nobody";
}

/**
 * "Stalled, needs a question" vs "picked up, just waiting".
 *
 * moving  - status changed, or work landed on it since the baseline.
 * waiting - it moved recently but the status did not, so someone has it in hand.
 * stalled - In Progress, nothing has touched it for stalledAfterDays. This is the one
 *           that earns a clarifying question.
 * idle    - Not Started and nothing has touched it. Expected early in a sprint, worth
 *           noticing late in one.
 */
export function classifyMovement(current, before, { stalledAfterDays = 3, now = Date.now() } = {}) {
  const statusChanged = Boolean(before) && current.status !== before.status;
  const commentsGrew =
    typeof current.commentCount === "number" &&
    typeof before?.commentCount === "number" &&
    current.commentCount > before.commentCount;
  const assigneesChanged = Boolean(before) && !sameIdSet(current.assignees, before.assignees);
  const ownersChanged = Boolean(before) && !sameIdSet(current.taskOwners, before.taskOwners);
  const updatedMoved = Boolean(before) && (current.dateUpdated ?? 0) > (before.dateUpdated ?? 0);

  const touched = statusChanged || commentsGrew || assigneesChanged || ownersChanged || updatedMoved;
  const idleDays = current.dateUpdated ? Math.floor((now - current.dateUpdated) / DAY_MS) : null;

  let signal;
  if (statusChanged) signal = "moving";
  else if (touched) signal = "waiting";
  else if (current.bucket === "inProgress" && (idleDays ?? 0) >= stalledAfterDays) signal = "stalled";
  else if (current.bucket === "notStarted") signal = "idle";
  else signal = "waiting";

  return {
    signal,
    idleDays,
    changed: { statusChanged, commentsGrew, assigneesChanged, ownersChanged, updatedMoved },
  };
}

/**
 * @param {object|null} baseline previous working day's 8 AM snapshot, or null on a first run
 * @param {object} current this morning's snapshot
 */
export function clickupDelta(baseline, current, { config, now = Date.now(), comments = null, statusLedger = null } = {}) {
  const stalledAfterDays = config?.clickup?.rules?.stalledAfterDays ?? 3;
  const beforeById = new Map((baseline?.items ?? []).map((t) => [t.id, t]));
  const currentById = new Map((current?.items ?? []).map((t) => [t.id, t]));

  const changes = {
    newTasks: [],
    closed: [],
    disappeared: [],
    statusChanges: [],
    assigneeChanges: [],
    ownerChanges: [],
    priorityChanges: [],
    newComments: [],
  };

  const tasks = [];

  for (const task of current?.items ?? []) {
    const before = beforeById.get(task.id) ?? null;
    const movement = classifyMovement(task, before, { stalledAfterDays, now });

    // How long it has sat where it is, which is a different question from whether it
    // moved since yesterday. A ticket can be "waiting" every single day for a month.
    const age = statusAge(statusLedger?.entries?.[String(task.id)], new Date(now));
    const stale = isStale(task, age, config);

    const entry = {
      ...task,
      before: before ? { status: before.status, bucket: before.bucket } : null,
      ...movement,
      statusAge: age,
      stale,
      // Carried so the dashboard can show a healthy ticket's limit too. It has the
      // delta but not config.
      staleThresholdDays: stalenessThreshold(task, config),
    };
    tasks.push(entry);

    if (!before) {
      if (baseline) changes.newTasks.push(entry);
      continue;
    }
    if (movement.changed.statusChanged) {
      changes.statusChanges.push({ ...entry, from: before.status, to: task.status });
      if (task.bucket === "done" && before.bucket !== "done") changes.closed.push(entry);
    }
    if (movement.changed.assigneesChanged) {
      changes.assigneeChanges.push({ ...entry, from: label(before.assignees), to: label(task.assignees) });
    }
    if (movement.changed.ownersChanged) {
      changes.ownerChanges.push({ ...entry, from: label(before.taskOwners), to: label(task.taskOwners) });
    }
    if ((before.leadershipPriority?.optionId ?? null) !== (task.leadershipPriority?.optionId ?? null)) {
      changes.priorityChanges.push({
        ...entry,
        from: before.leadershipPriority?.label ?? "none",
        to: task.leadershipPriority?.label ?? "none",
      });
    }
    if (movement.changed.commentsGrew) {
      const fresh = comments?.[task.id] ?? current?.comments?.[task.id] ?? null;
      changes.newComments.push({
        ...entry,
        added: (task.commentCount ?? 0) - (before.commentCount ?? 0),
        latest: fresh?.latest ?? null,
      });
    }
  }

  for (const [id, before] of beforeById) {
    if (!currentById.has(id)) changes.disappeared.push(before);
  }

  // Worst first, not-started excluded. A backlog is supposed to sit, so including it
  // would put a year-old idea above a ticket that has been in QA for a fortnight.
  const byStaleness = tasks
    .filter((t) => t.bucket !== "notStarted" && t.bucket !== "done" && t.statusAge)
    .sort((a, b) => b.statusAge.days - a.statusAge.days || String(a.name).localeCompare(String(b.name)));

  const notStarted = tasks.filter((t) => t.bucket === "notStarted");
  const inProgress = tasks.filter((t) => t.bucket === "inProgress");
  const done = tasks.filter((t) => t.bucket === "done");

  return {
    hasBaseline: Boolean(baseline),
    baselineDate: baseline?.takenAt ?? null,
    tasks,
    boards: { notStarted, inProgress, done },
    byStaleness,
    changes,
    counts: {
      total: tasks.length,
      notStarted: notStarted.length,
      inProgress: inProgress.length,
      done: done.length,
      stalled: tasks.filter((t) => t.signal === "stalled").length,
      stale: tasks.filter((t) => t.stale).length,
      waiting: tasks.filter((t) => t.signal === "waiting").length,
      moving: tasks.filter((t) => t.signal === "moving").length,
      changed:
        changes.statusChanges.length +
        changes.assigneeChanges.length +
        changes.ownerChanges.length +
        changes.priorityChanges.length +
        changes.newComments.length +
        changes.newTasks.length,
    },
  };
}
