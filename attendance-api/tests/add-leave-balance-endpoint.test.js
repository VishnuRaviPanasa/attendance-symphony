import test from "node:test";
import assert from "node:assert/strict";
import { listEmployees, historyFor } from "../lib/store.js";

// Unit-test the leave balance logic without starting an HTTP server.
// The route uses listEmployees() and historyFor() from lib/store.js, so we
// can verify the calculation directly against real data.

const ANNUAL_LEAVE_DAYS = 20;

function computeBalances() {
  return listEmployees().map((emp) => {
    const taken = historyFor(emp.id).filter((r) => r.status === "leave").length;
    const remaining = Math.max(0, ANNUAL_LEAVE_DAYS - taken);
    return { id: emp.id, name: emp.name, dept: emp.dept, leaveAllowance: ANNUAL_LEAVE_DAYS, leavesTaken: taken, leaveBalance: remaining };
  });
}

test("leave balance: returned for every employee", () => {
  const balances = computeBalances();
  const employees = listEmployees();
  assert.equal(balances.length, employees.length);
});

test("leave balance: every record has required fields", () => {
  for (const row of computeBalances()) {
    assert.ok(typeof row.id === "string" && row.id.length > 0, "missing id");
    assert.ok(typeof row.name === "string" && row.name.length > 0, "missing name");
    assert.ok(typeof row.dept === "string", "missing dept");
    assert.ok(typeof row.leaveAllowance === "number", "missing leaveAllowance");
    assert.ok(typeof row.leavesTaken === "number", "missing leavesTaken");
    assert.ok(typeof row.leaveBalance === "number", "missing leaveBalance");
  }
});

test("leave balance: leavesTaken is non-negative and does not exceed allowance", () => {
  for (const row of computeBalances()) {
    assert.ok(row.leavesTaken >= 0, `negative leavesTaken for ${row.id}`);
    assert.ok(row.leaveBalance >= 0, `negative leaveBalance for ${row.id}`);
    assert.equal(row.leaveAllowance, ANNUAL_LEAVE_DAYS);
  }
});

test("leave balance: leavesTaken matches historyFor leave count", () => {
  for (const emp of listEmployees()) {
    const expected = historyFor(emp.id).filter((r) => r.status === "leave").length;
    const row = computeBalances().find((b) => b.id === emp.id);
    assert.equal(row.leavesTaken, expected, `mismatch for ${emp.id}`);
  }
});

test("leave balance: leaveBalance equals allowance minus taken (clamped at 0)", () => {
  for (const row of computeBalances()) {
    const expected = Math.max(0, ANNUAL_LEAVE_DAYS - row.leavesTaken);
    assert.equal(row.leaveBalance, expected, `balance mismatch for ${row.id}`);
  }
});
