// Slack's interactivity endpoint. Two kinds of click land here.
//
// "Ask for recommendation". Slack expects an acknowledgement within three seconds and an
// Anthropic call takes longer, so this verifies the signature, hands off to the
// background function, and acknowledges. The answer arrives in the thread when ready.
//
// Triage: Done, Snooze, Not a problem. Written straight to the flag ledger, the same
// write the dashboard makes, and the button row is replaced in the message with what was
// done and by whom. Only Alex can triage: the readout is Alex's queue, and a teammate
// clearing a flag about their own work would defeat it.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { dateKey } from "../../src/lib/time.js";
import { FlagLedger, keyForRef } from "../../src/store/flag-ledger.js";
import { SLACK_TRIAGE } from "../../src/render/report.js";
import { verifySlackSignature, IDENTITY_LINE } from "../../src/send/slack.js";

/** Replies through the response_url, the only way a block action can change its message. */
async function respond(payload, body, logger) {
  if (!payload.response_url) return;
  try {
    await fetch(payload.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
  } catch (err) {
    logger.warn("slack.respond_failed", { err });
  }
}

const ephemeral = (text) => ({ response_type: "ephemeral", replace_original: false, text: `${IDENTITY_LINE} ${text}` });

export async function handleTriage({ payload, action, config, store, logger, respondImpl = respond }) {
  const user = payload.user?.id ?? null;
  const alex = config.people?.alex?.slackUserId ?? null;
  if (!alex) {
    await respondImpl(payload, ephemeral("Triage from Slack is off until config.people.alex.slackUserId is set, so nobody else can clear Alex's flags."), logger);
    return { ok: false, reason: "alex_unset" };
  }
  if (user !== alex) {
    logger.info("triage.refused_other_user", { user });
    await respondImpl(payload, ephemeral("Only Alex can triage readout flags. If this one is yours to fix, reply in the thread instead."), logger);
    return { ok: false, reason: "not_alex" };
  }

  const ledger = new FlagLedger(store.backend, logger);
  const key = keyForRef(action.value, Object.keys((await ledger.read()).entries));
  if (!key) {
    await respondImpl(payload, ephemeral("That flag is no longer raised, so there is nothing to mark."), logger);
    return { ok: false, reason: "not_raised" };
  }

  const t = SLACK_TRIAGE[action.action_id];
  const entry = await ledger.setTriage(key, { status: t.status, workingDays: t.workingDays }, {
    today: dateKey(new Date(), config.system.timezone),
    workingWeekdays: config.system.schedule?.workingWeekdays,
    by: `slack:${user}`,
  });
  logger.info("triage.from_slack", { key, status: t.status });

  const label = t.status === "snoozed" ? `Snoozed until ${entry.triage.until}` : t.label;
  const blocks = (payload.message?.blocks ?? []).map((b) =>
    b.block_id === action.block_id
      ? { type: "context", block_id: b.block_id, elements: [{ type: "mrkdwn", text: `:white_check_mark: ${label} by <@${user}>. Undo on the dashboard.` }] }
      : b,
  );
  await respondImpl(payload, { replace_original: true, text: payload.message?.text ?? "Turnpups readout", blocks }, logger);
  return { ok: true, key, entry };
}

async function handOff(payload, logger) {
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  const response = await fetch(`${base}/.netlify/functions/advisor-background`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  logger.info("advisor.handed_off", { status: response.status, flagId: payload.flagId });
}

export default async (req) => {
  const logger = createLogger({ base: { fn: "slack-interactive" } });
  const rawBody = await req.text();

  const verified = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!verified.ok) {
    logger.warn("slack.signature_rejected", { reason: verified.reason });
    return new Response("forbidden", { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "{}");
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const action = (payload.actions ?? [])[0];
  if (payload.type === "block_actions" && SLACK_TRIAGE[action?.action_id]) {
    const config = loadConfig();
    try {
      await handleTriage({ payload, action, config, store: await Store.open({ config, logger }), logger });
    } catch (err) {
      logger.error("triage.failed", { err });
      await respond(payload, ephemeral(`I could not save that: ${err.message}`), logger);
    }
    return new Response("", { status: 200 });
  }
  if (payload.type !== "block_actions" || action?.action_id !== "ask_advisor") {
    return new Response("", { status: 200 });
  }

  logger.info("advisor.button_clicked", { flagId: action.value, clickedBy: payload.user?.id ?? null });

  try {
    await handOff(
      {
        flagId: action.value,
        channel: payload.channel?.id ?? null,
        threadTs: payload.message?.thread_ts ?? payload.message?.ts ?? null,
        clickedBy: payload.user?.id ?? null,
      },
      logger,
    );
  } catch (err) {
    logger.error("advisor.handoff_failed", { err });
    return new Response(
      JSON.stringify({ response_type: "ephemeral", text: `${IDENTITY_LINE} I could not start that recommendation: ${err.message}` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text: `${IDENTITY_LINE} Working on that recommendation. It will land in this thread.`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
