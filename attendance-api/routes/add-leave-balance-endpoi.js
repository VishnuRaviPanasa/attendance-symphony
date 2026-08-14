// GET /api/leave-balance — returns the leave balance for every employee.
//
// "leaveUsed"      = days with status "leave" in the attendance store.
// "leaveAllotted"  = fixed annual entitlement (ANNUAL_LEAVE_DAYS constant).
// "leaveRemaining" = allotted − used, floored at 0.
import { listEmployees, historyFor } from "../lib/store.js";

const ANNUAL_LEAVE_DAYS = 20;

export const meta = {
  name: "leave-balance",
  description: "Leave balance (used / allotted / remaining) for each employee",
};

/** Pure function — extracted so the test file can call it without HTTP. */
export function computeLeaveBalances() {
  return listEmployees().map((emp) => {
    const leaveUsed = historyFor(emp.id).filter((r) => r.status === "leave").length;
    return {
      id: emp.id,
      name: emp.name,
      dept: emp.dept,
      leaveUsed,
      leaveAllotted: ANNUAL_LEAVE_DAYS,
      leaveRemaining: Math.max(0, ANNUAL_LEAVE_DAYS - leaveUsed),
    };
  });
}

export default function register(router) {
  router.get("/api/leave-balance", (_req, res) => {
    res.json({ balances: computeLeaveBalances() });
  });
}
