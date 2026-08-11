#!/usr/bin/env node
// Dev harness: run ONE ticket through the real agent runner and print live progress.
// Useful for debugging a ticket without booting the whole console.
//
//   node scripts/run-one.mjs demo/tickets/101-summary.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../lib/agent-runner.js";
import { ProgressTracker } from "../lib/progress.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const WORKSPACE = path.resolve(ROOT, "..", "attendance-api");

const ticketPath = process.argv[2];
if (!ticketPath) { console.error("usage: node scripts/run-one.mjs <ticket.json>"); process.exit(1); }
const ticket = JSON.parse(fs.readFileSync(ticketPath, "utf8"));

const runDir = path.join(ROOT, "runs", "dev-" + Date.now());
const tracker = new ProgressTracker({ agentId: "agent-01", ticketId: ticket.id });
const started = Date.now();

console.log(`\n▶ ${ticket.key || ticket.id}: ${ticket.title}`);
console.log(`  workspace: ${WORKSPACE}`);
console.log(`  owns:      ${(ticket.scope || []).join(", ") || "(nothing)"}\n`);

let lastLine = "";
const { promise } = runAgent({
  agentId: "agent-01",
  ticket,
  workspace: WORKSPACE,
  runDir,
  hookScript: path.join(ROOT, "hooks", "scope-guard.mjs"),
  onEvent(ev) {
    tracker.apply(ev);
    const s = tracker.snapshot();
    const el = ((Date.now() - started) / 1000).toFixed(0).padStart(3);
    const line = `${el}s [${String(s.percent).padStart(3)}%] ${s.stageLabel.padEnd(13)} ${s.activity}`;
    if (line !== lastLine) { console.log(line.slice(0, 150)); lastLine = line; }
  },
  onLog: (k, m) => console.log(`   (${k}) ${m}`),
});

const res = await promise;
const s = tracker.snapshot();
console.log("\n─── outcome ───");
console.log(`ok=${res.ok}  exit=${res.exitCode}  ${res.error ? "error=" + res.error : ""}`);
console.log(`stage=${s.stage} percent=${s.percent}%  why="${s.whyPercent}"`);
console.log(`tools=${s.toolCalls}  todos=${s.todosDone}/${s.todosTotal}  tokens=${s.tokens}  cost=$${s.costUsd}`);
console.log(`files written: ${s.filesWritten.join(", ") || "(none)"}`);
console.log(`tests: ${s.testsPassed} passed / ${s.testsFailed} failed`);
if (res.denials?.length) console.log(`scope denials: ${res.denials.length}\n  ` + res.denials.map((d) => d.reason.slice(0, 100)).join("\n  "));
console.log(`raw transcript: ${res.rawPath}`);
