import { getEmployee, STATUSES, isValidDateString } from "../lib/store.js";

export const meta = {
  name: "validation",
  description: "Validate a check-in record before it is trusted",
};

const REQUIRES_CHECKIN = new Set(["present", "late", "remote"]);
const NO_CHECKIN = new Set(["absent", "leave"]);

const HH_MM = /^\d{2}:\d{2}$/;

function parseHHMM(s) {
  // Returns total minutes, or null if invalid
  if (typeof s !== "string" || !HH_MM.test(s)) return null;
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(3, 5));
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function toHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

export default function register(router) {
  router.post("/api/attendance/validate", (req, res) => {
    const { empId, date, status, checkIn, checkOut } = req.body || {};
    const errors = [];

    // Validate empId
    const emp = empId != null ? getEmployee(empId) : null;
    if (!emp) errors.push("unknown empId");

    // Validate date
    if (!isValidDateString(date)) errors.push("malformed date");

    // Validate status
    if (!STATUSES.includes(status)) {
      errors.push(`status must be one of: ${STATUSES.join(", ")}`);
    }

    // Validate checkIn/checkOut format when provided
    let checkInMins = null;
    let checkOutMins = null;

    const hasCheckIn = checkIn != null && checkIn !== "";
    const hasCheckOut = checkOut != null && checkOut !== "";

    if (hasCheckIn) {
      checkInMins = parseHHMM(checkIn);
      if (checkInMins === null) errors.push("checkIn must be in HH:MM format");
    }

    if (hasCheckOut) {
      checkOutMins = parseHHMM(checkOut);
      if (checkOutMins === null) errors.push("checkOut must be in HH:MM format");
    }

    // Validate checkOut not before checkIn (only when both are valid)
    if (checkInMins !== null && checkOutMins !== null && checkOutMins <= checkInMins) {
      errors.push("checkOut must be later than checkIn");
    }

    // Validate presence rules (only when status is known)
    if (STATUSES.includes(status)) {
      if (REQUIRES_CHECKIN.has(status) && !hasCheckIn) {
        errors.push(`status '${status}' requires checkIn`);
      }
      if (NO_CHECKIN.has(status) && hasCheckIn) {
        errors.push(`status '${status}' must not have checkIn`);
      }
    }

    if (errors.length > 0) {
      return res.json({ valid: false, errors });
    }

    // Build normalized record
    const normalizedCheckIn = toHHMM(checkInMins);
    const normalizedCheckOut = hasCheckOut ? toHHMM(checkOutMins) : null;

    let hours = null;
    if (checkInMins !== null && checkOutMins !== null) {
      hours = Math.max(0, (checkOutMins - checkInMins) / 60 - 1);
    }

    const normalized = { empId, date, status, checkIn: normalizedCheckIn };
    if (normalizedCheckOut !== null) normalized.checkOut = normalizedCheckOut;
    if (hours !== null) normalized.hours = +hours.toFixed(2);

    res.json({ valid: true, normalized });
  });
}
