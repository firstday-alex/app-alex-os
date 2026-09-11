// Skill 4. Learning Skill. Agentic. One call per feedback reply.
//
// Every update delivered in Slack can receive feedback from Alex in a reply. This skill
// reads that feedback, decides which of the manager skills or which config value needs to
// change to implement it, proposes the specific edit, and waits for a yes.
//
// DECIDED: propose then approve. No automatic edits to manager skills. On this stack the
// proposal is a pull request and the yes is a merge, so approval, history and rollback all
// come for free.

import fs from "node:fs";
import path from "node:path";
// The beta helper, to match the beta messages endpoint this skill and the advisor use.
// A raw JSON schema rather than zod: the SDK's zod helper needs zod v4's toJSONSchema, and
// one small schema is not worth pinning this repo to a zod major.
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { ask, readSkill } from "./anthropic.js";
import { repoRoot } from "../config.js";
import { openProposalPr } from "./github.js";
import { postMessage } from "../send/slack.js";

/** The only files the Learning Skill may propose changes to. */
export const EDITABLE = [
  "config/system.json",
  "config/clickup.json",
  "config/intelligems.json",
  "config/leadership.json",
  "config/references.json",
  "config/people.json",
  "config/shopify.json",
  "skills/clickup-manager/SKILL.md",
  "skills/intelligems-manager/SKILL.md",
  "skills/leadership-priority-manager/SKILL.md",
  "skills/store-metrics-manager/SKILL.md",
  "skills/strategic-advisor/SKILL.md",
];

/**
 * Files that look editable but are not, with the reason. Naming them is better than
 * silently rejecting a reasonable request: the skill can tell Alex where the thing
 * actually lives instead of saying no.
 */
export const NOT_EDITABLE = {
  "config/leadership-queue.json":
    "Rocks moved out of config and into the app's own store. Edit them on the Rocks screen, where every change is recorded with what it was before. This file is only a seed for a store that has never been written, and a fallback if storage is unreachable.",
};

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    actionable: { type: "boolean", description: "false when the feedback is a remark rather than a change request" },
    reasoning: { type: "string", description: "one or two sentences on why this is the right file and the right change" },
    targetFile: { type: "string", description: "repo-relative path. must be one of the editable files listed in the prompt, or empty when not actionable" },
    newContent: { type: "string", description: "the complete new contents of that file, not a patch. empty when not actionable" },
    summary: { type: "string", description: "one line describing the change, suitable as a pull request title" },
    affectedSkill: { type: "string", description: "which manager skill this changes the behavior of, or 'none'" },
  },
  required: ["actionable", "reasoning", "targetFile", "newContent", "summary", "affectedSkill"],
  additionalProperties: false,
};

