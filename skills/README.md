# skills/

Five skills. Three managers that run as deterministic code, one strategic advisor that
runs on demand, and one that learns from Alex's feedback and rewrites the others.

| # | Skill | Runs as | Invoked by |
|---|---|---|---|
| 1 | ClickUp Manager | deterministic code | the 8 AM scheduler, and the dashboard refresh |
| 2 | Intelligems Manager | deterministic code | the 8 AM scheduler, and the dashboard refresh |
| 3 | Leadership Priority Manager | deterministic code | the 8 AM scheduler, and the dashboard refresh |
| 4 | Learning Skill | agentic | Alex replying to a readout in Slack |
| 5 | Strategic Advisor | agentic | Alex clicking the button on a flagged item |

## Why the manager skills are written as skills but run as code

The daily readout has to be trustworthy and cheap. A model summarizing numbers can drift,
hallucinate a metric, or phrase the same fact three ways on three days. Code cannot.

So each manager skill file is the plain-language spec, and the code in `src/` is its
implementation. Neither hardcodes a threshold: both point at `config/`, which is the single
source of truth. When the Learning Skill changes a threshold it changes config, and the
skill file and the code move together because they read the same file.

Expected token spend on a normal day: zero. Tokens are spent only when Alex asks a
question or gives feedback.

## A note on the spec's "Skill 2a"

The requirements document lists a **Skill 2a. Test Analysis Skill** and then, under Skill 2,
says "One skill. Pulls the reports, runs the analysis, stores what it learns. **No separate
analysis skill.**" It also says "Five skills" and numbers the Learning Skill as 4 and the
Strategic Advisor as 5, leaving no slot for a sixth.

Skill 2a reads as an earlier draft that Skill 2 supersedes, so this build has five skills
and the analysis lives inside the Intelligems Manager. Every requirement listed under 2a —
the per-test metric map, the trade off analysis, the projected recommendation, the readiness
gate — is implemented, just not as a separate skill. **If that reading is wrong, this is
the one structural thing to correct before building further.**
