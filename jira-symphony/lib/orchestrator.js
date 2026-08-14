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
import { execFile } from "node:child_process";

import { runAgent } from "./agent-runner.js";
import { ProgressTracker } from "./progress.js";
import { roleFor, ROLES } from "./prompts.js";
import { createWorkspace, integrate } from "./workspace.js";
import { verifyTask } from "./verify.js";
import { deliver } from "./delivery.js";

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
    // Isolated worktree per ticket. Off in tests, where the stub runner never touches disk.
    isolate = false,
    repoRoot = null,
    // off | merge | pr | both — what happens to verified work.
    //   merge = integrate into the working tree (fast demo payoff)
    //   pr    = branch pushed for review, working tree untouched (true Symphony)
    //   both  = PR opened AND merged locally, i.e. auto-merge on green
    delivery = "merge",
  } = {}) {
    super();
    this._runner = runner;
    this._slotHoldMs = slotHoldMs;
    this.isolate = isolate;
    this.repoRoot = repoRoot;
    this.delivery = delivery;
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
      // Files this task must hold alone. index.html is shared by every UI ticket, so two of
      // them running at once would overwrite each other's edits.
      exclusive: ticket.exclusive || [],
      workspace: ticket.workspace || this.workspace,
      workspaceRel: ticket.workspaceRel || "",
      postSync: !!ticket.postSync,
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

      // A task whose exclusive files are already held waits, even though a slot is free.
      const blockedBy = this._heldBy(task);
      if (blockedBy) {
        if (!task.waitingFor) {
          task.waitingFor = blockedBy.key;
          this.log("i", `${task.key} waits for ${blockedBy.key} — both need ${task.exclusive.join(", ")}`);
          this.emit("change");
        }
        continue;                    // try the next ticket rather than stalling the queue
      }
      task.waitingFor = null;
      // agent slot is claimed synchronously inside _dispatch before its first await
      this._dispatch(task, agent).catch((e) => this.log("err", `dispatch failed: ${e.message}`));
    }
  }

  /**
   * The running task holding any file this one needs exclusively, if any.
   *
   * Only relevant WITHOUT sandboxes. With a worktree per ticket two agents can edit the same
   * file concurrently and have both edits three-way merged on the way back in, so the lock
   * would serialise work for no reason.
   */
  _heldBy(task) {
    if (this.isolate) return null;
    if (!task.exclusive?.length) return null;
    const want = new Set(task.exclusive.map((f) => f.toLowerCase()));
    return this.tasks.find((t) =>
      t !== task &&
      (t.state === "assigned" || t.state === "working") &&
      (t.exclusive || []).some((f) => want.has(String(f).toLowerCase()))
    ) || null;
  }

  async _dispatch(task, agent) {
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
    this.emit("started", { task, agent });
    this.emit("change");

    // Isolated workspace per ticket. The agent works on its own checkout, so it cannot see or
    // overwrite another agent's edits even when both target the same file.
    let workspace = task.workspace || this.workspace;
    if (this.isolate && this.repoRoot) {
      const ws = await createWorkspace(this.repoRoot, task.key, (k, m) => this.log(k, m, agent.id));
      if (ws) {
        task.worktree = ws;
        task.baseRef = ws.baseRef;
        // Re-root the ticket's workspace inside the sandbox.
        workspace = task.workspaceRel ? path.join(ws.dir, task.workspaceRel) : ws.dir;
        this.log("i", `${agent.id} sandbox ready · ${path.join(".worktrees", task.key)}`, agent.id);
      } else {
        this.log("w", `${task.key}: no sandbox — falling back to the shared working tree`, agent.id);
      }
    }
    task.effectiveWorkspace = workspace;

    const handle = this._runner({
      agentId: agent.id,
      ticket: task.ticket,
      workspace,
      runDir: this.runDir,
      hookScript: this.hookScript,
      onEvent: (ev) => this._onAgentEvent(task, agent, ev),
      onLog: (k, m) => this.log(k, `${agent.id}: ${m}`, agent.id),
    });
    agent.handle = handle;

    handle.promise.then((res) => this._onAgentFinished(task, agent, res).catch((e) => this.log("err", `finish handler failed: ${e.message}`)));
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

  async _onAgentFinished(task, agent, res) {
    const t = agent.tracker;
    agent.finishedAt = Date.now();
    agent.handle = null;
    this.totalCostUsd += res.resultEvent?.costUsd || 0;

    // ── VERIFY ────────────────────────────────────────────────────────────────────────────
    // Everything above this point is the agent's account of its own work. Run the suite in its
    // worktree before believing any of it: an agent that ships a failing test must not show
    // COMPLETED. Red here fails the ticket and the normal retry path takes over.
    if (res.ok && task.worktree) {
      const wsDir = task.workspaceRel ? path.join(task.worktree.dir, task.workspaceRel) : task.worktree.dir;
      try {
        const v = await verifyTask(task, wsDir, { onLog: (k, m) => this.log(k, m, agent.id) });
        task.verification = v;
        if (v.ok) {
          this.log("ok", `${task.key} verified · ${v.summary}`, agent.id);
        } else {
          this.log("err", `${task.key} FAILED VERIFICATION · ${v.summary}`, agent.id);
          if (v.output) for (const line of v.output.split("\n").slice(-4)) this.log("w", `  ${line}`, agent.id);
          res = { ...res, ok: false, error: `verification failed: ${v.summary}` };
        }
      } catch (e) {
        task.verification = { ok: false, summary: e.message };
        res = { ...res, ok: false, error: `verification errored: ${e.message}` };
      }
    }

    // ── DELIVER ───────────────────────────────────────────────────────────────────────────
    // Verified work becomes a named branch and a commit — a reviewable artefact per ticket,
    // pushed and turned into a PR link when a remote is configured.
    if (res.ok && task.worktree && this.delivery !== "off") {
      try {
        // Regenerate derived files IN THE WORKTREE before committing. app.html is produced from
        // index.html and has no build step, so a UI ticket that only commits index.html leaves
        // the branch internally inconsistent — CI caught exactly that on ATT-206.
        const extraPaths = [];
        if (task.postSync) {
          const synced = await this._syncDerived(task.worktree.dir, agent.id);
          extraPaths.push(...synced);
        }

        const d = await deliver({
          repoRoot: this.repoRoot,
          worktreeDir: task.worktree.dir,
          task,
          push: this.delivery === "pr" || this.delivery === "both",
          extraPaths,
          onLog: (k, m) => this.log(k, m, agent.id),
        });
        task.delivery = d;
        if (!d.ok && d.reason) this.log("w", `${task.key}: ${d.reason}`, agent.id);
      } catch (e) {
        this.log("w", `${task.key}: delivery failed — ${e.message}`, agent.id);
      }
    }

    // ── INTEGRATE ─────────────────────────────────────────────────────────────────────────
    // Bring the sandbox's work into the real tree before declaring success. A merge conflict
    // means another agent already changed the same lines — that is a genuine failure of this
    // ticket, not something to paper over by overwriting their work.
    //
    // Skipped in "pr" mode: there, the branch IS the deliverable and a human merges it.
    if (res.ok && task.worktree && this.delivery === "pr") {
      this.log("i", `${task.key}: left on ${task.delivery?.branch} for review — working tree untouched`, agent.id);
    } else if (res.ok && task.worktree) {
      try {
        const r = await integrate(this.repoRoot, task.worktree.dir, task, (k, m) => this.log(k, m, agent.id));
        task.integration = r;
        if (r.conflicts.length) {
          res = { ...res, ok: false, error: `merge conflict in ${r.conflicts.join(", ")}` };
        } else {
          const parts = [];
          if (r.merged.length) parts.push(`merged ${r.merged.join(", ")}`);
          if (r.copied.length) parts.push(`applied ${r.copied.join(", ")}`);
          if (parts.length) this.log("ok", `${task.key}: ${parts.join(" · ")}`, agent.id);
        }
      } catch (e) {
        res = { ...res, ok: false, error: `integration failed: ${e.message}` };
      }
    }
    if (task.worktree) {
      try { await task.worktree.cleanup(); } catch { /* pruned later */ }
      task.worktree = null;
    }

    if (res.ok) {
      task.state = "completed";
      task.finishedAt = Date.now();
      task.result = {
        summary: t?.summary || "",
        verified: task.verification?.ok ?? null,
        verifySummary: task.verification?.summary || null,
        branch: task.delivery?.branch || null,
        prUrl: task.delivery?.prUrl || null,
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

  /**
   * Run the repo's derived-file generator inside a worktree.
   * @returns {Promise<string[]>} repo-relative paths it produced, to add to the commit
   */
  _syncDerived(worktreeDir, agentId) {
    return new Promise((resolve) => {
      const script = path.join(worktreeDir, "scripts", "sync-app-html.js");
      if (!fs.existsSync(script)) return resolve([]);
      execFile(process.execPath, [script], { cwd: worktreeDir }, (err, stdout) => {
        if (err) {
          this.log("w", `could not regenerate app.html in the sandbox — ${err.message.split("\n")[0]}`, agentId);
          return resolve([]);
        }
        const wrote = String(stdout).split("\n").filter((l) => l.startsWith("wrote ")).map((l) => l.split(/\s+/)[1]);
        if (wrote.length) this.log("ok", `regenerated ${wrote.join(", ")} in the sandbox`, agentId);
        resolve(wrote);
      });
    });
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

  /**
   * Kill the process running a task.
   *
   * This is the deterministic way to demonstrate failure handling. The scope hook is good at
   * containment but a blocked agent usually recovers and still succeeds, so it cannot be relied
   * on to produce a FAILED card on cue. Killing the child is a genuine failure: the process
   * exits with no `result` event, the runner reports it, and the normal retry path takes over.
   * Nothing about the failure is simulated.
   */
  killTask(taskId) {
    const task = this.tasks.find((t) => String(t.id) === String(taskId));
    if (!task || !task.agentId) return false;
    const agent = this.agents.find((a) => a.id === task.agentId);
    if (!agent?.handle) return false;
    this.log("w", `${task.key}: killing ${agent.id} (operator request)`, agent.id);
    agent.handle.kill();
    return true;
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
        scope: t.scope, error: t.error, result: t.result, integration: t.integration || null,
        verification: t.verification || null, delivery: t.delivery || null,
        exclusive: t.exclusive, waitingFor: t.waitingFor || null, workspace: t.workspace,
        queuedAt: t.queuedAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
      })),
      events: this.events.slice(-120),
    };
  }
}
