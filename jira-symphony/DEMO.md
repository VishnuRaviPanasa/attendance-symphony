# Manager demo — script and runbook

**The one message to land:** *I did not assign or start any of this. Symphony found the work,
chose the agents, and ran them in parallel — and everything on that screen came from what the
agents actually did.*

---

## Before you start (5 minutes, do this every time)

```bash
# 1. Two terminals
cd attendance-api  && npm start     # → http://localhost:4400
cd jira-symphony   && npm start     # → http://localhost:4300

# 2. Clean slate
curl -X POST http://localhost:4300/api/demo/reset -H "Content-Type: application/json" -d "{\"revertCode\":true}"
```

Check before you present:
- [ ] <http://localhost:4300> shows **● RUNNING**, 0 queued, 0 in progress
- [ ] <http://localhost:4400/api/health> returns `ok:true`
- [ ] `attendance-api/routes/` contains **only** `health.js`
- [ ] Header does **not** say "Claude Code CLI not found"
- [ ] Browser zoom ~110 %, console in fullscreen (⛶ top right)
- [ ] A terminal open on `attendance-symphony/` for the closing proof
- [ ] Network is up (agents need the API)
- [ ] **<http://localhost:4400/app> open in a second tab, signed in as HR Admin, scrolled to the bottom** —
      it must read *"No agent-built features yet."* If it does not, you have not reset.

### Timing — read this before you plan the meeting

Runs vary a lot, because the agents genuinely iterate. Measured across five real runs:

| | fastest | slowest |
|---|---|---|
| **"Change UI theme to black" (1 ticket)** | **2m 15s** | — |
| Wall clock, 3 API tickets | **2m 10s** | **7m 0s** |
| ATT-101 (summary) | 69 s | 77 s |
| ATT-102 (monthly) | 86 s | 313 s |
| ATT-103 (validation) | 79 s | 410 s |
| Cost | $0.50 (UI) / $0.72 (×3) | $1.45 |

**Budget 7 minutes for the agent phase and plan to talk over it.** The variance comes from
agents writing their own tests and then iterating when a test fails — which is real work, and
worth narrating rather than apologising for.

Two things make the wait comfortable:
- **ATT-101 almost always finishes first, in ~80 s.** You get a COMPLETED card early to point
  at while the other two are still running.
- The live activity stream always has something moving. Narrate it.

**The single free-text UI ticket is the most demo-friendly option: ~2m15s, ~$0.50, and the
payoff is a whole application that visibly changed colour.** If you need the 3-ticket run
shorter, use two (`{"ids":["101","103"]}`) or set `AGENT_EFFORT=low` in `.env`.

**Rehearse the whole thing twice** — once to check it works, once to practise the narration.

---

## The script (~5 minutes of talking + 2–7 minutes of agent time)

### 1 · The application (0:00) — **establish the "before"**
Open <http://localhost:4400/app> and sign in as HR Admin. Show the dashboard, then **scroll to the bottom**:

```
SHIPPED BY SYMPHONY
● Attendance API connected · 1 endpoint live
        No agent-built features yet.
  Open the Symphony console, create a ticket, and this section fills itself in.
```

> "This is our Attendance Management application. Note this section at the bottom — it's empty.
> Nothing has been built yet. Remember what it looks like."

**This is the single most important 15 seconds of the demo.** Without the "before", the "after"
proves nothing. Leave this tab open — you will come back to it.

### 2 · The console (0:45)
Switch to <http://localhost:4300>.
> "This is Symphony, the orchestration console. Right now it's idle — no agents, empty queue."

Point out the flow diagram: task queue → orchestrator → nothing yet.

### 3 · Create a ticket **in your own words** (1:15)
Click **New ticket**. Type, out loud as you do it:

```
Change the UI theme to black
```

> "I'm not picking an agent. I'm not saying which files to touch. I'm describing what I want,
> the way I'd write it in Jira."

Press **Create ticket**. The dialog reports back what Symphony decided:

```
Routed to UI Agent — will write index.html.
Ticket ATT-201 written to tickets/inbox; the watcher picks it up on its own.
```

> "Symphony read that sentence, decided this is UI work, chose the UI agent, and worked out that
> the only file it needs to write is index.html. That's a real decision about this request —
> there's no list of pre-canned tickets behind it."

*(The event stream shows the same thing: `New request received — triaging: "Change the UI theme
to black"` → `Routed to UI Agent (decided by Symphony)`.)*

