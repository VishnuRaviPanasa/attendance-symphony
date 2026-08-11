import test from "node:test";
import assert from "node:assert/strict";
import {
  listEmployees, getEmployee, recFor, statusFor,
  countsForDay, lastWorkingDays, deptRates, allDates, isWeekend,
  isValidDateString, isValidMonthString, currentMonth,
} from "../lib/store.js";

test("isValidDateString accepts real dates regardless of timezone", () => {
  // Regression guard. A UTC round-trip implementation rejects all of these on a
  // UTC+5:30 machine — the bug this helper exists to prevent.
  for (const d of ["2026-07-15", "2026-01-01", "2026-12-31", "2024-02-29", "2026-08-11"]) {
    assert.equal(isValidDateString(d), true, `${d} should be valid`);
  }
});

test("isValidDateString rejects malformed and impossible dates", () => {
  for (const d of ["15-07-2026", "2026-7-15", "2026-13-01", "2026-00-10", "2026-02-30",
                   "2025-02-29", "2026-04-31", "nope", "", null, undefined, 20260715]) {
    assert.equal(isValidDateString(d), false, `${d} should be invalid`);
  }
});

test("isValidMonthString and currentMonth", () => {
  assert.equal(isValidMonthString("2026-07"), true);
  assert.equal(isValidMonthString("2026-13"), false);
  assert.equal(isValidMonthString("2026-7"), false);
  assert.match(currentMonth(), /^\d{4}-\d{2}$/);
});

test("employees are loaded", () => {
  const emps = listEmployees();
  assert.ok(emps.length >= 20);
  assert.equal(getEmployee("E01").name, "Arjun Rao");
  assert.equal(getEmployee("nope"), null);
});

test("statusFor returns 'unmarked' for days with no record", () => {
  assert.equal(statusFor("E01", "1999-01-01"), "unmarked");
  assert.equal(recFor("E01", "1999-01-01"), null);
});

test("countsForDay totals every employee exactly once", () => {
  const day = allDates().at(-1);
  const c = countsForDay(day);
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  assert.equal(total, listEmployees().length);
});

test("lastWorkingDays returns n weekdays, oldest first", () => {
  const days = lastWorkingDays(7);
  assert.equal(days.length, 7);
  for (const d of days) assert.ok(!isWeekend(new Date(d.date + "T00:00:00")), `${d.date} is a weekend`);
  const dates = days.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort(), "not oldest-first");
});

test("deptRates is sorted desc and bounded 0..1", () => {
  const rows = deptRates(allDates().at(-1));
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.rate >= 0 && r.rate <= 1, `rate out of range: ${r.rate}`);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].rate >= rows[i].rate, "not sorted desc");
});

test("dataset spans multiple months so monthly reports are meaningful", () => {
  const months = new Set(allDates().map((d) => d.slice(0, 7)));
  assert.ok(months.size >= 2, `only ${months.size} month(s) in dataset`);
});
