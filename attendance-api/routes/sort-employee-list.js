// Employee list endpoint — returns employees sorted alphabetically by name (A-Z, case-insensitive).
// GET /api/employees

import { listEmployees } from "../lib/store.js";

export const meta = {
  name: "sort-employee-list",
  description: "Employee list sorted alphabetically by name (case-insensitive)",
};

export default function register(router) {
  router.get("/api/employees", (_req, res) => {
    const employees = listEmployees()
      .slice()
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    res.json({ employees });
  });
}
