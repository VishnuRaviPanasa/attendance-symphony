// Normalises raw Claude Code stream-json into flat, display-ready events.
//
// The shapes here are NOT taken from documentation — they were captured from a real run of
// claude 2.1.52 on this machine. See samples/SCHEMA.md and samples/probe.jsonl.
//
// The two traps that bite anyone working from the docs:
//   * assistant/user content is nested at `.message.content`, not top level
//   * Write's payload key is `content`, not `file_text`
//   * tool_result `is_error` is frequently ABSENT — never test `!== false`

/** Commands we count as "running the tests". */
const TEST_CMD = /(^|\s|&&|\|\||;)(npm\s+(run\s+)?test|node\s+--test|npx\s+(vitest|jest|mocha)|pnpm\s+test|yarn\s+test|vitest|jest|mocha)\b/i;

export const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
export const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

export function isTestCommand(cmd) { return !!cmd && TEST_CMD.test(cmd); }

/** Shorten an absolute path to something readable on a card. */
export function shortPath(p, root) {
  if (!p) return null;
  let s = String(p).replace(/\\/g, "/");
  if (root) {
    const r = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
    if (s.toLowerCase().startsWith(r.toLowerCase() + "/")) s = s.slice(r.length + 1);
  }
  const parts = s.split("/");
  return parts.length > 3 ? parts.slice(-3).join("/") : s;
}

/**
 * Turn one raw stream-json object into zero or more normalised events.
 * Each returned event is a plain object: { kind, text, ...details }
 */
export function normalize(raw, ctx = {}) {
  const root = ctx.cwd;
  const out = [];
  if (!raw || typeof raw !== "object") return out;

  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") {
        out.push({
          kind: "init",
          sessionId: raw.session_id,
          model: raw.model,
          toolCount: (raw.tools || []).length,
          text: `session ${String(raw.session_id || "").slice(0, 8)} · model ${raw.model || "?"} · ${(raw.tools || []).length} tools`,
        });
      } else {
        out.push({ kind: "system", text: `system: ${raw.subtype || "event"}` });
      }
      break;

    case "assistant": {
      const blocks = raw.message?.content || [];
      const usage = raw.message?.usage || null;
      for (const b of blocks) {
        if (b.type === "thinking") {
          out.push({ kind: "thinking", text: firstSentence(b.thinking) });
        } else if (b.type === "text") {
          const t = (b.text || "").trim();
          if (t) out.push({ kind: "text", text: firstSentence(t), full: t });
        } else if (b.type === "tool_use") {
          out.push(toolEvent(b, root));
        }
      }
      if (usage) out.push({ kind: "usage", usage, text: null });
      break;
    }

    case "user": {
      const blocks = raw.message?.content || [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        // NOTE: is_error is often undefined — only an explicit true means failure.
        const failed = b.is_error === true;
        out.push({
          kind: "tool_result",
          toolId: b.tool_use_id,
          isError: failed,
          preview: previewOf(b.content),
          text: failed ? `tool failed: ${previewOf(b.content, 80)}` : null,
        });
      }
      break;
    }

    case "rate_limit_event": {
      const i = raw.rate_limit_info || {};
      out.push({
        kind: "rate_limit",
        status: i.status,
        rateLimitType: i.rateLimitType,
        resetsAt: i.resetsAt,
        // Only worth showing when it is NOT the happy path.
        text: i.status && i.status !== "allowed" ? `rate limit ${i.status} (${i.rateLimitType})` : null,
      });
      break;
    }

    case "result":
      out.push({
        kind: "result",
        subtype: raw.subtype,
        isError: raw.is_error === true,
        durationMs: raw.duration_ms,
        numTurns: raw.num_turns,
        costUsd: raw.total_cost_usd,
        usage: raw.usage || null,
        summary: raw.result || "",
        permissionDenials: raw.permission_denials || [],
        text: raw.is_error === true
          ? `run failed (${raw.subtype})`
          : `completed · ${raw.num_turns} turns · ${fmtDur(raw.duration_ms)} · $${(raw.total_cost_usd || 0).toFixed(3)}`,
      });
      break;

    default:
      out.push({ kind: "other", text: `${raw.type}` });
  }
  return out;
}

function toolEvent(b, root) {
  const name = b.name;
  const input = b.input || {};
  const ev = { kind: "tool", tool: name, toolId: b.id, input };

  if (WRITE_TOOLS.has(name)) {
    ev.file = input.file_path || null;             // NOT file_text — see SCHEMA.md §7
    ev.fileShort = shortPath(ev.file, root);
    ev.isWrite = true;
    ev.text = `${name === "Write" ? "writing" : "editing"} ${ev.fileShort || "file"}`;
  } else if (READ_TOOLS.has(name)) {
    ev.file = input.file_path || null;
    ev.fileShort = shortPath(ev.file, root);
    ev.isRead = true;
    ev.text = name === "Read"
      ? `reading ${ev.fileShort || "file"}`
      : `${name.toLowerCase()} ${input.pattern || ""}`.trim();
  } else if (name === "Bash") {
    ev.command = input.command || "";
    ev.isTest = isTestCommand(ev.command);
    // `description` is authored by the agent — use it verbatim rather than inventing a label.
    ev.text = input.description || `$ ${truncate(ev.command, 70)}`;
  } else if (PLAN_TOOLS.has(name)) {
    ev.isPlan = true;
    ev.todos = normalizeTodos(input);
    const done = ev.todos.filter((t) => t.status === "completed").length;
    ev.text = ev.todos.length ? `plan updated · ${done}/${ev.todos.length} done` : "plan updated";
  } else {
    ev.text = `${name}`;
  }
  return ev;
}

/** TodoWrite → [{content, status, activeForm}]; tolerant of the newer Task* shape. */
function normalizeTodos(input) {
  const list = input.todos || input.tasks || [];
  if (!Array.isArray(list)) return [];
  return list.map((t) => ({
    content: t.content || t.title || "",
    status: t.status || "pending",
    activeForm: t.activeForm || null,
  }));
}

function previewOf(content, n = 140) {
  if (content == null) return "";
  if (typeof content === "string") return truncate(content.replace(/\s+/g, " ").trim(), n);
  if (Array.isArray(content)) {
    return truncate(content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ").replace(/\s+/g, " ").trim(), n);
  }
  return "";
}

function firstSentence(s, n = 150) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^.{10,}?[.!?](\s|$)/);
  return truncate(m ? m[0].trim() : t, n);
}

function truncate(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function fmtDur(ms) { const s = Math.round((ms || 0) / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; }
