// Regenerates app.html from index.html (and symphony-app.html from symphony-dashboard.html).
//
// These pairs are byte-identical apart from an HTML wrapper — app.html is the body-only source
// used to publish the shareable artifact links. There was no build step, so every edit had to be
// made twice by hand and they were one slip away from silently diverging.
//
//   node scripts/sync-app-html.js          # write
//   node scripts/sync-app-html.js --check  # verify only (non-zero exit if stale)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAIRS = [
  { from: "index.html", to: "app.html" },
  { from: "symphony-dashboard.html", to: "symphony-app.html" },
];

/** Strip the <!doctype>…<body> head and the trailing </body></html>. */
function bodyOnly(html) {
  const open = html.match(/<body[^>]*>\s*\n?/i);
  if (!open) throw new Error("no <body> tag found");
  const start = open.index + open[0].length;
  const close = html.toLowerCase().lastIndexOf("</body>");
  if (close === -1) throw new Error("no </body> tag found");
  return html.slice(start, close).replace(/\s*$/, "") + "\n";
}

const check = process.argv.includes("--check");
let stale = 0;

for (const { from, to } of PAIRS) {
  const src = path.join(ROOT, from);
  const dst = path.join(ROOT, to);
  if (!fs.existsSync(src)) { console.warn(`skip ${from} (missing)`); continue; }

  const next = bodyOnly(fs.readFileSync(src, "utf8"));
  const current = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : null;

  if (current === next) { console.log(`ok    ${to} is in sync with ${from}`); continue; }

  if (check) { console.error(`STALE ${to} does not match ${from}`); stale++; continue; }
  fs.writeFileSync(dst, next);
  console.log(`wrote ${to} from ${from} (${next.length} bytes)`);
}

if (check && stale) {
  console.error(`\n${stale} file(s) out of date — run: node scripts/sync-app-html.js`);
  process.exit(1);
}
