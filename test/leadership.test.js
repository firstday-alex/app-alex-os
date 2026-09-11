// Layer 1 rules: the mini readout tolerance window, unassigned P1s, one big swing per
// person, backlog overflow, and dropdown sync.

import { test } from "node:test";
import assert from "node:assert/strict";
import { leadershipChecks } from "../src/delta/leadership-checks.js";
import { collectLeadership } from "../src/collectors/leadership.js";
import { testConfig } from "./fixtures/config.js";
import { FIELD_MAP } from "./fixtures/tasks.js";

const NOW_ISO = "2026-09-10T13:00:00Z";
const config = testConfig();

function leadership({ queue = [], backlog = [], roster = null, dropdownOptions = [] } = {}) {
  return {
    queue,
    backlog,
    roster: roster ?? [
      { clickupUserId: "u1", name: "dana" },
      { clickupUserId: "u2", name: "rey" },
    ],
    dropdownOptions,
  };
}

const rules = (result) => result.flags.map((f) => f.rule);
const run = (input, clickup = { fieldMap: FIELD_MAP }) =>
  leadershipChecks({ leadership: input, clickup, config, dateKey: "2026-09-10", nowIso: NOW_ISO });

test("a shipped test checked inside the tolerance window is quiet", () => {
  const result = run(
    leadership({
      queue: [{ id: "p1", title: "Upsell", state: "shipped", shippedAt: "2026-08-20", lastMiniReadoutAt: "2026-09-07", owner: { clickupUserId: "u1", name: "dana" } }],
    }),
  );
  assert.ok(!rules(result).includes("leadership.mini_readout_overdue"));
});

test("a shipped test past the tolerance window is flagged", () => {
  const result = run(
    leadership({
      queue: [{ id: "p1", title: "Upsell", state: "shipped", shippedAt: "2026-08-01", lastMiniReadoutAt: "2026-08-15", owner: { clickupUserId: "u1", name: "dana" } }],
    }),
  );
  const flag = result.flags.find((f) => f.rule === "leadership.mini_readout_overdue");
  assert.ok(flag);
  assert.equal(flag.severity, "p1");
  assert.equal(flag.values.toleranceWindowDays, 7);
  assert.ok(flag.values.daysSinceLastCheck > 7);
});

test("a per-type tolerance window overrides the global one", () => {
  const custom = testConfig({ leadership: { ...config.leadership, miniReadout: { toleranceWindowDays: 7, perProjectType: { test: 60 } } } });
  const input = leadership({
    queue: [{ id: "p1", title: "Upsell", type: "test", state: "shipped", shippedAt: "2026-08-01", lastMiniReadoutAt: "2026-08-15", owner: { clickupUserId: "u1", name: "dana" } }],
  });
  const result = leadershipChecks({ leadership: input, clickup: { fieldMap: FIELD_MAP }, config: custom, dateKey: "2026-09-10", nowIso: NOW_ISO });
  assert.ok(!rules(result).includes("leadership.mini_readout_overdue"));
});

test("a shipped test never checked at all is flagged, not treated as fresh", () => {
  const result = run(
    leadership({ queue: [{ id: "p1", title: "Upsell", state: "shipped", shippedAt: "2026-09-09", lastMiniReadoutAt: null, owner: { clickupUserId: "u1", name: "dana" } }] }),
  );
  // shippedAt is one day ago, so the window has not lapsed, but nothing has been recorded.
  assert.ok(!rules(result).includes("leadership.mini_readout_overdue"));
  const old = run(
    leadership({ queue: [{ id: "p2", title: "Old", state: "shipped", shippedAt: "2026-01-01", lastMiniReadoutAt: null, owner: { clickupUserId: "u1", name: "dana" } }] }),
  );
  assert.ok(rules(old).includes("leadership.mini_readout_overdue"));
});

test("a shipped item with no shipped date is flagged rather than silently passing", () => {
  const result = run(leadership({ queue: [{ id: "p1", title: "Upsell", state: "shipped", shippedAt: null, owner: { clickupUserId: "u1", name: "dana" } }] }));
  assert.ok(rules(result).includes("leadership.shipped_without_date"));
});

test("an unassigned active priority is flagged as needing an active owner", () => {
  const result = run(leadership({ queue: [{ id: "p1", title: "Upsell", state: "active", owner: null }] }));
  const flag = result.flags.find((f) => f.rule === "leadership.unassigned");
  assert.ok(flag);
  assert.equal(flag.severity, "p1");
});

test("one person holding two active leadership priorities is flagged", () => {
  const result = run(
    leadership({
      queue: [
        { id: "p1", title: "A", state: "active", owner: { clickupUserId: "u1", name: "dana" } },
        { id: "p2", title: "B", state: "active", owner: { clickupUserId: "u1", name: "dana" } },
      ],
    }),
  );
  const flag = result.flags.find((f) => f.rule === "leadership.over_capacity");
  assert.ok(flag);
  assert.equal(flag.values.cap, 1);
});

