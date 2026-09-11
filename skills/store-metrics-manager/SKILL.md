---
name: store-metrics-manager
description: Owns Layer 0. Pulls store-wide metrics from ShopifyQL, computes the derived ones, compares the primary window against the others, and builds the conversion funnel.
runs_as: deterministic code
implemented_by: src/collectors/shopify.js
config: config/shopify.json
---

# Store Metrics Manager

Owns **Layer 0**, the store-wide numbers that sit above everything else in the readout.

This is a **sixth skill, added after the original five**. The requirements document
specifies five, and Layer 0 was not in it: it was asked for later, when the metrics
overview was added. It follows the same rule as the other managers — the skill file is
the plain-language spec, the code implements it, and both read `config/shopify.json`.

## Why this layer exists

Layer 3 tells Alex that a test moved a number. Layer 0 tells him whether the **whole
store** moved. Without it, a sitewide swing reads as a test result, and a test gets
shipped or killed on the strength of a good Tuesday.

Nothing here is a statistical claim. Layer 3 owns the statistics. This layer is a sanity
check, and the flags say so in those words.

## How it reads

ShopifyQL is aggregated reporting, reached through the Admin GraphQL `shopifyqlQuery`
field. It is **read-only by construction**: every query is `FROM … SHOW …`, there is no
mutation surface, and the collector refuses to send anything that does not start with
`FROM` or that contains a write keyword. That guard matters because queries live in
config and **config is editable by this system's own learning skill**.

### Auth

Legacy custom apps, and the static `shpat_` tokens they issued, could not be created
after 1 January 2026. Authentication is the **client credentials grant**: the app's client
id and secret are exchanged for a token that lives 24 hours. The token is cached with its
expiry and refreshed five minutes early, so a dashboard refresh does not re-exchange on
every click and a token cannot expire mid-run. A pre-cutoff `SHOPIFY_ADMIN_TOKEN` is still
honoured if one exists.

## Windows

One primary window, shown, and the rest compared against it. Currently **MTD**, compared
against **Yesterday**, **7D** and **30D**.

A window is either a named range (`DURING yesterday`) or explicit `SINCE`/`UNTIL` bounds.
`DURING` replaces both and must never be combined with either.

**The same filter is used across every window.** A filter that differs between windows
makes the comparison quietly meaningless, which is worse than not comparing at all.

## Rates and totals compare differently

This is the rule most likely to be got wrong, so it is stated plainly:

- A **rate** — an average, a ratio, a per-order or per-visitor figure — is already
  normalized and compares directly across windows of different lengths.
- A **total** is not. Month-to-date gross sales against a 7 day total measures the length
  of the window, not the business. Totals are put on a **per-day** footing first and the
  comparison is marked `/d`.

On live data this flips the sign: 9,902 MTD orders against 7,769 over 7 days looks like
growth and is 900/day against 1,110/day, which is a decline.

## Derived metrics

A derived metric is a formula over the metrics of one window. Identifiers may be a bare
metric name, or `query.metric` to reach across queries.

Formulas are **parsed, not evaluated as code**: only arithmetic, parentheses, numbers and
metrics a query actually returned are permitted. A missing input makes the result
**unknown, not zero**, and a division by zero yields nothing rather than infinity.

### ncAOV

New Customer AOV: `(gross_sales + discounts + shipping_charges) / orders`, for new
customers on the Online Store, excluding cancelled orders and post-order adjustments.

**Discounts arrive negative from ShopifyQL**, so adding them subtracts them. This is
deliberately not Shopify's built-in `average_order_value`, which is computed on a
different base and reads about a dollar lower.

### Sub. Opt-In

New Customer Subscription Opt-in: subscription orders over **the same order count ncAOV is
built on**, so both tiles describe one population.

This differs from the stacked bar in the Shopify report, which groups by
`subscription_or_one_time`. An order containing both a subscription line and a one-time
line is counted in **both** groups, so the groups sum to more than the number of orders.
On live MTD data that is 12,968 against 9,902 — dividing by the group sum gives 57%
against 74.6%, nearly eighteen points, and the difference between "most new customers
subscribe" and "most do not".

Both figures are computed. The tile shows the share of distinct orders; the info hover
shows the mix figure beside it. Neither is wrong — they answer different questions.

## The funnel

The sessions schema's closed funnel: sessions → cart additions → reached checkout →
completed checkout. The end-to-end product **must** equal the reported `conversion_rate`;
there is a test asserting it, because a wrong step would otherwise look plausible.

Bar width is share of all sessions, so the collapse is visible at a glance. The number per
row is the **step rate**, the share of the row above, because that is where a drop-off
lives.

**Funnel comparisons are on the step rate, never the count.** MTD has 534,091 sessions and
yesterday has 52,219, so comparing counts would report every step down about 90% and say
nothing at all.

## Flags

A tile moving more than `alerts.movePercentThreshold` against `alerts.compareAgainst` is
flagged. Deliberately one named window rather than all of them, or a single move produces
a flag per comparison and the readout says the same thing three times.

Direction is not the same as good. `goodDirection` lives on the tile because **discounts
are stored negative**, so a rise there means less discounting.

## Error states handled on purpose

- **One query fails**: it loses its own tiles, not the layer. A failed tile renders as
  unavailable **with the reason**, never as zero.
- **One window fails**: the tile keeps its value and loses only that comparison.
- **A parse error or a GraphQL error**: raised, never returned as empty data.
- **Missing credentials**: named explicitly, listing both accepted forms.
- **`rows` is a JSON scalar**, so its shape carries no schema guarantee. The Admin API
  returns objects keyed by column name; other surfaces return positional arrays. Both are
  parsed, because assuming one and getting the other yields a row of nulls and no error.

## What Alex still owes this skill

- Confirmation that the tile set is the right one, and whether `Sub. mix` should be
  promoted from the info hover to a tile of its own.
- Whether totals should compare per day (current) or raw.
