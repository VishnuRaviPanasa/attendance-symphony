// The tests that keep this project honest.
//
// Everything here replays samples/probe.jsonl — a REAL captured run of claude 2.1.52 on this
// machine — rather than synthetic fixtures, so the parser is verified against what the tool
// actually emits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalize } from "../lib/events.js";
import { ProgressTracker, STAGES, FLOOR } from "../lib/progress.js";
import { createJsonlSplitter } from "../lib/jsonl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(__dirname, "..", "samples", "probe.jsonl");

function rawEvents() {
  return fs.readFileSync(PROBE, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function replay() {
  const p = new ProgressTracker({ agentId: "agent-01", ticketId: "T-1" });
  const seen = [];
  for (const raw of rawEvents()) {
    for (const ev of normalize(raw)) {
      p.apply(ev);
      seen.push({ kind: ev.kind, stage: p.stage, percent: p.percent });
    }
  }
  return { p, seen };
}

/* ─────────────── the anti-fakery guarantees ─────────────── */

test("ANTI-FAKERY: progress cannot advance without an inbound event", async () => {
  const { p } = replay();
  const frozen = p.percent;
  const stage = p.stage;
  // Let real wall-clock time pass. A timer-driven bar would move here; this one must not.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(p.percent, frozen, "percent changed with no event applied");
  assert.equal(p.stage, stage, "stage changed with no event applied");
});

test("ANTI-FAKERY: progress.js never consults a clock in the percentage path", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "progress.js"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");            // strip line comments
  assert.ok(!/Date\.now|performance\.now|new Date|setInterval|setTimeout/.test(code),
    "progress.js references a time source — progress must be event-derived only");
});

test("ANTI-FAKERY: 100% is reachable only via a real result event", () => {
  const p = new ProgressTracker({});
  // Feed a great many tool events; the bar must saturate below 100.
  for (let i = 0; i < 500; i++) {
    p.apply({ kind: "tool", tool: "Write", toolId: "t" + i, file: `/x/f${i}.js`, input: {} });
  }
  assert.ok(p.percent < 100, `saturated at ${p.percent}, expected < 100 before result`);
  p.apply({ kind: "result", isError: false, numTurns: 3, durationMs: 1000, costUsd: 0.1 });
  assert.equal(p.percent, 100);
});

test("ANTI-FAKERY: progress is monotonic across the whole real run", () => {
  const { seen } = replay();
  let last = -1;
  for (const s of seen) {
    assert.ok(s.percent >= last, `percent went backwards: ${last} → ${s.percent}`);
    last = s.percent;
  }
});

/* ─────────────── correctness against the real transcript ─────────────── */

test("real run reaches completed at 100%", () => {
  const { p } = replay();
  assert.equal(p.stage, "completed");
  assert.equal(p.percent, 100);
  assert.equal(p.failed, false);
});

test("real run mines the facts the dashboard displays", () => {
  const { p } = replay();
  const snap = p.snapshot();

  assert.ok(snap.sessionId, "no session id captured");
  assert.equal(snap.model, "claude-sonnet-4-6");
  assert.ok(snap.toolCalls >= 8, `only ${snap.toolCalls} tool calls`);

  // Write's payload key is `content`, not `file_text` — if that regressed, this is empty.
  assert.ok(snap.filesWritten.length >= 1, "no written files detected");
  assert.ok(snap.filesWritten.some((f) => f.endsWith("greet.js")), snap.filesWritten.join(","));

  // TodoWrite works on 2.1.52 and carries activeForm.
  assert.ok(snap.todosTotal >= 3, `todos not captured (${snap.todosTotal})`);
  assert.ok(snap.costUsd > 0, "no cost captured");
  assert.ok(snap.tokens > 0, "no tokens captured");
  assert.equal(snap.numTurns, 10);
});

test("stage sequence follows real tool activity", () => {
  const { seen } = replay();
  const order = [];
  for (const s of seen) if (order.at(-1) !== s.stage) order.push(s.stage);

  assert.equal(order[0], "initializing", `first stage was ${order[0]}`);
  assert.equal(order.at(-1), "completed");
  // monotonic by ordinal
  const idx = order.map((s) => STAGES.indexOf(s));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `stage regressed: ${order[i - 1]} → ${order[i]}`);
  // this agent planned before reading — the model must tolerate that, not assume a fixed order
  assert.ok(order.includes("planning") && order.includes("implementing"));
});

test("failure freezes progress instead of inflating it", () => {
  const p = new ProgressTracker({});
  p.apply({ kind: "init", sessionId: "s", model: "m" });
  p.apply({ kind: "tool", tool: "Read", toolId: "a", file: "/x/a.js", input: {} });
  const before = p.percent;
  p.apply({ kind: "result", isError: true, subtype: "error_during_execution" });
  assert.equal(p.stage, "failed");
  assert.equal(p.percent, before, "percent moved on failure");
  assert.ok(p.failed);
});

test("is_error absent is NOT treated as a failure", () => {
  // Most tool_results in the real transcript omit is_error entirely.
  const results = rawEvents()
    .filter((o) => o.type === "user")
    .flatMap((o) => normalize(o))
    .filter((e) => e.kind === "tool_result");
  assert.ok(results.length >= 8);
  assert.ok(results.some((r) => r.isError === false), "expected non-error results");
  assert.equal(results.filter((r) => r.isError).length, 0, "absent is_error misread as failure");
});

/* ─────────────── the splitter ─────────────── */

test("JSONL splitter reassembles objects split across chunk boundaries", () => {
  const objs = [];
  const bad = [];
  const s = createJsonlSplitter((o) => objs.push(o), (l, e) => bad.push([l, e]));

  const payload = rawEvents().map((o) => JSON.stringify(o)).join("\n") + "\n";
  // Feed in deliberately awkward 7-byte chunks so objects split mid-token.
  for (let i = 0; i < payload.length; i += 7) s.push(Buffer.from(payload.slice(i, i + 7)));
  s.end();

  assert.equal(bad.length, 0, `unparseable lines: ${bad.length}`);
  assert.equal(objs.length, rawEvents().length);
  assert.equal(objs.at(-1).type, "result");
});

test("JSONL splitter flushes a trailing line with no newline", () => {
  const objs = [];
  const s = createJsonlSplitter((o) => objs.push(o));
  s.push('{"type":"a"}\n{"type":"b"}');   // no trailing newline
  assert.equal(objs.length, 1);
  s.end();
  assert.equal(objs.length, 2);
  assert.equal(objs[1].type, "b");
});

test("stage floors are ordered and consistent with STAGES", () => {
  for (let i = 1; i < STAGES.length; i++) {
    assert.ok(FLOOR[STAGES[i]] > FLOOR[STAGES[i - 1]], `floor not increasing at ${STAGES[i]}`);
  }
  assert.equal(FLOOR.completed, 100);
});
