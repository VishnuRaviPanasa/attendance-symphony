import test from "node:test";
import assert from "node:assert/strict";
import { computeLeaveBalances } from "../routes/add-leave-balance-endpoi.js";
import { listEmployees, historyFor } from "../lib/store.js";

test("returns one balance entry per employee", () => {
  const balances = computeLeaveBalances();
  assert.equal(balances.length, listEmployees().length);
});

test("each entry has id, name, dept, leaveUsed, leaveAllotted, leaveRemaining", () => {
  for (const b of computeLeaveBalances()) {
    assert.equal(typeof b.id, "string");
    assert.equal(typeof b.name, "string");
    assert.equal(typeof b.dept, "string");
    assert.equal(typeof b.leaveUsed, "number");
    assert.equal(typeof b.leaveAllotted, "number");
    assert.equal(typeof b.leaveRemaining, "number");
  }
});

test("leaveUsed matches actual leave records in the store", () => {
  for (const b of computeLeaveBalances()) {
    const expected = historyFor(b.id).filter((r) => r.status === "leave").length;
    assert.equal(b.leaveUsed, expected, `leaveUsed mismatch for ${b.id}`);
  }
});

test("leaveRemaining equals leaveAllotted minus leaveUsed, floored at 0", () => {
  for (const b of computeLeaveBalances()) {
    assert.equal(b.leaveRemaining, Math.max(0, b.leaveAllotted - b.leaveUsed));
  }
});

test("leaveUsed and leaveRemaining are non-negative integers", () => {
  for (const b of computeLeaveBalances()) {
    assert.ok(b.leaveUsed >= 0, `${b.id}: leaveUsed is negative`);
    assert.ok(b.leaveRemaining >= 0, `${b.id}: leaveRemaining is negative`);
    assert.equal(b.leaveUsed % 1, 0, `${b.id}: leaveUsed is not integer`);
    assert.equal(b.leaveRemaining % 1, 0, `${b.id}: leaveRemaining is not integer`);
  }
});

test("dataset contains at least one employee with recorded leave", () => {
  const balances = computeLeaveBalances();
  const anyLeave = balances.some((b) => b.leaveUsed > 0);
  assert.ok(anyLeave, "expected at least one employee with leave days used");
});
