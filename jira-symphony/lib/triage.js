// Turns a free-text task description into a routed, scoped ticket.
//
// "Change UI theme to black" has to become: which agent, which files may it write, and what
// counts as done. A short structured-output call decides that — so "Symphony picked the agent"
// is a real decision about this specific request, not a lookup table.
//
// If the call fails or is slow, keyword routing takes over. Triage must never be the reason a
// demo stalls, and a wrong-but-instant guess is recoverable (the operator can pick the agent
// explicitly in the form).

import { spawn } from "node:child_process";
import { resolveCli, childEnv } from "./agent-runner.js";

const KINDS = ["frontend", "backend", "testing", "docs"];

/** Where each kind of work happens, and what it is allowed to write. */
export function targetFor(kind, slug, repoRoot, apiDir) {
  switch (kind) {
    case "frontend":
      return {
        workspace: repoRoot,
        workspaceRel: "",
        scope: ["index.html"],
        // index.html is one file shared by every UI ticket: two agents editing it at once would
        // clobber each other. Declaring it exclusive makes the orchestrator serialise them.
        exclusive: ["index.html"],
        postSync: true,
      };
    case "testing":
      return { workspace: apiDir, workspaceRel: "attendance-api", scope: [`tests/${slug}.test.js`], exclusive: [] };
    case "docs":
      return { workspace: apiDir, workspaceRel: "attendance-api", scope: [`docs/${slug}.md`], exclusive: [] };
    case "backend":
    default:
      return { workspace: apiDir, workspaceRel: "attendance-api", scope: [`routes/${slug}.js`, `tests/${slug}.test.js`], exclusive: [] };
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: KINDS, description: "Which specialist should do this work" },
    title: { type: "string", description: "Short imperative title, max 60 chars" },
    slug: { type: "string", description: "lowercase-hyphenated identifier, max 24 chars, no extension" },
    acceptance: {
      type: "array",
      items: { type: "string" },
      description: "3 to 6 concrete, checkable acceptance criteria",
    },
    reason: { type: "string", description: "One sentence on why this agent" },
  },
  required: ["kind", "title", "slug", "acceptance", "reason"],
  additionalProperties: false,
};

const PROMPT = `You are triaging a task for an autonomous coding fleet working on an attendance system.

There are two codebases:
  * The ATTENDANCE APP — a single self-contained index.html (vanilla JS, inline CSS with custom
    properties, light/dark themes). All user-visible UI, styling, theming, layout and screens.
  * The ATTENDANCE API — an Express service where each feature is its own file in routes/.
    Server-side data, endpoints, calculations, reports, validation.

Choose exactly one specialist:
  frontend — anything the user SEES: theme, colours, styling, layout, a screen, a widget, copy.
  backend  — a new or changed HTTP endpoint, server-side calculation or data rule.
  testing  — explicitly asks for tests and nothing else.
  docs     — explicitly asks for documentation and nothing else.

Write acceptance criteria that are specific and checkable by looking at the result. For a
frontend task, say what should be visibly different. Do not invent requirements the task did
not ask for.

TASK:
`;

/**
 * @returns {Promise<{kind,title,slug,acceptance,reason,via}>}
 */
export async function triage(description, { timeoutMs = 45000, model = "haiku" } = {}) {
  const fallback = () => ({ ...heuristic(description), via: "keywords" });

  const cli = resolveCli();
  if (!cli) return fallback();

  try {
    const out = await runJson(cli, PROMPT + description.trim() + "\n", { timeoutMs, model });
    const s = out?.structured_output;
    if (!s || !KINDS.includes(s.kind)) return fallback();
    return {
      kind: s.kind,
      title: String(s.title || description).slice(0, 80),
      slug: slugify(s.slug || s.title || description),
      acceptance: Array.isArray(s.acceptance) && s.acceptance.length ? s.acceptance.slice(0, 8) : heuristic(description).acceptance,
      reason: s.reason || "",
      via: "llm",
      costUsd: out.total_cost_usd || 0,
    };
  } catch {
    return fallback();
  }
}

function runJson(cli, prompt, { timeoutMs, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      cli, "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA),
      "--model", model,
      "--max-budget-usd", "0.25",
      "--strict-mcp-config",
      "--mcp-config", JSON.stringify({ mcpServers: {} }),
      // Triage reads nothing and writes nothing; it only classifies text.
      "--disallowedTools", "Bash Write Edit Read Glob Grep WebSearch WebFetch Task",
    ];
    const child = spawn(process.execPath, args, { env: childEnv(), windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("triage timed out")); }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(err.trim().split("\n")[0] || "triage returned no JSON")); }
    });
  });
}

/** Instant routing when the model is unavailable. Deliberately simple and predictable. */
export function heuristic(description) {
  const t = String(description || "").toLowerCase();
  let kind = "backend";
  // NB: plurals and inflections — \btest\b does not match "tests", and \bdoc\b does not
  // match "Document". Both slipped through the first version.
  if (/\b(tests?|testing|specs?|coverage|assert\w*)\b/.test(t)) kind = "testing";
  else if (/\b(docs?|document\w*|readme|guide|changelog)\b/.test(t)) kind = "docs";
  else if (/\b(theme|colou?r|dark|light|black|white|ui|ux|style|css|font|layout|screen|page|button|icon|logo|banner|sidebar|header|footer|badge|look|design|branding)\b/.test(t)) kind = "frontend";
  else if (/\b(api|endpoint|route|report|summary|calculate|validation|validate|server)\b/.test(t)) kind = "backend";

  const title = String(description || "Task").trim().replace(/\s+/g, " ").slice(0, 70);
  return {
    kind,
    title,
    slug: slugify(title),
    reason: "routed by keyword match (model triage unavailable)",
    acceptance: [
      "The change described in the task is implemented.",
      kind === "frontend"
        ? "The difference is visible when the app is opened in a browser."
        : "The behaviour is verifiable by calling the endpoint.",
      "Nothing unrelated is changed or broken.",
    ],
  };
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "task";
}
