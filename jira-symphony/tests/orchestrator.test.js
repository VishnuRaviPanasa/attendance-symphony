// Orchestration behaviour: backpressure, priority, retry, dedupe.
//
// These use an injected stub runner so the queueing logic can be exercised deterministically
// without spawning real agents (a real 6-ticket run would take ~7 minutes and cost real money).
// The stub only stands in for the *process*; every other code path is the production one.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { Orchestrator } from "../lib/orchestrator.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sym-orch-"));

/** A runner whose completion each test drives by hand. */
function makeStub() {
  const inflight = [];
  const runner = ({ agentId, ticket, onEvent }) => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = {
      agentId, ticketId: ticket.id, onEvent,
      finish: (res = {}) => resolve({ ok: true, exitCode: 0, sawResult: true, resultEvent: { costUsd: 0.1 }, denials: [], ...res }),
      fail: (error = "boom") => resolve({ ok: false, exitCode: 1, sawResult: false, error, denials: [] }),
    };
    inflight.push(entry);
    return { promise, kill: () => {}, sessionId: "stub" };
  };
  return { runner, inflight, pending: () => inflight.filter((e) => !e.done) };
}

function mkOrch(over = {}) {
  const { runner, inflight } = over.stub || makeStub();
  const o = new Orchestrator({
    agents: 6, maxConc: 2, workspace: TMP, runsRoot: TMP,
    hookScript: "noop", slotHoldMs: 0, runner, ...over,
  });
  return { o, inflight };
}

const ticket = (id, extra = {}) => ({ id: String(id), key: "ATT-" + id, title: "Task " + id, kind: "backend", scope: [`routes/r${id}.js`], ...extra });
const tick = () => new Promise((r) => setTimeout(r, 5));

test("backpressure: never exceeds maxConc, and everything eventually runs", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 2 });

  for (let i = 1; i <= 6; i++) o.addTicket(ticket(i));

  assert.equal(o.activeCount(), 2, "more than maxConc dispatched immediately");
  assert.equal(o.queuedCount(), 4, "remaining tickets should be waiting");

  let maxSeen = o.activeCount();
  // Finish them one at a time; a freed slot must pull exactly one queued ticket.
  for (let done = 0; done < 6; done++) {
    const running = stub.inflight.filter((e) => !e.done);
    const next = running[0];
    next.done = true;
    next.finish();
    await tick();
    maxSeen = Math.max(maxSeen, o.activeCount());
  }
  await tick();

  assert.ok(maxSeen <= 2, `concurrency exceeded cap: ${maxSeen}`);
  assert.equal(o.completedCount, 6);
  assert.equal(o.tasks.filter((t) => t.state === "completed").length, 6);
  assert.equal(o.queuedCount(), 0);
});

test("each dispatched ticket goes to a distinct agent slot", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 3 });
  for (let i = 1; i <= 3; i++) o.addTicket(ticket(i));

  const agents = stub.inflight.map((e) => e.agentId);
  assert.equal(new Set(agents).size, 3, `agents reused: ${agents.join(",")}`);
  const assigned = o.tasks.filter((t) => t.agentId);
  assert.equal(new Set(assigned.map((t) => t.agentId)).size, 3);
});

test("higher priority tickets dispatch first", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 1 });

  o.addTicket(ticket(1, { priority: 5 }));
  o.addTicket(ticket(2, { priority: 1 }));   // most important
  o.addTicket(ticket(3, { priority: 3 }));

  assert.equal(stub.inflight.length, 1);
  assert.equal(stub.inflight[0].ticketId, "1", "first added should already be running");

  stub.inflight[0].finish(); await tick();
  assert.equal(stub.inflight[1].ticketId, "2", "priority 1 should be next, not insertion order");
  stub.inflight[1].finish(); await tick();
  assert.equal(stub.inflight[2].ticketId, "3");
});

test("a failed run is genuinely retried, then succeeds", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 2, maxRetries: 1 });
  o.addTicket(ticket(1));

  stub.inflight[0].fail("process exited 1");
  await tick();

  // A free slot exists, so the retry is picked up straight away — the task moves
  // queued → assigned within the same pump rather than sitting in the backlog.
  assert.notEqual(o.tasks[0].state, "failed", "should be retried, not failed");
  assert.equal(stub.inflight.length, 2, "retry should spawn a genuinely new run");
  assert.equal(o.tasks[0].attempts, 2, "attempt counter did not advance");
  assert.equal(o.failedCount, 0);

  stub.inflight[1].finish();
  await tick();
  assert.equal(o.tasks[0].state, "completed");
  assert.equal(o.tasks[0].attempts, 2);
  assert.equal(o.completedCount, 1);
});

test("failing past maxRetries marks the task failed and records it", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 2, maxRetries: 1 });
  o.addTicket(ticket(1));

  stub.inflight[0].fail("boom"); await tick();
  stub.inflight[1].fail("boom again"); await tick();

  assert.equal(o.tasks[0].state, "failed");
  assert.equal(o.failedCount, 1);
  assert.match(o.tasks[0].error, /boom again/);
  assert.ok(o.events.some((e) => e.kind === "err"), "failure should reach the event stream");
});

test("manual retry re-queues a failed task", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 2, maxRetries: 0 });
  o.addTicket(ticket(1));
  stub.inflight[0].fail("nope"); await tick();
  assert.equal(o.tasks[0].state, "failed");

  assert.equal(o.retry("1"), true);
  await tick();
  assert.equal(o.tasks[0].state, "assigned");
  assert.equal(o.failedCount, 0);
});

test("duplicate ticket ids are ignored", () => {
  const { o } = mkOrch({});
  assert.equal(o.addTicket(ticket(1)), true);
  assert.equal(o.addTicket(ticket(1)), false, "same id accepted twice");
  assert.equal(o.tasks.length, 1);
});

test("stopping prevents new dispatch but keeps running agents", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 2 });
  o.addTicket(ticket(1));
  assert.equal(o.activeCount(), 1);

  o.stop();
  o.addTicket(ticket(2));
  assert.equal(o.activeCount(), 1, "dispatched while stopped");
  assert.equal(o.queuedCount(), 1);

  o.start();
  await tick();
  assert.equal(o.activeCount(), 2, "did not resume on start");
});

test("getState exposes what the console renders", async () => {
  const stub = makeStub();
  const { o } = mkOrch({ stub, maxConc: 2 });
  o.addTicket(ticket(1));
  stub.inflight[0].onEvent({ kind: "init", sessionId: "abcdef12", model: "claude-sonnet-4-6" });
  stub.inflight[0].onEvent({ kind: "tool", tool: "Write", toolId: "t1", file: "/w/routes/r1.js", fileShort: "routes/r1.js", input: {} });

  const s = o.getState({ mode: "test" });
  assert.equal(s.mode, "test");
  assert.equal(s.counts.agentsActive, 1);
  assert.equal(s.counts.queued, 0);

  const a = s.agents.find((x) => x.status === "working");
  assert.ok(a, "no working agent in state");
  assert.equal(a.ticketKey, "ATT-1");
  assert.equal(a.progress.stage, "implementing");
  assert.deepEqual(a.progress.filesWritten, ["routes/r1.js"]);
  assert.ok(a.progress.percent >= 60);
  assert.ok(s.events.length > 0);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
