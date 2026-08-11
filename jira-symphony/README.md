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
cd jira-symphony && npm start          # console  → http://localhost:4300
cd attendance-api && npm start         # work API → http://localhost:4400
```

Then open <http://localhost:4300>, click **Create tickets**, and do nothing else.

Ports are 4300/4400 because **4000 and 3000 are already in use on this machine**.

## The demo

See **[DEMO.md](DEMO.md)** for the 7-minute manager script and the operator runbook.

---

## Why the parallelism is real

Agents write into `attendance-api/`, whose `server.js` auto-discovers `routes/*.js` — drop a file
in and the endpoint goes live with no restart. Each ticket therefore **owns its own files**:

| Ticket | Owns |
|---|---|
| ATT-101 summary API | `routes/summary.js`, `tests/summary.test.js` |
| ATT-102 monthly report | `routes/monthly.js`, `tests/monthly.test.js` |
| ATT-103 validation | `routes/validation.js`, `tests/validation.test.js` |

No two agents ever touch the same file, so they genuinely run at once rather than serialising.
A `PreToolUse` hook (`hooks/scope-guard.mjs`) enforces this — see [Containment](#containment).

**Measured:** 3 agents, 234 s of agent work, **~130 s wall clock**, ~$1.08, 32 tests passing
(9 hand-written + 23 written by the agents).

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
