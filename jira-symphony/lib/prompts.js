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
    label: "UI Agent",
    color: "#34d399",
    system:
      "You are a frontend engineer working on a single self-contained HTML application. " +
      "You make precise, surgical edits to existing markup, CSS and vanilla JS. You never " +
      "introduce a build step, a framework, or an external request.",
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
    "- You MUST create EVERY file listed under 'Files you own'. The task is not done until all of " +
      "them exist. If one of them is a test file, writing it is mandatory, not optional.",
    "- Only create or modify the files you have been assigned. Any write outside that set will be " +
      "blocked by a hook and counts as a failure.",
    "- Do not re-implement helpers that lib/store.js already provides. Read it first and use what is " +
      "there — especially for date validation, which has a timezone trap.",
    "- Do not modify server.js, lib/store.js, package.json, or any file belonging to another task.",
    "- Prefer a small, correct change over a large one. Do not refactor unrelated code.",
    "- Finish by stating in one sentence what you produced.",
  ].join("\n");
}

/** The user prompt: the ticket itself. */
export function buildPrompt(ticket, { workspace }) {
  if (roleFor(ticket).id === "frontend") return buildUiPrompt(ticket, { workspace });

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
    // Enumerated here, not only under "Files you own", because agents build their plan from
    // this section: a first run whose plan omitted the test file completed "successfully"
    // with the file never written.
    ...scope.map((f) => `- [ ] \`${f}\` exists and is complete.`),
    `- [ ] \`${ticket.verify || "npm test"}\` passes.`,
    "- [ ] The feature works against the real data in `data/attendance.json`.",
    "",
    scope.length > 1
      ? `Your TodoWrite list must include one step per file above (${scope.length} files) plus a verification step. ` +
        "Do not report success until every box is ticked."
      : "Start by writing your TodoWrite list.",
  ].filter((l) => l !== null).join("\n");
}

/**
 * Prompt for work on the attendance app itself.
 *
 * index.html is 1500 lines and ~100 KB with everything inline, so the agent is told exactly
 * where things live rather than left to discover it — that is the difference between a 40 s
 * edit and a 5 minute exploration, and a demo has to be predictable.
 */
function buildUiPrompt(ticket, { workspace }) {
  const acceptance = Array.isArray(ticket.acceptance) ? ticket.acceptance : ticket.acceptance ? [ticket.acceptance] : [];
  return [
    `# ${ticket.key || ticket.id}: ${ticket.title}`,
    "",
    ticket.spec ? `The request, in the requester's own words:\n\n> ${ticket.spec}` : "",
    "",
    "## The application",
    `Working directory: ${workspace}`,
    "`index.html` is the whole attendance app: one file, no build step, no dependencies, no",
    "network requests. Structure (line numbers are approximate — confirm with Grep):",
    "",
    "- `<style>` around lines 10-500. **All colour lives in CSS custom properties**, defined four times:",
    "    1. `:root { ... }`                              — the light palette (the default)",
    "    2. `@media (prefers-color-scheme: dark) :root`  — follows the OS",
    "    3. `:root[data-theme=\"light\"]`                  — explicit light override",
    "    4. `:root[data-theme=\"dark\"]`                   — explicit dark override",
    "  The tokens are `--bg --bg-grad --surface --surface-2 --surface-3 --border --border-2`,",
    "  `--ink --ink-2 --muted --muted-2`, `--accent --accent-2 --accent-ink --accent-soft --accent-glow`,",
    "  and the status pairs `--present --late --absent --leave --remote` (each with a `-soft` twin).",
    "- Static body markup around lines 500-560 (login screen, app shell, sidebar, topbar).",
    "- One IIFE `(function(){ \"use strict\"; ... })();` holding every bit of JS.",
    "- `applyTheme(t)` / `initTheme()` near the end set `data-theme` and persist `attendpro.theme`.",
    "",
    "## How to make this change well",
    "- **Prefer editing the CSS custom properties over touching individual rules.** Almost any",
    "  look-and-feel change is a palette change; components read the tokens.",
    "- If the task is about a theme, change **all four** blocks listed above so the result holds",
    "  whatever the OS setting and whatever the toggle says. A change to only one block will look",
    "  broken on someone else's machine.",
    "- Keep contrast readable — text must stay legible against its background.",
    "- Do not remove features, rename ids/classes other code depends on, or reformat the file.",
    "- Never add a `<script src>`, `<link rel=stylesheet>`, webfont or any other external request:",
    "  the file must keep working offline from disk.",
    "",
    "## Files you own",
    "- `index.html`  (edit it in place)",
    "",
    "`app.html` is a generated copy — do NOT edit it, it is regenerated automatically.",
    "Do not touch any other file.",
    "",
    acceptance.length ? "## Acceptance criteria\n" + acceptance.map((a) => `- ${a}`).join("\n") : "",
    "",
    "## Definition of done",
    "- [ ] `index.html` contains the change.",
    "- [ ] The change is visible immediately on opening the app — no console errors.",
    "- [ ] `node -e \"const s=require('fs').readFileSync('index.html','utf8'); if(!/<\\/html>/.test(s)) throw new Error('truncated')\"` succeeds.",
    "- [ ] Nothing unrelated was altered.",
    "",
    "Start by writing a TodoWrite list, then Grep for the token block you need before editing.",
  ].filter((l) => l !== null).join("\n");
}

/** Tools an agent is permitted to request. */
export const ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "Write", "Edit", "TodoWrite",
  "Bash(node:*)", "Bash(npm test:*)", "Bash(npm run test:*)",
];

/** Tools that are never useful here and only add latency or risk. */
export const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "Task", "NotebookEdit"];
