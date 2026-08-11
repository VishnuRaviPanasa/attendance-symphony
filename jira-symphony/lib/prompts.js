// Builds the prompt and role framing handed to each spawned agent.
//
// Two things here exist specifically to make the dashboard honest:
//   1. agents are told to keep a TodoWrite list — that list IS the progress bar. Asking a
//      worker to report status is instrumentation, not fabrication; the numbers still come
//      from the agent's own tool calls.
//   2. agents are told the exact files they own. Combined with the scope hook this is what
//      lets several of them run at once without touching a shared file.

export const ROLES = {
  backend: {
    id: "backend",
    label: "Backend Agent",
    color: "#60a5fa",
    system:
      "You are a backend engineer working inside an existing Express API. " +
      "You add self-contained route modules. You never modify shared infrastructure.",
  },
  testing: {
    id: "testing",
    label: "Test Agent",
    color: "#fbbf24",
    system:
      "You are a test engineer. You write focused tests with node:test that pin real behaviour. " +
      "You do not modify the code under test — if it looks wrong, your test documents the actual behaviour.",
  },
  docs: {
    id: "docs",
    label: "Docs Agent",
    color: "#c084fc",
    system:
      "You are a technical writer. You produce concise, accurate API documentation in Markdown " +
      "based on what the code actually does. You do not modify code.",
  },
  frontend: {
    id: "frontend",
    label: "Frontend Agent",
    color: "#34d399",
    system:
      "You are a frontend engineer. You write small, dependency-free browser modules.",
  },
};

export function roleFor(ticket) {
  const k = String(ticket?.kind || "").toLowerCase();
  return ROLES[k] ? ROLES[k] : ROLES.backend;
}

/** The system prompt appended to Claude Code's default. */
export function systemPromptFor(ticket) {
  const role = roleFor(ticket);
  return [
    role.system,
    "",
    "OPERATING RULES (these are strict):",
    "- Maintain a TodoWrite list of 4 to 6 concrete steps and mark each one completed as you finish it. " +
      "An orchestration dashboard reads this list to report your progress, so keep it current.",
    "- Only create or modify the files you have been assigned. Any write outside that set will be " +
      "blocked by a hook and counts as a failure.",
    "- Do not modify server.js, lib/store.js, package.json, or any file belonging to another task.",
    "- Prefer a small, correct change over a large one. Do not refactor unrelated code.",
    "- Finish by stating in one sentence what you produced.",
  ].join("\n");
}

/** The user prompt: the ticket itself. */
export function buildPrompt(ticket, { workspace }) {
  const scope = ticket.scope || [];
  const acceptance = Array.isArray(ticket.acceptance) ? ticket.acceptance : ticket.acceptance ? [ticket.acceptance] : [];

  return [
    `# ${ticket.key || ticket.id}: ${ticket.title}`,
    "",
    ticket.spec || "",
    "",
    "## Where you are",
    `Working directory: ${workspace}`,
    "This is an Express API whose routes are auto-discovered: every file in `routes/` is imported at",
    "startup and its default export is called with an express Router. The directory is watched, so a",
    "new route file goes live without a restart. You therefore never need to edit `server.js`.",
    "",
    "Read `routes/health.js` first — it is the worked example of the pattern.",
    "Read data through `lib/store.js` (already provides recFor, statusFor, countsForDay,",
    "lastWorkingDays, deptRates, historyFor, allDates, listEmployees). Do not read the JSON directly,",
    "and do not modify `lib/store.js`.",
    "",
    "## Files you own",
    scope.length
      ? scope.map((f) => `- \`${f}\`  (create it)`).join("\n")
      : "- (none declared — create only what the task plainly requires)",
    "",
    "You may READ any file in the workspace. You may only WRITE the files listed above.",
    "",
    acceptance.length ? "## Acceptance criteria\n" + acceptance.map((a) => `- ${a}`).join("\n") : "",
    "",
    "## Definition of done",
    ticket.verify
      ? `- \`${ticket.verify}\` passes.`
      : "- `npm test` passes (run it from the working directory).",
    "- The feature works when exercised through the real data in `data/attendance.json`.",
    "",
    "Start by writing your TodoWrite list.",
  ].filter((l) => l !== null).join("\n");
}

/** Tools an agent is permitted to request. */
export const ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "Write", "Edit", "TodoWrite",
  "Bash(node:*)", "Bash(npm test:*)", "Bash(npm run test:*)",
];

/** Tools that are never useful here and only add latency or risk. */
export const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "Task", "NotebookEdit"];
