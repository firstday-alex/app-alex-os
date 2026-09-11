#!/usr/bin/env node
// Runs the whole pipeline locally against the real APIs, writing snapshots to .data/
// instead of Netlify Blobs. This is build step 1 through 3 of the spec's build order:
// pull, delta, render, and look at the JSON by eye before anything is scheduled.
//
//   node scripts/run-local.js --mode=refresh --dry-run     # no Slack post
//   node scripts/run-local.js --mode=official              # posts, once per day
//   node scripts/run-local.js --dry-run --date=2026-09-11   # pretend it is another day

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/pipeline.js";
import { loadConfig, validateConfig, openItems } from "../src/config.js";
import { createLogger } from "../src/lib/logger.js";

// Load .env before anything reads process.env. Node's own loader, no dotenv dependency.
// Values already set in the real environment win, so `CLICKUP_TOKEN=x npm run readout:dry`
// still overrides the file.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.error(`Loaded ${envFile}`);
} else {
  console.error("No .env file found. Copy .env.example to .env and fill in the tokens you have.");
}

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  }),
);

const config = loadConfig();
const problems = validateConfig(config);

if (problems.length) {
  console.error("\nConfig problems:\n");
  for (const problem of problems) console.error(`  [${problem.level}] ${problem.message}`);
  console.error("");
  if (problems.some((p) => p.level === "fatal") && !args.force) {
    console.error("Fatal config problems. Fix them, or pass --force to run anyway and see what happens.\n");
    process.exit(1);
  }
}

const now = args.date ? new Date(`${args.date}T13:00:00Z`) : new Date();
const logger = createLogger({ level: args.quiet ? "warn" : "debug" });

const result = await runPipeline({
  config,
  mode: args.mode === "official" ? "official" : "refresh",
  dryRun: Boolean(args["dry-run"]),
  now,
  logger,
  storageMode: args.storage ?? "fs",
});

console.log(`\n${"=".repeat(78)}\n`);
console.log(result.report.text);
console.log(`${"=".repeat(78)}\n`);
console.log(`run       ${result.runId}`);
console.log(`outcome   ${result.outcome}`);
console.log(`report    ${result.reportKey}`);
console.log(`slack     ${result.delivery.sent ? "sent" : `not sent (${result.delivery.reason})`}`);

const outstanding = openItems(config);
if (outstanding.length) {
  console.log(`\n${outstanding.length} decision(s) still open:`);
  for (const item of outstanding) console.log(`  ${item.at}\n    ${item.note}`);
}
console.log("");
