// The Symphony orchestrator.
//
// Descends from _pump() in the old lib/symphony.js — priority-sorted backlog, a fixed pool of
// agent slots, a concurrency cap for backpressure. What has changed is what a "running agent"
// means: it used to be a setInterval advancing a number, and is now a real OS process whose
// event stream drives every field on the dashboard.
//
// There is no tick(). Nothing in this file moves on a timer.

import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";

import { runAgent } from "./agent-runner.js";
import { ProgressTracker } from "./progress.js";
import { roleFor, ROLES } from "./prompts.js";

const SLOT_COLORS = ["#2dd4bf", "#60a5fa", "#c084fc", "#fbbf24", "#34d399", "#f472b6", "#38bdf8", "#a78bfa"];
const MAX_EVENTS = 400;

export class Orchestrator extends EventEmitter {
  constructor({
    agents = 6,
    maxConc = 3,
    workspace,
    runsRoot,
    hookScript,
    maxRetries = 1,
    autoStart = true,
    // Injected so tests can exercise queueing/backpressure/retry without spawning real
    // processes. Production always uses the real runner; there is no simulation mode.
    runner = runAgent,
    slotHoldMs = 4000,
  } = {}) {
    super();
    this._runner = runner;
    this._slotHoldMs = slotHoldMs;
    this.workspace = workspace;
    this.runsRoot = runsRoot;
    this.hookScript = hookScript;
    this.maxConc = maxConc;
    this.maxRetries = maxRetries;
    this.running = autoStart;

    this._newRunDir();

    this.agents = Array.from({ length: agents }, (_, i) => ({
      id: "agent-" + String(i + 1).padStart(2, "0"),
      color: SLOT_COLORS[i % SLOT_COLORS.length],
      status: "idle",           // idle | working | done | failed
      ticketId: null,
      role: null,
      tracker: null,
      handle: null,
      startedAt: null,
      finishedAt: null,
    }));

    this.tasks = [];            // queued | assigned | working | completed | failed
    this.events = [];
    this.startedAt = Date.now();
    this.completedCount = 0;
    this.failedCount = 0;
    this.totalCostUsd = 0;
  }

  /**
   * Start a fresh recording directory.
   *
   * Called on construction AND on reset. Without the reset call, every demo run of a given
   * server session appended to one transcript, so replay would have re-played several runs
   * concatenated as if they were one.
   */
  _newRunDir() {
    this.runId = "run-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      + "-" + Math.random().toString(36).slice(2, 6);
    this.runDir = path.join(this.runsRoot, this.runId);
    fs.mkdirSync(this.runDir, { recursive: true });
    return this.runId;
  }

  /* ─────────────── logging ─────────────── */

  log(kind, message, agentId = null) {
    const e = {
      ts: Date.now(),
      time: new Date().toTimeString().slice(0, 8),
      kind,                     // i | ok | w | err
      message,
      agentId,
      color: agentId ? this.agents.find((a) => a.id === agentId)?.color : null,
    };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit("event", e);
    return e;
  }

  /* ─────────────── queue ─────────────── */

  hasTicket(id) { return this.tasks.some((t) => String(t.id) === String(id)); }

  /** Add a discovered ticket to the backlog. Returns false if it is already known. */
  addTicket(ticket) {
    if (!ticket || this.hasTicket(ticket.id)) return false;
    const role = roleFor(ticket);
    const task = {
      id: String(ticket.id),
      key: ticket.key || `ATT-${ticket.id}`,
      title: ticket.title,
      kind: ticket.kind || "backend",
      roleLabel: role.label,
      priority: ticket.priority ?? 2,
      scope: ticket.scope || [],
      ticket,
      state: "queued",
      agentId: null,
      attempts: 0,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };
    this.tasks.push(task);
    this.log("i", `Task ${task.key} detected — "${task.title}"`);
    this._pump();
    return true;
  }

  setMaxConc(n) {
    const v = Math.max(1, Math.min(this.agents.length, n | 0));
    if (v === this.maxConc) return this.maxConc;
    this.maxConc = v;
    this.log("i", `max parallel agents → ${v}`);
    this._pump();
    return v;
  }

