// Symphony Operations Console — server.
//
// Replaces the old simulated engine. The SSE transport and the general shape are inherited
// from the previous server (it already worked); what changed is the source of truth: state now
// comes from real Claude Code processes via lib/orchestrator.js, not from a tick() function.
//
//   npm start          → console on http://localhost:4300
//
// Port note: 4300, not 4000. Port 4000 is occupied on this machine by an unrelated service.

import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Orchestrator } from "./lib/orchestrator.js";
import { FileTicketSource } from "./lib/sources/file-tickets.js";
import { JiraTicketSource } from "./lib/sources/jira-tickets.js";
import { resolveCli } from "./lib/agent-runner.js";
import { DEMO_TICKETS, FAILURE_TICKET } from "./demo/tickets.js";
import { triage, heuristic, targetFor } from "./lib/triage.js";
import { pruneAll } from "./lib/workspace.js";
import { pruneBranches, getRemote } from "./lib/delivery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const cfg = {
  port: +(process.env.PORT || 4300),
  workspace: process.env.WORKSPACE || path.join(REPO_ROOT, "attendance-api"),
  agents: +(process.env.AGENTS || 6),
  maxConc: +(process.env.MAX_CONCURRENT_AGENTS || 3),
  maxRetries: +(process.env.MAX_RETRIES || 1),
  apiPort: +(process.env.API_PORT || 4400),
  jira: {
    baseUrl: process.env.JIRA_BASE_URL || "",
    email: process.env.JIRA_EMAIL || "",
    token: process.env.JIRA_API_TOKEN || "",
    jql: process.env.JIRA_JQL || "assignee = currentUser() ORDER BY updated DESC",
    pollSec: +(process.env.POLL_INTERVAL_SEC || 15),
    dispatchExisting: String(process.env.DISPATCH_EXISTING_ON_START || "false") === "true",
  },
};

const TICKETS_DIR = path.join(REPO_ROOT, "tickets");
const RUNS_ROOT = path.join(__dirname, "runs");
const HOOK = path.join(__dirname, "hooks", "scope-guard.mjs");

/* ─────────────── orchestrator ─────────────── */

const orch = new Orchestrator({
  agents: cfg.agents,
  maxConc: cfg.maxConc,
  maxRetries: cfg.maxRetries,
  workspace: cfg.workspace,
  runsRoot: RUNS_ROOT,
  hookScript: HOOK,
  // One git worktree per ticket — agents cannot see or overwrite each other's edits.
  isolate: String(process.env.ISOLATE_WORKSPACES || "true") === "true",
  repoRoot: REPO_ROOT,
  // merge = integrate into the working tree · pr = leave it on a branch for review
  // both  = push a branch AND merge (auto-merge on green) · off = no branch at all
  delivery: process.env.DELIVERY_MODE || "merge",
});

const REMOTE_URL = await getRemote(REPO_ROOT);
const cliPath = resolveCli();
orch.log("i", `Symphony orchestrator online · ${cfg.agents} agent slots · max ${cfg.maxConc} parallel`);
orch.log(cliPath ? "ok" : "err",
  cliPath ? `Claude Code CLI located — agents will run for real` : `Claude Code CLI NOT FOUND — agents cannot start`);
orch.log("i", `workspace: ${cfg.workspace}`);
orch.log("i", `delivery: ${orch.delivery}` + (REMOTE_URL ? ` · remote ${REMOTE_URL}` : " · no git remote — branches stay local"));

/* ─────────────── ticket sources ─────────────── */

const fileSource = new FileTicketSource({
  dir: TICKETS_DIR,
  onTicket: (t) => orch.addTicket(t),
  onLog: (k, m) => orch.log(k, m),
}).start();

let jiraSource = null;
if (JiraTicketSource.isConfigured(cfg.jira)) {
  jiraSource = new JiraTicketSource({
    ...cfg.jira,
    onTicket: (t) => orch.addTicket(t),
    onLog: (k, m) => orch.log(k, m),
  });
  jiraSource.start().catch((e) => orch.log("w", "Jira source failed to start: " + e.message));
} else {
  orch.log("i", "Jira not configured — file tickets only (set JIRA_* in .env to enable)");
}

/* ─────────────── write-back: the tracker is the control plane, both ways ───────────────
 * Symphony treats the issue tracker as the control plane, which means reporting back to it —
 * not just reading from it. Tickets that came from Jira get a comment and a status transition
 * at the real moments. File tickets have no tracker to update and are skipped.
 */
