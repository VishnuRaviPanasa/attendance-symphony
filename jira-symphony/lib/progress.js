// Derives an agent's live progress from its REAL event stream.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
//   progress moves only when an event arrives. Never on a timer, never on an interval,
//   never interpolated. If an agent thinks for 40 seconds the bar does not move — that is
//   correct, and it is the difference between this and the simulation it replaces.
//
// There is deliberately no reference to Date.now() / performance.now() anywhere in the
// percentage path. tests/progress.test.js asserts that mechanically.

import { READ_TOOLS, WRITE_TOOLS, PLAN_TOOLS } from "./events.js";

/**
 * Ordered lifecycle. Index = ordinal, used to keep the stage monotonic.
 *
 * Planning sits BEFORE analyzing because that is the order real agents actually work in:
 * in both the captured probe run and the first live ticket, the agent wrote its TodoWrite
 * plan first and only then started reading files. An idealised analyze→plan order made the
 * card sit on "Planning" while the agent was visibly reading.
 */
export const STAGES = [
  "queued", "assigned", "initializing", "planning",
  "analyzing", "implementing", "testing", "reviewing", "completed",
];

/** Floor percentage for each stage. Reaching a stage is itself evidence of progress. */
export const FLOOR = {
  queued: 0, assigned: 5, initializing: 10, planning: 20,
  analyzing: 35, implementing: 60, testing: 85, reviewing: 95, completed: 100,
};

const ORD = Object.fromEntries(STAGES.map((s, i) => [s, i]));

/** Tool results produced by the scope hook refusing a call, not by the work failing. */
const BLOCKED_BY_POLICY = /^(Bash|Write|Edit) blocked:/i;
const LABEL = {
  queued: "Queued", assigned: "Assigned", initializing: "Initializing",
  analyzing: "Analyzing", planning: "Planning", implementing: "Implementing",
  testing: "Testing", reviewing: "Reviewing", completed: "Completed", failed: "Failed",
};

/** Percentage credited per real tool call inside a stage. */
const PER_TOOL = 2;
/** Nothing may reach 100 except a real `result` event. */
const CEILING_BEFORE_RESULT = 99;

export function stageLabel(s) { return LABEL[s] || s; }

export class ProgressTracker {
  constructor({ agentId, ticketId } = {}) {
    this.agentId = agentId;
    this.ticketId = ticketId;

    this.stage = "assigned";
    this.percent = FLOOR.assigned;
    this.failed = false;

    this.activity = "Waiting for the agent process to start";
    this.lastEvent = null;

    this.toolCalls = 0;
    this._toolCallsInStage = 0;
    this._pendingTools = new Map();   // tool_use_id -> descriptor

    this.todos = [];
    this.filesWritten = [];
    this.filesRead = [];
    this.tests = [];
    this.denials = [];
    this.errors = [];

    this.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    this.costUsd = 0;
    this.sessionId = null;
    this.model = null;
    this.numTurns = 0;
    this.durationMs = null;
    this.rateLimit = null;
    this.summary = "";

    // `whyPercent` records the event that last moved the bar — surfaced in the UI so a
    // sceptical viewer can trace any number on screen back to a real event.
    this.whyPercent = "not started";
  }

  /** Apply one normalised event (from events.js normalize()). */
  apply(ev) {
    if (!ev) return this;
    if (ev.text) this.lastEvent = ev.text;

    switch (ev.kind) {
      case "init":
        this.sessionId = ev.sessionId || null;
        this.model = ev.model || null;
        this._enter("initializing", "agent process reported session init");
        this.activity = "Starting up";
        break;

      case "tool":
        this.toolCalls++;
        this._applyTool(ev);
        break;

      case "tool_result":
        this._applyToolResult(ev);
        break;

      case "usage":
        this._addUsage(ev.usage);
        break;

      case "text":
        if (ev.text) this.activity = ev.text;
        break;

      case "thinking":
        // Thinking is real work but produces no artefact — show it, do not credit it.
        if (ev.text) this.activity = ev.text;
        break;

      case "rate_limit":
        this.rateLimit = { status: ev.status, type: ev.rateLimitType, resetsAt: ev.resetsAt };
        break;

      case "result":
        this._applyResult(ev);
        break;
    }
    return this;
  }

  _applyTool(ev) {
    const t = ev.tool;
    if (ev.toolId) this._pendingTools.set(ev.toolId, ev);

    if (WRITE_TOOLS.has(t)) {
      this._enter("implementing", `${t} on ${ev.fileShort || ev.file || "a file"}`);
      // store the workspace-relative form — an absolute Windows path is unreadable on a card
      const f = ev.fileShort || ev.file;
      if (f && !this.filesWritten.includes(f)) this.filesWritten.push(f);
    } else if (t === "Bash" && ev.isTest) {
      this._enter("testing", `test command: ${ev.command?.slice(0, 60)}`);
    } else if (PLAN_TOOLS.has(t)) {
      this._enter("planning", "agent wrote a plan");
      if (Array.isArray(ev.todos) && ev.todos.length) this.todos = ev.todos;
    } else if (READ_TOOLS.has(t)) {
      this._enter("analyzing", `${t} ${ev.file || ev.input?.pattern || ""}`.trim());
      if (ev.file && !this.filesRead.includes(ev.file)) this.filesRead.push(ev.file);
    }

    this._toolCallsInStage++;
    this._recompute(`tool call: ${t}`);
    this.activity = this._deriveActivity(ev);
  }