**Alternative, if you prefer parallel work as the headline:** click **Demo tickets ×3** instead
for three independent API tickets, and follow steps 6–7 below. The free-text UI ticket is the
better opener because the payoff is visual; the ×3 run is the better parallelism story. With
time for both, do the UI ticket first.

### 4 · Take your hands off the keyboard (1:30)
**Say this explicitly.**
> "I'm not going to assign these. I'm not going to start anything. Watch."

### 5 · Discovery and assignment (1:45)
Within a second the event stream fills:
```
Task ATT-101 detected — "Add employee attendance summary API"
ATT-101 assigned to agent-01 as Backend Agent · slot 1/3
agent-01 session a93a4dea · claude-sonnet-4-6
```
> "Symphony detected all three, picked an agent for each by type, and started them."

### 6 · Parallelism (2:00)
Three cards, three tasks, three progress bars.
> "Three agents. Different tasks. Running at the same time."

Point at the **live activity** panel — colour-coded per agent, visibly interleaved.
> "That's the giveaway — the three colours are interleaved, not sequential."

### 7 · The strongest beat (2:15) — *optional but very effective*
Alt-tab to a terminal:
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*claude-code*cli.js*' } |
  Select-Object ProcessId, CreationDate
```
Three PIDs, all created in the same second.
> "Three real Claude Code processes. This isn't an animation."

### 8 · Live progress (2:30 — until they finish, 1–6 min)
Narrate what the cards say — don't invent:
> "Agent 01 is reading the repository. Agent 02 is already writing code — that's a real file
> path. Agent 03 just ran the test suite."

If someone asks whether the bar is real, point at the `ⓘ` under it:
> "That line names the event that last moved the bar. `tool call: Write`. It only moves when
> something actually happens — if an agent is thinking, it sits still."

### 9 · Completion
Cards flip to **● COMPLETED**, 100 %, with completion time, files written, tests, and cost.
> "Done. Files written, tests passed, results recorded."

### 10a · **The UI ticket payoff — the app itself changed**
*(If you ran "Change the UI theme to black".)*

Switch to the attendance app tab and **press F5**.

**The entire application is black.** Sidebar, cards, charts, tables — all of it.

> "Same file, same app. I typed one sentence. An agent found the four places colour is defined
> in that file, rewrote all of them, and kept the contrast readable."

Show the diff to make it concrete:
```bash
git diff --stat index.html          # ~140 lines changed, one file
git diff index.html | head -40      # the CSS custom properties
```
> "One file, a hundred and forty lines, all of it colour tokens. Nothing else was touched."

Toggle the theme button (top right) to show light/dark both still work:
> "It changed all four theme blocks, not just the one you'd notice — so it still behaves
> correctly on a machine set to light mode."

### 10b · **The API payoff — new features in the app**
*(If you ran the ×3 demo tickets.)*

Switch to the attendance app tab and **press F5**. Scroll to the bottom.

The section that said *"No agent-built features yet"* is now populated:

```
SHIPPED BY SYMPHONY
● Attendance API connected · 4 endpoints live · 3 shipped by Symphony agents

  Server-side summary                    Live endpoints
  73%        22                          GET  /api/health              BASELINE
  attendance rate  headcount             GET  /api/attendance/summary  AGENT-BUILT
  ● Present 10  ● Late 3  ● Remote 3     GET  /api/reports/monthly     AGENT-BUILT
  BY DEPARTMENT                          POST /api/attendance/validate AGENT-BUILT
  Product ████████████ 100%
