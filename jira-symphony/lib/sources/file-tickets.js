// Ticket discovery from the filesystem.
//
// Tickets are JSON files dropped into tickets/inbox/. The orchestrator finds them on its own —
// nothing pushes them in. That is the point of the demo: you create a ticket, you do not assign
// it. Creating one by hand in a text editor mid-demo works exactly the same way as the button.
//
// fs.watch alone is not dependable on Windows (missed events, duplicate events, and it can fire
// before the file is fully written), so a 1s directory poll runs alongside it as the real
// guarantee. The watch just makes discovery feel instant.

import fs from "node:fs";
import path from "node:path";

export class FileTicketSource {
  /**
   * @param {object} o
   * @param {string} o.dir            tickets/ root (contains inbox/, active/, done/)
   * @param {(ticket:object)=>boolean} o.onTicket  return true if the ticket was accepted
   * @param {(kind:string,msg:string)=>void} [o.onLog]
   */
  constructor({ dir, onTicket, onLog = () => {}, pollMs = 1000 }) {
    this.dir = dir;
    this.inbox = path.join(dir, "inbox");
    this.active = path.join(dir, "active");
    this.done = path.join(dir, "done");
    this.onTicket = onTicket;
    this.onLog = onLog;
    this.pollMs = pollMs;
    this._seen = new Set();
    this._timer = null;
    this._watcher = null;
    this._scanning = false;
    for (const d of [this.inbox, this.active, this.done]) fs.mkdirSync(d, { recursive: true });
  }

  start() {
    try {
      this._watcher = fs.watch(this.inbox, () => this.scan());
    } catch {
      this.onLog("w", "fs.watch unavailable on tickets/inbox — relying on the poll");
    }
    this._timer = setInterval(() => this.scan(), this.pollMs);
    this.onLog("i", `watching ${rel(this.inbox)} for new tickets`);
    this.scan();
    return this;
  }

  stop() {
    clearInterval(this._timer);
    try { this._watcher?.close(); } catch { /* already gone */ }
    this._timer = this._watcher = null;
  }

  /** Forget everything seen, so a reset re-discovers tickets. */
  reset() { this._seen.clear(); }

  scan() {
    if (this._scanning) return;
    this._scanning = true;
    try {
      let files = [];
      try { files = fs.readdirSync(this.inbox).filter((f) => f.endsWith(".json")).sort(); } catch { return; }

      for (const file of files) {
        const full = path.join(this.inbox, file);
        if (this._seen.has(full)) continue;

        let ticket;
        try {
          const raw = fs.readFileSync(full, "utf8");
          if (!raw.trim()) continue;               // still being written
          ticket = JSON.parse(raw);
        } catch (e) {
          // A partially-written file throws here; leave it unseen and retry next poll.
          if (e instanceof SyntaxError) continue;
          this.onLog("w", `could not read ${file}: ${e.message}`);
          continue;
        }

        if (!ticket || !ticket.title) { this.onLog("w", `${file}: no title, skipping`); this._seen.add(full); continue; }
        ticket.id = String(ticket.id || path.basename(file, ".json"));
        ticket.key = ticket.key || `ATT-${ticket.id}`;
        ticket.source = "file";
        ticket.sourceFile = file;

        this._seen.add(full);
        const accepted = this.onTicket(ticket);
        if (accepted) this._claim(full, file);
      }
    } finally {
      this._scanning = false;
    }
  }

  /** Move inbox → active so the queue and the filesystem agree. */
  _claim(full, file) {
    try {
      fs.mkdirSync(this.active, { recursive: true });
      fs.renameSync(full, path.join(this.active, file));
    } catch (e) {
      this.onLog("w", `could not move ${file} to active/: ${e.message}`);
    }
  }

  /** Move active → done when the ticket finishes. */
  complete(ticket, ok = true) {
    if (!ticket?.sourceFile) return;
    const from = path.join(this.active, ticket.sourceFile);
    const to = path.join(this.done, (ok ? "" : "failed-") + ticket.sourceFile);
    try { if (fs.existsSync(from)) { fs.mkdirSync(this.done, { recursive: true }); fs.renameSync(from, to); } }
    catch { /* cosmetic only — never let it break the run */ }
  }

  /** Write tickets into the inbox. Used by the demo button; discovery still happens via scan(). */
  seed(tickets) {
    fs.mkdirSync(this.inbox, { recursive: true });
    const written = [];
    for (const t of tickets) {
      const name = `${t.id}-${slug(t.title)}.json`;
      const dest = path.join(this.inbox, name);
      // Write to a temp file then rename: rename is atomic, so the watcher can never
      // observe a half-written ticket.
      const tmp = dest + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
      fs.renameSync(tmp, dest);
      written.push(name);
    }
    return written;
  }

  /** Empty every ticket directory. */
  clear() {
    for (const d of [this.inbox, this.active, this.done]) {
      try { for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true }); } catch { /* nothing there */ }
    }
    this.reset();
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const rel = (p) => p.split(/[\\/]/).slice(-2).join("/");
