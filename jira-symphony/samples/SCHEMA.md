# Claude Code headless `stream-json` — the schema THIS machine actually emits

Captured empirically on **2026-08-11** from `claude 2.1.52` on Windows 11.
Source capture: [`probe.jsonl`](probe.jsonl) (23 events, exit 0).

> **Do not write parser code from the published docs.** Several documented shapes are wrong for
> this version — the differences are listed in §7 and each one would have silently broken the parser.

Reproduce with:

```bash
cd <workspace>
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
  claude -p --output-format stream-json --verbose \
    --permission-mode acceptEdits \
    --allowedTools "Read Glob Grep Edit Write TodoWrite Bash(node:*)" \
    --model sonnet --max-budget-usd 1.00 \
  < prompt.txt > probe.jsonl
```

---

## 1. Framing

- **JSONL** — one complete JSON object per line, `\n` terminated. Not an array.
- A single object **will** be split across stdout chunks (events here reach ~4 KB). The reader
  must buffer partial lines. See `lib/agent-runner.js`.

## 2. Event types observed

| `type` (+`subtype`) | Count | Notes |
|---|---|---|
| `system` / `init` | 1 | always first |
| `assistant` | 11 | one per assistant message |
| `user` | 9 | carries `tool_result` |
| `rate_limit_event` | 1 | **undocumented** — see §6 |
| `result` / `success` | 1 | always last |

## 3. `system/init`

```
type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode,
slash_commands, apiKeySource, claude_code_version, output_style, agents,
skills, plugins, uuid, fast_mode_state
```

- `session_id` — UUID, correlates every later event.
- `mcp_servers` — `[{name, status}]`. On this machine **15 servers report `needs-auth` / `failed`**,
  which adds startup latency and noise to every spawn. Agents are therefore launched with
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` to disable MCP entirely.

## 4. `assistant` — ⚠️ content is NESTED

```jsonc
{
  "type": "assistant",
  "message": {                       // <- NOT top-level `content`
    "content": [ /* blocks */ ],
    "usage": { /* see below */ }     // <- NOT top-level `usage`
  },
  "parent_tool_use_id": null,        // non-null for subagent messages
  "session_id": "...",
  "uuid": "..."
}
```

Content block types seen: `thinking` (has `.thinking` + `.signature`), `text`, `tool_use`.

`message.usage`:
```json
{ "input_tokens": 2, "cache_creation_input_tokens": 20149, "cache_read_input_tokens": 0,
  "output_tokens": 7, "service_tier": "standard" }
```

## 5. `user` — tool results

```jsonc
{
  "type": "user",
  "message": { "content": [ { "type": "tool_result",
                              "tool_use_id": "toolu_…",   // correlates to the tool_use block
                              "content": "…",
                              "is_error": false } ] },
  "tool_use_result": { … }          // undocumented extra, tool-specific structured result
}
```

- **`is_error` is often ABSENT**, not `false`. Treat `undefined` as *not an error* — never `!== false`.
- `tool_use_result` for `TodoWrite` is `{ oldTodos, newTodos }` — the state transition directly.

## 6. `rate_limit_event` (undocumented)

```json
{ "type": "rate_limit_event",
  "rate_limit_info": { "status": "allowed", "resetsAt": 1786462200,
                       "rateLimitType": "five_hour", "overageStatus": "rejected",
                       "overageDisabledReason": "org_level_disabled",
                       "isUsingOverage": false },
  "uuid": "...", "session_id": "..." }
```

Surfaced on the console — a `status` other than `allowed` explains a stalled agent, which
would otherwise look like a hang during a live demo.

## 7. Tool `input` shapes — where the docs are wrong

| Tool | Actual `input` keys | Docs said | Impact if trusted |
|---|---|---|---|
| `Write` | `file_path`, **`content`** | `file_text` | file-tracking silently empty |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` | same | ok |
| `Read` | `file_path`, `limit`, `offset` | same | ok |
| `Bash` | `command`, **`description`** | `command` only | missed a free activity label |
| `Glob` | `pattern`, `path` | same | ok |
| `TodoWrite` | `todos[]` | *"deprecated, disabled by default"* | **would have skipped the best progress signal** |

`TodoWrite` **works on 2.1.52** (deprecation landed in 2.1.142, after this build):

```json
{ "todos": [ { "content": "Look at existing files",
               "status": "in_progress",
               "activeForm": "Looking at existing files" } ] }
```
`status` ∈ `pending | in_progress | completed`.
**`activeForm` is a present-tense, agent-authored activity string** — used verbatim as the card's
"Current activity" line. Nothing is invented.

## 8. `result` (final event)

```
type, subtype, is_error, duration_ms, duration_api_ms, num_turns, result,
stop_reason, session_id, total_cost_usd, usage, modelUsage, permission_denials, uuid
```

Observed: `duration_ms: 39226`, `num_turns: 10`, `total_cost_usd: 0.257023`,
`modelUsage: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]`, `permission_denials: []`.

**Cost note:** a *trivial* task cost **$0.26**, dominated by cache creation (22 k) and cache reads
(169 k). Budget roughly **$0.25–1.00 per agent per ticket**; a 4-agent demo run is order **$1–4**.
`--max-budget-usd` is set per agent as the guard.

## 9. Failure detection

- Exit code `0` + `result.is_error === false` → success.
- Nested-session refusal exits **1 with completely empty stdout** — no `result` event at all.
  The runner must treat "process exited without a `result`" as a failure, not wait forever.

## 10. Environment gotchas (both cost a real debugging cycle)

1. **Nested sessions are refused.** Launching `claude` from inside a Claude Code session prints
   `Error: Claude Code cannot be launched inside another Claude Code session` and exits 1 with
   empty stdout. The runner **scrubs `CLAUDECODE` and every `CLAUDE_*` var** from the child env so
   the orchestrator works no matter where it is started from.
2. **`--allowedTools` did not constrain `Bash`.** With `--permission-mode acceptEdits` and
   `--allowedTools "… Bash(node:*)"` the agent still successfully ran `ls`. The allowlist is
   therefore **not** a containment boundary — the `PreToolUse` scope hook is mandatory.
