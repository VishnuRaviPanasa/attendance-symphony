# Jira · Symphony — real Jira → auto-dispatch agents

Watches your **Jira** for tickets **assigned to you** and, the moment a new one
appears, **auto-starts a Symphony agent** to work it — shown live on a dashboard.
When an agent starts/finishes it **comments on the ticket and moves it**
(To Do → In Progress → Done) back in Jira.

This is the real Symphony loop: *issue tracker as the control plane*.

```
New ticket assigned to you in Jira
      │  (backend polls every 15s)
      ▼
Orchestrator claims it → dispatches a free agent   ── up to N in parallel (backpressure)
      ▼
Agent runs the Symphony phases (live on the dashboard)
      ▼
Jira write-back:  comment + "In Progress"  →  on finish:  comment (PR) + "Done"
```

## 1. Install (one time)

You need Node 18+ (you have v24). In this folder:

```bash
npm install
```

## 2. Get a Jira API token

1. Go to **https://id.atlassian.net/manage-profile/security/api-tokens**
2. **Create API token**, copy it.
3. Note the **email** of that Atlassian account and your **site URL**
   (e.g. `https://artrecruitment.atlassian.net`).

## 3. Configure

```bash
copy .env.example .env      # Windows (PowerShell/cmd)
# then edit .env and fill JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
```

## 4. Run

```bash
npm start
```

Open **http://localhost:4000**. You'll see the live dashboard.

- **Assign a Jira ticket to yourself** → within ~15s an agent auto-starts, and the
  ticket gets a comment + moves to *In Progress*, then *Done* when the agent finishes.
- **"Sync assigned tickets"** button — poll Jira right now and dispatch any new ones.
- **"Simulate a ticket"** button — trigger a fake ticket (safe demo filler, no Jira writes).
- **Max parallel** slider — change how many agents run at once (backpressure).

### Try it without Jira first (mock mode)
Just run `npm start` **without** filling `.env` (or set `JIRA_MOCK=true`). Tickets
are generated automatically so you can see the whole pipeline. No Jira calls are made.

## Verifying the connection
Visit **http://localhost:4000/api/jira/test** — it returns your Jira display name
if the token works, or the exact error if not.

## Notes & tuning
- **Only NEW assignments** trigger agents by default. To also pick up tickets already
  assigned to you at startup, set `DISPATCH_EXISTING_ON_START=true`.
- **Statuses differ per project.** If your board doesn't use "In Progress"/"Done",
  set `STATUS_IN_PROGRESS` / `STATUS_DONE` to your column names — they're fuzzy-matched
  against the transitions Jira actually offers, and skipped safely if not found.
- **Read-only?** Set `WRITE_BACK=false` to never modify Jira (dashboard-only).
- **Scope the watch** with `JIRA_JQL`, e.g. add `AND project = KAN`.
- The agent *work* here is a faithful Symphony simulation (reliable, no repo/LLM keys).
  The connection, triggering, and Jira write-back are **real**. Wiring a real coding
  agent (clone repo → LLM writes code → open PR) is a drop-in extension of the
  `onStart`/`onComplete` hooks in `server.js`.

## Live-reflect mode — the board mirrors what *Claude* is actually building

This mode makes the dashboard show the **real tasks you give Claude**: when you ask
Claude to build something, a card appears and an agent shows **working** while Claude
actually edits code, then flips to **done** when Claude finishes. Start/finish are
tied to Claude's real work (the phase animation in between is cosmetic).

```bash
npm run live         # empty board at http://localhost:4000, no Jira needed
```

Then just ask Claude to make a change. Claude drives the board with the helper:

```bash
node claude-task.mjs start "Add a leave-balance widget"   # -> prints TASK-1, card appears
node claude-task.mjs note  TASK-1 "editing app.html (+38 -4)"
node claude-task.mjs done  TASK-1 "shipped + republished"  # -> card completes, PR shown
```

(`SYM_URL` overrides the server URL; it defaults to `http://localhost:4000`.)

**Note:** this works on the local `localhost:4000` board only — a published artifact
link can't receive live updates from your machine. For a manager demo, watch it on
your own laptop while Claude works.

## Files
- `server.js` — poller, SSE, write-back, control endpoints, mock mode
- `lib/jira.js` — Jira REST client (search / transitions / comments)
- `lib/symphony.js` — agent + task state machine (Symphony phases)
- `public/dashboard.html` — the live dashboard (served at `/`)
- `.env.example` — copy to `.env` and fill in
