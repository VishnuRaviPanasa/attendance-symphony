#!/usr/bin/env node
// Run the whole stack locally and keep it in step with merged PRs.
//
//   node scripts/serve-local.mjs
//
// Starts the attendance API and the Symphony console, then watches origin/main. When a PR is
// merged on GitHub it pulls the change and restarts only what the change actually affects:
//
//   attendance-api/routes/*   nothing — the API's own file watcher mounts new routes
//   attendance-api/lib|data/  restart the API (ESM caches transitive imports)
//   jira-symphony/*           restart the console
//   index.html / app.html     nothing — refresh the browser tab
//
// It never pulls over uncommitted work: local edits win, and it says so rather than
// silently skipping updates forever.
//
//   --every=20     seconds between checks (default 30)
//   --once         start the services, do not watch
//   --no-pull      run the services only, never touch git

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`, cy: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (msg) => console.log(`${c.dim(stamp())}  ${msg}`);

const args = process.argv.slice(2);
const intervalMs = Number(args.find((a) => a.startsWith("--every="))?.split("=")[1] ?? 30) * 1000;
const once = args.includes("--once");
const noPull = args.includes("--no-pull");

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();

/* ─────────────── services ─────────────── */

const SERVICES = [
  { name: "attendance-api", dir: "attendance-api", port: 4400, url: "http://localhost:4400/app" },
  { name: "symphony",       dir: "jira-symphony",  port: 4300, url: "http://localhost:4300" },
];

const running = new Map();   // name -> child process

function start(svc) {
  // `npm` is a shell script on Windows, so it needs a shell. cmd spawns node as a GRANDCHILD,
  // which is why stop() has to kill the whole tree rather than just this pid.
  const child = WIN
    ? spawn("cmd.exe", ["/c", "npm", "start"], { cwd: path.join(ROOT, svc.dir), windowsHide: true })
    : spawn("npm", ["start"], { cwd: path.join(ROOT, svc.dir) });

  const tag = c.cy(svc.name.padEnd(15));
  const pipe = (stream, isErr) => stream.on("data", (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      console.log(`${c.dim(stamp())}  ${tag} ${isErr ? c.r(line) : line}`);
    }
  });
  pipe(child.stdout, false);
  pipe(child.stderr, true);

  child.on("exit", (code) => {
    if (running.get(svc.name) === child) {
      log(`${tag} ${c.r(`exited (${code})`)}`);
      running.delete(svc.name);
    }
  });

  running.set(svc.name, child);
  return child;
}

function stop(svc) {
  const child = running.get(svc.name);
  if (!child) return;
  running.delete(svc.name);
  try {
    // Killing `cmd /c npm start` leaves the node grandchild holding the port. /T takes the tree.
    if (WIN) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* already gone */ }
}

async function waitHealthy(svc, timeoutMs = 25000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://localhost:${svc.port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(600);
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────── update loop ─────────────── */

/** What a set of changed paths implies for the services. */
function affected(files) {
  const out = { restart: new Set(), hot: false, browser: false };
  for (const f of files) {
    if (f.startsWith("attendance-api/routes/")) out.hot = true;
    else if (f.startsWith("attendance-api/")) out.restart.add("attendance-api");
    else if (f.startsWith("jira-symphony/")) out.restart.add("symphony");
    else if (f === "index.html" || f === "app.html") out.browser = true;
  }
  return out;
}

async function checkForUpdates() {
  try { git("fetch", "--quiet", "origin"); }
  catch (e) { log(c.y(`could not reach origin — ${e.message.split("\n")[0]}`)); return; }

  const behind = Number(git("rev-list", "--count", "HEAD..origin/main"));
  if (!behind) return;

  const incoming = git("log", "--oneline", "HEAD..origin/main").split("\n").filter(Boolean);
  log(c.b(`${behind} new commit(s) on origin/main`));
  for (const line of incoming) log(`   ${line}`);

  const dirty = git("status", "--porcelain");
  if (dirty) {
    log(c.y("uncommitted local changes — not pulling. Commit or stash to resume auto-updates."));
    for (const l of dirty.split("\n").slice(0, 5)) log(c.dim("   " + l));
    return;
  }

  const files = git("diff", "--name-only", "HEAD..origin/main").split("\n").filter(Boolean);
  git("pull", "--ff-only", "--quiet", "origin", "main");
  log(c.g(`pulled → ${git("rev-parse", "--short", "HEAD")}`));

  const eff = affected(files);
  if (eff.hot) log(`   ${c.g("no restart needed")} — the API watcher mounts new route files itself`);
  if (eff.browser) log(`   ${c.g("no restart needed")} — the app changed, refresh the browser tab`);

  for (const name of eff.restart) {
    const svc = SERVICES.find((s) => s.name === name);
    log(`   ${c.y("restarting")} ${svc.name} (its own code changed)`);
    stop(svc);
    await sleep(1200);
    start(svc);
    const ok = await waitHealthy(svc);
    log(`   ${ok ? c.g(`${svc.name} healthy on :${svc.port}`) : c.r(`${svc.name} did not come back on :${svc.port}`)}`);
  }
  if (!eff.restart.size && !eff.hot && !eff.browser) log(c.dim("   nothing that affects a running service"));
}

/* ─────────────── boot ─────────────── */

// Free the ports first: a leftover server from a previous session would win the bind and this
// supervisor would sit there supervising nothing.
for (const svc of SERVICES) {
  if (!WIN) continue;
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = [...new Set(out.split(/\r?\n/)
      .filter((l) => l.includes(`:${svc.port} `) && l.includes("LISTENING"))
      .map((l) => l.trim().split(/\s+/).pop()))];
    for (const pid of pids) {
      if (!pid || pid === "0") continue;
      log(c.dim(`freeing :${svc.port} (pid ${pid})`));
      try { execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
  } catch { /* netstat unavailable */ }
}

console.log(c.b("\n  Local deployment — services + auto-update on merge\n"));
if (!noPull) {
  try { log(`at ${c.cy(git("rev-parse", "--short", "HEAD"))} on ${c.cy(git("rev-parse", "--abbrev-ref", "HEAD"))}`); }
  catch { log(c.y("not a git repository — running without auto-update")); }
}

for (const svc of SERVICES) start(svc);
for (const svc of SERVICES) {
  const ok = await waitHealthy(svc);
  log(`${ok ? c.g("up  ") : c.r("DOWN")} ${svc.name.padEnd(15)} ${svc.url}`);
}

console.log();
log(c.b("Attendance app  ") + "http://localhost:4400/app");
log(c.b("Symphony console") + " http://localhost:4300");
console.log();

if (once || noPull) {
  log(c.dim("not watching for updates (--once/--no-pull). Ctrl-C to stop."));
} else {
  log(c.dim(`watching origin/main every ${intervalMs / 1000}s — merge a PR and it lands here automatically`));
  setInterval(() => { checkForUpdates().catch((e) => log(c.r("update check failed: " + e.message))); }, intervalMs);
}

const shutdown = () => {
  console.log();
  log("shutting down…");
  for (const svc of SERVICES) stop(svc);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
