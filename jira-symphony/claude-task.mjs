#!/usr/bin/env node
// Drive the live-reflect dashboard from the command line.
// Claude (or you) calls these while a real task is being worked on.
//
//   node claude-task.mjs start "Add a leave-balance widget"     -> prints the task KEY
//   node claude-task.mjs note  TASK-1 "editing app.html (+42 -6)"
//   node claude-task.mjs done  TASK-1 "shipped + republished"
//
// Server URL defaults to http://localhost:4000 (override with SYM_URL).

const BASE = process.env.SYM_URL || "http://localhost:4000";
const [, , cmd, a1, a2] = process.argv;

async function call(path, body) {
  try {
    const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) {
    console.error(`(dashboard not reachable at ${BASE} — is the server running? skipping)`);
    return null;
  }
}

(async () => {
  if (cmd === "start") {
    const r = await call("/api/task", { title: a1 || "Live task" });
    if (r && r.key) console.log(r.key);
  } else if (cmd === "note") {
    await call(`/api/task/${encodeURIComponent(a1)}/note`, { message: a2 || "…" });
  } else if (cmd === "done") {
    await call(`/api/task/${encodeURIComponent(a1)}/done`, { summary: a2 || "completed" });
  } else {
    console.log('Usage:\n  node claude-task.mjs start "<title>"\n  node claude-task.mjs note <KEY> "<message>"\n  node claude-task.mjs done <KEY> "<summary>"');
  }
})();
