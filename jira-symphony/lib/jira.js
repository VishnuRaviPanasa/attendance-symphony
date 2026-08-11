// Minimal Jira Cloud REST client (v3). Uses Basic auth (email + API token).
// Node 18+ has global fetch, so no extra HTTP dependency is needed.

export class JiraClient {
  constructor({ baseUrl, email, token }) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.email = email;
    this.token = token;
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  headers(extra = {}) {
    return {
      Authorization: this.auth,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async _req(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!res.ok) {
      const msg = (json && (json.errorMessages?.join("; ") || JSON.stringify(json.errors || json))) || text || res.statusText;
      const err = new Error(`Jira ${method} ${path} → ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Verify credentials; returns the authenticated user.
  async myself() {
    return this._req("GET", "/rest/api/3/myself");
  }

  // Search issues by JQL. Tries the enhanced endpoint first, falls back to classic.
  async search(jql, fields, maxResults = 50) {
    const f = fields || ["summary", "status", "priority", "labels", "issuetype", "assignee", "created", "updated"];
    try {
      const r = await this._req("POST", "/rest/api/3/search/jql", { jql, maxResults, fields: f });
      return r.issues || [];
    } catch (e) {
      if (e.status === 404 || e.status === 410 || e.status === 405) {
        const qs = new URLSearchParams({ jql, maxResults: String(maxResults), fields: f.join(",") });
        const r = await this._req("GET", "/rest/api/3/search?" + qs.toString());
        return r.issues || [];
      }
      throw e;
    }
  }

  async getTransitions(key) {
    const r = await this._req("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return r.transitions || [];
  }

  // Move an issue to a target status by (fuzzy) name. Returns true if a transition ran.
  async transitionTo(key, statusName) {
    if (!statusName) return false;
    const want = statusName.toLowerCase().trim();
    const trans = await this.getTransitions(key);
    let t =
      trans.find((x) => (x.to?.name || "").toLowerCase() === want) ||
      trans.find((x) => (x.name || "").toLowerCase() === want) ||
      trans.find((x) => (x.to?.name || "").toLowerCase().includes(want)) ||
      trans.find((x) => (x.name || "").toLowerCase().includes(want));
    if (!t) return false;
    await this._req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }

  // Add a comment (v3 requires Atlassian Document Format).
  async comment(key, text) {
    const body = {
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: String(text) }] }],
      },
    };
    return this._req("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, body);
  }

  issueUrl(key) {
    return `${this.baseUrl}/browse/${key}`;
  }
}

// Normalize a raw Jira issue into the shape the Symphony engine consumes.
export function normalizeIssue(issue, baseUrl) {
  const f = issue.fields || {};
  const prioName = (f.priority && f.priority.name) || "Medium";
  const prioMap = { Highest: 1, High: 1, Medium: 2, Low: 3, Lowest: 4 };
  return {
    key: issue.key,
    title: f.summary || issue.key,
    status: (f.status && f.status.name) || "To Do",
    prio: prioMap[prioName] || 2,
    labels: (f.labels && f.labels.length ? f.labels : [(f.issuetype && f.issuetype.name) || "task"]).slice(0, 3),
    assignee: (f.assignee && (f.assignee.displayName || f.assignee.accountId)) || null,
    url: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/browse/${issue.key}` : "#",
    updated: f.updated || null,
  };
}