const writeBack = String(process.env.WRITE_BACK || "true") === "true";
const STATUS_IN_PROGRESS = process.env.STATUS_IN_PROGRESS || "In Progress";
const STATUS_DONE = process.env.STATUS_DONE || "Done";

async function jiraWriteBack(task, phase, agent, extra = {}) {
  if (!writeBack || !jiraSource?.connected || task.ticket?.source !== "jira") return;
  const key = task.key;
  try {
    if (phase === "started") {
      await jiraSource.client.comment(key, `🤖 Symphony dispatched ${agent.id} (${task.roleLabel}) to this ticket. Working in an isolated workspace.`);
      const moved = await jiraSource.client.transitionTo(key, STATUS_IN_PROGRESS);
      orch.log(moved ? "ok" : "w", moved ? `${key} → ${STATUS_IN_PROGRESS} in Jira` : `${key}: commented (no "${STATUS_IN_PROGRESS}" transition available)`, agent.id);
    } else if (phase === "completed") {
      const files = (extra.files || []).join(", ") || "no files";
      await jiraSource.client.comment(key,
        `✅ ${agent.id} finished. Files: ${files}. ` +
        `Tests: ${extra.testsPassed || 0} passed. Cost: $${(extra.costUsd || 0).toFixed(3)}.`);
      const moved = await jiraSource.client.transitionTo(key, STATUS_DONE);
      orch.log(moved ? "ok" : "w", moved ? `${key} → ${STATUS_DONE} in Jira` : `${key}: commented (no "${STATUS_DONE}" transition available)`, agent.id);
    } else if (phase === "failed") {
      await jiraSource.client.comment(key, `❌ ${agent.id} failed: ${extra.error || "unknown error"}. The ticket has been left for a human.`);
      orch.log("w", `${key}: failure reported to Jira`, agent.id);
    }
  } catch (e) {
    orch.log("w", `${key}: Jira write-back failed — ${e.message}`);
  }
}

orch.on("started", ({ task, agent }) => { jiraWriteBack(task, "started", agent); });

// Move the ticket file to done/ when its task finishes, so disk and queue agree.
orch.on("completed", ({ task, agent }) => {
  jiraWriteBack(task, "completed", agent, {
    files: task.result?.files || [],
    testsPassed: (task.result?.tests || []).filter((t) => t.ok).length,
    costUsd: task.result?.costUsd || 0,
  });
  fileSource.complete(task.ticket, true);
  // A UI agent edits index.html; app.html is its generated twin and must not drift.
  if (task.postSync) {
    execFile(process.execPath, [path.join(REPO_ROOT, "scripts", "sync-app-html.js")], { cwd: REPO_ROOT }, (err, stdout) => {
      orch.log(err ? "w" : "ok",
        err ? `app.html sync failed — ${err.message.split("\n")[0]}`
            : `app.html regenerated from index.html`);
    });
  }
});
orch.on("failed", ({ task, agent }) => {
  jiraWriteBack(task, "failed", agent, { error: task.error });
  fileSource.complete(task.ticket, false);
});

/* ─────────────── express ─────────────── */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "console.html")));

function meta() {
  return {
    cliFound: !!cliPath,
    workspace: cfg.workspace,
    apiPort: cfg.apiPort,
    ticketsDir: TICKETS_DIR,
    delivery: orch.delivery,
    remote: REMOTE_URL,
    jira: jiraSource ? jiraSource.status() : { connected: false, configured: false },
    replay: replayState.active ? { active: true, runId: replayState.runId, startedAt: replayState.startedAt } : { active: false },
  };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, cliFound: !!cliPath, running: orch.running }));
app.get("/api/state", (_req, res) => res.json(orch.getState(meta())));

/* SSE — the same transport the previous console used, kept because it already worked. */
const clients = new Set();
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify(orch.getState(meta()))}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

