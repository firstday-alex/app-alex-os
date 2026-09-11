// Small hand-written fixtures. Five tasks max, per the spec: a delta test wants a diff you
// can hold in your head, not a captured board.

export const FIELD_MAP = {
  taskOwner: { id: "f_owner", name: "Task Owner", type: "users" },
  leadershipPriority: { id: "f_priority", name: "Leadership Priority", type: "drop_down" },
  options: {
    f_priority: {
      opt_sub: { id: "opt_sub", label: "Subscription upsell", orderindex: 0 },
      opt_ship: { id: "opt_ship", label: "Shipping threshold test", orderindex: 1 },
      opt_bau: { id: "opt_bau", label: "Business as usual", orderindex: 2 },
    },
  },
};

const DAY = 86400000;
export const NOW = Date.parse("2026-09-10T13:00:00Z");

/** A normalized task, the shape the collector produces. */
export function task(overrides = {}) {
  return {
    id: "t1",
    name: "Task one",
    url: "https://app.clickup.com/t/t1",
    listId: "L1",
    listName: "Sprint",
    status: "in progress",
    statusType: "custom",
    bucket: "inProgress",
    assignees: [{ id: "u1", username: "dana" }],
    taskOwners: [{ id: "u1", username: "dana" }],
    leadershipPriority: { optionId: "opt_sub", label: "Subscription upsell" },
    priority: null,
    dueDate: null,
    dateUpdated: NOW - DAY,
    dateClosed: null,
    dateCreated: NOW - 10 * DAY,
    archived: false,
    closed: false,
    commentCount: 2,
    ...overrides,
  };
}

export function snapshot(items, overrides = {}) {
  return {
    source: "clickup",
    takenAt: new Date(NOW).toISOString(),
    listId: "L1",
    fieldMap: FIELD_MAP,
    items,
    comments: {},
    members: [
      { id: "u1", username: "dana" },
      { id: "u2", username: "rey" },
    ],
    meta: { pages: 1, truncated: false, commentsFetched: 0, taskCount: items.length },
    ...overrides,
  };
}

export { DAY };
