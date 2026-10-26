// Future value of a variant against control.
//
// The spec's example, made real: a test that shifts the subscription mix should be valued
// on what those customers are worth over the next year, not on the first order alone. A
// variant can lose on immediate revenue per visitor and still be the right call if it
// converts more people onto subscriptions.
//
// This is deliberately arithmetic, not judgement. It says what the numbers imply given
// the LTV references Alex supplied. Whether to act on it is the Strategic Advisor's job,
// and it only runs when Alex clicks.
//
// Two ways to value a customer, preferred in this order:
//   multipliers  a customer's value over the horizon as a multiple of their first order,
//                one for subscription and one for one-time (Alex, 2026-10-26: 3.95 and
//                1.78 over 12 months). Applied to each variant's own revenue split, so a
//                variant that discounts the subscription order is valued on what it took.
//   dollars      a flat value per subscription and per one-time customer, measured from
//                Shopify's cohort analysis. Used only when the multipliers are unset.

/**
 * Value of a visitor from LTV multipliers.
 *
 *   value per visitor = subRPV x subMultiplier + (RPV - subRPV) x oneTimeMultiplier
 *
 * subscription_revenue_per_visitor is read as the subscription part of net revenue per
 * visitor (live, it runs just under RPV x subscription share, as discounted subscription
 * orders should). A value above RPV would mean that reading is wrong, so it projects
 * nothing rather than a negative one-time revenue.
 */
export function valuePerVisitorFromMultipliers({ revenuePerVisitor, subscriptionRevenuePerVisitor, subscriptionMultiplier, oneTimeMultiplier }) {
  if (revenuePerVisitor == null || subscriptionRevenuePerVisitor == null || subscriptionMultiplier == null || oneTimeMultiplier == null) return null;
  if (subscriptionRevenuePerVisitor > revenuePerVisitor) return null;
  return subscriptionRevenuePerVisitor * subscriptionMultiplier + (revenuePerVisitor - subscriptionRevenuePerVisitor) * oneTimeMultiplier;
}

/**
 * Blended value of a visitor from dollar LTVs, given the subscription mix.
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
 * @param {object} settings  {subscriptionLtvMultiplier, oneTimeLtvMultiplier, ltvMultiplierHorizonMonths,
 *                            ltvMultipliersAsOf, subscriptionLtv6mo, oneTimeLtv6mo, ltvHorizonMonths,
 *                            ltvAsOf, ltvStaleAfterDays}
 * @param {Date}   now
 */
export function projectFutureValue(test, settings, now = new Date()) {
  const subMult = settings?.subscriptionLtvMultiplier ?? null;
  const oneMult = settings?.oneTimeLtvMultiplier ?? null;
  const subLtv = settings?.subscriptionLtv6mo ?? null;
  const oneLtv = settings?.oneTimeLtv6mo ?? null;
  const method = subMult != null && oneMult != null ? "multiplier" : subLtv != null && oneLtv != null ? "dollar" : null;
  const horizon = method === "multiplier" ? (settings?.ltvMultiplierHorizonMonths ?? 12) : (settings?.ltvHorizonMonths ?? 6);

  if (!method) {
    return {
      available: false,
      reason:
        "LTV references are not set. Add the subscription and one-time multipliers in Settings and every test gains a lifetime view alongside its immediate one.",
      horizonMonths: horizon,
    };
  }

  const control = (test.groups ?? []).find((g) => g.isControl) ?? null;
  if (!control) return { available: false, reason: "No control variation in this test.", horizonMonths: horizon };

  const read = (group, key) => group?.metrics?.[key]?.value ?? null;
  const valueOf = (group) =>
    method === "multiplier"
      ? valuePerVisitorFromMultipliers({
          revenuePerVisitor: read(group, "net_revenue_per_visitor"),
          subscriptionRevenuePerVisitor: read(group, "subscription_revenue_per_visitor"),
          subscriptionMultiplier: subMult,
          oneTimeMultiplier: oneMult,
        })
      : valuePerVisitor({
          conversionRate: read(group, "conversion_rate"),
          subscriptionShare: read(group, "pct_subscription_orders"),
          subscriptionLtv: subLtv,
          oneTimeLtv: oneLtv,
        });
  const controlValue = valueOf(control);

  if (controlValue == null) {
    return {
      available: false,
      reason:
        method === "multiplier"
          ? "The control is missing net or subscription revenue per visitor, so there is nothing to project against."
          : "The control is missing conversion rate or subscription share, so there is nothing to project against.",
      horizonMonths: horizon,
    };
  }

  const variants = (test.groups ?? [])
    .filter((g) => !g.isControl)
    .map((group) => {
      const value = valueOf(group);
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

  const asOf = (method === "multiplier" ? settings?.ltvMultipliersAsOf : settings?.ltvAsOf) ?? null;
  const staleAfter = settings?.ltvStaleAfterDays ?? 90;
  const ageDays = asOf ? Math.floor((now.getTime() - new Date(asOf).getTime()) / 86400000) : null;
  const what = method === "multiplier" ? "LTV multipliers" : "LTV figures";

  return {
    available: true,
    method,
    horizonMonths: horizon,
    subscriptionMultiplier: method === "multiplier" ? subMult : null,
    oneTimeMultiplier: method === "multiplier" ? oneMult : null,
    subscriptionLtv: method === "dollar" ? subLtv : null,
    oneTimeLtv: method === "dollar" ? oneLtv : null,
    spread: method === "dollar" ? subLtv - oneLtv : null,
    control: { id: control.id, name: control.name, valuePerVisitor: controlValue, subscriptionShare: read(control, "pct_subscription_orders") },
    variants,
    references: {
      asOf,
      ageDays,
      stale: ageDays != null && ageDays > staleAfter,
      staleAfterDays: staleAfter,
      note:
        ageDays != null && ageDays > staleAfter
          ? `These ${what} were measured ${ageDays} days ago, past the ${staleAfter} day mark. The projection is still shown, but it is resting on old numbers.`
          : null,
    },
  };
}