```

> "Same page. I only refreshed it. That section was empty five minutes ago — those panels exist
> because the agents built the endpoints behind them."

Point at the department bars, then at the app's own chart higher up the page:
> "And these agree with the app's own numbers — the difference is that these are computed on the
> server, by code that didn't exist when we started."

Open **Reports** too: a *Monthly roll-up* table is now there, which ATT-102 produced.

Then the code itself:
```bash
git status --short attendance-api      # the files they created
cd attendance-api && npm test          # suite now includes the agents' own tests
```
> "Here's the code, and their own tests passing. I never restarted anything — the API discovers
> new route files on its own, which is also why three agents could work at once without
> colliding."

### 11 · Close
> "The point isn't that it built an API. It's that **I didn't assign or run any of it.**
> Symphony found the work, picked the agents, and ran them in parallel — and everything on that
> screen came from what the agents actually did."

---

## Optional extras

**Backpressure.** Before creating tickets, drag **Max parallel** to 1. Only one agent starts;
the other two visibly wait in the queue. Raise it to 3 and they start immediately.
> "That's a real concurrency limit, not a display setting."

**Failure handling.** While an agent is working, click **Kill agent** on its card.
```
ATT-101 FAILED on agent-01 — exited null with no result event
ATT-101 will be retried (attempt 2/2)
ATT-101 assigned to agent-01 · session <new id>
```
> "I just killed that process. Symphony noticed, marked it failed, and retried it — with a new
> session. It finishes normally."
Verified: it completes on the retry.

**Containment.** `POST /api/demo/tickets {"failure":true}` seeds a ticket that tries to modify a
shared file. The hook blocks it and `lib/store.js` is left untouched.
> "Agents can only write the files their ticket owns. That's why they can run in parallel safely."
Note: the agent usually recovers and still succeeds — good containment, so use **Kill agent**
if you specifically want to show a FAILED card.

---

## If something goes wrong

| Symptom | Do this |
|---|---|
| Agent fails on stage | **Don't hide it.** "One failed — watch, Symphony retries it automatically." A handled failure is more persuasive than a flawless run. |
| Nothing dispatches | Header says STOPPED → click **Start Symphony**. |
| "Claude Code CLI not found" | Restart the console from a normal terminal (not inside a Claude Code session). |
| A route 404s | `curl localhost:4400/api/_routes` shows `loadErrors`. If it mentions a missing export from `lib/store.js`, restart `attendance-api`. |
| Agents very slow / rate limited | Cards show a rate-limit warning. Drop **Max parallel** to 2. |
| App still says "No agent-built features yet" after the run | Hard-refresh (Ctrl+F5). If it still shows nothing, check `curl localhost:4400/api/_routes` — if that lists the routes, it is a browser cache issue, not an agent issue. |
| Triage routes to the wrong agent | Re-create the ticket and pick the agent explicitly in the **Agent** dropdown. Symphony's choice is a real decision, so it can be wrong — overriding it is one click. |
| Theme change looks broken in light mode | The agent missed one of the four token blocks. Show it as a finding, then `curl -X POST .../api/demo/reset` and re-run — this is why the ticket asks for all four. |
| App says "Attendance API not reachable" | `cd attendance-api && npm start`. The app keeps working offline regardless — only the Symphony section is affected. |
| Everything is broken | Fall back to **replay** (below). |

### Replay — the safety net

Every run is recorded. If the live path fails, replay a real one:

```bash
curl http://localhost:4300/api/runs                     # list recorded runs
curl -X POST http://localhost:4300/api/replay/start \
  -H "Content-Type: application/json" \
  -d "{\"runId\":\"run-2026-08-11T12-32-55-5gz9\",\"speed\":3}"
```

The console shows a permanent **⏺ REPLAY MODE** banner naming the run.

**Say so out loud.** It is a real transcript of a real run replayed at true timing — but it is
not live, and the banner is there so nobody can mistake it. Never present a replay as live.

---

## Numbers you can quote

| | |
|---|---|
| Wall clock, 3 agents | 2–7 min (measured 130 s and 417 s) |
| Agent work compressed | 800 s of work in 417 s wall clock |
| Cost | $0.72–$1.45 for three tickets |
| Output | 3 endpoints + 3 test files |
| Test suite | 30-37 passing; ~2/3 written by the agents (varies per run) |

## Questions you'll get

**"Is the progress bar real?"**
Yes. It moves only on events from the agent's process — stage transitions come from actual tool
calls, and the percentage prefers the agent's own todo list. The `ⓘ` line names the event that
last moved it. There's a test asserting it cannot advance without an event.

**"What if two agents edit the same file?"**
They can't. Each ticket declares the files it owns and a hook blocks anything else. That's what
makes the parallelism real rather than staged.

**"Could it break the codebase?"**
Agents are confined to `attendance-api/`, can't run arbitrary shell commands, and everything they
do is a git diff you can revert. The attendance app itself is never touched.

**"How much does it cost?"**
About $0.30 per ticket at current sizes, capped per agent by `--max-budget-usd`.

**"Does this work with our real tickets?"**
Yes — the Jira source is wired. Assign a ticket to yourself and an agent picks it up within 15 s.
The file-drop source is used for the demo because it doesn't depend on the network.
