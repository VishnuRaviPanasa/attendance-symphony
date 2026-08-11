import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { JiraClient, normalizeIssue } from "./lib/jira.js";
import { Symphony } from "./lib/symphony.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const cfg = {
  port: +(process.env.PORT || 4000),
  baseUrl: process.env.JIRA_BASE_URL || "",
  email: process.env.JIRA_EMAIL || "",
  token: process.env.JIRA_API_TOKEN || "",
  jql: process.env.JIRA_JQL || "assignee = currentUser() ORDER BY updated DESC",
  pollSec: +(process.env.POLL_INTERVAL_SEC || 15),
  maxConc: +(process.env.MAX_CONCURRENT_AGENTS || 4),
  agents: +(process.env.AGENTS || 8),
  writeBack: String(process.env.WRITE_BACK || "true") === "true",
  statusInProgress: process.env.STATUS_IN_PROGRESS || "In Progress",
  statusDone: process.env.STATUS_DONE || "Done",
  dispatchExistingOnStart: String(process.env.DISPATCH_EXISTING_ON_START || "false") === "true",
  mock: String(process.env.JIRA_MOCK || "false") === "true",
  mockAuto: String(process.env.MOCK_AUTODISPATCH || "true") === "true",
};
// no credentials => fall back to mock so the dashboard still runs
if (!cfg.mock && (!cfg.baseUrl || !cfg.email || !cfg.token)) {
  console.warn("[jira-symphony] No Jira credentials found — starting in MOCK mode. Fill .env to connect for real.");
  cfg.mock = true;
}
const siteName = (() => { try { return new URL(cfg.baseUrl).host.split(".")[0]; } catch { return cfg.mock ? "mock" : "jira"; } })();

// ---------- Jira ----------
const jira = cfg.mock ? null : new JiraClient({ baseUrl: cfg.baseUrl, email: cfg.email, token: cfg.token });
const meta = { connected: false, mock: cfg.mock, liveReflect: cfg.mock && !cfg.mockAuto, site: siteName, jql: cfg.jql, me: cfg.mock ? "Demo User" : "…", writeBack: cfg.writeBack, pollSec: cfg.pollSec };

// ---------- write-back hooks ----------
async function onStart(t, a) {
  if (cfg.mock || !cfg.writeBack || t.source !== "jira" || !jira) return;
  try {
    await jira.comment(t.key, `🤖 Symphony agent ${a.id} started working on this ticket (workspace ${a.ws}). Auto-dispatched by the orchestrator.`);
    const moved = await jira.transitionTo(t.key, cfg.statusInProgress);
    sym.olog(moved ? "ok" : "w", moved ? `${t.key} → ${cfg.statusInProgress} in Jira · comment posted` : `${t.key}: comment posted (no "${cfg.statusInProgress}" transition available)`);
  } catch (e) {
    sym.olog("w", `${t.key}: write-back on start failed — ${e.message}`);
  }
}
async function onComplete(t, a) {
  if (cfg.mock || !cfg.writeBack || t.source !== "jira" || !jira) return;
  try {
    await jira.comment(t.key, `✅ Symphony agent ${a.id} finished — PR #${t.pr} opened, CI green (${a.tokens.toLocaleString()} tokens). Ready for review.`);
    const moved = await jira.transitionTo(t.key, cfg.statusDone);
    sym.olog(moved ? "ok" : "w", moved ? `${t.key} → ${cfg.statusDone} in Jira · PR #${t.pr} linked` : `${t.key}: PR comment posted (no "${cfg.statusDone}" transition available)`);
  } catch (e) {
    sym.olog("w", `${t.key}: write-back on complete failed — ${e.message}`);
  }
}

const sym = new Symphony({ agents: cfg.agents, maxConc: cfg.maxConc, onStart, onComplete });
sym.olog("i", `symphony orchestrator started · ${cfg.mock ? "MOCK mode" : "watching " + siteName + ".atlassian.net"}`);
sym.olog("i", `max_concurrent_agents = ${cfg.maxConc} · poll every ${cfg.pollSec}s`);

// ---------- Jira polling ----------
const seen = new Set();
async function pollJira(dispatchNew = true) {
  if (cfg.mock || !jira) return { count: 0 };
  const issues = await jira.search(cfg.jql);
  let dispatched = 0;
  for (const raw of issues) {
    const t = normalizeIssue(raw, cfg.baseUrl);
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    if (dispatchNew) { if (sym.addTicket({ ...t, source: "jira" })) dispatched++; }
  }
  return { count: issues.length, dispatched };
}

