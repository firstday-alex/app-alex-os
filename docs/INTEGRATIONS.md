# Integration notes

**Status: verified, not assumed.** Every endpoint, field name and value below was checked
on 2026-09-10 against the live First Day accounts and the published API references. Where
something is still unknown it says so explicitly.

The first version of this file was a list of guesses labelled "verify before deploy."
Most of them were wrong. What follows records what was actually found, including the
corrections, because the corrections are the useful part.

---

## Intelligems

**Account.** First Day Life Inc., org `86ab4ded-43f9-4a0a-a9ef-80dfd2b5508d`, shop
`first-day-inc.myshopify.com`, firstday.com, Shopify Plus, USD, **America/Los_Angeles**.
7 experiments currently `started`.

**Base.** `https://api.intelligems.io/v25-10-beta`, auth header `intelligems-access-token`,
generated under Integrations → External API → Enable.

### What was guessed, and what is actually true

| | First guess | Verified |
|---|---|---|
| Roster | `GET /experiments` | **`GET /experiences-list`** |
| Results | `GET /experiences/{id}/analyze` | **`POST /analytics/resource/{id}`** |
| Timeseries | `GET /experiences/{id}/variations/timeseries` | **`POST /analytics/experience/{id}/timeseries`** |
| Metric config | `GET /experiences/{id}/metrics-config` | **No such endpoint.** Key metrics ride on `GET /experiences/{id}` as `experienceKeyMetrics` |
| Shop info | `GET /shop` | **No such endpoint** on the External API |
| Pagination | 0-based, `last_page` | **1-based**, envelope of `page`/`limit`/`total`/`totalPages` |
| Method | GET everywhere | **Analytics are POST** with a JSON body |

The analytics body is `{view, testResult, startTs, endTs, filters, ...}`; `testResult: true`
is what makes the platform compute and return its verdict. Timeseries takes
`{granularity, mode, metrics, startTs, endTs}`.

### Response shape — the corrections that mattered most

Every one of these silently disabled a piece of Layer 3 rather than erroring:

- **Confidence intervals are `ci_low` / `ci_high`**, not `ciLow`/`ciHigh` and not
  `confidenceInterval`. With the wrong key every interval came back null, which meant
  every P1 band check and every P0 movement check skipped, on every test, forever. The
  readout would have looked fine and reported nothing.
- **`uplift` is an object** `{value, ci_low, ci_high, plus_minus}`, and its value is a
  **fraction**. `0.1588` is +15.9%, not +0.16%.
- **Probability to beat control is `p2bc`**; probability to be best is `p2bb`.
- **The verdict is an object**, not a string:
  `testResult: {verdict, runtime_days, orders_per_variant}`. It also hands over the
  runtime and the per-variant order counts, so the readiness gate is *read* rather than
  recomputed.
- **Metrics and variations are separate arrays**, joined on `variation_id`. The control
  carries no `uplift` and no `p2bc`.
- **Scalars are wrapped**: `n_orders: {value: 254}`.
- **There is no `aov` metric** in the variation overview. AOV is `net_revenue_per_order`.

The real payload is captured at `test/fixtures/intelligems-real.js`, and
`test/intelligems-real.test.js` asserts against it. Every assertion in that file failed
against the first implementation.

### Verified facts

- **The readiness gate is real and confirmed.** "[KCM-PDP] Price per Gummy" at
  `runtime_days: 42` with 254 / 238 orders per variant returns `not_ready`. Days met,
  orders not. **300 is per group.**
- **COGS is not configured** on this account: `cogsConfigured: false`,
  `cogsCoveragePct: 0`, and every `gross_profit_*` metric returns null. So
  `gross_profit_per_visitor` is deliberately kept out of the P0 list, and profit renders
  as "not configured", never zero.
- **There are 13 verdicts, not 6.** The spec listed six. The platform also returns `error`
  and six `filtered_*` variants, and documents that filtered verdicts describe a narrowed
  population and must never be treated as wins or losses. All seven now map to Keep
  Running so a future filter cannot silently produce a Ship.
