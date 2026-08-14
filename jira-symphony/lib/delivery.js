// Turning a finished, verified ticket into a reviewable change.
//
// Symphony's terminal state is "Pull Request opened", not "files edited". This module gives each
// ticket its own branch and commit inside the agent's worktree, pushes it when a remote exists,
// and produces the URL a human opens to review it.
//
// Without a remote it still creates the branch and commit locally, so there is always an
// inspectable per-ticket artefact — `git log sym/ATT-201` — rather than an anonymous pile of
// edits in the working tree.

import { execFile } from "node:child_process";
import path from "node:path";

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: (stdout || "").trim(), stderr: (stderr || err?.message || "").trim() }));
  });
}

/** Turn any remote URL into a browsable https base, or null if it isn't GitHub-ish. */
export function webUrlFor(remote) {
  if (!remote) return null;
  const m = remote.match(/^(?:https?:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?$/i);
  if (!m) return null;
  return `https://${m[1]}/${m[2]}`;
}

/** The push URL configured for this repo, or null. */
export async function getRemote(repoRoot) {
  const r = await git(repoRoot, ["remote", "get-url", "origin"]);
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * Commit the agent's work onto its own branch, and push it if asked.
 *
 * @returns {Promise<{ok, branch, commit, changed, pushed, prUrl, reason}>}
 */
export async function deliver({ repoRoot, worktreeDir, task, push = false, onLog = () => {} }) {
  const branch = `sym/${String(task.key).toLowerCase()}`;
  const out = { ok: false, branch, commit: null, changed: [], pushed: false, prUrl: null, reason: null };

  // The worktree is checked out detached; give this ticket's work a name.
  const co = await git(worktreeDir, ["checkout", "-B", branch]);
  if (!co.ok) { out.reason = `could not create ${branch}: ${co.stderr.split("\n")[0]}`; return out; }

  // -f is required: agent output under routes/, tests/ and docs/ is gitignored so that a demo
  // reset can clear it. Ignored-but-intended files still belong in the ticket's commit.
  const paths = (task.scope || []).map((s) => toRepoRel(task, s));
  if (paths.length) await git(worktreeDir, ["add", "-f", "--", ...paths]);
  else await git(worktreeDir, ["add", "-A"]);

  const staged = await git(worktreeDir, ["diff", "--cached", "--name-only"]);
  out.changed = staged.stdout ? staged.stdout.split("\n").filter(Boolean) : [];
  if (!out.changed.length) { out.reason = "the agent changed nothing"; return out; }

  const message = commitMessage(task);
  const commit = await git(worktreeDir, [
    "-c", "user.name=Symphony", "-c", "user.email=symphony@local",
    "commit", "-m", message,
  ]);
  if (!commit.ok) { out.reason = `commit failed: ${commit.stderr.split("\n")[0]}`; return out; }

  const sha = await git(worktreeDir, ["rev-parse", "--short", "HEAD"]);
  out.commit = sha.stdout;
  out.ok = true;
  onLog("ok", `${task.key}: committed ${out.commit} on ${branch} · ${out.changed.length} file(s)`);

  if (!push) return out;

  const remote = await getRemote(repoRoot);
  if (!remote) { out.reason = "no git remote configured — branch kept locally"; return out; }

  const pushed = await git(worktreeDir, ["push", "-u", "--force-with-lease", "origin", branch]);
  if (!pushed.ok) {
    out.reason = `push failed: ${pushed.stderr.split("\n").filter(Boolean).slice(-1)[0]}`;
    onLog("w", `${task.key}: ${out.reason}`);
    return out;
  }
  out.pushed = true;

  const web = webUrlFor(remote);
  // GitHub's compare view offers "Create pull request" — opening it via the API would need a
  // token we deliberately do not ask for, and this lands a human on the same screen.
  out.prUrl = web ? `${web}/compare/${branch}?expand=1` : null;
  onLog("ok", `${task.key}: pushed ${branch}${out.prUrl ? ` · open a PR at ${out.prUrl}` : ""}`);
  return out;
}

function commitMessage(task) {
  const lines = [`${task.key}: ${task.title}`, ""];
  if (task.ticket?.spec) lines.push(String(task.ticket.spec).trim(), "");
  const v = task.verification;
  if (v) lines.push(`Verified: ${v.command} — ${v.summary}`, "");
  lines.push(`Implemented by ${task.agentId} (${task.roleLabel}) under Symphony orchestration.`);
  return lines.join("\n");
}

/** Ticket scopes are workspace-relative; git needs them relative to the repo root. */
function toRepoRel(task, scopeEntry) {
  const ws = String(task.workspaceRel || "").replace(/\\/g, "/").replace(/^\/|\/$/g, "");
  const s = String(scopeEntry).replace(/\\/g, "/");
  return ws ? path.posix.join(ws, s) : s;
}

/** Delete the branches this system created. Used by demo reset. */
export async function pruneBranches(repoRoot) {
  const list = await git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/sym"]);
  const branches = list.stdout ? list.stdout.split("\n").filter(Boolean) : [];
  for (const b of branches) await git(repoRoot, ["branch", "-D", b]);
  return branches;
}
