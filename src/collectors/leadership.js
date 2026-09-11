// Layer 1 collector. The leadership queue.
//
// There is no third-party system behind Layer 1. The queue lives in
// config/leadership-queue.json, which means it is edited by pull request and therefore has
// a git history: who added a P1, when, and when it shipped. That is consistent with the
// DECIDED rule that config is the single source of truth.
//
// The collector's job is to read the queue, resolve owners against the roster, and hand
// the ClickUp dropdown options over so the sync check has something to compare.

export function resolveOwner(ownerRef, people) {
  if (ownerRef == null) return null;
  const asString = String(ownerRef);
  const match = (people?.team ?? []).find(
    (p) => String(p.clickupUserId) === asString || String(p.name).toLowerCase() === asString.toLowerCase(),
  );
  if (match) {
    return { clickupUserId: match.clickupUserId == null ? null : String(match.clickupUserId), name: match.name, slackUserId: match.slackUserId ?? null };
  }
  return { clickupUserId: asString, name: asString, slackUserId: null, unresolved: true };
}

export async function collectLeadership({ config, clickupSnapshot = null, logger, now = new Date() }) {
  const queueConfig = config.leadershipQueue ?? {};
  const people = config.people ?? {};

  const mapItem = (item, defaultState) => ({
    id: String(item.id),
    title: item.title ?? null,
    type: item.type ?? null,
    state: item.state ?? defaultState,
    owner: resolveOwner(item.owner, people),
    clickupOptionId: item.clickupOptionId == null ? null : String(item.clickupOptionId),
    shippedAt: item.shippedAt ?? null,
    lastMiniReadoutAt: item.lastMiniReadoutAt ?? null,
    intelligemsExperienceId: item.intelligemsExperienceId == null ? null : String(item.intelligemsExperienceId),
    notes: item.notes ?? null,
    // Everything in the leadership queue is a P1 by definition.
    priority: "P1",
  });

  const queue = (queueConfig.queue ?? []).map((item) => mapItem(item, "active"));
  const backlog = (queueConfig.backlog ?? []).map((item) => mapItem(item, "backlog"));

  // The dropdown options currently offered in ClickUp, so the sync check can compare them
  // against the live queue. Pulled from the snapshot we already have. No extra API call.
  const priorityFieldId = clickupSnapshot?.fieldMap?.leadershipPriority?.id ?? null;
  const dropdownOptions = priorityFieldId
    ? Object.values(clickupSnapshot?.fieldMap?.options?.[priorityFieldId] ?? {}).map((o) => ({ id: String(o.id), label: o.label }))
    : [];

  const roster = (people.team ?? [])
    .filter((p) => p.clickupUserId != null && p.countsTowardCapacity !== false)
    .map((p) => ({ clickupUserId: String(p.clickupUserId), name: p.name, slackUserId: p.slackUserId ?? null }));

  const rosterFallback =
    roster.length === 0
      ? (clickupSnapshot?.members ?? []).map((m) => ({ clickupUserId: String(m.id), name: m.username, slackUserId: null }))
      : [];

  if (rosterFallback.length) {
    logger?.warn("leadership.roster_fallback", {
      reason: "people.json has no real entries; using the ClickUp workspace member list",
      count: rosterFallback.length,
    });
  }

  return {
    source: "leadership",
    takenAt: now.toISOString(),
    items: [...queue, ...backlog],
    queue,
    backlog,
    roster: roster.length ? roster : rosterFallback,
    dropdownOptions,
    meta: {
      queueSize: queue.length,
      backlogSize: backlog.length,
      rosterSize: (roster.length ? roster : rosterFallback).length,
      rosterFromFallback: roster.length === 0,
    },
  };
}
