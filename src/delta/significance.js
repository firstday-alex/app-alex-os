// How much to believe a metric moved.
//
// Every node in the experiment tree carries one of these, because a tree of numbers with
// no sense of confidence invites exactly the mistake this system exists to prevent:
// reading a 12% swing on 40 orders as a result.
//
// Two independent signals, and they have to agree before anything is called strong:
//   probability to beat control  - the platform's own posterior, p2bc
//   the uplift interval          - whether it excludes zero
// A high probability with an interval spanning zero is not a finding, it is a coin
// landing heads twice.

export const LEVELS = {
  strong_win: { label: "Strong", tone: "win", rank: 4 },
  directional_win: { label: "Directional", tone: "win", rank: 3 },
  inconclusive: { label: "Inconclusive", tone: "flat", rank: 0 },
  directional_loss: { label: "Directional", tone: "loss", rank: 3 },
  strong_loss: { label: "Strong", tone: "loss", rank: 4 },
  no_data: { label: "No data", tone: "none", rank: -1 },
};

/**
 * @param {object} metric normalized metric: {value, uplift, upliftInterval, probBeatControl}
 * @param {object} thresholds {strong, directional} probabilities
 */
export function classify(metric, { strong = 0.95, directional = 0.8 } = {}) {
  if (!metric || metric.value == null) {
    return { level: "no_data", ...LEVELS.no_data, reason: "not configured or not returned" };
  }
  if (metric.uplift == null) {
    return { level: "no_data", ...LEVELS.no_data, reason: "no uplift against control" };
  }

  const p = metric.probBeatControl;
  const interval = metric.upliftInterval;
  const excludesZero = Boolean(interval && interval[0] != null && interval[1] != null && (interval[0] > 0 || interval[1] < 0));
  const direction = metric.uplift > 0 ? "win" : "loss";

  // No interval at all: the probability alone can only ever be directional. Saying
  // "strong" on one signal is how a dashboard talks someone into a bad decision.
  if (!interval) {
    if (p == null) return { level: "inconclusive", ...LEVELS.inconclusive, reason: "no interval and no probability" };
    const confident = p >= directional || p <= 1 - directional;
    return confident
      ? { level: `directional_${direction}`, ...LEVELS[`directional_${direction}`], reason: "probability only, no interval to corroborate it", probability: p }
      : { level: "inconclusive", ...LEVELS.inconclusive, reason: "probability inside the directional band", probability: p };
  }

  const pStrong = p != null && (p >= strong || p <= 1 - strong);
  const pDirectional = p != null && (p >= directional || p <= 1 - directional);

  if (excludesZero && pStrong) {
    return { level: `strong_${direction}`, ...LEVELS[`strong_${direction}`], reason: "interval excludes zero and the probability clears the strong bar", probability: p, interval };
  }
  if (excludesZero || pDirectional) {
    return {
      level: `directional_${direction}`,
      ...LEVELS[`directional_${direction}`],
      reason: excludesZero
        ? "interval excludes zero but the probability is short of the strong bar"
        : "probability is directional but the interval still spans zero",
      probability: p,
      interval,
    };
  }
  return { level: "inconclusive", ...LEVELS.inconclusive, reason: "interval spans zero and the probability is unremarkable", probability: p, interval };
}

/** The weakest level among several, for rolling a branch up to its parent. */
export function weakest(levels) {
  const real = levels.filter((l) => l && l.level !== "no_data");
  if (real.length === 0) return { level: "no_data", ...LEVELS.no_data };
  return real.reduce((a, b) => (LEVELS[a.level].rank <= LEVELS[b.level].rank ? a : b));
}
