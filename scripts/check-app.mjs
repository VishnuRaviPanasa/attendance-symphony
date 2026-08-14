#!/usr/bin/env node
// Structural check of the attendance app.
//
// This runs the SAME gate the orchestrator applies to a UI agent's work
// (jira-symphony/lib/verify.js). One definition of "the app is intact", used in two places:
//
//   * the orchestrator, before a frontend ticket is allowed to complete
//   * CI, on every push and on the sym/* branches the orchestrator pushes
//
// So a UI change cannot pass Symphony's gate and then quietly fail on GitHub, or vice versa.
//
//   node scripts/check-app.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTask } from "../jira-symphony/lib/verify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// index.html only. app.html is deliberately a BODY-ONLY fragment — it has no <html> or <body>
// closing tags by design, so the "complete document" check would fail it every time. Its
// correctness is guaranteed a different way: `sync-app-html.js --check` proves it is derived
// byte-for-byte from index.html, which this gate has just verified.
const FILES = ["index.html"];

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;

const result = await verifyTask(
  { key: "APP", kind: "frontend", scope: FILES, ticket: {} },
  ROOT,
);

console.log(`\n${result.command}`);
if (result.ok) {
  console.log(g(`  ✓ ${result.summary}`));
  console.log("    complete document · every inline script parses · no external resources\n");
} else {
  console.log(r(`  ✗ ${result.summary}\n`));
  for (const line of result.output.split("\n").filter(Boolean)) console.log(r("    " + line));
  console.log();
}

process.exitCode = result.ok ? 0 : 1;
