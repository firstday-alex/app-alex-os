---
name: intelligems-manager
description: Owns Layer 3. Pulls active test results, snapshots them, compares against the baseline, weighs the trade offs, and projects a recommendation per test.
runs_as: deterministic code
implemented_by:
  - src/collectors/intelligems.js
  - src/delta/intelligems-delta.js
  - src/delta/readiness.js
  - src/delta/p1band.js
config: config/intelligems.json, config/references.json
---

# Intelligems Manager

One skill. Pulls the reports, runs the analysis, stores what it learns. There is no
separate analysis skill.

Owns Layer 3: the tests currently running. Same day over day snapshot comparison as
Layer 2, but on **results** rather than ticket activity.

## Rules

- Compare the last snapshot against the most recent snapshot on test results.
- If a big change appears, flag it for Alex to look into.
- If no notable change, **prompt the owner** to look in and note next steps or a decision.
  A quiet test is not a non-event; it still needs a human to say what happens next.

## Which metrics

**P0 metrics** are the key metrics Alex cares about most. Always reported.
**P1 metrics** are good to know, and are flagged only when they swing way out of whack —
not for normal one direction trending.

The per-test metric map is not hand maintained. `get_experience_metrics_config` (MCP) /
the metrics-config endpoint returns the success metrics configured for that specific test.
Read it once per test, cache it, then pull those metrics. The P0 and P1 lists in
`config/intelligems.json` are the always-watch set on top of that.

## The P1 band

A P1 metric is out of whack when it has moved **outside its own 95 percent confidence
interval** day over day. The API already returns the interval, so the band needs no
invented threshold.

When a metric comes back with **no interval**, the band check is **skipped and logged**.
It is never compared against zero. A missing interval quietly treated as `[0, 0]` would
flag every metric every day, which is the exact shape of a confident wrong readout.

## The readiness gate

**Decided.** A test is not ready for a verdict until **both** are true: at least **7 days
running** AND at least **300 orders**. Research resolved the ambiguity: 300 is **per
group**, not total across the test.

If either is unmet the recommendation is **Keep Running**. No verdict yet.

Intelligems applies the same gate itself and returns `not_ready` until it is met, so this
skill asks for the verdict rather than reinventing it — but it **also computes the gate
locally and flags any disagreement** between the two, taking the conservative answer. Not
from distrust: a silent disagreement between our arithmetic and theirs is precisely the
quiet bug worth catching.

## Verdicts

`analyze_experience` with `testResult: true` returns one of `strong_win`,
`directional_win`, `directional_loss`, `strong_loss`, `mixed_signals`, `not_ready`.

These map to Ship / Iterate / Kill / Keep Running through
`config/intelligems.json` → `verdictMap`. **The current mapping is a default, not a
decision. Alex still owes the real one.** A verdict with no mapping produces Keep Running
and a flag saying so, rather than a guess.

## Trade off analysis

A win on one metric against a loss on another gets weighed, not just reported.

The arithmetic part is deterministic: for each variant, which P0 metrics moved up and
which moved down **with statistical confidence** (the uplift interval not spanning zero),
and whether those two sets conflict. A conflict is stated plainly and flagged.

The judgement on a conflict is what the **Strategic Advisor** is for, and it only runs
when Alex clicks the button.

## The experiment tree

Each test is shown as a cascading tree rather than a list of metrics, because a list
invites reading numbers side by side that are not independent.

Two roots, being the two questions worth asking of a test on this store:

- **RPV**, revenue per visitor, which decomposes into **conversion rate** and **AOV**,
  and those into their own components.
- **Subscription share of orders**, separate because it changes what a customer is
  *worth*, not what this order is worth.

`RPV = AOV x conversion rate` is an exact identity, verified against live data to zero
error. That is why the tree can **attribute** a move: "RPV is up 15.9%" becomes "up 15.9%,
and AOV carried most of it", which is a different decision from the same number coming
from conversion. Attribution is computed in log space so the parts sum to the whole, and
is offered **only** where the identity actually holds. Nothing else in the tree claims it.

Every metric the tree names is pulled, not just the P0 and P1 lists. Without that the
branches below the roots read "No data", which looks like the platform returned nothing
rather than like we discarded it.

## Significance

Every node carries a judgement, because a tree of numbers with no sense of confidence
invites exactly the mistake this system exists to prevent: reading a 12% swing on 40
orders as a result.

Two independent signals, and they must **agree** before anything is called strong:

- **probability to beat control**, the platform's own posterior
- **the uplift interval**, and whether it excludes zero

A high probability with an interval spanning zero is directional at best. With no interval
at all, nothing can ever be strong: one signal cannot corroborate itself.

**A parent is never reported as more certain than the branch beneath it.** A strong-looking
headline resting on noisy components is labelled as such, rather than being allowed to
borrow authority from its own summary.

## Audience breakdown

