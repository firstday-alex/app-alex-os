// Future value of a variant against control.
//
// The spec's example, made real: a test that shifts the subscription mix should be valued
// on what those customers are worth over six months, not on the first order alone. A
// variant can lose on immediate revenue per visitor and still be the right call if it
// converts more people onto subscriptions.
//
// This is deliberately arithmetic, not judgement. It says what the numbers imply given
// the LTV references Alex supplied. Whether to act on it is the Strategic Advisor's job,
// and it only runs when Alex clicks.

/**
 * Blended value of a visitor, given the subscription mix.
 *
 *   value per visitor = orders per visitor x ( subShare x subLTV + (1 - subShare) x oneTimeLTV )
 *
 * Every input must be present. A missing LTV reference makes the projection unavailable,
 * never zero: valuing a subscriber at nothing would make every mix-shifting test look
 * neutral, which is the exact error this exists to prevent.
 */
export function valuePerVisitor({ conversionRate, subscriptionShare, subscriptionLtv, oneTimeLtv }) {
  if (conversionRate == null || subscriptionShare == null || subscriptionLtv == null || oneTimeLtv == null) return null;
  const blended = subscriptionShare * subscriptionLtv + (1 - subscriptionShare) * oneTimeLtv;
  return conversionRate * blended;
}

/**
 * @param {object} test      normalized test with groups
 * @param {object} settings  {subscriptionLtv6mo, oneTimeLtv6mo, ltvHorizonMonths, ltvAsOf, ltvStaleAfterDays}
 * @param {Date}   now
 */
export function projectFutureValue(test, settings, now = new Date()) {
  const subLtv = settings?.subscriptionLtv6mo ?? null;
  const oneLtv = settings?.oneTimeLtv6mo ?? null;
  const horizon = settings?.ltvHorizonMonths ?? 6;

  if (subLtv == null || oneLtv == null) {
    return {
      available: false,
      reason:
        "LTV reference values are not set. Add the subscription and one-time figures in Settings and every test gains a lifetime view alongside its immediate one.",
      horizonMonths: horizon,
    };
  }

  const control = (test.groups ?? []).find((g) => g.isControl) ?? null;
  if (!control) return { available: false, reason: "No control variation in this test.", horizonMonths: horizon };

  const read = (group, key) => group?.metrics?.[key]?.value ?? null;
  const controlValue = valuePerVisitor({
    conversionRate: read(control, "conversion_rate"),
    subscriptionShare: read(control, "pct_subscription_orders"),
    subscriptionLtv: subLtv,
    oneTimeLtv: oneLtv,
  });

  if (controlValue == null) {
    return {
      available: false,
      reason: "The control is missing conversion rate or subscription share, so there is nothing to project against.",
      horizonMonths: horizon,
    };
  }

  const variants = (test.groups ?? [])
    .filter((g) => !g.isControl)
    .map((group) => {
      const value = valuePerVisitor({
        conversionRate: read(group, "conversion_rate"),
        subscriptionShare: read(group, "pct_subscription_orders"),
        subscriptionLtv: subLtv,
        oneTimeLtv: oneLtv,
      });
      const immediate = read(group, "net_revenue_per_visitor");
      const controlImmediate = read(control, "net_revenue_per_visitor");

      const upliftPct = value == null || controlValue === 0 ? null : ((value - controlValue) / Math.abs(controlValue)) * 100;
      const immediateUpliftPct =
        immediate == null || controlImmediate == null || controlImmediate === 0
          ? null
          : ((immediate - controlImmediate) / Math.abs(controlImmediate)) * 100;

      return {
        id: group.id,
        name: group.name,
        valuePerVisitor: value,
        upliftPct,
        immediateRpv: immediate,
        immediateUpliftPct,
        subscriptionShare: read(group, "pct_subscription_orders"),
        // The reason this projection exists: the two views can disagree, and when they do
        // that disagreement IS the decision.
        disagreesWithImmediate:
          upliftPct != null && immediateUpliftPct != null && Math.sign(upliftPct) !== Math.sign(immediateUpliftPct),
        visitors: group.visitors ?? null,
      };
    });

  const asOf = settings?.ltvAsOf ?? null;
  const staleAfter = settings?.ltvStaleAfterDays ?? 90;
  const ageDays = asOf ? Math.floor((now.getTime() - new Date(asOf).getTime()) / 86400000) : null;

  return {
    available: true,
    horizonMonths: horizon,
    subscriptionLtv: subLtv,
    oneTimeLtv: oneLtv,
    spread: subLtv - oneLtv,
    control: { id: control.id, name: control.name, valuePerVisitor: controlValue, subscriptionShare: read(control, "pct_subscription_orders") },
    variants,
    references: {
      asOf,
      ageDays,
      stale: ageDays != null && ageDays > staleAfter,
      staleAfterDays: staleAfter,
      note:
        ageDays != null && ageDays > staleAfter
          ? `These LTV figures were measured ${ageDays} days ago, past the ${staleAfter} day mark. The projection is still shown, but it is resting on old numbers.`
          : null,
    },
  };
}