  start() { if (!this.running) { this.running = true; this.log("ok", "Symphony started"); this._pump(); } }
  stop() { if (this.running) { this.running = false; this.log("w", "Symphony stopped — running agents finish, nothing new dispatches"); } }

  activeCount() { return this.agents.filter((a) => a.status === "working").length; }
  queuedCount() { return this.tasks.filter((t) => t.state === "queued").length; }

  /* ─────────────── dispatch ─────────────── */

  _pump() {
    if (!this.running) return;

    const backlog = this.tasks
      .filter((t) => t.state === "queued")
      .sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt);

    for (const task of backlog) {
      if (this.activeCount() >= this.maxConc) {
        // Backpressure: the remaining tickets genuinely wait for a slot.
        break;
      }
      const agent = this.agents.find((a) => a.status === "idle");
      if (!agent) break;
      this._dispatch(task, agent);
    }
  }

  _dispatch(task, agent) {
    const role = ROLES[task.kind] || roleFor(task.ticket);

    task.state = "assigned";
    task.agentId = agent.id;
    task.attempts++;
    task.startedAt = Date.now();

    agent.status = "working";
    agent.ticketId = task.id;
    agent.role = role;
    agent.startedAt = Date.now();
    agent.finishedAt = null;
    agent.tracker = new ProgressTracker({ agentId: agent.id, ticketId: task.id });

    this.log("ok", `${task.key} assigned to ${agent.id} as ${role.label} · slot ${this.activeCount()}/${this.maxConc}`, agent.id);
    this._appendManifest(task, agent);
    this.emit("change");

    const handle = this._runner({
      agentId: agent.id,
      ticket: task.ticket,
      workspace: this.workspace,
      runDir: this.runDir,
      hookScript: this.hookScript,
      onEvent: (ev) => this._onAgentEvent(task, agent, ev),
      onLog: (k, m) => this.log(k, `${agent.id}: ${m}`, agent.id),
    });
    agent.handle = handle;

    handle.promise.then((res) => this._onAgentFinished(task, agent, res));
  }

  _onAgentEvent(task, agent, ev) {
    const t = agent.tracker;
    if (!t) return;
    const before = t.percent;
    t.apply(ev);

    if (task.state === "assigned" && t.stage !== "assigned") {
      task.state = "working";
      this.log("i", `${agent.id} started execution`, agent.id);
    }

    // Only surface events that carry meaning — the stream should read as a work log,
    // not as raw protocol noise.
    if (ev.kind === "init") {
      this.log("i", `${agent.id} session ${String(ev.sessionId || "").slice(0, 8)} · ${ev.model}`, agent.id);
    } else if (ev.kind === "tool" && ev.text) {
      this.log("i", `${agent.id} ${ev.text}`, agent.id);
    } else if (ev.kind === "tool_result" && ev.isError && ev.text) {
      this.log("w", `${agent.id} ${ev.text}`, agent.id);
    } else if (ev.kind === "rate_limit" && ev.text) {
      this.log("w", `${agent.id} ${ev.text}`, agent.id);
    }

    if (t.percent !== before) this.emit("change");
  }

  _onAgentFinished(task, agent, res) {
    const t = agent.tracker;
    agent.finishedAt = Date.now();
    agent.handle = null;
    this.totalCostUsd += res.resultEvent?.costUsd || 0;

    if (res.ok) {
      task.state = "completed";
      task.finishedAt = Date.now();
      task.result = {
        summary: t?.summary || "",
        files: t?.filesWritten || [],
        tests: t?.tests || [],
        costUsd: t?.costUsd || 0,
        durationMs: t?.durationMs ?? (agent.finishedAt - agent.startedAt),
      };
      agent.status = "done";
      this.completedCount++;
      this.log("ok", `${task.key} completed by ${agent.id} · ${(t?.filesWritten || []).join(", ") || "no files"} · $${(t?.costUsd || 0).toFixed(3)}`, agent.id);
      this.emit("completed", { task, agent });
    } else {
      if (t) t.fail(res.error || "agent failed");
      task.error = res.error || "agent failed";
      this.log("err", `${task.key} FAILED on ${agent.id} — ${task.error}`, agent.id);

      if (task.attempts <= this.maxRetries) {
        task.state = "queued";                 // genuinely re-run, not cosmetically retried
        task.agentId = null;
        task.retrying = true;
        this.log("w", `${task.key} will be retried (attempt ${task.attempts + 1}/${this.maxRetries + 1})`);
        agent.status = "idle";
        agent.ticketId = null;
        agent.tracker = null;
      } else {
        task.state = "failed";
        task.finishedAt = Date.now();
        agent.status = "failed";
        this.failedCount++;
        this.emit("failed", { task, agent });
      }
    }

    this.emit("change");
    // Free the slot shortly after so the completed card is visible before it is reused.
    setTimeout(() => {
      if (agent.status === "done" || agent.status === "failed") {
        agent.status = "idle";
        agent.ticketId = null;
        agent.tracker = null;
        agent.role = null;
      }
      this._pump();
      this.emit("change");
    }, this._slotHoldMs);
    this._pump();
  }

  /** Record which agent ran which ticket, so a recorded run can be replayed faithfully. */
  _appendManifest(task, agent) {
    try {
      fs.appendFileSync(
        path.join(this.runDir, "manifest.jsonl"),
        JSON.stringify({
          at: Date.now(), agentId: agent.id, attempt: task.attempts,
          id: task.id, key: task.key, title: task.title, kind: task.kind,
          scope: task.scope, priority: task.priority,
        }) + "\n"
      );
    } catch { /* the manifest is a convenience; never let it break a run */ }
  }

  /** Manually re-queue a failed task. */
  retry(taskId) {
    const task = this.tasks.find((t) => String(t.id) === String(taskId));
    if (!task || task.state !== "failed") return false;
    task.state = "queued";
    task.attempts = 0;
    task.error = null;
    task.retrying = true;
    this.failedCount = Math.max(0, this.failedCount - 1);
    this.log("i", `${task.key} re-queued manually`);
    this._pump();
    this.emit("change");
    return true;
  }

  /** Stop everything and clear state (the demo reset). */
  reset() {
    for (const a of this.agents) {
      try { a.handle?.kill(); } catch { /* already gone */ }
      Object.assign(a, { status: "idle", ticketId: null, role: null, tracker: null, handle: null, startedAt: null, finishedAt: null });
    }
    this.tasks = [];
    this.events = [];
    this.completedCount = 0;
    this.failedCount = 0;
    this.totalCostUsd = 0;
    this.startedAt = Date.now();
    this._newRunDir();
    this.log("i", `state cleared · recording to ${this.runId}`);
    this.emit("change");
  }

  /* ─────────────── state for the UI ─────────────── */

  getState(meta = {}) {
    const now = Date.now();
    return {
      ...meta,
      runId: this.runId,
      running: this.running,
      maxConc: this.maxConc,
      counts: {
        agentsActive: this.activeCount(),
        queued: this.queuedCount(),
        inProgress: this.tasks.filter((t) => t.state === "working" || t.state === "assigned").length,
        completed: this.completedCount,
        failed: this.failedCount,
        total: this.tasks.length,
      },
      costUsd: +this.totalCostUsd.toFixed(4),
      agents: this.agents.map((a) => {
        const t = a.tracker;
        const task = a.ticketId ? this.tasks.find((x) => x.id === a.ticketId) : null;
        return {
          id: a.id,
          color: a.color,
          status: a.status,
          roleLabel: a.role?.label || null,
          roleColor: a.role?.color || a.color,
          ticketKey: task?.key || null,
          ticketTitle: task?.title || null,
          startedAt: a.startedAt,
          elapsedMs: a.startedAt ? (a.finishedAt || now) - a.startedAt : 0,
          progress: t ? t.snapshot() : null,
        };
      }),
      tasks: this.tasks.map((t) => ({
        id: t.id, key: t.key, title: t.title, kind: t.kind, roleLabel: t.roleLabel,
        priority: t.priority, state: t.state, agentId: t.agentId, attempts: t.attempts,
        scope: t.scope, error: t.error, result: t.result,
        queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
      })),
      events: this.events.slice(-120),
    };
  }
}