A test judged only in aggregate forces a binary decision: ship it or kill it. The
breakdown adds the third option that is usually the right one — **ship it to the segment
it works for**. "The new PDP lost" and "the new PDP lost on mobile and won on desktop"
lead to completely different work.

The danger is the opposite error, slicing until something looks significant. Two guards,
and they are the point of the feature rather than decoration:

- **A segment under the order bar is reported as "Too small", never as a result.** The
  same per-group bar the readiness gate uses. On the live A/A test — a null test by
  construction — Desktop showed **+277% on 12 orders**. Without the bar that reads as a
  massive desktop win.
- **A segment is only called out when it DISAGREES with the overall result.** Confirming
  the aggregate in six segments is noise; contradicting it is a finding.

Breakdowns are pulled during the daily run only for tests **past the readiness gate**: a
test that cannot be called overall cannot be called by segment either, and pulling it
would spend a request per test per dimension to produce nothing readable.

### Which dimensions, and why

`visitor_type` first. It is the only dimension on this store where **both** segments clear
the order bar — New 1,345 and Returning 324 on a representative test — and new versus
returning is the split this business already reasons in.

`device_type` second, not because it segments well but because it reliably reports Mobile
as judgeable and Desktop as too small. That is itself worth knowing: **this store is
mobile-dominant enough that desktop cannot be called on a normal test**, which is a fact
about the business, not a gap in the data.

`source_channel` is available on demand but only Paid Social clears the bar, so pulling it
every run would mostly produce "Too small" rows.

## Stored data for future value projection

The skill stores reference values that help project the **future** value of a test, not
just its current readout — for example subscription customer six month LTV versus one time
purchaser six month LTV. A test that shifts the subscription mix can then be valued on
lifetime, not just first order. These live in `config/references.json` and are reused
across tests.

While they are unset, future value renders as **"not configured"** — never as zero.
Valuing a subscriber at nothing would make every mix-shifting test look neutral, which is
the precise error the projection exists to prevent.

The values are **edited in the app**, under Settings, not in a config file: they change
when someone re-runs a cohort analysis, not when the logic changes, and waiting on a pull
request to update a number measured that morning is the wrong shape. Every change is
recorded, so "why did the projected value of every test move last Tuesday" has an answer.

### How the projection works

    value per visitor = conversion rate x ( sub share x sub LTV + (1 - sub share) x one-time LTV )

Computed for control and each variant, then compared. **The point is the disagreement**: a
variant can lose on immediate revenue per visitor and still be the right call if it moves
enough people onto subscriptions. When the two views point in opposite directions the
readout says so plainly, because that conflict *is* the decision, and it is a decision
rather than a calculation.

Past `ltvStaleAfterDays` the projection is still shown and flagged as resting on old
numbers. Old numbers beat no numbers; pretending they are fresh does not.

## Which calls, and why

| Purpose | MCP tool | Notes |
|---|---|---|
| the daily roster | `search_experiments` with `status: "started"` | every live test |
| the main results call | `analyze_experience` | value, 95% CI, probability to be best, probability to beat control, uplift with its own interval. Everything the trade off analysis needs from one call. |
| per test metric map | `get_experience_metrics_config` | configuration only, not results |
| stabilized or still swinging | `get_variation_timeseries`, cumulative | also spots promo distortion |
| post test customer value | `analyze_experience` with `view: "post_test"` | the hook for the LTV projection |
| order level detail | `get_experience_export` | presigned CSV, good ~15 minutes. Only if the built in post test view is not enough. |
| store wide sanity check | `get_sitewide_snapshot` | optional. Confirms a swing is not just the whole store moving. |

The MCP Server is the right way in when a human is in the loop with Claude. The 8 AM job
is not a human in the loop, so it uses the **External REST API** with the key in the
`intelligems-access-token` header. Both are official. The route strings live in config
because the External API is in beta and its exact paths must be verified before first
deploy.

## Delta per test

Verdict changed. Uplift on any P0 metric moved beyond its confidence interval. Probability
to beat control crossed the threshold. Order count crossed 300 per group. Any P1 metric
swung past its band.

## Error states this skill handles on purpose

- A test **ended overnight**: it drops out of the started roster. Report it as ended with
  its final verdict, then stop watching it.
- **Profit metrics return null** because COGS is not configured: render as "not
  configured", never as zero.
- **No confidence interval** on a metric: skip that band check and note it.
- **One test's results fail** to pull: the other tests still report. That test's section
  is missing, not empty.
- Reads return **saved state only**. Unsaved edits in the Intelligems editor are invisible
  to the API.

## What Alex still owes this skill

- the real P0 and P1 metric lists
- the verdict mapping to Ship / Iterate / Kill / Keep Running
- whether COGS is configured
- where the LTV reference values come from and how often they refresh
- confirmation that the MCP is connected, or an External API key if the 8 AM job runs
  outside Claude (it does, in this build)
