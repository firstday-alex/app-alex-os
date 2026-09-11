# config/ — the single source of truth

DECIDED in the spec: every threshold, metric list, field id and rule the manager skills
use lives here. The skill files in `skills/` describe the logic in plain language and
point at these files. The code in `src/` reads these files. Nothing is hardcoded in
either place.

When the Learning Skill changes a threshold it changes a file in here, as a pull
request. Code and skill move together because they read the same file.

| File | Owns |
|---|---|
| `system.json` | Schedule, timezone, storage keys, dashboard, logging |
| `clickup.json` | List id, field ids, status name map, delta and stall rules |
| `intelligems.json` | API paths, P0/P1 metric lists, readiness gate, verdict map, bands |
| `leadership.json` | Tolerance window, one-big-swing rule, cross layer thresholds |
| `leadership-queue.json` | The live leadership queue and backlog. Layer 1's data. |
| `references.json` | Stored LTV reference values used to project future test value |
| `people.json` | Team roster. ClickUp user ids to names and Slack ids. |

Every value that is still an open question in the spec is marked with a sibling
`"_TODO"` key naming who decides it. Search the repo for `_TODO` to find them all.
