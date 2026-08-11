// Baseline route — also the worked example every agent is pointed at.
//
// THE PATTERN:
//   1. export a `meta` object describing the feature
//   2. export default a function that receives an express Router and registers handlers
//   3. read data through ../lib/store.js — never read data/attendance.json directly
//
// Adding a file like this to routes/ makes the endpoint live without touching server.js.
import { db, listEmployees, allDates, todayKey } from "../lib/store.js";

export const meta = {
  name: "health",
  description: "Service liveness and dataset summary",
};

export default function register(router) {
  router.get("/api/health", (_req, res) => {
    const dates = allDates();
    res.json({
      ok: true,
      service: "attendance-api",
      today: todayKey(),
      employees: listEmployees().length,
      days: dates.length,
      range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      seededAt: new Date(db().created).toISOString(),
    });
  });
}
