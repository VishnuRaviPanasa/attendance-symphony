// Replay of a recorded run — the stage safety net.
//
// This is NOT a simulation. It re-plays the byte-for-byte transcript of agents that genuinely
// ran, through exactly the same normalise → progress → dashboard path as a live run, at the
// original inter-event timing. Nothing is invented; the only difference is that the events come
// from disk instead of a live process.
//
// The console shows a permanent REPLAY banner whenever this is active. That banner must never
// be suppressed: a replayed run presented as live would be precisely the dishonesty this whole
// project exists to remove.

import fs from "node:fs";
import path from "node:path";
import { normalize } from "./events.js";

/**
 * @returns {() => void} cancel function
 */
export function startReplay({ dir, orch, speed = 2, onDone = () => {} }) {
  const manifest = readManifest(dir);
  if (!manifest.length) {
    orch.log("w", `replay: ${path.basename(dir)} has no manifest — cannot reconstruct tickets`);
    onDone();
    return () => {};
  }

  // Deduplicate retries: replay the last attempt recorded for each agent.
  const byAgent = new Map();
  for (const m of manifest) byAgent.set(m.agentId, m);

  const timers = new Set();
  let cancelled = false;
  let outstanding = 0;

  // Swap in a runner that reads from disk. Restored when the replay finishes.
  const originalRunner = orch._runner;
  orch._runner = ({ agentId, onEvent }) => {
    const entry = byAgent.get(agentId);
    const lines = readLines(path.join(dir, `${agentId}.jsonl`));
    const timing = readTiming(path.join(dir, `${agentId}.timing.jsonl`), lines.length);
    outstanding++;

    let resolve;
    const promise = new Promise((r) => { resolve = r; });

    let sawResult = false;
    let resultEvent = null;

    lines.forEach((line, i) => {
      const delay = (timing[i] ?? i * 400) / speed;
      const timer = setTimeout(() => {
        if (cancelled) return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        for (const ev of normalize(obj, {})) {
          if (ev.kind === "result") { sawResult = true; resultEvent = ev; }
          try { onEvent(ev); } catch { /* keep replaying */ }
        }
        if (i === lines.length - 1) finish();
      }, delay);
      timers.add(timer);
    });

    if (!lines.length) setTimeout(finish, 50);

    function finish() {
      if (cancelled) return;
      resolve({
        ok: sawResult && !resultEvent?.isError,
        exitCode: 0,
        sawResult,
        resultEvent,
        denials: [],
        rawPath: path.join(dir, `${agentId}.jsonl`),
        replay: true,
      });
      if (--outstanding === 0) done();
    }

    return { promise, kill: () => { cancelled = true; }, sessionId: entry?.key || agentId };
  };

  // Feed the recorded tickets in. Discovery/dispatch/backpressure all run for real.
  const tickets = [...byAgent.values()].sort((a, b) => a.at - b.at);
  orch.setMaxConc(Math.max(orch.maxConc, tickets.length));
  for (const t of tickets) {
    orch.addTicket({ id: t.id, key: t.key, title: t.title, kind: t.kind, priority: t.priority, scope: t.scope, replay: true });
  }

  function done() {
    orch._runner = originalRunner;
    onDone();
  }

  return function cancel() {
    cancelled = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    orch._runner = originalRunner;
  };
}

function readManifest(dir) {
  try {
    return fs.readFileSync(path.join(dir, "manifest.jsonl"), "utf8")
      .split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readLines(file) {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
}

/**
 * Offsets in ms for each recorded line. Returns [] when the sidecar is missing or short —
 * the caller then falls back to even spacing (`?? i * 400`), so a run recorded before the
 * timing sidecar existed still replays.
 */
function readTiming(file, n) {
  try {
    const t = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l).t; } catch { return null; } })
      .filter((x) => typeof x === "number");
    return t.length >= n ? t : [];
  } catch { return []; }
}
