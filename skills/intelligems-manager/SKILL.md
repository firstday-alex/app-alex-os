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

## Stored data for future value projection

The skill stores reference values that help project the **future** value of a test, not
just its current readout — for example subscription customer six month LTV versus one time
purchaser six month LTV. A test that shifts the subscription mix can then be valued on
lifetime, not just first order. These live in `config/references.json` and are reused
across tests.

While they are unset, future value renders as **"not configured"** — never as zero.

**Open question, not yet decided:** where those values come from (pulled from Shopify,
entered by Alex, or computed by the skill) and how often they refresh.

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
