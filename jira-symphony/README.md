# Symphony — Operations Console

Symphony discovers tickets on its own, assigns them to agents, and runs **real Claude Code
processes in parallel** to implement them. The console shows what those processes are actually
doing, live.

> **What changed.** This used to be a faithful *simulation*: progress advanced on a timer and
> tokens came from `Math.random()`. It now spawns real `claude` processes and every number on
> screen is traceable to an event one of them emitted. See [MIGRATION](#what-replaced-what).

```
tickets/inbox/*.json  ─┐
Jira (assignee = you) ─┴─►  watcher  ─►  ORCHESTRATOR  ─►  N × real `claude` process
                                          queue                    │
                                          backpressure             │ stream-json on stdout
                                          retry                    ▼
                                                          normalise → progress → SSE → console
```

---

## Run it

```bash
cd attendance-api && npm start   # attendance app → http://localhost:4400/app
                                 # agent-built API → http://localhost:4400/api/...
cd jira-symphony  && npm start   # Symphony console → http://localhost:4300
```

Then open <http://localhost:4300>, click **Create tickets**, and do nothing else.

Ports are 4300/4400 because **4000 and 3000 are already in use on this machine**.

## The demo

See **[DEMO.md](DEMO.md)** for the 7-minute manager script and the operator runbook.

---

## How this maps to Symphony

Measured against the definition in [`spec-kit-vs-symphony.html`](../spec-kit-vs-symphony.html):
*"treats an issue tracker as the control plane: watches for ready tickets, spins up an isolated
workspace per ticket, dispatches a coding agent to each, runs tests, opens a Pull Request, and
reports back."*

| Symphony property | Here |
|---|---|
| Watches for ready tickets | ✅ file watcher + Jira poller |
| **Isolated workspace per ticket** | ✅ a real `git worktree` per ticket (`lib/workspace.js`) |
| Dispatches an agent to each | ✅ one real `claude` process per ticket |
| Parallelism with backpressure | ✅ concurrency cap; queued tickets wait for a slot |
| **Runs tests** | ✅ the orchestrator runs them **itself**, in the agent's worktree — see below |
| **Reports back to the tracker** | ✅ Jira comment + To Do → In Progress → Done (needs `JIRA_*` in `.env`) |
| Claim states | ✅ queued → assigned → working → retry → released |
| Proof of work | ✅ tokens, runtime, cost, files, verified test result, branch + commit |
| **Opens a Pull Request** | ⚠️ branch + commit per ticket always; pushed with a PR link when a remote exists (`DELIVERY_MODE=pr`) |
| Execution phase names | ❌ replaced with stages derived from real events (see below) |

### Verification is independent

Until recently a ticket was "completed" when the agent's process exited cleanly and emitted a
result event — **the agent's account of its own work**. An agent that wrote a failing test still
showed green.

`lib/verify.js` now runs the suite itself, in the agent's worktree, after it finishes and before
anything is merged:

| Ticket kind | Gate |
|---|---|
| backend / testing / docs | the ticket's `verify` command, default `npm test` |
| frontend | structural check — file complete, every inline script parses, no external resources |

Red fails the ticket and the normal retry path takes over. `COMPLETED` now means *verified*.

### Delivery

Verified work is committed to its own branch (`sym/att-101`) with a message recording the
request, the verification result and which agent did it. `DELIVERY_MODE` decides what happens
next:

| Mode | Behaviour |
|---|---|
| `merge` *(default)* | branch + commit, then merged into the working tree |
| `pr` | branch pushed, PR link produced, **working tree untouched** — closest to Symphony |
| `both` | pushed *and* merged, i.e. auto-merge on green — **use this for a demo** |
| `off` | no branch at all |

> **`pr` mode does not change the app.** That is the point of it — the work waits on a branch for
> a human to merge. It is also the single most confusing thing here if you forget you set it: the
> console says COMPLETED, verification says PASS, and the application looks untouched because it
> *is* untouched. The console now says so on every completed card, and the header carries
> `delivery pr (work stays on branches — the app does NOT change)`.
>
> For a manager demo use `both`: the branch and PR still exist as the audit trail, and the app
> visibly changes when you refresh.

`pr` and `both` need a git remote; without one the branch is still created locally, so there is
always a per-ticket artefact to inspect with `git show sym/att-101`.

**One deliberate departure worth naming.** The free-text ticket box is *task production*, which
is Spec Kit's half of the pipeline — the same document says *"Spec Kit produces tasks; Symphony
consumes them."* So this is **Spec-Kit-style intake feeding a Symphony-style orchestrator**.
That composition is what the report's "Using them together" section recommends, but it is worth
saying out loud rather than presenting free-text triage as a Symphony feature.

The phase names also differ on purpose: Symphony's `PreparingWorkspace → BuildingPrompt → …`
describe the *orchestrator's* steps, whereas the stages here are derived from what the agent is
actually observed doing. Honesty about the agent was worth more than matching the vocabulary.

---

## Why the parallelism is real

Agents write into `attendance-api/`, whose `server.js` auto-discovers `routes/*.js` — drop a file
in and the endpoint goes live with no restart. Each ticket therefore **owns its own files**:

| Ticket | Owns |
|---|---|
| ATT-101 summary API | `routes/summary.js`, `tests/summary.test.js` |
| ATT-102 monthly report | `routes/monthly.js`, `tests/monthly.test.js` |
| ATT-103 validation | `routes/validation.js`, `tests/validation.test.js` |

Beyond disjoint files, **each ticket runs in its own `git worktree`**, so two agents can edit
the *same* file at once — two UI tickets both changing `index.html`, for instance. On completion
each agent's work is three-way merged back (`git merge-file`, base = the commit the worktree was
cut from). Non-overlapping edits both survive; a genuine overlap fails that ticket with
`merge conflict in <file>` rather than silently discarding the other agent's work.

