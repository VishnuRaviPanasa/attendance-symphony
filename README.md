# AttendPro — Attendance Management + Symphony

Three things live here. **Read this first, because two of them look alike and only
one of them is real.**

| | What it is | Real or simulated |
|---|---|---|
| **`jira-symphony/`** | **Symphony Operations Console** — spawns real Claude Code processes that build real features, in parallel | **REAL execution** |
| `index.html` | The AttendPro attendance app (login, dashboard, reports, `localStorage`) | Real app |
| `symphony-dashboard.html` | The older standalone "agents in parallel" screen | **Simulated — animation only** |

## ▶ For the manager demo, use `jira-symphony/`

```bash
cd attendance-api && npm start      # the API the agents build → http://localhost:4400
cd jira-symphony  && npm start      # the console             → http://localhost:4300
```

Open <http://localhost:4300>, click **Create tickets**, and then do nothing. Symphony discovers
the tickets from disk, assigns them to agents, and runs real `claude` processes in parallel.
Progress on screen only moves when those processes emit events.

- **[jira-symphony/DEMO.md](jira-symphony/DEMO.md)** — the manager script and operator runbook
- **[jira-symphony/README.md](jira-symphony/README.md)** — architecture and how progress is derived

Measured: 3 agents, 800 s of agent work compressed into ~2–7 min wall clock, ~$0.72–1.45,
producing 3 live endpoints and 3 test files (37 tests pass; 28 of them written by the agents).

## ⚠ The older simulated screens

`symphony-dashboard.html`, `symphony-app.html` and the **Symphony Build** tab inside
`index.html` are a **client-side simulation** — progress advances on a `setInterval` and the
token counts come from `Math.random()`. They are kept for reference and as a projector fallback.

**Do not present them as real agent activity.** If you want a fallback that is still truthful,
use the console's replay mode instead: it re-plays a recorded transcript of agents that genuinely
ran, behind a permanent REPLAY banner.

---

## The attendance app itself

## Two ways to open it

**A) The full app** — double-click **`index.html`**. Sign in, use the attendance
system, and open the *Symphony Build* tab inside it. Best for the complete story.

**B) The standalone agents dashboard** — double-click **`symphony-dashboard.html`**.
This opens **directly** to a full-screen "agents working in parallel" view — no
login, dark by default, with a Fullscreen button. **Use this one to project for
your manager** when you just want to show the parallel-agent build. It shows the
whole agent fleet at once (6 building in parallel by default), live token rate,
task board, and orchestrator log.

Both work fully offline in any browser. Light & dark themes (toggle top-right).

**Shareable links (for a remote manager):**
- Full app: https://claude.ai/code/artifact/cf4b2b82-7deb-45c9-8f43-edf02fc12e3d
- Standalone agents dashboard: https://claude.ai/code/artifact/cd9ec31f-0f1e-49c1-9605-74b3bc3c9f01

## Demo login accounts

| Role       | Email                       | Password      | Sees                                   |
|------------|-----------------------------|---------------|----------------------------------------|
| HR Admin   | `admin@panasatech.com`      | `admin123`    | Everything incl. Symphony Build Console |
| Employee   | `arjun.rao@panasatech.com`  | `employee123` | Own attendance + check-in/out           |

On the login screen, click a **demo account card** to auto-fill the credentials.

## Suggested demo script (≈4 minutes)

1. **Sign in** as HR Admin (click the "HR Admin" card, then Sign in).
2. **Dashboard** — point out present/late/on-leave tiles, the 7-day trend, the
   "today by status" donut, and per-department attendance rates.
3. **Attendance** — check someone in/out live; show the status updates instantly.
4. **Employees / Reports** — add an employee, filter reports, click **Export CSV**.
5. **Symphony Build (the highlight)** — this is the "agents working in parallel"
   screen:
   - Show the **task board** (Backlog → Claimed → Running → In Review → Done) and
     the **agent lanes** — several agents each on a *different* task, at
     *different* phases, streaming logs simultaneously.
   - Type a feature (e.g. *"Overtime & payroll export"*) → **Dispatch to agents**.
     Watch it split into tasks that get picked up by free agents in parallel.
   - Drag the **Max parallel** slider down to 2 to show **backpressure** (extra
     tasks wait in the queue); raise it to show more agents spin up.
   - Watch PRs merge and "feature shipped" tick up in the header.
6. Optionally sign out and sign in as the **Employee** to show the self-service
   check-in view.

## Files

- `index.html` — the full attendance app (login + dashboard + Symphony tab). **(self-contained)**
- `symphony-dashboard.html` — **standalone "agents in parallel" dashboard** (no login). **(self-contained)**
- `app.html` / `symphony-app.html` — body-only sources used to publish the web links.
- `_shots/` — ready-made screenshots you can drop straight into a slide deck.
- `README.md` — this file.

## Notes

- The Symphony console **inside `index.html`** and `symphony-dashboard.html` is a
  simulation — kept for reference. The real one now exists: see `jira-symphony/`,
  which spawns actual Claude Code processes. Do not mix them up when presenting.
- To reset all demo data to the seeded state: open the browser console and run
  `localStorage.clear()`, then refresh.
