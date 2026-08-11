// Server-side Symphony engine: agents + tasks state machine.
// Each Jira ticket becomes a task; the orchestrator dispatches tasks to free
// agents up to a concurrency cap (backpressure), and each agent runs through the
// Symphony phases. Lifecycle hooks (onStart/onComplete) let the server write
// back to Jira at the real moments.

const AV = ["#2dd4bf", "#60a5fa", "#c084fc", "#fbbf24", "#34d399", "#f472b6", "#38bdf8", "#a78bfa"];
export const PHASES = ["PreparingWorkspace", "BuildingPrompt", "LaunchingAgentProcess", "InitializingSession", "StreamingTurn", "Finishing"];
const PHASE_MS = [1500, 1700, 1400, 1600, 7200, 1900];
const MODS = ["checkin", "attendance", "schedule", "leave", "payroll", "report", "device", "geofence", "notify", "auth"];
const LOG = {
  PreparingWorkspace: ["cloning repo @ main", "checkout -b {BR}", "workspace ready: {WS}", "installing deps …"],
  BuildingPrompt: ["reading issue {ID}", "indexing repo · 38k LOC", "assembling context window", "system prompt composed"],
  LaunchingAgentProcess: ["spawning codex app-server (pid {PID})", "session {SID} attached", "tools: fs, shell, git, test"],
  InitializingSession: ["reconcile: claim {ID} → running", "loading repo conventions", "plan: {N} steps drafted"],
  StreamingTurn: ["edit src/{MOD}.js <span class='ac'>(+{A} -{D})</span>", "add tests/{MOD}.test.js", "run <span class='em'>pnpm test</span> …", "<span class='ok'>✓ {TP} passing</span>", "lint --fix · 0 errors", "typecheck <span class='ok'>✓ clean</span>"],
  Finishing: ["git commit -m \"feat: {ID}\"", "push origin {BR}", "open PR <span class='ac'>#{PR}</span>", "CI: build <span class='ok'>✓</span> · e2e <span class='ok'>✓</span>", "request review"],
};