async function startJira() {
  try {
    const me = await jira.myself();
    meta.connected = true;
    meta.me = me.displayName || me.emailAddress || "you";
    sym.olog("ok", `connected to Jira as ${meta.me} · JQL: ${cfg.jql}`);
    // seed "seen" with existing so we only react to NEW assignments (unless configured)
    const first = await pollJira(cfg.dispatchExistingOnStart);
    sym.olog("i", `initial poll: ${first.count} ticket(s) assigned to you${cfg.dispatchExistingOnStart ? ` · dispatched ${first.dispatched}` : " · watching for new ones"}`);
    setInterval(() => { pollJira(true).catch((e) => sym.olog("w", "poll failed — " + e.message)); }, cfg.pollSec * 1000);
  } catch (e) {
    meta.connected = false;
    sym.olog("w", "Jira connection failed — " + e.message);
    console.error("[jira-symphony] Jira connection failed:", e.message);
  }
}

// ---------- mock generator ----------
const MOCK_TITLES = [
  "Add biometric device check-in", "Build shift-scheduling module", "Leave approval workflow",
  "Geo-fenced remote check-in", "Overtime & payroll export", "Slack absence alerts",
  "Face-recognition kiosk mode", "Timesheet approvals for managers", "Bulk import employees (CSV)",
];
let mockN = 6;
function startMock() {
  meta.connected = true;
  if (!cfg.mockAuto) { sym.olog("i", "live-reflect mode · board waits for tasks Claude pushes via /api/task"); return; }
  const fire = () => {
    const key = "KAN-" + mockN++;
    const title = MOCK_TITLES[Math.floor(Math.random() * MOCK_TITLES.length)];
    sym.addTicket({ key, title, labels: ["backend", "feature"], prio: 1 + Math.floor(Math.random() * 3), url: "#" + key, source: "mock" });
  };
  fire(); setTimeout(fire, 1200); setTimeout(fire, 2600);
  setInterval(fire, 9000);
}

// ---------- engine tick ----------
let last = Date.now();
setInterval(() => { const now = Date.now(); let dt = now - last; last = now; if (dt > 500) dt = 500; sym.tick(dt); }, 150);

// ---------- express + SSE ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/api/health", (_req, res) => res.json({ ok: true, mock: cfg.mock, connected: meta.connected }));
app.get("/api/state", (_req, res) => res.json(sym.getState(meta)));

app.get("/api/jira/test", async (_req, res) => {
  if (cfg.mock || !jira) return res.json({ ok: false, mock: true, message: "Running in mock mode (no credentials)." });
  try { const me = await jira.myself(); res.json({ ok: true, me: me.displayName, account: me.accountId }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post("/api/config", (req, res) => { if (req.body && req.body.maxConc != null) sym.setMaxConc(+req.body.maxConc); res.json({ ok: true, maxConc: sym.maxConc }); });

app.post("/api/dispatch", (req, res) => {
  const b = req.body || {};
  const key = b.key || ("SIM-" + (100 + Math.floor(Math.random() * 900)));
  const title = b.title || "Manual test task";
  const ok = sym.addTicket({ key, title, labels: ["manual"], prio: 2, url: "#", source: "manual" });
  res.json({ ok, key });
});

// ── live-reflect: Claude pushes the REAL task it is working on ──
app.post("/api/task", (req, res) => { const b = req.body || {}; const key = sym.addLiveTask({ title: b.title, key: b.key, labels: b.labels }); res.json({ ok: true, key }); });
app.post("/api/task/:key/note", (req, res) => { const ok = sym.noteTask(req.params.key, (req.body && req.body.message) || "…"); res.json({ ok }); });
app.post("/api/task/:key/done", (req, res) => { const ok = sym.completeLiveTask(req.params.key, req.body || {}); res.json({ ok }); });

app.post("/api/sync", async (_req, res) => {
  if (cfg.mock) return res.json({ ok: true, mock: true, dispatched: 0 });
  try { const r = await pollJira(true); sym.olog("i", `manual sync · ${r.dispatched} new ticket(s) dispatched`); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// SSE live stream
const clients = new Set();
app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify(sym.getState(meta))}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
setInterval(() => {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(sym.getState(meta))}\n\n`;
  for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
}, 300);

app.listen(cfg.port, () => {
  console.log(`\n  Jira · Symphony running →  http://localhost:${cfg.port}`);
  console.log(`  mode: ${cfg.mock ? "MOCK (no credentials)" : "LIVE (" + siteName + ".atlassian.net)"}\n`);
  if (cfg.mock) startMock(); else startJira();
});
