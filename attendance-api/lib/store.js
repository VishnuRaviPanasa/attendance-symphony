// Data access for the attendance API.
//
// Mirrors the helper cluster in ../../index.html:687-710 (recFor / statusFor / todayCounts /
// last7 / deptRates) so server-side features match what the browser app already computes.
//
// AGENTS: this file is READ-ONLY for you. Import from it; do not modify it. Build your feature
// as a new file under routes/ — see routes/health.js for the pattern.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data", "attendance.json");

export const STATUSES = ["present", "late", "absent", "leave", "remote"];

let _db = null;

/** Load (and memoise) the attendance database. */
export function db() {
  if (!_db) _db = JSON.parse(fs.readFileSync(DATA, "utf8"));
  return _db;
}

/** Drop the memoised copy — used by tests and by the demo reset. */
export function reload() { _db = null; return db(); }

/* ---------- date helpers (same semantics as the browser app) ---------- */
export const pad = (n) => String(n).padStart(2, "0");
export const fmtDate = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
export function todayKey() { const t = new Date(); t.setHours(0, 0, 0, 0); return fmtDate(t); }

/**
 * True when `s` is a real calendar date in YYYY-MM-DD.
 *
 * Use this instead of writing your own check. The obvious implementation —
 *   new Date(s + "T00:00:00").toISOString().startsWith(s)
 * — is WRONG: that constructor parses as LOCAL time while toISOString() formats as UTC, so
 * every valid date is rejected in any timezone ahead of UTC (this machine is UTC+5:30).
 * Two separate agent runs independently wrote that exact bug, which is why the correct
 * version lives here as shared, tested code rather than being re-derived per feature.
 */
export function isValidDateString(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= lengths[m - 1];
}

/** True when `s` is a well-formed YYYY-MM month. */
export function isValidMonthString(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** The current month as YYYY-MM, in local time. */
export function currentMonth() { return todayKey().slice(0, 7); }

/* ---------- employees ---------- */
export function listEmployees() { return db().employees; }
export function getEmployee(id) { return db().employees.find((e) => e.id === id) || null; }

/* ---------- attendance ---------- */

/** One attendance record, or null when the day was never marked. */
export function recFor(empId, key) { return (db().attendance[empId] || {})[key] || null; }

/** Status for a day. "unmarked" when no record exists — it is never stored. */
export function statusFor(empId, key) { const r = recFor(empId, key); return r ? r.status : "unmarked"; }

/** Head-count by status for a single day (defaults to today). */
export function countsForDay(key = todayKey()) {
  const c = { present: 0, late: 0, absent: 0, leave: 0, remote: 0, unmarked: 0 };
  for (const e of listEmployees()) { const s = statusFor(e.id, key); c[s] = (c[s] || 0) + 1; }
  return c;
}

/** The last `n` working days, oldest first, with per-day counts. */
export function lastWorkingDays(n = 7) {
  const out = [];
  const t = new Date(); t.setHours(0, 0, 0, 0);
  for (let d = 0; out.length < n && d < n * 4; d++) {
    const dt = new Date(t); dt.setDate(t.getDate() - d);
    if (isWeekend(dt)) continue;
    const key = fmtDate(dt);
    out.push({ date: key, counts: countsForDay(key) });
  }
  return out.reverse();
}

/** Attendance rate per department for a day — present/late/remote all count as "in". */
export function deptRates(key = todayKey()) {
  const m = {};
  for (const e of listEmployees()) {
    m[e.dept] = m[e.dept] || { present: 0, total: 0 };
    m[e.dept].total++;
    const s = statusFor(e.id, key);
    if (s === "present" || s === "late" || s === "remote") m[e.dept].present++;
  }
  return Object.entries(m)
    .map(([dept, v]) => ({ dept, rate: v.total ? +(v.present / v.total).toFixed(4) : 0, total: v.total }))
    .sort((a, b) => b.rate - a.rate);
}

/** Every recorded day for one employee, oldest first. */
export function historyFor(empId) {
  const rows = db().attendance[empId] || {};
  return Object.keys(rows).sort().map((date) => ({ date, ...rows[date] }));
}

/** All dates present in the dataset, oldest first. */
export function allDates() {
  const set = new Set();
  for (const byDate of Object.values(db().attendance)) for (const d of Object.keys(byDate)) set.add(d);
  return [...set].sort();
}
