// Isolated workspace per ticket — the property the Symphony write-up singles out as what
// makes it orchestration ("each ticket runs in its own sandboxed directory").
//
// Each ticket gets a real `git worktree` checked out from HEAD. The agent cannot see, read or
// clobber another agent's edits, because it is working on its own copy of the repository.
//
// Integrating the work back is the interesting half. Two agents may legitimately edit the same
// tracked file (two UI tickets both touching index.html), so we do a proper three-way merge per
// file with `git merge-file`, using HEAD as the base:
//
//     base   = the file at HEAD (what both agents started from)
//     ours   = the main working tree (may already contain another agent's merged work)
//     theirs = this agent's worktree
//
// Edits to different parts of the file merge cleanly; genuine overlaps are reported as
// conflicts and fail the ticket rather than silently discarding someone's work. That is the
// same model Symphony gets from branch-per-ticket + pull request, minus the review step.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const WORKTREES = ".worktrees";

function git(repoRoot, args, opts = {}) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, ...args], { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || "", stderr: stderr || (err?.message ?? "") });
    });
  });
}

/** Directories that must exist inside a worktree but are not tracked (deps, seeded data). */
const LINK_DIRS = ["attendance-api/node_modules", "jira-symphony/node_modules"];

/**
 * Create an isolated checkout for a ticket.
 * @returns {Promise<{dir:string, baseRef:string, cleanup:()=>Promise<void>}|null>}
 */
export async function createWorkspace(repoRoot, taskKey, onLog = () => {}) {
  const root = path.join(repoRoot, WORKTREES);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, safeName(taskKey));

  // A stale worktree from a killed run would block the add.
  if (fs.existsSync(dir)) await git(repoRoot, ["worktree", "remove", "--force", dir]);

  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) { onLog("w", `worktree: cannot resolve HEAD — ${head.stderr.trim()}`); return null; }
  const baseRef = head.stdout.trim();

  const add = await git(repoRoot, ["worktree", "add", "--detach", dir, baseRef]);
  if (!add.ok) { onLog("w", `worktree add failed — ${add.stderr.trim().split("\n")[0]}`); return null; }

  // node_modules is gitignored, so the fresh checkout has none and `npm test` would fail.
  // Junctions are used rather than copies: instant, and Windows allows them without admin.
  for (const rel of LINK_DIRS) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(dir, rel);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(src, dst, os.platform() === "win32" ? "junction" : "dir");
    } catch (e) {
      onLog("w", `could not link ${rel} into the worktree (${e.code || e.message}) — tests may fail there`);
    }
  }

  return {
    dir,
    baseRef,
    cleanup: async () => {
      // Remove the junctions first so worktree removal never follows them out of the sandbox.
      for (const rel of LINK_DIRS) {
        const p = path.join(dir, rel);
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* may be a real dir; leave it */ }
      }
      await git(repoRoot, ["worktree", "remove", "--force", dir]);
      await git(repoRoot, ["worktree", "prune"]);
    },
  };
}

/**
 * Bring a finished agent's files back into the main working tree.
 * @returns {Promise<{ok:boolean, merged:string[], copied:string[], conflicts:string[], missing:string[]}>}
 */
export async function integrate(repoRoot, worktreeDir, task, onLog = () => {}) {
  const files = filesToIntegrate(worktreeDir, task);
  const out = { ok: true, merged: [], copied: [], conflicts: [], missing: [] };

  for (const rel of files) {
    const from = path.join(worktreeDir, rel);
    const to = path.join(repoRoot, rel);

    if (!fs.existsSync(from)) { out.missing.push(rel); continue; }

    const tracked = (await git(repoRoot, ["ls-files", "--error-unmatch", rel])).ok;

    // Untracked output (new route files, new tests, docs) cannot collide — copy it.
    if (!tracked || !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      out.copied.push(rel);
      continue;
    }

    // Tracked and already present: three-way merge so concurrent edits both survive.
    const base = await git(repoRoot, ["show", `${task.baseRef || "HEAD"}:${rel.replace(/\\/g, "/")}`]);
    if (!base.ok) { fs.copyFileSync(from, to); out.copied.push(rel); continue; }

    // Normalise line endings for the merge. `git show` returns the blob as stored (LF), while
    // both working trees are checked out CRLF on Windows — so without this every single line
    // reads as modified on both sides and even a trivial merge conflicts on the whole file.
    const oursRaw = fs.readFileSync(to, "utf8");
    const eol = /\r\n/.test(oursRaw) ? "\r\n" : "\n";
    const lf = (s) => s.replace(/\r\n/g, "\n");

    const tmpBase = tmpFile(rel, "base");
    const tmpOurs = tmpFile(rel, "ours");
    const tmpTheirs = tmpFile(rel, "theirs");
    fs.writeFileSync(tmpBase, lf(base.stdout));
    fs.writeFileSync(tmpOurs, lf(oursRaw));
    fs.writeFileSync(tmpTheirs, lf(fs.readFileSync(from, "utf8")));

    // -p prints the result instead of writing in place; a non-zero exit means conflict hunks.
    const m = await git(repoRoot, ["merge-file", "-p", tmpOurs, tmpBase, tmpTheirs]);
    for (const f of [tmpBase, tmpOurs, tmpTheirs]) { try { fs.unlinkSync(f); } catch {} }

    if (m.ok) {
      fs.writeFileSync(to, eol === "\r\n" ? m.stdout.replace(/\r?\n/g, "\r\n") : m.stdout);
      out.merged.push(rel);
    } else {
      out.ok = false;
      out.conflicts.push(rel);
      onLog("w", `${task.key}: ${rel} genuinely overlaps work already integrated — not applied`);
    }
  }
  return out;
}

/** Scope, plus anything the agent actually produced under its declared directories. */
function filesToIntegrate(worktreeDir, task) {
  const set = new Set();
  for (const s of task.scope || []) {
    const rel = toRepoRel(task, s);
    if (rel.endsWith("/")) {
      const abs = path.join(worktreeDir, rel);
      if (fs.existsSync(abs)) for (const f of fs.readdirSync(abs)) set.add(path.posix.join(rel, f));
    } else {
      set.add(rel);
    }
  }
  return [...set];
}

/** Ticket scopes are relative to the ticket's workspace; integration works from the repo root. */
function toRepoRel(task, scopeEntry) {
  const ws = String(task.workspaceRel || "").replace(/\\/g, "/").replace(/^\/|\/$/g, "");
  const s = String(scopeEntry).replace(/\\/g, "/");
  return ws ? `${ws}/${s}` : s;
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60) || "task";

let tmpSeq = 0;
function tmpFile(rel, tag) {
  return path.join(os.tmpdir(), `sym-${tag}-${process.pid}-${tmpSeq++}-${path.basename(rel)}`);
}

/** Remove every worktree this system created — used by demo reset. */
export async function pruneAll(repoRoot) {
  const root = path.join(repoRoot, WORKTREES);
  try {
    for (const d of fs.readdirSync(root)) {
      await git(repoRoot, ["worktree", "remove", "--force", path.join(root, d)]);
    }
  } catch { /* none */ }
  await git(repoRoot, ["worktree", "prune"]);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
