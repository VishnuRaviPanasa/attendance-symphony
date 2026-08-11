// The demo ticket set.
//
// Every ticket owns a DIFFERENT file. That is not a stylistic choice — it is what makes the
// parallelism real. Two agents editing one file would serialise or corrupt each other, and the
// headline claim of the demo ("they ran at the same time") would be theatre.
//
// Ticket 105 deliberately targets a file another ticket owns; it is the failure/retry
// demonstration and is not part of the default set.

export const DEMO_TICKETS = [
  {
    id: "101",
    key: "ATT-101",
    title: "Add employee attendance summary API",
    kind: "backend",
    priority: 1,
    scope: ["routes/summary.js", "tests/summary.test.js"],
    spec: "HR needs one endpoint that summarises attendance for a given day, so the browser app stops recalculating it client-side on every render.",
    acceptance: [
      "GET /api/attendance/summary returns JSON for today by default.",
      "Accepts an optional ?date=YYYY-MM-DD query parameter and uses that day instead.",
      "Response includes: date, totals (head-count per status: present, late, absent, leave, remote, unmarked), headcount, and attendanceRate ((present+late+remote)/headcount rounded to 4 decimals).",
      "Response includes byDepartment using deptRates() from lib/store.js.",
      "An invalid date returns HTTP 400 with a clear { error } message.",
      "Exports a meta object with name and description, matching routes/health.js.",
      "Also write tests/summary.test.js covering: the default (no date), an explicit valid date, and a rejected malformed date. Import your handler logic directly or assert against lib/store.js — do not start a server in the test.",
      "DATE VALIDATION: import isValidDateString from lib/store.js and use it. Do not write your own date check — the obvious one has a timezone bug.",
    ],
    verify: "npm test",
  },
  {
    id: "102",
    key: "ATT-102",
    title: "Add monthly attendance report",
    kind: "backend",
    priority: 1,
    scope: ["routes/monthly.js", "tests/monthly.test.js"],
    spec: "Managers need a per-month roll-up per employee for payroll and review conversations.",
    acceptance: [
      "GET /api/reports/monthly?month=YYYY-MM returns a report for that month.",
      "Defaults to the current month when ?month is omitted.",
      "Includes workingDays (count of distinct dates present in the data for that month).",
      "Includes an employees array; each entry has id, name, dept, and counts per status, plus totalHours (sum of the hours field) and attendanceRate.",
      "Includes a totals object aggregating across all employees.",
      "A malformed month returns HTTP 400 with a clear { error } message.",
      "A month with no data returns 200 with workingDays: 0 and an empty employees array — not an error.",
      "Uses allDates(), historyFor() and listEmployees() from lib/store.js.",
      "Also write tests/monthly.test.js covering: a month with data, a month with no data, and a malformed month.",
      "MONTH VALIDATION: import isValidMonthString and currentMonth from lib/store.js and use them. Filter dates with `date.startsWith(month)` — never via a Date round-trip.",
    ],
    verify: "npm test",
  },
  {
    id: "103",
    key: "ATT-103",
    title: "Add attendance check-in validation endpoint",
    kind: "backend",
    priority: 2,
    scope: ["routes/validation.js", "tests/validation.test.js"],
    spec: "Check-in data arrives from several devices and needs validating before it is trusted. Today nothing validates it.",
    acceptance: [
      "POST /api/attendance/validate accepts a JSON body { empId, date, status, checkIn, checkOut }.",
      "Returns { valid: true, normalized } when the record is sound, where normalized has checkIn/checkOut as HH:MM and a computed hours value (checkOut - checkIn - 1 for lunch, never negative).",
      "Returns { valid: false, errors: [...] } listing EVERY problem found, not just the first.",
      "Rejects: unknown empId, malformed date, a status outside present/late/absent/leave/remote, times not in HH:MM, and checkOut earlier than checkIn.",
      "present, late and remote require a checkIn; absent and leave must NOT have one.",
      "Always responds 200 — validity is carried in the body, not the status code.",
      "Uses getEmployee() and STATUSES from lib/store.js.",
      "Also write tests/validation.test.js covering: a fully valid record, several invalid records, and the absent/leave rules.",
      "DATE VALIDATION: import isValidDateString from lib/store.js and use it for the date check. Do NOT write your own — the obvious implementation has a timezone bug. Your test must assert that a real date such as 2026-07-15 is ACCEPTED.",
    ],
    verify: "npm test",
  },
  {
    id: "104",
    key: "ATT-104",
    title: "Add API test coverage for the store layer",
    kind: "testing",
    priority: 2,
    scope: ["tests/coverage.test.js"],
    spec: "The store layer underpins every endpoint but only has smoke tests. Pin its real behaviour before more features land on it.",
    acceptance: [
      "Creates tests/coverage.test.js using node:test and node:assert/strict.",
      "Covers historyFor (ordering and shape), allDates (sorted, no duplicates), countsForDay for a date with no data, and recFor/statusFor for a known employee.",
      "Asserts that hours is never negative anywhere in the dataset.",
      "Asserts every stored status is one of the values in STATUSES.",
      "Tests must describe the CODE AS IT IS. Do not modify lib/store.js — if something looks wrong, write a test that documents the actual behaviour.",
      "npm test passes with the new file included.",
    ],
    verify: "npm test",
  },
  {
    id: "106",
    key: "ATT-106",
    title: "Document the attendance API",
    kind: "docs",
    priority: 3,
    scope: ["docs/API.md"],
    spec: "There is no written reference for the API. Produce one from what the code actually does.",
    acceptance: [
      "Creates docs/API.md.",
      "Documents every endpoint currently registered in routes/ — read the files, do not guess.",
      "For each: method, path, query/body parameters, a realistic example response, and error cases.",
      "Includes a short section describing the auto-discovery pattern (drop a file in routes/, it goes live).",
      "Accurate over exhaustive: if an endpoint does not exist yet, do not document it.",
    ],
    verify: "npm test",
  },
];

/**
 * A ticket engineered to FAIL: it tries to modify a file it does not own.
 * The scope hook blocks the write, the run fails, and Symphony retries it — which is the
 * failure-handling story on the dashboard.
 */
export const FAILURE_TICKET = {
  id: "105",
  key: "ATT-105",
  title: "Refactor the shared store helpers",
  kind: "backend",
  priority: 1,
  scope: [],
  spec: "Rework lib/store.js to add caching.",
  acceptance: ["Modify lib/store.js directly to add a caching layer."],
  verify: "npm test",
};
