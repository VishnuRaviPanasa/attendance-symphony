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
cd attendance-api && npm start      # the app + the API the agents build
cd jira-symphony  && npm start      # the Symphony console
```

| | URL |
|---|---|
| Attendance app | <http://localhost:4400/app> |
| Symphony console | <http://localhost:4300> |
| Agent-built API | <http://localhost:4400/api/_routes> |

(The app also still works opened straight from disk as `index.html`, fully offline.)

Open <http://localhost:4300>, click **Create tickets**, and then do nothing. Symphony discovers
the tickets from disk, assigns them to agents, and runs real `claude` processes in parallel.
Progress on screen only moves when those processes emit events.

- **[jira-symphony/DEMO.md](jira-symphony/DEMO.md)** — the manager script and operator runbook
- **[jira-symphony/README.md](jira-symphony/README.md)** — architecture and how progress is derived

Measured: 3 agents, 2–7 min wall clock, $0.72–1.45, producing 3 live endpoints and 3 test
files. The app's dashboard then shows those endpoints' data where it showed nothing before.

## ⚠ The older simulated screens

`symphony-dashboard.html`, `symphony-app.html` and the **Symphony Build** tab inside
`index.html` are a **client-side simulation** — progress advances on a `setInterval` and the
token counts come from `Math.random()`. They are kept for reference and as a projector fallback.

**Do not present them as real agent activity.** If you want a fallback that is still truthful,
use the console's replay mode instead: it re-plays a recorded transcript of agents that genuinely
ran, behind a permanent REPLAY banner.

---

## The attendance app itself

Double-click **`index.html`**. Sign in and use the attendance system: dashboard,
employee directory, check-in/check-out, reports and CSV export. It works fully
offline in any browser, with light & dark themes (toggle top-right), and stores
data in `localStorage`.

It also contains a *Symphony Build* tab — that tab is the **simulation**, not the
real console. For real agent execution use `jira-symphony/` as described above.

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
5. Optionally sign out and sign in as the **Employee** to show the self-service
   check-in view.
6. **For the agent story, switch to the real console** — see
   [jira-symphony/DEMO.md](jira-symphony/DEMO.md). Do not use the simulated
   Symphony Build tab for that part.

## Files

- `jira-symphony/` — **the real Symphony Operations Console** (spawns actual agents).
- `attendance-api/` — the API the agents build; routes are auto-discovered from `routes/*.js`.
- `tickets/inbox/` — drop a ticket JSON here and Symphony picks it up on its own.
- `index.html` — the full attendance app (login + dashboard + simulated Symphony tab).
- `symphony-dashboard.html` — the older simulated agents dashboard. **(animation only)**
- `app.html` / `symphony-app.html` — body-only sources used to publish the web links.
- `_shots/` — screenshots for slides. Note: shots 4-6, 8 show the *simulated* board.
- `README.md` — this file.

## Notes

- The Symphony console **inside `index.html`** and `symphony-dashboard.html` is a
  simulation — kept for reference. The real one now exists: see `jira-symphony/`,
  which spawns actual Claude Code processes. Do not mix them up when presenting.
- To reset all demo data to the seeded state: open the browser console and run
  `localStorage.clear()`, then refresh.
