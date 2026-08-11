// Live-reflect mode launcher.
// Starts the dashboard with an EMPTY board that mirrors the tasks Claude is
// actually working on (no auto-generated mock tickets, no Jira needed).
//   npm run live   ->   http://localhost:4000
process.env.JIRA_MOCK = "true";
process.env.MOCK_AUTODISPATCH = "false";
await import("./server.js");
