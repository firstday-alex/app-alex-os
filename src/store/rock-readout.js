// The per-rock readout.
//
// Built by joining the rock's linked experiments against the most recent Intelligems
// snapshot the pipeline already took. Deliberately COMPUTED ON READ rather than stored on
// the rock: a copy of the numbers on the rock would be a second source of truth that goes
// stale silently, and "the rock says one thing and the test says another" is exactly the
// confident-wrong-readout failure this system exists to avoid.
//
// Costs nothing extra. The snapshot is already in storage.

import { recommendFor } from "../delta/readiness.js";

/**
 * @param {object} rock
 * @param {object|null} intelligemsSnapshot the latest snapshot, or null if none exists
 * @param {object} config
 */
export function buildRockReadout(rock, intelligemsSnapshot, config) {
  const linked = (rock.experimentLinks ?? []).map((l) => l.experienceId).filter(Boolean);
  // The single-id field predates the links, and is still honoured.
  if (rock.intelligemsExperienceId) linked.push(String(rock.intelligemsExperienceId));
  const ids = [...new Set(linked)];

  if (ids.length === 0) {
    return { state: "no_experiments", message: "No Intelligems experiment is linked to this rock.", tests: [] };
  }
  if (!intelligemsSnapshot) {
    return {
      state: "no_snapshot",
      message: "No Intelligems snapshot has been taken yet. Run a refresh or wait for the 8 AM readout.",
      tests: [],
      linkedIds: ids,
    };
  }

  const byId = new Map((intelligemsSnapshot.items ?? []).map((t) => [String(t.id), t]));
  const p0 = config.intelligems?.metrics?.p0 ?? [];

  const tests = ids.map((id) => {
    const test = byId.get(id);
    if (!test) {
      // Linked, but not in the running roster. Almost always means it ended.
      return {
        experienceId: id,
        found: false,
        message: "Not in the current running roster. It has probably ended, or the link points at another store.",
      };
    }

    const recommendation = recommendFor(test, config);
    const control = (test.groups ?? []).find((g) => g.isControl) ?? null;

    return {
      experienceId: id,
      found: true,
      name: test.name,
      verdict: test.verdict,
      recommendation: recommendation.recommendation,
      reason: recommendation.reason,
      daysRunning: test.daysRunning,
      ordersInSmallestGroup: test.minOrdersPerGroup,
      gateMet: recommendation.gate.ready,
      estMonthlyRevenueImpact: test.estMonthlyRevenueImpact ?? null,
      stabilized: test.timeseriesStabilized?.stabilized ?? null,
      // One line per challenger per P0 metric: the number, and how it moved.
      metrics: (test.groups ?? [])
        .filter((g) => !g.isControl)
        .map((group) => ({
          group: group.name,
          orders: group.orders,
          values: p0.map((name) => {
            const metric = group.metrics?.[name];
            const controlValue = control?.metrics?.[name]?.value ?? null;
            return {
              metric: name,
              value: metric?.value ?? null,
              control: controlValue,
              upliftPct: metric?.upliftPct ?? null,
              probBeatControl: metric?.probBeatControl ?? null,
              // Confident only when the uplift interval does not span zero.
              confident: Boolean(
                metric?.upliftInterval &&
                  metric.upliftInterval[0] != null &&
                  (metric.upliftInterval[0] > 0 || metric.upliftInterval[1] < 0),
              ),
              configured: metric?.configured ?? false,
            };
          }),
        })),
    };
  });

  const live = tests.filter((t) => t.found);
  return {
    state: live.length ? "ok" : "not_running",
    takenAt: intelligemsSnapshot.takenAt ?? null,
    // The rock-level line: the least settled recommendation across its tests, because a
    // rock is not done while any of its tests is still running.
    headline: live.length
      ? live.some((t) => t.recommendation === "Keep Running")
        ? "Keep Running"
        : live[0].recommendation
      : null,
    tests,
    linkedIds: ids,
  };
}
