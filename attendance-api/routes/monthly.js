import { allDates, historyFor, listEmployees, isValidMonthString, currentMonth, STATUSES } from "../lib/store.js";

export const meta = {
  name: "monthly",
  description: "Monthly attendance roll-up per employee",
};

export default function register(router) {
  router.get("/api/reports/monthly", (req, res) => {
    const month = req.query.month ?? currentMonth();

    if (!isValidMonthString(month)) {
      return res.status(400).json({ error: `Invalid month "${month}". Expected YYYY-MM (e.g. 2026-08).` });
    }

    // All dates in the dataset that fall in this month
    const workingDays = allDates().filter((d) => d.startsWith(month + "-"));

    if (workingDays.length === 0) {
      return res.json({ month, workingDays: 0, employees: [], totals: buildTotals([]) });
    }

    const workingDaySet = new Set(workingDays);

    const employees = listEmployees().map((emp) => {
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      let totalHours = 0;

      for (const row of historyFor(emp.id)) {
        if (!workingDaySet.has(row.date)) continue;
        if (counts[row.status] !== undefined) counts[row.status]++;
        if (typeof row.hours === "number") totalHours += row.hours;
      }

      const attended = (counts.present ?? 0) + (counts.late ?? 0) + (counts.remote ?? 0);
      const attendanceRate = +(attended / workingDays.length).toFixed(4);

      return { id: emp.id, name: emp.name, dept: emp.dept, ...counts, totalHours: +totalHours.toFixed(2), attendanceRate };
    });

    return res.json({ month, workingDays: workingDays.length, employees, totals: buildTotals(employees) });
  });
}

function buildTotals(employees) {
  const totals = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  totals.totalHours = 0;

  for (const emp of employees) {
    for (const s of STATUSES) totals[s] += emp[s] ?? 0;
    totals.totalHours += emp.totalHours ?? 0;
  }

  totals.totalHours = +totals.totalHours.toFixed(2);
  return totals;
}
