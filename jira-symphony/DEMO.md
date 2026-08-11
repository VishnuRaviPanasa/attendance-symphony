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

**Rehearse the whole thing twice.** Runs take 2–3 minutes and vary.

---

## The script (~7 minutes)

### 1 · The application (0:00)
Open `index.html`. Dashboard, attendance, reports.
> "This is our Attendance Management application."

### 2 · The console (0:45)
Switch to <http://localhost:4300>.
> "This is Symphony, the orchestration console. Right now it's idle — no agents, empty queue."

Point out the flow diagram: task queue → orchestrator → nothing yet.

### 3 · Create the tickets (1:15)
Click **+ Create tickets**.
> "I'm creating three tickets: an attendance summary API, a monthly report, and a validation
> endpoint. All I did was create them — they're just JSON files on disk."

*(Optional, and it lands well: show `tickets/inbox/` in a file explorer beforehand and drop a
ticket in by hand. It behaves identically — the button has no privileged path.)*

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

### 8 · Live progress (2:30 – 5:30)
Narrate what the cards say — don't invent:
> "Agent 01 is reading the repository. Agent 02 is already writing code — that's a real file
> path. Agent 03 just ran the test suite."

If someone asks whether the bar is real, point at the `ⓘ` under it:
> "That line names the event that last moved the bar. `tool call: Write`. It only moves when
> something actually happens — if an agent is thinking, it sits still."

### 9 · Completion (~5:30)
Cards flip to **● COMPLETED**, 100 %, with completion time, files written, tests, and cost.
> "Done. Files written, tests passed, results recorded."

### 10 · The proof (6:00)
In the terminal:
```bash
git status --short attendance-api      # the files they created
cd attendance-api && npm test          # 32 tests pass — 23 written by the agents
curl "http://localhost:4400/api/attendance/summary"
curl "http://localhost:4400/api/reports/monthly?month=2026-07"
```
> "Here's the code they wrote, their own tests passing, and the endpoints live and returning
> real data. I never restarted the server — the API picks new routes up on its own."

### 11 · Close (6:45)
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
| Wall clock, 3 agents | ~130 s (234 s of agent work) |
| Cost | ~$1.08 for three tickets (~$0.25–0.35 each) |
| Output | 3 endpoints + 3 test files, 32 tests passing |
| Agents' own tests | 23 of the 32 |

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
