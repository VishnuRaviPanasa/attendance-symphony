import { countsForDay, deptRates, todayKey, listEmployees, isValidDateString } from "../lib/store.js";

export const meta = {
  name: "summary",
  description: "Daily attendance summary with totals, headcount, attendance rate, and per-department breakdown",
};

export default function register(router) {
  router.get("/api/attendance/summary", (req, res) => {
    const dateParam = req.query.date;
    const date = dateParam !== undefined ? dateParam : todayKey();

    if (!isValidDateString(date)) {
      return res.status(400).json({ error: `Invalid date "${date}". Expected YYYY-MM-DD.` });
    }

    const totals = countsForDay(date);
    const headcount = listEmployees().length;
    const attended = totals.present + totals.late + totals.remote;
    const attendanceRate = headcount > 0 ? +(attended / headcount).toFixed(4) : 0;
    const byDepartment = deptRates(date);

    res.json({ date, totals, headcount, attendanceRate, byDepartment });
  });
}
