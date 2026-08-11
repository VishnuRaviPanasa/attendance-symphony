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

await loadRoutes();
app.listen(PORT, () => {
  console.log(`\n  Attendance API  →  http://localhost:${PORT}`);
  console.log(`  routes/ is watched — drop a new file in and it goes live.\n`);
});
