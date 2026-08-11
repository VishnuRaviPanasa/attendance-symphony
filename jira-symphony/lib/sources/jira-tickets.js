// Ticket discovery from Jira — the "issue tracker as the control plane" path.
//
// Reuses the existing JiraClient in ../jira.js unchanged. Only NEW assignments dispatch: the
// first poll seeds a `seen` set so a backlog of pre-existing tickets does not stampede the
// fleet the moment the server starts.
//
// This source is optional. With no credentials the console runs on file tickets alone, which
// is the reliable path for a live demo.

import { JiraClient, normalizeIssue } from "../jira.js";

export class JiraTicketSource {
  constructor({ baseUrl, email, token, jql, pollSec = 15, dispatchExisting = false, onTicket, onLog = () => {} }) {
    this.cfg = { baseUrl, email, token, jql, pollSec, dispatchExisting };
    this.onTicket = onTicket;
    this.onLog = onLog;
    this.client = new JiraClient({ baseUrl, email, token });
    this.seen = new Set();
    this.connected = false;
    this.me = null;
    this._timer = null;
  }

  static isConfigured(cfg) { return !!(cfg.baseUrl && cfg.email && cfg.token); }

  async start() {
    try {
      const me = await this.client.myself();
      this.connected = true;
      this.me = me.displayName || me.emailAddress || "you";
      this.onLog("ok", `Jira connected as ${this.me} · ${this.cfg.jql}`);
    } catch (e) {
      this.connected = false;
      this.onLog("w", `Jira connection failed — ${e.message}`);
      return this;
    }

    const first = await this.poll(this.cfg.dispatchExisting);
    this.onLog("i", this.cfg.dispatchExisting
      ? `Jira: dispatched ${first.dispatched} existing ticket(s)`
      : `Jira: ${first.count} ticket(s) already assigned — watching for new ones`);

    this._timer = setInterval(() => {
      this.poll(true).catch((e) => this.onLog("w", "Jira poll failed — " + e.message));
    }, this.cfg.pollSec * 1000);
    return this;
  }

  stop() { clearInterval(this._timer); this._timer = null; }

  async poll(dispatch = true) {
    if (!this.connected) return { count: 0, dispatched: 0 };
    const issues = await this.client.search(this.cfg.jql);
    let dispatched = 0;
    for (const raw of issues) {
      const t = normalizeIssue(raw, this.cfg.baseUrl);
      if (this.seen.has(t.key)) continue;
      this.seen.add(t.key);
      if (!dispatch) continue;

      // Jira gives us a title, not a file scope. Derive a safe, unique scope so the
      // agent still cannot collide with another agent's file.
      const ticket = {
        id: t.key,
        key: t.key,
        title: t.title,
        kind: kindFromLabels(t.labels),
        priority: t.prio,
        scope: [`routes/${slug(t.title)}.js`],
        spec: `Imported from Jira: ${t.url}`,
        source: "jira",
        url: t.url,
      };
      if (this.onTicket(ticket)) dispatched++;
    }
    return { count: issues.length, dispatched };
  }

  status() {
    return { connected: this.connected, me: this.me, jql: this.cfg.jql, pollSec: this.cfg.pollSec };
  }
}

function kindFromLabels(labels = []) {
  const l = labels.map((x) => String(x).toLowerCase());
  if (l.some((x) => /test|qa/.test(x))) return "testing";
  if (l.some((x) => /doc/.test(x))) return "docs";
  if (l.some((x) => /front|ui|web/.test(x))) return "frontend";
  return "backend";
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";