test("when everyone is at capacity, the remaining items should be in the backlog", () => {
  const result = run(
    leadership({
      queue: [
        { id: "p1", title: "A", state: "active", owner: { clickupUserId: "u1", name: "dana" } },
        { id: "p2", title: "B", state: "active", owner: { clickupUserId: "u2", name: "rey" } },
        { id: "p3", title: "C", state: "active", owner: null },
      ],
    }),
  );
  const flag = result.flags.find((f) => f.rule === "leadership.should_be_backlogged");
  assert.ok(flag);
  assert.equal(flag.values.rosterSize, 2);
  assert.deepEqual(flag.values.unassigned, ["C"]);
});

test("with capacity to spare, an unassigned item is not told to go to the backlog", () => {
  const result = run(
    leadership({
      queue: [
        { id: "p1", title: "A", state: "active", owner: { clickupUserId: "u1", name: "dana" } },
        { id: "p2", title: "B", state: "active", owner: null },
      ],
    }),
  );
  assert.ok(!rules(result).includes("leadership.should_be_backlogged"), "rey is still free");
  assert.ok(rules(result).includes("leadership.unassigned"), "but it does still need an owner");
});

test("an active priority with no matching ClickUp dropdown option is flagged", () => {
  const result = run(
    leadership({
      queue: [{ id: "p1", title: "Brand new priority", state: "active", owner: { clickupUserId: "u1", name: "dana" }, clickupOptionId: "opt_missing" }],
      dropdownOptions: [{ id: "opt_sub", label: "Subscription upsell" }],
    }),
  );
  assert.ok(rules(result).includes("leadership.dropdown_missing_option"));
});

test("a BAU dropdown option is never reported as an orphan", () => {
  const result = run(
    leadership({
      queue: [{ id: "p1", title: "Subscription upsell", state: "active", owner: { clickupUserId: "u1", name: "dana" }, clickupOptionId: "opt_sub" }],
      dropdownOptions: [
        { id: "opt_sub", label: "Subscription upsell" },
        { id: "opt_bau", label: "Business as usual" },
      ],
    }),
  );
  assert.ok(!rules(result).includes("leadership.dropdown_orphan_option"));
});

test("every item in the queue is a P1 by virtue of being in the queue", async () => {
  const snapshot = await collectLeadership({
    config: testConfig({
      leadershipQueue: { queue: [{ id: "p1", title: "A", state: "active", owner: "u1" }], backlog: [{ id: "p2", title: "B" }] },
    }),
    clickupSnapshot: { fieldMap: FIELD_MAP, members: [] },
  });
  assert.ok(snapshot.items.every((item) => item.priority === "P1"));
  assert.equal(snapshot.backlog[0].state, "backlog", "a backlog item defaults to the backlog state");
});

test("the roster falls back to the ClickUp workspace members when people.json is empty", async () => {
  const snapshot = await collectLeadership({
    config: testConfig({ people: { team: [{ clickupUserId: null, name: "EXAMPLE" }], alex: {} } }),
    clickupSnapshot: { fieldMap: FIELD_MAP, members: [{ id: "9", username: "sam" }] },
  });
  assert.equal(snapshot.meta.rosterFromFallback, true);
  assert.deepEqual(snapshot.roster, [{ clickupUserId: "9", name: "sam", slackUserId: null }]);
});

/* ----------------- the rock fields, once they reach Layer 1 ----------------- */

const rock = (over = {}) => ({
  id: "r1", title: "Sub opt-in for NC", state: "active", status: "on_track",
  owner: { clickupUserId: "u1", name: "dana" }, kpi: "pct_subscription_orders",
  startDate: "2026-09-08", checkInDate: "2026-09-09", clickupOptionId: "opt_sub", ...over,
});

test("a rock its owner marked At Risk is a P1", () => {
  // At Risk is the only warning status, so it carries the weight the retired off_track had.
  const result = run(leadership({ queue: [rock({ status: "at_risk" })] }));
  const flag = result.flags.find((f) => f.rule === "leadership.rock_at_risk");
  assert.ok(flag);
  assert.equal(flag.severity, "p1");
  assert.match(flag.message, /At Risk/);
  assert.equal(flag.values.kpi, "pct_subscription_orders");
});

test("an on-track rock checked in on recently is quiet", () => {
  // The dropdown option has to exist too, or the sync check speaks up — correctly.
  const result = run(leadership({ queue: [rock()], dropdownOptions: [{ id: "opt_sub", label: "Sub opt-in for NC" }] }));
  assert.deepEqual(rules(result), [], "nothing to say about a healthy, linked, recently checked rock");
});

test("an active rock nobody has checked in on is flagged against the tolerance window", () => {
  const result = run(leadership({ queue: [rock({ checkInDate: "2026-08-01" })] }));
  const flag = result.flags.find((f) => f.rule === "leadership.check_in_overdue");
  assert.ok(flag);
  assert.ok(flag.values.daysSinceCheckIn > 7);
  assert.equal(flag.values.toleranceWindowDays, 7);
});

test("a rock with no KPI is noted, because nothing says whether it worked", () => {
  const result = run(leadership({ queue: [rock({ kpi: null })] }));
  const flag = result.flags.find((f) => f.rule === "leadership.rock_without_kpi");
  assert.ok(flag);
  assert.equal(flag.severity, "info");
});

test("a rock not linked to ClickUp is flagged, since no ticket can ladder up to it", () => {
  const result = run(leadership({ queue: [rock({ clickupOptionId: null })] }));
  assert.ok(rules(result).includes("leadership.rock_not_linked"));
});
