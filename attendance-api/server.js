// Attendance API — routes are auto-discovered.
//
// Every file in routes/ is imported and its default export is called with an express Router.
// The directory is watched, so a NEW ROUTE FILE GOES LIVE WITHOUT A RESTART. That is what lets
// several agents add endpoints in parallel without any of them editing a shared file.
//
// AGENTS: do not modify this file. Add routes/<your-feature>.js instead.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, "routes");
const PORT = +(process.env.PORT || 4400);

const app = express();
app.use(express.json());

// The attendance app is opened straight from disk (file://), whose Origin is "null", so it
// cannot call this API without permissive CORS. This is a local demo service serving seeded
// data on localhost — do not copy this policy to anything real.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// A stable middleware that delegates to whichever router is current, so reloading
// never has to touch the express app itself.
let current = express.Router();
let mounted = [];
let loadErrors = [];
app.use((req, res, next) => current(req, res, next));

async function loadRoutes() {
  const router = express.Router();
  const found = [];
  const errors = [];

  let files = [];
  try {
    files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js")).sort();
  } catch {
    fs.mkdirSync(ROUTES_DIR, { recursive: true });
  }

  for (const file of files) {
    const full = path.join(ROUTES_DIR, file);
    try {
      // cache-bust so an edited file is genuinely re-imported
      const mod = await import(pathToFileURL(full).href + "?v=" + fs.statSync(full).mtimeMs);
      if (typeof mod.default !== "function") {
        errors.push({ file, error: "no default export function register(router)" });
        continue;
      }
      // Record the paths this module registers, for /api/_routes and the console.
      const before = router.stack.length;
      mod.default(router);
      const added = router.stack.slice(before)
        .map((l) => l.route && { method: Object.keys(l.route.methods)[0].toUpperCase(), path: l.route.path })
        .filter(Boolean);
      found.push({ file, meta: mod.meta || null, endpoints: added });
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }

  current = router;
  mounted = found;
  loadErrors = errors;

  const n = found.reduce((s, f) => s + f.endpoints.length, 0);
  console.log(`[attendance-api] ${found.length} route file(s), ${n} endpoint(s)` + (errors.length ? ` · ${errors.length} failed` : ""));
  for (const e of errors) console.warn(`  ✗ ${e.file}: ${e.error}`);
  return { mounted, loadErrors };
}

// Introspection — used by the Symphony console to show what the agents actually shipped.
app.get("/api/_routes", (_req, res) => res.json({ mounted, loadErrors }));

/* ---------- serve the attendance app itself ----------
 * The app is a single self-contained file that also works opened straight from disk. Serving it
 * here gives it a real URL for demos (easier to project and refresh than file://) and puts it on
 * the same origin as this API, so it reaches the agent-built endpoints without relying on CORS.
 * `no-store` because agents rewrite this file mid-demo and a cached copy would hide their work.
 */
const APP_HTML = path.join(__dirname, "..", "index.html");
app.get(["/", "/app"], (_req, res) => {
  if (!fs.existsSync(APP_HTML)) return res.status(404).send("index.html not found next to attendance-api/");
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.sendFile(APP_HTML);
});

/* ---------- watch routes/ so new agent output goes live immediately ---------- */
let debounce = null;
function scheduleReload(why) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log(`[attendance-api] reloading routes (${why})`);
    loadRoutes().catch((e) => console.error("[attendance-api] reload failed:", e.message));
  }, 250);
}

fs.mkdirSync(ROUTES_DIR, { recursive: true });
try {
  fs.watch(ROUTES_DIR, () => scheduleReload("fs.watch"));
} catch {
  /* fs.watch is unreliable on some Windows setups — the poll below is the safety net */
}

// Editing lib/ requires a full restart, NOT a route reload. Route files are re-imported with
// a cache-busting query, but that does not invalidate their transitive imports: ESM keeps the
// first lib/store.js it loaded forever. A stale copy here once made three correct agent-written
// routes fail to mount with "does not provide an export named …", which looked like agent error
// and was not. Run under `npm start` (node --watch-path=./lib) so this restarts cleanly.
try {
  fs.watch(path.join(__dirname, "lib"), () => {
    console.warn("\n[attendance-api] lib/ changed — RESTART REQUIRED (ESM caches transitive imports).");
    console.warn("[attendance-api] routes importing new exports will fail to mount until you restart.\n");
  });
} catch { /* optional */ }

// A re-seed rewrites data/attendance.json. Reload the store in place rather than letting the
// process restart: `--watch-path=./data` turned a re-seed into a restart that raced the still
// listening server and died with EADDRINUSE.
try {
  fs.watch(path.join(__dirname, "data"), async () => {
    const { reload } = await import("./lib/store.js");
    try { reload(); console.log("[attendance-api] data changed — store reloaded"); } catch { /* mid-write */ }
  });
} catch { /* optional */ }

// Poll fallback: fs.watch misses events on Windows often enough to matter for a live demo.
let lastSig = "";
setInterval(() => {
  let sig = "";
  try {
    sig = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js")).sort()
      .map((f) => f + ":" + fs.statSync(path.join(ROUTES_DIR, f)).mtimeMs).join("|");
  } catch { return; }
  if (lastSig && sig !== lastSig) scheduleReload("poll");
  lastSig = sig;
}, 1000);

/**
 * Keep the demo data covering today.
 *
 * The dataset is generated relative to the day it is seeded, but every query asks for "today".
 * Leave it a few days and today falls off the end, the dashboard reports all 22 employees
 * unmarked, and the app looks broken when it is merely stale. That has happened three times.
 * Re-seeding is deterministic and touches nothing an agent owns, so it is safe to do on boot.
 */
async function ensureFreshData() {
  const { allDates, todayKey, reload } = await import("./lib/store.js");
  let last;
  try { last = allDates().at(-1); } catch { last = null; }
  const today = todayKey();
  if (last && today <= last) return;

  console.warn(`[attendance-api] data ends ${last ?? "never"} but today is ${today} — re-seeding`);
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.execPath, [path.join(__dirname, "scripts", "seed.js")], { stdio: "pipe" });
    reload();
    console.log(`[attendance-api] re-seeded — now covers ${allDates().at(-1)}`);
  } catch (e) {
    console.error(`[attendance-api] re-seed failed: ${e.message.split("\n")[0]}`);
    console.error(`[attendance-api] today's figures will be empty until you run: npm run seed`);
  }
}

await ensureFreshData();
await loadRoutes();
app.listen(PORT, () => {
  console.log(`\n  Attendance API  →  http://localhost:${PORT}`);
  console.log(`  routes/ is watched — drop a new file in and it goes live.\n`);
});
