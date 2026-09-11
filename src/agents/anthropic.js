// The only place an Anthropic call is made.
//
// Expected token spend on a normal day is zero. This module runs when Alex clicks the
// button on a flagged item, and when Alex replies to a readout with feedback. Nothing
// else invokes it.

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../config.js";

let client = null;
export function getClient(env = process.env) {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

/** A skill file is the system prompt. It is the spec the code implements, in plain language. */
export function readSkill(name) {
  const file = path.join(repoRoot, "skills", name, "SKILL.md");
  return fs.readFileSync(file, "utf8");
}

/**
 * One Messages call.
 *
 * Adaptive thinking, because both surfaces are judgement work. Streaming, because a long
 * answer must not hit the request timeout. Server-side fallbacks so a policy decline
 * returns an answer rather than nothing.
 */
export async function ask({
  system,
  messages,
  config,
  env = process.env,
  maxTokens,
  effort,
  outputFormat,
  logger,
}) {
  const anthropic = getClient(env);
  const modelConfig = config?.system?.anthropic ?? {};
  const model = modelConfig.model ?? "claude-opus-5";
  const startedAt = Date.now();

  const request = {
    model,
    max_tokens: maxTokens ?? modelConfig.maxTokens ?? 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: effort ?? modelConfig.effort ?? "high", ...(outputFormat ? { format: outputFormat } : {}) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages,
  };

  const stream = anthropic.beta.messages.stream(request);
  const response = await stream.finalMessage();

  logger?.info("anthropic.call", {
    model: response.model,
    stopReason: response.stop_reason,
    durationMs: Date.now() - startedAt,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    cacheRead: response.usage?.cache_read_input_tokens ?? null,
  });

  // Check stop_reason before reading content. A refusal is a 200 with no useful answer.
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? null;
    logger?.warn("anthropic.refused", { category });
    return { refused: true, category, text: null, parsed: null, response };
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  // `parsed_output` is populated by the SDK's parse helper. A streamed create may not set
  // it, so when a schema was requested, fall back to parsing the text ourselves rather
  // than reporting a well-formed answer as a shape failure.
  let parsed = response.parsed_output ?? null;
  if (!parsed && outputFormat && text) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger?.warn("anthropic.parse_failed", { err, chars: text.length });
    }
  }

  return { refused: false, text, parsed, response };
}
