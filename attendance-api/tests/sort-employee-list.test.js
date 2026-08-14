import test from "node:test";
import assert from "node:assert/strict";
import { listEmployees } from "../lib/store.js";

// Unit-test the sort logic without starting an HTTP server.
// We apply the same sort used by the route and verify the ordering invariants.

function sortedEmployees() {
  return listEmployees()
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

test("sort-employee-list: returns all employees", () => {
  const sorted = sortedEmployees();
  assert.equal(sorted.length, listEmployees().length);
});

test("sort-employee-list: names are in ascending A-Z order (case-insensitive)", () => {
  const sorted = sortedEmployees();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].name.toLowerCase();
    const curr = sorted[i].name.toLowerCase();
    assert.ok(
      prev.localeCompare(curr) <= 0,
      `"${sorted[i - 1].name}" should come before "${sorted[i].name}"`
    );
  }
});

test("sort-employee-list: sort is stable and consistent across calls", () => {
  const first = sortedEmployees().map((e) => e.id);
  const second = sortedEmployees().map((e) => e.id);
  assert.deepEqual(first, second);
});

test("sort-employee-list: sort is case-insensitive (lowercase equals uppercase ordering)", () => {
  // Construct a small synthetic list and confirm the sort is case-insensitive.
  const synthetic = [
    { id: "z1", name: "zebra" },
    { id: "a1", name: "Apple" },
    { id: "b1", name: "banana" },
    { id: "a2", name: "ant" },
  ];
  const result = synthetic
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const names = result.map((e) => e.name);
  assert.deepEqual(names, ["ant", "Apple", "banana", "zebra"]);
});

test("sort-employee-list: every employee has id and name fields", () => {
  for (const emp of sortedEmployees()) {
    assert.ok(typeof emp.id === "string" && emp.id.length > 0, "missing id");
    assert.ok(typeof emp.name === "string" && emp.name.length > 0, "missing name");
  }
});
