// Integration of an isolated worktree back into the main tree.
//
// The interesting case is two agents editing the SAME tracked file concurrently: different
// regions must both survive, overlapping regions must be reported rather than silently
// discarding somebody's work. These run against a real throwaway git repo — the line-ending
// bug that made every merge conflict only reproduces with an actual `git show`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createWorkspace, integrate, pruneAll } from "../lib/workspace.js";

function mkRepo(eol) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-wt-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  const lines = [":root{", "  --bg: #ffffff;", "  --ink: #000000;", "}", ".nav{", "  font-size: 13px;", "}", "footer{}"];
  fs.writeFileSync(path.join(dir, "app.html"), lines.join(eol) + eol);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, git };
}

const task = (over = {}) => ({ key: "ATT-1", scope: ["app.html"], workspaceRel: "", ...over });

for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`non-overlapping concurrent edits both survive (${label} working tree)`, async () => {
    const { dir } = mkRepo(eol);
    try {
      const wsA = await createWorkspace(dir, "ATT-1");
      const wsB = await createWorkspace(dir, "ATT-2");
      assert.ok(wsA && wsB, "worktrees not created");

      // Agent A recolours the palette; agent B changes the nav. Different regions.
      const fileA = path.join(wsA.dir, "app.html");
      fs.writeFileSync(fileA, fs.readFileSync(fileA, "utf8").replace("--bg: #ffffff;", "--bg: #000000;"));
      const fileB = path.join(wsB.dir, "app.html");
      fs.writeFileSync(fileB, fs.readFileSync(fileB, "utf8").replace("font-size: 13px;", "font-size: 18px;"));

      const rA = await integrate(dir, wsA.dir, task({ key: "ATT-1", baseRef: wsA.baseRef }));
      assert.deepEqual(rA.conflicts, [], "first integration conflicted");
      assert.deepEqual(rA.merged, ["app.html"]);

      const rB = await integrate(dir, wsB.dir, task({ key: "ATT-2", baseRef: wsB.baseRef }));
      assert.deepEqual(rB.conflicts, [], "second integration conflicted despite touching a different region");

      const final = fs.readFileSync(path.join(dir, "app.html"), "utf8");
      assert.match(final, /--bg: #000000;/, "agent A's change was lost");
      assert.match(final, /font-size: 18px;/, "agent B's change was lost");
      assert.ok(!/<<<<<<</.test(final), "conflict markers were written into the file");
      // the working tree keeps its own line endings
      assert.equal(/\r\n/.test(final), eol === "\r\n");

      await wsA.cleanup(); await wsB.cleanup();
    } finally { await pruneAll(dir); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("genuinely overlapping edits are reported, not silently applied", async () => {
  const { dir } = mkRepo("\r\n");
  try {
    const wsA = await createWorkspace(dir, "ATT-1");
    const wsB = await createWorkspace(dir, "ATT-2");

    // Both rewrite the SAME line differently.
    const fA = path.join(wsA.dir, "app.html");
    fs.writeFileSync(fA, fs.readFileSync(fA, "utf8").replace("--bg: #ffffff;", "--bg: #000000;"));
    const fB = path.join(wsB.dir, "app.html");
    fs.writeFileSync(fB, fs.readFileSync(fB, "utf8").replace("--bg: #ffffff;", "--bg: #112233;"));

    const rA = await integrate(dir, wsA.dir, task({ key: "ATT-1", baseRef: wsA.baseRef }));
    assert.deepEqual(rA.conflicts, []);

    const rB = await integrate(dir, wsB.dir, task({ key: "ATT-2", baseRef: wsB.baseRef }));
    assert.deepEqual(rB.conflicts, ["app.html"], "overlap was not detected");
    assert.equal(rB.ok, false);

    // A's work must still be intact and unpolluted.
    const final = fs.readFileSync(path.join(dir, "app.html"), "utf8");
    assert.match(final, /--bg: #000000;/);
    assert.ok(!/<<<<<<</.test(final), "conflict markers leaked into the working tree");

    await wsA.cleanup(); await wsB.cleanup();
  } finally { await pruneAll(dir); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("untracked agent output is copied straight in", async () => {
  const { dir } = mkRepo("\n");
  try {
    const ws = await createWorkspace(dir, "ATT-3");
    fs.mkdirSync(path.join(ws.dir, "routes"), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, "routes", "new.js"), "export default () => {};\n");

    const r = await integrate(dir, ws.dir, task({ key: "ATT-3", scope: ["routes/new.js"], baseRef: ws.baseRef }));
    assert.deepEqual(r.copied, ["routes/new.js"]);
    assert.equal(r.conflicts.length, 0);
    assert.ok(fs.existsSync(path.join(dir, "routes", "new.js")));

    await ws.cleanup();
  } finally { await pruneAll(dir); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a file the agent never created is reported missing, not copied as empty", async () => {
  const { dir } = mkRepo("\n");
  try {
    const ws = await createWorkspace(dir, "ATT-4");
    const r = await integrate(dir, ws.dir, task({ key: "ATT-4", scope: ["routes/never.js"], baseRef: ws.baseRef }));
    assert.deepEqual(r.missing, ["routes/never.js"]);
    assert.equal(r.copied.length, 0);
    await ws.cleanup();
  } finally { await pruneAll(dir); fs.rmSync(dir, { recursive: true, force: true }); }
});