const rnd = () => Math.random();
const pad = (n) => String(n).padStart(2, "0");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Symphony {
  constructor({ agents = 8, maxConc = 4, onStart, onComplete, onLog } = {}) {
    this.maxConc = maxConc;
    this.onStart = onStart || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onLog = onLog || (() => {});
    this.prSeq = 41;
    this.tokens = 0; this.prs = 0; this.feats = 0; this.completed = 0;
    this.log = [];
    this.tokWindow = [];
    this.agents = [];
    for (let i = 0; i < agents; i++) this.agents.push(this._mkAgent(i));
    this.tasks = [];
    this._t0 = Date.now();
  }

  _mkAgent(i) {
    return { id: "agent-" + pad(i + 1), color: AV[i % AV.length], status: "idle", task: null, phase: 0, pp: 0, tokens: 0, elapsed: 0, log: [], br: "", ws: "", pid: 0, sid: "", add: 0, del: 0, files: 0 };
  }
  _now() { const s = Math.floor((Date.now() - this._t0) / 1000) + 9 * 3600 + 11 * 60; const h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, ss = s % 60; return pad(h) + ":" + pad(m) + ":" + pad(ss); }
  olog(k, m) { this.log.push({ k, m, ts: this._now() }); if (this.log.length > 200) this.log.shift(); this.onLog(k, m); }
  activeCount() { return this.agents.filter((a) => a.status === "running").length; }
  hasTask(key) { return this.tasks.some((t) => t.key === key); }

  // Add a ticket to the backlog. ticket = {key,title,labels,prio,url,source}
  addTicket(ticket) {
    if (this.hasTask(ticket.key)) return false;
    const t = {
      key: ticket.key, title: ticket.title, labels: ticket.labels || ["task"], prio: ticket.prio || 2,
      url: ticket.url || "#", source: ticket.source || "jira", live: !!ticket.live,
      state: "backlog", agentId: null, tokens: 0, add: 0, del: 0, files: 0, pr: null, mod: MODS[Math.floor(rnd() * MODS.length)],
    };
    this.tasks.push(t);
    this.olog("i", `issue ${t.key} assigned → queued · "${t.title}"`);
    this._pump();
    return true;
  }

  setMaxConc(n) { this.maxConc = clamp(n | 0, 1, this.agents.length); this.olog("i", "max_concurrent_agents updated → " + this.maxConc); this._pump(); }

  // ── live tasks: driven by real Claude work (start now, hold until marked done) ──
  addLiveTask({ title, key, labels } = {}) {
    const k = key || ("TASK-" + (this._liveSeq = (this._liveSeq || 0) + 1));
    if (!this.hasTask(k)) this.addTicket({ key: k, title: title || "Live task", labels: (labels && labels.length ? labels : ["live"]), prio: 1, url: "#", source: "claude", live: true });
    return k;
  }
  noteTask(key, message) {
    const t = this.tasks.find((x) => x.key === key); if (!t) return false;
    const a = t.agentId ? this.agents.find((x) => x.id === t.agentId) : null;
    if (a) { a.log.push(String(message)); if (a.log.length > 5) a.log.shift(); }
    this.olog("i", `${key}: ${String(message).replace(/<[^>]+>/g, "")}`);
    return true;
  }
  completeLiveTask(key, opts = {}) {
    const t = this.tasks.find((x) => x.key === key && x.state !== "done");
    if (!t) return false;
    t.doneRequested = true;
    if (opts.summary) this.noteTask(key, "✓ " + opts.summary);
    const a = t.agentId ? this.agents.find((x) => x.id === t.agentId) : null;
    if (a && a.status === "running") { if (opts.pr) t.pr = opts.pr; a.phase = PHASES.length - 1; this._complete(a); }
    else if (t.state === "backlog") { t.state = "done"; this.olog("ok", `${key} completed (was queued)`); }
    return true;
  }

  _pump() {
    const bl = this.tasks.filter((t) => t.state === "backlog").sort((a, b) => a.prio - b.prio);
    for (const t of bl) {
      if (this.activeCount() >= this.maxConc) break;
      const a = this.agents.find((x) => x.status === "idle");
      if (!a) break;
      t.state = "running"; t.agentId = a.id;
      a.status = "running"; a.task = t; a.phase = 0; a.pp = 0; a.tokens = 0; a.elapsed = 0; a.log = []; a.add = 0; a.del = 0; a.files = 0;
      a.br = "sym/" + t.key.toLowerCase() + "-" + t.mod;
      a.ws = "~/.symphony/ws/" + t.key.toLowerCase() + "-" + Math.random().toString(36).slice(2, 6);
      a.pid = 2000 + Math.floor(rnd() * 7000); a.sid = Math.random().toString(36).slice(2, 10);
      this.olog("i", `dispatch ${t.key} → ${a.id} · slot ${this.activeCount()}/${this.maxConc}`);
      this._pushLog(a, 0);
      // fire lifecycle hook (Jira write-back: comment + In Progress)
      Promise.resolve(this.onStart(t, a)).catch(() => {});
    }
  }

  _pushLog(a, pi) {
    const t = a.task; const pool = LOG[PHASES[pi]];
    const ln = pool[Math.floor(rnd() * pool.length)]
      .replace("{ID}", t.key).replace("{BR}", a.br).replace("{WS}", a.ws).replace("{PID}", a.pid).replace("{SID}", a.sid)
      .replace("{N}", 3 + Math.floor(rnd() * 4)).replace("{MOD}", t.mod)
      .replace("{A}", 20 + Math.floor(rnd() * 180)).replace("{D}", Math.floor(rnd() * 40))
      .replace("{TP}", 12 + Math.floor(rnd() * 40)).replace("{PR}", t.pr || "—");
    if (a.log[a.log.length - 1] !== ln) { a.log.push(ln); if (a.log.length > 5) a.log.shift(); }
  }

  tick(dt) {
    let tokDelta = 0;
    for (const a of this.agents) {
      if (a.status !== "running") continue;
      a.elapsed += dt; a.pp += (dt / PHASE_MS[a.phase]) * 100;
      const rate = a.phase === 4 ? 46 : a.phase === 1 ? 15 : 6;
      const d = Math.floor(rate * (dt / 100) * (0.7 + rnd() * 0.6));
      a.tokens += d; a.task.tokens += d; this.tokens += d; tokDelta += d;
      if (a.phase === 4 && rnd() < 0.2) { a.files++; const ad = 8 + Math.floor(rnd() * 60), de = Math.floor(rnd() * 20); a.add += ad; a.del += de; a.task.add += ad; a.task.del += de; a.task.files++; }
      if (rnd() < 0.15) this._pushLog(a, a.phase);
      // live tasks (driven by real Claude work) hold in StreamingTurn until marked done
      if (a.task && a.task.live && !a.task.doneRequested && a.phase >= 4 && a.pp > 92) a.pp = 92;
      if (a.pp >= 100) { a.pp = 0; a.phase++; if (a.phase >= PHASES.length) this._complete(a); else this._pushLog(a, a.phase); }
    }
    this.tokWindow.push({ t: Date.now(), d: tokDelta });
    const cut = Date.now() - 2000; while (this.tokWindow.length && this.tokWindow[0].t < cut) this.tokWindow.shift();
  }

  _complete(a) {
    const t = a.task; if (t.pr == null) t.pr = this.prSeq++; this._pushLog(a, 5); t.state = "review"; this.prs++; this.completed++;
    this.olog("ok", `${t.key} PR #${t.pr} opened · CI green · ${a.tokens.toLocaleString()} tok`);
    a.status = "done"; const fa = a;
    // fire lifecycle hook (Jira write-back: comment PR + Done)
    Promise.resolve(this.onComplete(t, a)).catch(() => {});
    setTimeout(() => {
      t.state = "done";
      this.olog("ok", `merge ${t.key} · PR #${t.pr} → main · claim released`);
      this.feats++;
      fa.status = "idle"; fa.task = null; this._pump();
    }, 1000 + rnd() * 900);
  }

  tokRate() { return Math.round(this.tokWindow.reduce((s, x) => s + x.d, 0) / 2); }

  getState(meta = {}) {
    return {
      ...meta,
      maxConc: this.maxConc,
      active: this.activeCount(),
      completed: this.completed,
      tokens: this.tokens,
      tokRate: this.tokRate(),
      prs: this.prs,
      feats: this.feats,
      agents: this.agents.map((a) => ({
        id: a.id, color: a.color, status: a.status,
        taskKey: a.task ? a.task.key : null, taskTitle: a.task ? a.task.title : null, taskUrl: a.task ? a.task.url : null, taskSource: a.task ? a.task.source : null,
        phase: a.phase, pp: a.pp, tokens: a.tokens, elapsed: a.elapsed, add: a.add, del: a.del, files: a.files, ws: a.ws,
        log: a.log.slice(),
      })),
      tasks: this.tasks.map((t) => ({ key: t.key, title: t.title, labels: t.labels, prio: t.prio, state: t.state, agentId: t.agentId, pr: t.pr, url: t.url, source: t.source })),
      log: this.log.slice(-70),
      phases: PHASES,
    };
  }
}
