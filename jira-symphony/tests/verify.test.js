// The verification gate.
//
// The behaviour that matters: an agent whose process exits cleanly but whose tests FAIL must not
// be reported as completed. Before this gate existed, it was.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyTask } from "../lib/verify.js";

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-verify-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const cleanup = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

const task = (over = {}) => ({ key: "ATT-1", kind: "backend", scope: [], ticket: {}, ...over });

/* ─────────────── command verification ─────────────── */

test("a passing suite verifies", async () => {
  const dir = scratch({
    "package.json": JSON.stringify({ name: "x", type: "module", scripts: { test: 'node --test "*.test.js"' } }),
    "ok.test.js": 'import test from "node:test";\nimport a from "node:assert/strict";\ntest("t", () => a.equal(1, 1));\n',
  });
  try {
    const v = await verifyTask(task(), dir);
    assert.equal(v.ok, true, v.summary + "\n" + v.output);
    assert.equal(v.counts.fail, 0);
    assert.match(v.summary, /passed/);
  } finally { cleanup(dir); }
});

test("GATE: a FAILING suite fails the ticket, however cleanly the agent exited", async () => {
  const dir = scratch({
    "package.json": JSON.stringify({ name: "x", type: "module", scripts: { test: 'node --test "*.test.js"' } }),
    "bad.test.js": 'import test from "node:test";\nimport a from "node:assert/strict";\ntest("t", () => a.equal(1, 2));\n',
  });
  try {
    const v = await verifyTask(task(), dir);
    assert.equal(v.ok, false, "a failing suite was accepted");
    assert.ok(v.counts.fail >= 1, `expected failures, got ${JSON.stringify(v.counts)}`);
    assert.match(v.summary, /FAILED/);
  } finally { cleanup(dir); }
});

test("a missing test script fails rather than passing silently", async () => {
  const dir = scratch({ "package.json": JSON.stringify({ name: "x", type: "module" }) });
  try {
    const v = await verifyTask(task(), dir);
    assert.equal(v.ok, false);
  } finally { cleanup(dir); }
});

test("verification honours the ticket's own verify command", async () => {
  const dir = scratch({ "package.json": "{}" });
  try {
    const v = await verifyTask(task({ ticket: { verify: "node -e \"process.exit(0)\"" } }), dir);
    assert.equal(v.ok, true);
    assert.match(v.command, /process\.exit\(0\)/);
  } finally { cleanup(dir); }
});

/* ─────────────── html verification (UI tickets have no suite) ─────────────── */

const HTML = (script = "const a = 1;") =>
  `<!doctype html><html><head><title>t</title></head><body><div>hi</div><script>${script}</script></body></html>`;

test("an intact single-file app verifies", async () => {
  const dir = scratch({ "index.html": HTML() });
  try {
    const v = await verifyTask(task({ kind: "frontend", scope: ["index.html"] }), dir);
    assert.equal(v.ok, true, v.output);
  } finally { cleanup(dir); }
});

test("GATE: a syntax error in the inline script is caught", async () => {
  const dir = scratch({ "index.html": HTML("function broken( { ") });
  try {
    const v = await verifyTask(task({ kind: "frontend", scope: ["index.html"] }), dir);
    assert.equal(v.ok, false, "broken JS was accepted");
    assert.match(v.output, /syntax error/i);
  } finally { cleanup(dir); }
});

test("GATE: a truncated file is caught", async () => {
  const dir = scratch({ "index.html": "<!doctype html><html><body><script>const a=1;</script>" });
  try {
    const v = await verifyTask(task({ kind: "frontend", scope: ["index.html"] }), dir);
    assert.equal(v.ok, false, "a truncated document was accepted");
    assert.match(v.output, /truncated|closing/i);
  } finally { cleanup(dir); }
});

test("GATE: an external resource breaks the self-contained rule", async () => {
  const dir = scratch({
    "index.html": '<!doctype html><html><body><script src="https://cdn.example/x.js"></script><script>const a=1;</script></body></html>',
  });
  try {
    const v = await verifyTask(task({ kind: "frontend", scope: ["index.html"] }), dir);
    assert.equal(v.ok, false, "an external script was accepted");
    assert.match(v.output, /external/i);
  } finally { cleanup(dir); }
});

test("a missing scoped file is caught", async () => {
  const dir = scratch({ "other.txt": "x" });
  try {
    const v = await verifyTask(task({ kind: "frontend", scope: ["index.html"] }), dir);
    assert.equal(v.ok, false);
    assert.match(v.output, /missing/);
  } finally { cleanup(dir); }
});