Verified: "Change the UI theme to black" and "Make the sidebar labels larger and bolder" ran
concurrently against `index.html` and both landed — black palette *and* larger nav, no conflict
markers.

A `PreToolUse` hook (`hooks/scope-guard.mjs`) still bounds what each agent may write — see
[Containment](#containment).

**Measured:** 3 agents, 2-7 min wall clock, $0.72-1.45, 30-37 tests passing — 9 hand-written,
the rest produced by the agents (the count varies because they choose their own coverage).

---

## How progress is derived

`lib/progress.js` exists to enforce one rule:

> **Progress moves only when an event arrives. Never on a timer.**

If an agent thinks for 40 seconds the bar does not move. That is correct.

| Stage | Floor | Real signal |
|---|---|---|
| `queued` | 0 % | ticket file appeared |
| `assigned` | 5 % | orchestrator bound it to a slot |
| `initializing` | 10 % | `system/init` event |
| `planning` | 20 % | first `TodoWrite` |
| `analyzing` | 35 % | first `Read`/`Glob`/`Grep` |
| `implementing` | 60 % | first `Write`/`Edit` |
| `testing` | 85 % | `Bash` matching a test runner |
| `reviewing` | 95 % | final text, no result yet |
| `completed` | 100 % | `result` with `is_error: false` |

Within a stage: **+2 % per real tool call**, capped below the next floor. Monotonic.
When the agent keeps a todo list, `10 + 85 × (done/total)` takes over — that is the agent's own
`TodoWrite`, and the card's "Now:" line is its `activeForm` string verbatim.

`planning` sits before `analyzing` because that is the order agents actually work in — both the
captured probe and the first live ticket planned first, then read.

Every card carries a `ⓘ whyPercent` line naming the event that last moved the bar.

**Four tests enforce this** (`tests/progress.test.js`), replayed against a real captured
transcript rather than fixtures:
- progress cannot advance without an inbound event
- `progress.js` contains no `Date.now`/`setInterval`/`setTimeout` in the percentage path
- 100 % is reachable only via a real `result` event
- progress is monotonic across the whole run

---

## Containment

`--allowedTools` is **not** a sandbox. Verified in Phase 0: with
`--allowedTools "… Bash(node:*)"` the agent still successfully ran `ls`.

Containment is `hooks/scope-guard.mjs`, a `PreToolUse` hook passed per-invocation via
`--settings '<inline json>'` (the user's global `~/.claude/settings.json` is never modified):

- writes are rejected outside the ticket's declared `scope`, including `../` traversal
- `Bash` is limited to an allowlist of command heads; `git` is read-only, `npm` is test-only
- refusals are recorded to `runs/<id>/<agent>.denials.jsonl` and shown on the dashboard

Verified: an agent told to modify `lib/store.js` was blocked and left the file untouched.

---

## Layout

| Path | Role |
|---|---|
| `lib/agent-runner.js` | spawns the process, parses stdout, tees the transcript |
| `lib/events.js` | raw stream-json → flat events |
| `lib/progress.js` | the stage machine (no clock) |
| `lib/orchestrator.js` | queue, routing, backpressure, retry |
| `lib/jsonl.js` | chunk-boundary-safe JSONL splitter |
| `lib/replay.js` | replays a recorded run through the same pipeline |
| `lib/workspace.js` | worktree per ticket + three-way merge back |
| `lib/triage.js` | free text → agent, scope, acceptance criteria |
| `lib/sources/file-tickets.js` | `tickets/inbox` watcher (`fs.watch` + 1 s poll) |
| `lib/sources/jira-tickets.js` | Jira poller, reuses `lib/jira.js` |
| `hooks/scope-guard.mjs` | the containment boundary |
| `public/console.html` | the console |
| `samples/SCHEMA.md` | **what stream-json actually emits on this machine** |
| `runs/<id>/` | per-run transcripts, timing sidecars, manifest, denials |

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | full snapshot |
| GET | `/api/stream` | SSE, 250 ms, change-gated |
| POST | `/api/demo/tickets` | write ticket files (`{count}`, `{ids}`, `{failure:true}`) |
| POST | `/api/demo/reset` | clear queue + revert agent code |
| POST | `/api/control` | `{action:"start"\|"stop"}` |
| POST | `/api/config` | `{maxConc}` |
| POST | `/api/task/:id/kill` | kill a running agent (real failure) |
| POST | `/api/task/:id/retry` | re-queue a failed task |
| GET | `/api/runs` · POST `/api/replay/start\|stop` | recorded runs |

## Configuration

`.env` (all optional):

```bash
PORT=4300
API_PORT=4400
AGENTS=6                     # agent slots
MAX_CONCURRENT_AGENTS=3      # backpressure cap
MAX_RETRIES=1
AGENT_MODEL=sonnet
AGENT_EFFORT=medium
MAX_BUDGET_USD=2             # per agent, per attempt
AGENT_TIMEOUT_MS=720000
ISOLATE_WORKSPACES=true      # git worktree per ticket
WRITE_BACK=true              # comment + transition Jira tickets
STATUS_IN_PROGRESS=In Progress
STATUS_DONE=Done

# Optional — enables the Jira ticket source
JIRA_BASE_URL= / JIRA_EMAIL= / JIRA_API_TOKEN= / JIRA_JQL=
```

Auth is inherited from your Claude Code subscription login (`~/.claude/.credentials.json`).
**No API key is needed and none is stored.**

---

## What replaced what

| Was | Now |
|---|---|
| `lib/symphony.js` `tick(dt)` advancing `pp` against `PHASE_MS` | deleted — `lib/orchestrator.js` has no tick |
| `_pushLog()` random lines from a template table | `lib/events.js`, real tool calls |
| `Math.random()` tokens / `+add`/`-del` / PR numbers | `usage` and `total_cost_usd` from the run |
| `_complete()` on a timer | the process's `result` event |
| `_pump()` backpressure | **kept** — it was already real |
| SSE at 300 ms | **kept** — it already worked |
| `lib/jira.js` | **kept** unchanged |

`public/dashboard.html` (the old simulated board) is retired; the state shape it expects no
longer exists.

## Gotchas worth knowing

1. **Nested sessions are refused.** Claude Code will not start inside another Claude Code
   session — it exits 1 with *empty stdout*. The runner scrubs every `CLAUDE*` env var, so the
   server works wherever you start it from.
2. **Editing `attendance-api/lib/` needs a restart.** Route files are re-imported with a
   cache-busting query, but ESM caches their transitive imports; a stale `store.js` once made
   three correct agent-written routes fail to mount. `npm start` runs under `--watch-path=./lib`.
3. **Restart the console after editing `jira-symphony/lib/`** — Node will not pick it up.
4. Ticket files are written via temp-file + atomic rename, so the watcher never sees a partial one.
