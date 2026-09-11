// The readiness gate. DECIDED in the spec.
//
// A test is not ready for a verdict until BOTH are true: at least 7 days running AND at
// least 300 orders. Research resolved the ambiguity: 300 is per group, not total across
// the test, and Intelligems applies the same gate itself, returning `not_ready` until it
// is met.
//
// So we ask Intelligems for its verdict AND compute the gate ourselves. Not because we
// distrust them, but because a silent disagreement between the two is exactly the kind of
// quiet bug that produces a confident wrong readout. When they disagree we say so and
// take the more conservative answer.

export function evaluateGate(test, gate) {
  const minDays = gate.minDaysRunning;
  const minOrders = gate.minOrdersPerGroup;

  const days = test.daysRunning;
  const orders = test.minOrdersPerGroup;

  const daysMet = typeof days === "number" ? days >= minDays : null;
  const ordersMet = typeof orders === "number" ? orders >= minOrders : null;

  const unknown = daysMet === null || ordersMet === null;
  const ready = !unknown && daysMet && ordersMet;

  const reasons = [];
  if (daysMet === null) reasons.push("days running is unknown");
  else if (!daysMet) reasons.push(`${days} of ${minDays} days`);
  if (ordersMet === null) reasons.push("orders per group is unknown");
  else if (!ordersMet) reasons.push(`${orders} of ${minOrders} orders in the smallest group`);

  return { ready, unknown, daysMet, ordersMet, days, orders, minDays, minOrders, reasons };
}

/**
 * The recommendation for one test.
 *
 * Until the gate is passed the recommendation is Keep Running. No verdict. Once it is
 * passed, the Intelligems verdict maps through config.intelligems.verdictMap.
 */
export function recommendFor(test, config) {
  const gateConfig = config.intelligems.readinessGate;
  const map = config.intelligems.verdictMap ?? {};
  const gate = evaluateGate(test, gateConfig);
  const verdict = test.verdict ?? null;

  const theirGateSaysNotReady = verdict === "not_ready";
  const disagreement =
    verdict != null && !gate.unknown && gate.ready === theirGateSaysNotReady
      ? {
          ours: gate.ready ? "ready" : "not ready",
          theirs: theirGateSaysNotReady ? "not_ready" : verdict,
        }
      : null;

  if (!gate.ready || theirGateSaysNotReady) {
    return {
      recommendation: "Keep Running",
      verdict,
      gate,
      disagreement,
      // No verdict yet is a statement, not a hedge.
      reason: gate.unknown
        ? `Readiness cannot be computed: ${gate.reasons.join("; ")}.`
        : theirGateSaysNotReady && gate.ready
          ? "Our gate is met but Intelligems still reports not_ready. Taking the conservative answer."
          : `Gate not met: ${gate.reasons.join("; ")}.`,
    };
  }

  if (verdict == null) {
    return {
      recommendation: "Keep Running",
      verdict: null,
      gate,
      disagreement,
      reason: "Gate is met but no verdict came back from the platform.",
    };
  }

  const mapped = map[verdict];
  if (!mapped) {
    return {
      recommendation: "Keep Running",
      verdict,
      gate,
      disagreement,
      reason: `Verdict "${verdict}" has no mapping in config.intelligems.verdictMap. Not guessing.`,
      unmappedVerdict: true,
    };
  }

  return {
    recommendation: mapped,
    verdict,
    gate,
    disagreement,
    reason: `Gate met at ${gate.days} days and ${gate.orders} orders in the smallest group. Platform verdict: ${verdict}.`,
  };
}