  _applyToolResult(ev) {
    const src = ev.toolId ? this._pendingTools.get(ev.toolId) : null;
    const blocked = BLOCKED_BY_POLICY.test(ev.preview || "");

    if (blocked) {
      // The scope hook refused the call. That is containment working as designed, not a
      // failing test — recording it as one made a healthy run show "1 test failed".
      this.denials.push({ reason: ev.preview });
    } else if (src?.isTest) {
      this.tests.push({ command: src.command, ok: !ev.isError, preview: ev.preview || "" });
    } else if (ev.isError) {
      this.errors.push(ev.preview || "tool error");
    }
    if (ev.toolId) this._pendingTools.delete(ev.toolId);
  }

  _applyResult(ev) {
    this.numTurns = ev.numTurns ?? this.numTurns;
    this.durationMs = ev.durationMs ?? this.durationMs;
    this.costUsd = ev.costUsd ?? this.costUsd;
    this.summary = ev.summary || "";
    this.denials = ev.permissionDenials || [];
    if (ev.usage) this._addUsage(ev.usage, true);

    if (ev.isError) {
      this.fail(`run ended with ${ev.subtype || "error"}`);
    } else {
      this.stage = "completed";
      this.percent = 100;                 // the ONLY path to 100
      this.whyPercent = "result event: success";
      this.activity = ev.summary ? truncate(ev.summary, 120) : "Task completed";
    }
  }

  /** Mark the run failed. Progress freezes where it was — it is not reset or inflated. */
  fail(reason) {
    this.failed = true;
    this.stage = "failed";
    this.activity = reason || "Failed";
    this.whyPercent = `frozen at failure: ${reason || "error"}`;
    this.errors.push(reason || "failed");
    return this;
  }

  /** Reset for a retry. The new attempt genuinely starts over. */
  resetForRetry() {
    const keep = { agentId: this.agentId, ticketId: this.ticketId };
    Object.assign(this, new ProgressTracker(keep));
    this.activity = "Retrying after failure";
    return this;
  }

  _enter(stage, why) {
    if (this.failed) return;
    if ((ORD[stage] ?? -1) > (ORD[this.stage] ?? -1)) {
      this.stage = stage;
      this._toolCallsInStage = 0;
      this.whyPercent = why || `entered ${stage}`;
    }
  }

  _recompute(why) {
    if (this.failed || this.stage === "completed") return;

    const floor = FLOOR[this.stage] ?? 0;
    const nextIdx = (ORD[this.stage] ?? 0) + 1;
    const nextFloor = FLOOR[STAGES[nextIdx]] ?? 100;

    // within-stage credit: strictly one increment per real tool call
    const withinStage = Math.min(nextFloor - 1, floor + PER_TOOL * this._toolCallsInStage);

    // preferred signal: the agent's own todo list
    let candidate = Math.max(floor, withinStage);
    const total = this.todos.length;
    if (total > 0) {
      const done = this.todos.filter((t) => t.status === "completed").length;
      const todoPct = 10 + 85 * (done / total);
      if (todoPct > candidate) {
        candidate = todoPct;
        why = `todo list: ${done}/${total} complete`;
      }
    }

    const next = Math.min(CEILING_BEFORE_RESULT, Math.round(candidate));
    if (next > this.percent) {           // monotonic — never goes backwards
      this.percent = next;
      this.whyPercent = why;
    }
  }

  _deriveActivity(ev) {
    // 1. what the agent itself says it is doing right now
    const active = this.todos.find((t) => t.status === "in_progress");
    if (active?.activeForm) return active.activeForm;
    // 2. the agent's own description of the command it ran
    if (ev.tool === "Bash" && ev.input?.description) return ev.input.description;
    // 3. the tool call, humanised
    if (ev.text) return capitalise(ev.text);
    return stageLabel(this.stage);
  }

  _addUsage(u, isFinal = false) {
    if (!u) return;
    // The final result carries run TOTALS; per-message usage is incremental.
    if (isFinal) {
      this.tokens = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
      };
      return;
    }
    this.tokens.input += u.input_tokens || 0;
    this.tokens.output += u.output_tokens || 0;
    this.tokens.cacheRead += u.cache_read_input_tokens || 0;
    this.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
  }

  get totalTokens() {
    const t = this.tokens;
    return t.input + t.output + t.cacheRead + t.cacheCreate;
  }

  /** Plain object for the SSE snapshot. */
  snapshot() {
    const done = this.todos.filter((t) => t.status === "completed").length;
    return {
      stage: this.stage,
      stageLabel: stageLabel(this.stage),
      percent: this.percent,
      failed: this.failed,
      activity: this.activity,
      lastEvent: this.lastEvent,
      whyPercent: this.whyPercent,
      toolCalls: this.toolCalls,
      todos: this.todos,
      todosDone: done,
      todosTotal: this.todos.length,
      filesWritten: this.filesWritten,
      filesRead: this.filesRead.length,
      tests: this.tests,
      testsPassed: this.tests.filter((t) => t.ok).length,
      testsFailed: this.tests.filter((t) => !t.ok).length,
      tokens: this.totalTokens,
      tokenBreakdown: this.tokens,
      costUsd: +(this.costUsd || 0).toFixed(4),
      sessionId: this.sessionId,
      model: this.model,
      numTurns: this.numTurns,
      durationMs: this.durationMs,
      rateLimit: this.rateLimit,
      denials: this.denials,
      errors: this.errors.slice(-3),
      summary: this.summary,
    };
  }
}

function truncate(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function capitalise(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; }
