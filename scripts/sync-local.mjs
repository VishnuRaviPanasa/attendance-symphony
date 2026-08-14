#!/usr/bin/env node
// Bring the local checkout in line with merged PRs, and say what needs restarting.
//
// Merging a PR on GitHub changes origin/main. It does NOT touch this machine — nothing pulls,
// so the local app and API keep serving the old code until you fetch. That gap is easy to miss
// because the console says COMPLETED and GitHub says merged.
//
//   node scripts/sync-local.mjs           pull once and report
//   node scripts/sync-local.mjs --watch   keep polling; pull whenever main moves
//
// Never pulls over uncommitted work.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const watch = process.argv.includes("--watch");
const intervalMs = Number(process.argv.find((a) => a.startsWith("--every="))?.split("=")[1] ?? 30) * 1000;

/** What a set of changed paths implies for the processes running on this machine. */
function impact(files) {
  const needs = new Set();
  for (const f of files) {
    if (f.startsWith("attendance-api/routes/")) needs.add("routes-hot");        // watcher handles it
    else if (f.startsWith("attendance-api/")) needs.add("restart-api");
    else if (f.startsWith("jira-symphony/")) needs.add("restart-console");
    else if (f === "index.html" || f === "app.html") needs.add("refresh-browser");
  }
  return needs;
}

async function syncOnce() {
  git("fetch", "--quiet", "origin");

  const behind = Number(git("rev-list", "--count", "HEAD..origin/main"));
  if (!behind) return { pulled: false, behind: 0 };

  const incoming = git("log", "--oneline", "HEAD..origin/main").split("\n").filter(Boolean);
  console.log(`\n${bold(`${behind} new commit(s) on origin/main`)}`);
  for (const line of incoming) console.log("  " + line);

  const dirty = git("status", "--porcelain");
  if (dirty) {
    console.log(r("\nYou have uncommitted changes — not pulling over them:"));
    console.log(dirty.split("\n").map((l) => "  " + l).join("\n"));
    console.log(dim("\nCommit or stash, then run this again.\n"));
    return { pulled: false, behind, blocked: true };
  }

  const files = git("diff", "--name-only", "HEAD..origin/main").split("\n").filter(Boolean);
  git("pull", "--ff-only", "--quiet", "origin", "main");
  console.log(g(`\npulled — now at ${git("rev-parse", "--short", "HEAD")}`));

  const needs = impact(files);
  console.log(bold("\nWhat that means for what's running here"));
  if (needs.has("routes-hot")) console.log(`  ${g("automatic")}  new route files — the API watcher mounts them within a second`);
  if (needs.has("refresh-browser")) console.log(`  ${g("automatic")}  the app changed — just refresh the browser tab`);
  if (needs.has("restart-api")) console.log(`  ${y("restart")}    attendance-api (lib/ or data/ changed — ESM caches those)`);
  if (needs.has("restart-console")) console.log(`  ${y("restart")}    jira-symphony console (orchestrator code changed)`);
  if (!needs.size) console.log(dim("  nothing that affects a running process"));
  console.log();

  return { pulled: true, behind, needs };
}

if (!watch) {
  const res = await syncOnce();
  if (!res.pulled && !res.blocked) console.log(g("\nAlready up to date with origin/main.\n"));
  process.exitCode = res.blocked ? 1 : 0;
} else {
  console.log(dim(`watching origin/main every ${intervalMs / 1000}s — Ctrl-C to stop`));
  for (;;) {
    try { await syncOnce(); } catch (e) { console.log(r("sync failed: " + e.message.split("\n")[0])); }
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
}
