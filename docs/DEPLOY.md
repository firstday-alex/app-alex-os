# Deploying

Order matters here: the pipeline is verified locally before anything is scheduled, and the
learning skill goes last because it edits everything else.

---

## 1. Locally, before Netlify

```bash
npm install
npm test          # 117 tests. no network, no keys.
npm run check
```

The sprint list id and status names are already filled in and verified, so all a dry run
needs is the two tokens:

```bash
cp .env.example .env
# open .env, paste in CLICKUP_TOKEN and INTELLIGEMS_TOKEN
npm run readout:dry
```

`.env` lives in the project root, is gitignored, and is read by `process.loadEnvFile` —
no dotenv dependency. A real environment variable overrides the file, so a one-off run
without touching the file works too:

```bash
CLICKUP_TOKEN=pk_... npm run readout:dry
```

**The `.env` file is for local runs only.** The deployed site never reads it; Netlify
holds the same variable names in its own environment settings (step 3).

Read the printed readout against the actual board. This is build step 1 through 3 of the
spec's order, and it is the only time the JSON gets eyeballed cheaply. Look for:

- the right tasks in Not Started and In Progress
- statuses landing in the right buckets (an unmapped status logs
  `clickup.status_unmapped`)
- Task Owner and Leadership Priority resolving, or reporting as null for the right tickets
- the stalled/waiting/moving signal matching your read of the board

Run it twice on two different days to see a real delta. `--date=` will not manufacture one:
the second run needs a genuine previous-day snapshot.

---

## 2. GitHub

Push the repo. Every config and skill change lands as a commit from here on, which is what
gives the learning skill its history and its rollback.

---

## 3. Netlify site

Connect the repo. Build settings come from `netlify.toml`; there is no build step.

**Environment variables** (Site configuration → Environment variables). Never in the repo:

| Variable | Notes |
|---|---|
| `CLICKUP_TOKEN` | personal API token, `pk_...` |
| `INTELLIGEMS_TOKEN` | External API key |
| `SLACK_BOT_TOKEN` | `xoxb-...`, scope `chat:write` |
| `SLACK_SIGNING_SECRET` | verifies inbound Slack requests |
| `SLACK_READOUT_CHANNEL` | channel id, e.g. `C0123456789` |
| `ANTHROPIC_API_KEY` | advisor and learning skill only |
| `GITHUB_TOKEN` | scoped to this repo: contents + pull requests write |
| `DASHBOARD_PASSWORD` | the shared dashboard password |
| `DASHBOARD_COOKIE_SECRET` | `openssl rand -base64 32`. Also gates internal function calls. |

**Never use a value that appears in the repo.** Netlify scans the build output for every
environment value and fails the build when it finds one. That is not a nuisance to be
suppressed: a `DASHBOARD_PASSWORD` of `turnpups-mos` is the package name, the Blobs store
name and the GitHub user-agent, and is guessable from the repo in one try. Generate
passwords and secrets, never name them after the project.

**Only secrets go here.** The repo and branch the learning skill targets live in
`config/system.json` → `github`, not in the environment. Netlify runs a secrets scanner
over the build output and fails the build on any string matching an environment value —
so a variable set to `main` fails on every `<main>` tag in the HTML and every "domain" in
the CSS. Anything that is not genuinely secret belongs in `config/`.

`DASHBOARD_COOKIE_SECRET` does double duty: it signs the dashboard session **and** is the
shared secret that lets the scheduler and the refresh endpoint invoke the pipeline. Without
it set, the pipeline cannot be triggered by anything at all — which is the intended failure
direction.

**Confirm Background Functions are on this plan** before relying on the 15 minute budget.
See `docs/INTEGRATIONS.md`.

---

## 4. Watch three mornings before trusting it

The spec's build order says to let the scheduler run three mornings. Do that.

The scheduled function fires at 13:00 and 14:00 UTC and logs
`scheduled.skipped` with the Central hour on the run that is not 8 AM. Both firing and
skipping should appear in the function log every weekday. Check:

- one `scheduled.firing` per weekday, none on Saturday or Sunday
- `run.end` with `outcome: success`
- one Slack post per day, and no doubles after a retry
- `snapshot.stored` for each source

---

## 5. Slack app

Use `slack-app-manifest.json` in the repo root. **Order matters: the Netlify site must
already be deployed**, because Slack calls both request URLs the moment you submit the
manifest and rejects it if they do not answer. Do step 3 before this one.

1. Open `slack-app-manifest.json` and replace every `YOUR-SITE` with the real Netlify site
   name. Two occurrences.
2. api.slack.com/apps → **Create New App** → **From an app manifest** → pick the workspace
   → paste the JSON.
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-...`) into
   Netlify as `SLACK_BOT_TOKEN`.
4. **Basic Information → App Credentials → Signing Secret** → copy into Netlify as
   `SLACK_SIGNING_SECRET`. This is what proves an inbound request really came from Slack.
   Without it every button click and every reply is rejected, by design.
5. Invite the bot to the readout channel (`/invite @Turnpups MOS`) and put that channel's
   id in Netlify as `SLACK_READOUT_CHANNEL`.
6. Put Alex's Slack member id in `config/people.json` → `alex.slackUserId`. **Until that is
   set, any human reply in the thread drives the learning skill**, and the system logs a
   warning saying so on every event.

### What each scope is for

| Scope | Needed by |
|---|---|
| `chat:write` | posting the readout, and the advisor's reply into the thread |
| `chat:write.public` | posting to a public channel the bot has not been invited to. Drop it if you always invite the bot. |
| `channels:history` | **required** to receive `message.channels`. Subscribing to that event without this scope silently delivers nothing, which is a miserable thing to debug. |
| `groups:history` | the same, for a private readout channel. Drop it if the channel is public. |

The manifest subscribes to both `message.channels` and `message.groups`. Delete whichever
does not match your readout channel rather than carrying a scope you do not use.

---

## 6. The dashboard

`https://<site>/` — shared password, then a signed HttpOnly session cookie for 12 hours.

Prefer real accounts? Netlify Identity is a drop-in swap: `isAuthorized` in
`src/lib/dashboard-auth.js` is the only function that would change. Do not leave the site
public either way; it shows sprint and test data.

---

## 7. The learning skill, last

Everything it can edit should be stable first, because it edits everything else.

Test it once end to end with something harmless and reversible — reply to a readout with
*"make the stalled threshold four days instead of three"* — and confirm:

- a PR appears against `config/clickup.json` and nothing else
- the Slack reply names the file, the change and the reason, with the merge link
- **nothing changed until the merge**
- the next run uses four days
- reverting the PR puts it back

If any of those five is not true, stop and fix it before letting the loop run
unsupervised. The whole safety property of this design is that a proposal is inert until
Alex merges it.

---

## Rollback

Every behavioural change is a commit, so `git revert` is the rollback and Netlify redeploys
on merge. Snapshots in Blobs are append-only per date, so reverting code does not lose
history.

To silence the morning send without a deploy: change the schedule in `netlify.toml`, or set
`config/system.json` → `schedule.readoutHourCentral` to an hour the cron never fires at
(anything but 8). The second is a config change, so it is also a PR, so it is also
reversible.