function readRepoFile(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

/**
 * Turns one piece of Slack feedback into a proposed edit. Does not apply anything.
 */
export async function proposeChange({ feedback, reportContext, config, env = process.env, logger }) {
  const system = readSkill("learning-skill");

  // The skill sees the current contents of every file it is allowed to change, so the
  // proposal is a real edit to real content rather than a guess at what the file says.
  const currentFiles = {};
  for (const relative of EDITABLE) {
    try {
      currentFiles[relative] = readRepoFile(relative);
    } catch {
      currentFiles[relative] = null;
    }
  }

  const result = await ask({
    system,
    config,
    env,
    logger,
    maxTokens: 32000,
    outputFormat: betaJSONSchemaOutputFormat(PROPOSAL_SCHEMA, "proposal"),
    messages: [
      {
        role: "user",
        content: [
          "Alex replied to a readout in Slack with this feedback:",
          "",
          JSON.stringify(feedback, null, 2),
          "",
          "The readout the feedback is about:",
          JSON.stringify(reportContext ?? {}, null, 2),
          "",
          "Files you may change, with their current contents:",
          JSON.stringify(currentFiles, null, 2),
          "",
          "Decide which single file needs to change to implement the feedback and return its complete new contents.",
          "Config carries thresholds and lists. Skill files carry the plain-language logic. Change whichever one actually holds the thing Alex is asking about, and keep the two consistent.",
          "If the feedback is not a change request, set actionable to false and leave targetFile empty.",
        ].join("\n"),
      },
    ],
  });

  if (result.refused) {
    return { actionable: false, error: "The model declined to answer this one.", category: result.category };
  }

  const proposal = result.parsed;
  if (!proposal) {
    return { actionable: false, error: "The proposal did not come back in the expected shape.", raw: result.text };
  }
  if (!proposal.actionable) {
    return { actionable: false, reasoning: proposal.reasoning };
  }
  if (!EDITABLE.includes(proposal.targetFile)) {
    logger?.warn?.("learning.target_rejected", { targetFile: proposal.targetFile });
    const why = NOT_EDITABLE[proposal.targetFile];
    return {
      actionable: false,
      error: why
        ? `${proposal.targetFile} is not edited here. ${why}`
        : `${proposal.targetFile} is not an editable file. Nothing proposed.`,
    };
  }
  // A config file that no longer parses would take the pipeline down on the next run.
  if (proposal.targetFile.endsWith(".json")) {
    try {
      JSON.parse(proposal.newContent);
    } catch (err) {
      logger?.warn?.("learning.invalid_json", { targetFile: proposal.targetFile, err });
      return { actionable: false, error: `The proposed ${proposal.targetFile} is not valid JSON. Nothing proposed.` };
    }
  }

  return { ...proposal, currentContent: currentFiles[proposal.targetFile] };
}

/**
 * The full loop: read the feedback, propose the edit, open the PR, and say back in Slack
 * exactly what would change and where. Nothing is applied until Alex merges.
 */
export async function handleFeedback({ feedback, reportContext, config, env = process.env, logger, store, fetchImpl }) {
  const proposal = await proposeChange({ feedback, reportContext, config, env, logger });

  const reply = async (text) => {
    if (!env.SLACK_BOT_TOKEN || !feedback.channel) return;
    await postMessage({
      channel: feedback.channel,
      threadTs: feedback.threadTs ?? feedback.ts,
      text,
      token: env.SLACK_BOT_TOKEN,
      logger,
      fetchImpl,
      config,
    });
  };

  if (!proposal.actionable) {
    const message = proposal.error
      ? `I could not turn that into a change. ${proposal.error}`
      : `Read that as a comment rather than a change request, so I have not proposed anything. ${proposal.reasoning ?? ""}`.trim();
    await reply(message);
    return { proposed: false, reason: message };
  }

  let pr = null;
  try {
    pr = await openProposalPr({
      // Config first: the repo and branch are settings, not secrets. The env vars are
      // still honoured so an existing deployment does not break.
      repo: config.system.github?.repo ?? env.GITHUB_REPO,
      baseBranch: config.system.github?.defaultBranch ?? env.GITHUB_DEFAULT_BRANCH ?? "main",
      filePath: proposal.targetFile,
      newContent: proposal.newContent,
      title: `MOS: ${proposal.summary}`,
      body: [
        "Proposed by the Turnpups MOS learning skill from Slack feedback.",
        "",
        `**Feedback:** ${feedback.text}`,
        "",
        `**Change:** ${proposal.summary}`,
        `**File:** \`${proposal.targetFile}\``,
        `**Affects:** ${proposal.affectedSkill}`,
        "",
        `**Reasoning:** ${proposal.reasoning}`,
        "",
        "Nothing changes until this is merged. Revert the PR to undo it.",
      ].join("\n"),
      token: env.GITHUB_TOKEN,
      logger,
      fetchImpl,
      config,
    });
  } catch (err) {
    logger?.error?.("learning.pr_failed", { err });
    await reply(`I worked out the change but could not open the pull request: ${err.message}`);
    return { proposed: false, proposal, error: err.message };
  }

  const message = [
    `Proposal ready. ${proposal.summary}`,
    `File: \`${proposal.targetFile}\`. Affects: ${proposal.affectedSkill}.`,
    `Why: ${proposal.reasoning}`,
    "",
    `Approve by merging: ${pr.url}`,
    "Nothing changes until you merge. Revert the PR to undo it.",
  ].join("\n");

  await reply(message);
  if (store) {
    await store.backend.set(`learning/${pr.number}.json`, {
      pr,
      proposal: { ...proposal, newContent: undefined, currentContent: undefined },
      feedback,
      proposedAt: new Date().toISOString(),
    });
  }
  logger?.info?.("learning.proposed", { pr: pr.number, targetFile: proposal.targetFile });
  return { proposed: true, pr, proposal };
}
