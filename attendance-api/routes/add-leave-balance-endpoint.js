// Leave balance endpoint.
// GET /api/leave-balance
// Returns the annual leave allowance, days taken, and remaining balance for every employee.

import { listEmployees, historyFor } from "../lib/store.js";

export const meta = {
  name: "add-leave-balance-endpoint",
  description: "Leave balance (taken / remaining) for each employee",
};

// Standard annual leave allowance in days.
const ANNUAL_LEAVE_DAYS = 20;

export default function register(router) {
  router.get("/api/leave-balance", (_req, res) => {
    const employees = listEmployees();

    const balances = employees.map((emp) => {
      const taken = historyFor(emp.id).filter((r) => r.status === "leave").length;
      const remaining = Math.max(0, ANNUAL_LEAVE_DAYS - taken);
      return {
        id: emp.id,
        name: emp.name,
        dept: emp.dept,
        leaveAllowance: ANNUAL_LEAVE_DAYS,
        leavesTaken: taken,
        leaveBalance: remaining,
      };
    });

    res.json({ employees: balances });
  });
}