let dirty = true;
orch.on("change", () => { dirty = true; });
orch.on("event", () => { dirty = true; });
setInterval(() => {
  if (!clients.size || !dirty) return;
  dirty = false;
  const payload = `data: ${JSON.stringify(orch.getState(meta()))}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}, 250);
// Heartbeat so proxies and idle tabs keep the stream open.
setInterval(() => { for (const c of clients) { try { c.write(": ping\n\n"); } catch { clients.delete(c); } } }, 15000);

/* ─────────────── controls ─────────────── */

app.post("/api/config", (req, res) => {
  if (req.body?.maxConc != null) orch.setMaxConc(+req.body.maxConc);
  res.json({ ok: true, maxConc: orch.maxConc });
});

app.post("/api/control", (req, res) => {
  const action = req.body?.action;
  if (action === "start") orch.start();
  else if (action === "stop") orch.stop();
  else return res.status(400).json({ ok: false, message: "action must be start or stop" });
  res.json({ ok: true, running: orch.running });
});

app.post("/api/task/:id/retry", (req, res) => {
  const ok = orch.retry(req.params.id);
  res.json({ ok });
});

/** Kill a running agent — the deterministic failure/retry demonstration. */
app.post("/api/task/:id/kill", (req, res) => {
  const ok = orch.killTask(req.params.id);
  res.json({ ok });
});

/**
 * Create demo tickets.
 *
 * This writes JSON FILES into tickets/inbox/ and returns. It does not enqueue anything and it
 * does not talk to the orchestrator — the watcher discovers them independently, exactly as it
 * would for a ticket you created by hand in a text editor. That distinction is the whole point
 * of the demo, so the endpoint deliberately keeps it.
 */
app.post("/api/demo/tickets", (req, res) => {
  // `failure: true` seeds the ticket engineered to be blocked by the scope hook, so the
  // FAILED → RETRYING → FAILED path can be demonstrated on demand.
  if (req.body?.failure) {
    const written = fileSource.seed([{ ...FAILURE_TICKET, workspace: cfg.workspace, workspaceRel: "attendance-api" }]);
    orch.log("w", `failure-demo ticket ${FAILURE_TICKET.key} written to tickets/inbox`);
    return res.json({ ok: true, written });
  }
  const n = Math.max(1, Math.min(DEMO_TICKETS.length, +(req.body?.count ?? 3)));
  const only = req.body?.ids;
  const chosen = Array.isArray(only) && only.length
    ? DEMO_TICKETS.filter((t) => only.map(String).includes(String(t.id)))
    : DEMO_TICKETS.slice(0, n);
  const written = fileSource.seed(chosen.map((t) => ({ ...t, workspace: cfg.workspace, workspaceRel: "attendance-api" })));
  orch.log("i", `${written.length} ticket file(s) written to tickets/inbox — waiting for the watcher to find them`);
  res.json({ ok: true, written });
});

/**
 * Create a ticket from a free-text description.
 *
 * The operator types what they want ("Change the UI theme to black"); Symphony decides which
 * specialist should do it and which files that specialist may write. As with the demo button,
 * this only WRITES A TICKET FILE — the watcher discovers it independently, so nothing here
 * assigns work.
 */
app.post("/api/tickets", async (req, res) => {
  const description = String(req.body?.description || "").trim();
  if (!description) return res.status(400).json({ ok: false, message: "description is required" });

  const forced = req.body?.kind;                       // operator can override the routing
  const priority = +(req.body?.priority ?? 1);

  orch.log("i", `New request received — triaging: "${truncate(description, 70)}"`);
  let t;
  try {
    // Triage runs even when the operator has picked the agent: only the ROUTING is being
    // overridden, and the model still produces a far better title, slug and acceptance
    // criteria than keyword matching. Skipping it entirely gave filenames like
    // `routes/add-an-endpoint-that-ret.js`, cut out of the raw description.
    t = await triage(description);
    if (forced && forced !== t.kind) {
      orch.log("i", `operator routed this to ${ROLE_LABEL[forced] || forced} (Symphony suggested ${ROLE_LABEL[t.kind] || t.kind})`);
      t = { ...t, kind: forced, via: "operator" };
    }
  } catch (e) {
    t = { ...heuristic(description), kind: forced || heuristic(description).kind, via: "keywords" };
    orch.log("w", `triage failed (${e.message}) — routed by keyword`);
  }

  const target = targetFor(t.kind, t.slug, REPO_ROOT, cfg.workspace);
  const id = String(nextTicketId++);
  const ticket = {
    id,
    key: `ATT-${id}`,
    title: t.title,
    kind: t.kind,
    priority,
    spec: description,
    acceptance: t.acceptance,
    scope: target.scope,
    exclusive: target.exclusive,
    workspace: target.workspace,
    workspaceRel: target.workspaceRel,
    postSync: !!target.postSync,
    verify: t.kind === "frontend" ? null : "npm test",
    triage: { via: t.via, reason: t.reason },
  };

  orch.log("ok",
    `Routed to ${ROLE_LABEL[t.kind] || t.kind} (${t.via === "llm" ? "decided by Symphony" : t.via})` +
    ` · will write ${target.scope.join(", ")}`);

  const written = fileSource.seed([ticket]);
  res.json({ ok: true, ticket: { ...ticket, spec: undefined }, written });
});

const ROLE_LABEL = { frontend: "UI Agent", backend: "Backend Agent", testing: "Test Agent", docs: "Docs Agent" };
let nextTicketId = 201;
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/** Full demo reset: stop agents, clear state, clear tickets, revert agent-written code. */
app.post("/api/demo/reset", async (req, res) => {
  orch.reset();
  fileSource.clear();
  await pruneAll(REPO_ROOT);
  const dropped = await pruneBranches(REPO_ROOT);
  if (dropped.length) orch.log("i", `removed ${dropped.length} ticket branch(es)`);
  const revert = req.body?.revertCode !== false;
  let reverted = null;
  if (revert) {
    try { reverted = await revertWorkspace(); } catch (e) { reverted = { ok: false, error: e.message }; }
  }
  orch.log("ok", "demo reset — queue cleared" + (revert ? ", agent code reverted" : ""));
  res.json({ ok: true, reverted });
});

app.get("/api/runs", (_req, res) => {
  let runs = [];
  try {
    runs = fs.readdirSync(RUNS_ROOT).filter((d) => d.startsWith("run-")).sort().reverse()
      .map((d) => {
        const dir = path.join(RUNS_ROOT, d);
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.includes("denials"));
        return { runId: d, agents: files.length, bytes: files.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) };
      })
      .filter((r) => r.agents > 0);
  } catch { /* no runs yet */ }
  res.json({ runs });
});

/* ─────────────── replay (stage safety net) ─────────────── */

const replayState = { active: false, runId: null, startedAt: null, cancel: null };

app.post("/api/replay/start", async (req, res) => {
  const runId = req.body?.runId;
  const speed = Math.max(0.25, Math.min(20, +(req.body?.speed || 2)));
  if (!runId) return res.status(400).json({ ok: false, message: "runId required" });
  const dir = path.join(RUNS_ROOT, runId);
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, message: "no such run" });

  const { startReplay } = await import("./lib/replay.js");
  orch.reset();
  replayState.active = true;
  replayState.runId = runId;
  replayState.startedAt = Date.now();
  replayState.cancel = startReplay({
    dir, orch, speed,
    onDone: () => { replayState.active = false; replayState.cancel = null; orch.log("i", `replay of ${runId} finished`); },
  });
  orch.log("w", `REPLAY MODE — replaying recorded run ${runId} at ${speed}x. This is a real transcript, not live.`);
  res.json({ ok: true, runId, speed });
});

app.post("/api/replay/stop", (_req, res) => {
  replayState.cancel?.();
  replayState.active = false;
  replayState.cancel = null;
  orch.log("i", "replay stopped");
  res.json({ ok: true });
});

/* ─────────────── helpers ─────────────── */

/** Revert agent-written code with git, so a rehearsal can be repeated cleanly. */
function revertWorkspace() {
  return new Promise((resolve) => {
    execFile("git", ["-C", REPO_ROOT, "checkout", "--", "attendance-api", "index.html", "app.html"], (err1) => {
      // -x is required: agent output is gitignored, and plain `git clean -fd` skips ignored
      // files, so a reset silently left the previous run's work in place. Tracked files
      // (routes/health.js, tests/store.test.js) are never touched by clean.
      execFile("git", ["-C", REPO_ROOT, "clean", "-fdx", "attendance-api/routes", "attendance-api/tests", "attendance-api/docs"], (err2, stdout) => {
        resolve({
          ok: !err2,
          checkout: err1 ? err1.message.split("\n")[0] : "ok",
          removed: (stdout || "").trim().split("\n").filter(Boolean),
        });
      });
    });
  });
}

app.listen(cfg.port, () => {
  console.log(`\n  Symphony Operations Console  →  http://localhost:${cfg.port}`);
  console.log(`  workspace : ${cfg.workspace}`);
  console.log(`  tickets   : ${TICKETS_DIR}\\inbox`);
  console.log(`  agents    : ${cfg.agents} slots, max ${cfg.maxConc} parallel`);
  if (!cliPath) console.log(`\n  ⚠ Claude Code CLI not found — agents cannot run.\n`);
  console.log("");
});
