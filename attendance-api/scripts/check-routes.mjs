#!/usr/bin/env node
// Detect two route files claiming the same endpoint.
//
// Routes are auto-mounted from routes/*.js in alphabetical order, and Express answers with the
// FIRST match. So when two files register the same path, one of them silently becomes dead code
// and which one wins depends on the filename — not on anything a reviewer would think to check.
//
// This is a predictable consequence of agents adding route files independently: run a ticket
// twice, or run two tickets that overlap, and you get two implementations of one URL with
// different response shapes. It happened here — /api/leave-balance was claimed by two files
// returning { balances } and { employees } respectively.
//
//   npm run check:routes

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, "..", "routes");

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** A router stand-in that records registrations instead of serving them. */
function recordingRouter(into, file) {
  const record = (method) => (routePath) => {
    into.push({ method: method.toUpperCase(), path: routePath, file });
  };
  return { get: record("get"), post: record("post"), put: record("put"), patch: record("patch"), delete: record("delete"), use: () => {} };
}

const registered = [];
const errors = [];

const files = fs.existsSync(ROUTES_DIR)
  ? fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js")).sort()
  : [];

for (const file of files) {
  try {
    const mod = await import(pathToFileURL(path.join(ROUTES_DIR, file)).href);
    if (typeof mod.default !== "function") { errors.push(`${file}: no default export register(router)`); continue; }
    mod.default(recordingRouter(registered, file));
  } catch (e) {
    errors.push(`${file}: ${e.message}`);
  }
}

console.log(`\n${files.length} route file(s), ${registered.length} endpoint(s)\n`);

const byEndpoint = new Map();
for (const e of registered) {
  const key = `${e.method} ${e.path}`;
  byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), e.file]);
}

const duplicates = [...byEndpoint.entries()].filter(([, fs_]) => fs_.length > 1);

for (const [endpoint, owners] of byEndpoint) {
  const dup = owners.length > 1;
  console.log(`  ${dup ? r("✗") : g("✓")} ${endpoint.padEnd(34)} ${dim(owners.join(", "))}`);
  if (dup) console.log(`      ${r(`claimed ${owners.length}×  — "${owners[0]}" wins, the rest are dead code`)}`);
}

for (const e of errors) console.log(`  ${r("✗")} ${e}`);

if (duplicates.length || errors.length) {
  console.log(r(`\n${duplicates.length} duplicate endpoint(s), ${errors.length} load error(s).`));
  console.log(dim("Delete the redundant route file, or give one of them a distinct path.\n"));
  process.exitCode = 1;
} else {
  console.log(g("\nEvery endpoint is claimed exactly once.\n"));
}
