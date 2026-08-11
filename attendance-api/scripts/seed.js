// Generates data/attendance.json.
//
// Deliberately mirrors seedDB() in ../../index.html:604-673 — same mulberry PRNG, same seed,
// same employee/attendance record shapes — so the API and the browser app describe the
// same world. Run: node scripts/seed.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "attendance.json");

/* Seedable PRNG — identical to index.html:588 */
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AV_COLORS = ["#0d9488", "#2563eb", "#9333ea", "#c2740a", "#16a34a", "#db2777", "#0891b2", "#7c3aed", "#ca8a04", "#e11d48"];
const DEPTS = ["Engineering", "Product", "Design", "Sales", "Marketing", "Support", "Finance", "People Ops"];
const POS = {
  Engineering: ["Software Engineer", "Senior Engineer", "QA Engineer", "DevOps Engineer", "Eng Manager"],
  Product: ["Product Manager", "Associate PM", "Product Lead"],
  Design: ["Product Designer", "UX Researcher", "Design Lead"],
  Sales: ["Account Executive", "SDR", "Sales Manager"],
  Marketing: ["Content Lead", "Growth Marketer", "Brand Designer"],
  Support: ["Support Specialist", "Support Lead"],
  Finance: ["Financial Analyst", "Accountant"],
  "People Ops": ["HR Business Partner", "Recruiter", "HR Admin"],
};
const FIRST = ["Arjun", "Priya", "Vikram", "Ananya", "Rahul", "Sneha", "Karthik", "Divya", "Rohan", "Meera", "Aditya", "Kavya", "Sanjay", "Nisha", "Varun", "Isha", "Aravind", "Pooja", "Manish", "Riya", "Nikhil", "Deepa", "Gaurav", "Shreya"];
const LAST = ["Rao", "Sharma", "Nair", "Iyer", "Patel", "Reddy", "Menon", "Gupta", "Kumar", "Desai", "Bose", "Verma", "Pillai", "Shetty", "Joshi", "Kapoor", "Chopra", "Malhotra", "Nanda", "Bhat"];

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const hhmm = (h) => pad(Math.floor(h)) + ":" + pad(Math.floor((h - Math.floor(h)) * 60));
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

function seed() {
  const rnd = mulberry(20260722);
  const employees = [];
  for (let i = 0; i < 22; i++) {
    const fn = FIRST[i % FIRST.length];
    const ln = LAST[Math.floor(rnd() * LAST.length)];
    const dept = DEPTS[Math.floor(rnd() * DEPTS.length)];
    const poss = POS[dept];
    employees.push({
      id: "E" + pad(i + 1),
      name: fn + " " + ln, first: fn, last: ln,
      email: (fn + "." + ln).toLowerCase() + "@panasatech.com",
      dept, position: poss[Math.floor(rnd() * poss.length)],
      initials: (fn[0] + ln[0]).toUpperCase(),
      color: AV_COLORS[i % AV_COLORS.length],
      joined: "20" + (19 + Math.floor(rnd() * 6)) + "-" + pad(1 + Math.floor(rnd() * 12)) + "-" + pad(1 + Math.floor(rnd() * 28)),
    });
  }
  // demo employee, same as the browser app
  Object.assign(employees[0], {
    name: "Arjun Rao", first: "Arjun", last: "Rao",
    email: "arjun.rao@panasatech.com", initials: "AR",
    dept: "Engineering", position: "Senior Engineer",
  });

  // 90 days of history (weekdays only) — deeper than the app's 30 so monthly
  // reports have more than one month to work with.
  const attendance = {};
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const e of employees) {
    attendance[e.id] = {};
    for (let d = 89; d >= 0; d--) {
      const dt = new Date(today); dt.setDate(today.getDate() - d);
      if (isWeekend(dt)) continue;
      const r = rnd();
      const status = r < 0.72 ? "present" : r < 0.8 ? "remote" : r < 0.89 ? "late" : r < 0.955 ? "leave" : "absent";
      const rec = { status, checkIn: null, checkOut: null, hours: 0 };
      if (status === "present" || status === "remote" || status === "late") {
        const inH = status === "late" ? 9.5 + rnd() * 1.3 : 8.6 + rnd() * 0.55;
        const outH = 17.4 + rnd() * 1.6;
        rec.checkIn = hhmm(inH);
        rec.checkOut = hhmm(outH);
        rec.hours = Math.max(0, +(outH - inH - 1).toFixed(1)); // minus lunch
      }
      attendance[e.id][fmtDate(dt)] = rec;
    }
  }

  return {
    employees,
    attendance,
    users: {
      "admin@panasatech.com": { pass: "admin123", role: "admin", name: "Meera Kapoor", initials: "MK", color: "#9333ea", title: "HR Administrator" },
      "arjun.rao@panasatech.com": { pass: "employee123", role: "employee", empId: "E01" },
    },
    created: Date.now(),
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const db = seed();
fs.writeFileSync(OUT, JSON.stringify(db, null, 2));
const days = Object.keys(db.attendance.E01).length;
console.log(`seeded ${OUT}\n  ${db.employees.length} employees · ${days} working days each`);