- **Rate limits are documented**: experience endpoints burst 50 / refill 25 per 30s;
  export burst 20; sitewide burst 10 / refill 5 per 30s. Headers are `x-ratelimit-limit`,
  `x-ratelimit-remaining` and `x-ratelimit-reset`, where **reset is milliseconds until
  reset, not an epoch**, and a 429 body carries `retryAfter` in seconds. Reading that
  header as an epoch schedules a retry in 1970; reading it as seconds sleeps for eight
  hours. `serverRetryDelayMs` handles all three shapes and is tested on each.
- **The LTV question may already be answered.** `view: "post_test"` returns customers who
  converted during a test tracked by their later purchase behavior, split by variation,
  with `total_*` as the LTV view. Worth checking one live test before sourcing LTV values
  from Shopify by hand.

### Still unknown

- Whether Central or Pacific is the intended day boundary. The **store reports in
  Pacific** and the readout is specified for **8 AM Central**. Two hours apart, so
  "yesterday" is not the same window in both. Recorded in `config/references.json`.

---

## ClickUp

**Workspace** `18042215`. **Sprint list: `901112668495`**, "Current Sprint", at
WEB → 2025/26 Updated Team Boards → Current Sprint.

### Verified

- **Statuses**: `to do` (open), **`in-progress`** (hyphenated), `vqa`, `qa`,
  `ready for deploy`, `complete` (closed). The first config guessed `"in progress"` with a
  space and knew nothing about vqa/qa/ready-for-deploy, so **four of the six statuses fell
  through to Not Started** with only a log line. Now mapped and tested.
- **A separate backlog list exists**: "Site Backlog" `901111926996`, in the same folder.
  This answers the spec's open question — `include_timl=true` is required, not optional.
- **The list holds 100+ tasks**, mostly `complete`, going back months. It is an
  accumulating board rather than a weekly sprint. ~16 tickets are open at any time, which
  is the set the readout is actually about.
- **54 workspace members**, which is the whole company. The people holding open sprint work
  are Robson Lopes, Blake Tucker, Oleksandr Zghonnyk, Cristobal Alanis and Alex Turney.

### The blocker

**Neither `Task Owner` nor `Leadership Priority` exists.** Checked at list, space and
workspace level: the sprint list has 📅 Target Month, Epic, Design Reference URL, Rock
Reference and Ready for Estimate, and there are **no space-level or workspace-level custom
fields at all**. There is no user-type field anywhere.

**`Rock Reference` already does most of the Leadership Priority job.** It is a dropdown of
quarterly rocks — ncAOV, Sub opt-in for NC, Increase Email & SMS Opt-in, RFP for
Subscription Platform, Launch new configuration / New GWP Offer, Redesigned Homepage, CVR,
LTV, Lead Capture, Engagement — and it **already has a BAU option**, which is exactly the
business-as-usual marker the cross layer rule needs. Either point the system at it or
create a second field and accept two overlapping priority fields on every ticket.
`config/clickup.json` lists both names so it resolves whichever exists.

### Still to verify

- The `GET /api/v2/task/{task_id}/comment` path and response shape. Still unconfirmed:
  the MCP server exposes comments through its own tool, which does not prove the REST
  path. If it is wrong, comment deltas silently report nothing.
- Whether the team uses subtasks on sprint tickets.
- Whether `ready for deploy` should count as in progress (current mapping) or as done.

---

## Slack, Anthropic, GitHub, Netlify

Unchanged from the build. Slack v0 HMAC verification with a five minute replay window;
`claude-opus-5` with adaptive thinking and server-side fallbacks, called only on a button
click or a feedback reply; a repo-scoped GitHub token for the proposal PRs; a scheduled
function at `0 13,14 * * 1-5` that checks the Central hour and exits.

Still open: **confirm Background Functions are available on this Netlify plan.** The
documentation conflicts, and the retry behaviour the idempotence guard is built around
depends on it.
