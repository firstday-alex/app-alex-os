#!/usr/bin/env node
// Parses every source file. Catches a typo before a deploy does, without adding a linter.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["src", "netlify/functions", "scripts", "test", "public"];
const files = [];

const walk = (dir) => {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(rel);
  }
};
for (const dir of dirs) walk(dir);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" });
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${file}\n${err.stderr?.toString() ?? err.message}`);
  }
}

// Config must parse too. A broken config file takes the 8 AM readout down.
for (const file of fs.readdirSync(path.join(root, "config")).filter((f) => f.endsWith(".json"))) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, "config", file), "utf8"));
  } catch (err) {
    failed += 1;
    console.error(`FAIL config/${file}: ${err.message}`);
  }
}

console.log(`${files.length} source file(s) checked, ${failed} failure(s).`);
process.exit(failed ? 1 : 0);
