# Atlas MCP, Phase A ("Rhys AI")

Rhys's own business (his calls, tasks and drafts) as MCP tools that any assistant can use: Claude Code, Codex, and later Natalie's Grok. It is the same idea as the Jeremy AI MCP Rhys already uses, but over Atlas.

**Phase A is read-only and local.**
- It is bound to `127.0.0.1` only. The config loader refuses any other host.
- It is not installed into Mission Control and changes nothing there. It reads the task board through the same hosted principal credentials the board uses.
- No tool creates, assigns, approves or sends anything.
- Exposure to Natalie's Grok is a separate, later decision (see [EXPOSURE.md](EXPOSURE.md)).

Authority: sprint-20261007 DECISIONS item 14(b) (build only, not installed, not exposed).

## Tools

| Tool | What it does | Notes |
|---|---|---|
| `whoami` | Shows who is connected (principal and hosted actor), what this caller can see, and the ask_call budget left | |
| `capabilities` | Lists the tools, limits and safety rules | |
| `list_tasks(owner?, status?, client?, limit?)` | Lists tasks and task suggestions from calls, with owner, executor, reviewer, client, status, due date and source call | `status` matches the request state (`pending_approval`, `approved`, ...) or the work status (`todo`, ...) |
| `get_task(id)` | Returns one task: the request, its supporting quotes (with timestamps), status, draft status and source call with its Fireflies link | `id` is the task id or the request id |
| `get_draft(task_id)` | Returns the latest draft for the task and its citations (the draft's facts and quotes) | Says "not provisioned" until the hosted drafting grants exist (Lane D5) |
| `search_calls(query, client?, from?, to?, limit?)` | Finds calls. Returns the date, title, client, a short summary, matching quotes and the Fireflies link | Uses a local SQLite FTS5 index over atlas-brain call notes. Also searches calls in the hosted catalog that the caller is allowed to see |
| `ask_call(call_id, question)` | Answers from **one** call's transcript, with exact supporting quotes | One Claude call (claude-sonnet-5-5, effort low, structured output). Quotes are verified as exact substrings. The tool refuses when the call does not support an answer. Budget-capped |

Every tool carries `readOnlyHint: true`.

### Example prompts for Rhys

- "What's waiting on me?" → `list_tasks(owner: "rhys")`, then `get_task` on anything interesting.
- "What needs my approval?" → `list_tasks(status: "pending_approval")`.
- "What did Jess say about pricing on her last call?" → `search_calls(query: "pricing", client: "Jess")`, take the most recent call, then `ask_call(call_id, "What did Jess say about pricing on this call?")`.
- "Find the call where we talked about the onboarding SOP this year" → `search_calls(query: "onboarding SOP", from: "2026-01-01")`.
- "Is there a draft for the Sam onboarding task yet?" → `list_tasks(client: "Sam")`, then `get_draft(task_id)`.

## Who can see what

| Principal | Hosted actor | Scope |
|---|---|---|
| `rhys` | `rhys` | Owner. Sees all of Rhys's calls (every brain note), every client and internal meetings, and every task the board shows Rhys. Owner scope is only accepted when the hosted service confirms the actor is Rhys's reviewer (`meeting_capability`). |
| `nat` | `nat` | Granted. Sees only the calls and tasks that the hosted service (`meeting_queue('list')`, under Nat's own JWT) returns, which means clients granted through `workspace_clients`. Brain notes are visible only when their Fireflies id is in that set. Internal and ungranted calls are never visible, including in search snippets and ask_call. Unknown and out-of-scope ids get the same "not found". |
| `grok_as_nat` | `nat` | Same as `nat`, under a separate token, so it is audited and can be revoked separately. |

- Every tool call is authorised server-side against the hosted service, using that principal's own existing scoped credential: `meeting_capability` on every call, plus `meeting_queue('list')` for the grant set.
- There is no service key and no new superuser path.
- The hosted client allows only these RPCs:
  - `meeting_capability`;
  - `meeting_queue` actions `list` and `context`;
  - `meeting_document` actions `read` and `artifact`.
- As of 2026-10-21, Nat has no client grants, so `nat` and `grok_as_nat` see nothing. That is correct until Rhys grants clients.

## Safety

- **Card masking.** All transcript-derived text passes the Lane P card-mask module (`vendor/card-mask.mjs`, byte-identical to `fireflies-bridge/card-mask.mjs`, SHA256 `6891d69c…3926`, pinned by a test) before it is indexed, returned or sent to a model. This covers turns, speakers, titles, summaries, analyses, hosted passages, task quotes and drafts. Only span counts are logged.
- **Audit.** `<stateDir>/audit.jsonl` (0600) holds one row per tool call:
  - the principal, transport and tool;
  - a SHA-256 of the canonical arguments;
  - the result ids, cost in micro-USD, mask span count and duration.
  It holds no transcript text, questions or answers.
- **Budget for ask_call.** `config/ask-call-budget.json`:
  - US$20/month, 200 calls/month, 30 calls/day (UTC);
  - Sonnet 5.5 rates, 2 and 10 micro-USD per token.
  Before each dispatch, the byte-floor bound is reserved (`requestBytes × 2 + maxOutputTokens × 10` micro-USD; input tokens can never exceed the request bytes). The call is refused if the bound would cross a cap. An unresolved call counts at its full bound. There is no retry.
  The ledger is `<stateDir>/ask-call-ledger.jsonl`.
- **Rate limits per principal** (config): 30 tool calls a minute and 10 ask_calls an hour.
- **Tokens.** Each caller has a bearer token (`atlas_mcp_…`, 32 random bytes). Only SHA-256 digests are stored (`tokens.json`, 0600). The raw token is in one 0600 file per caller. Tokens can be revoked with `revoke`.
- **HTTP hardening:**
  - the server accepts loopback peers only;
  - the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`;
  - a browser `Origin` must be loopback, which guards against DNS rebinding;
  - only `POST /mcp` is served, with a 256 KB body cap.

## Running it (on the Mac)

```sh
cd /Users/atlasai/atlas-astra-handoff-2026-09-10/implementation/atlas-mcp-20261021
export PATH=/opt/homebrew/bin:$PATH        # Node 25 (built-in TypeScript stripping and node:sqlite)

# One-time local setup (already done for the 2026-10-21 demo):
install -d -m 700 ~/.config/atlas/atlas-mcp ~/.config/atlas/atlas-mcp/tokens ~/.local/state/atlas-mcp
install -m 600 atlas-mcp/config/config.example.json   ~/.config/atlas/atlas-mcp/config.json
install -m 600 atlas-mcp/config/ask-call-budget.json  ~/.config/atlas/atlas-mcp/ask-call-budget.json
node atlas-mcp/bin/atlas-mcp.ts mint-token --principal rhys --out ~/.config/atlas/atlas-mcp/tokens/rhys.token

node atlas-mcp/bin/atlas-mcp.ts index      # refresh the call index (about 4 s full, about 15 ms incremental)
node atlas-mcp/bin/atlas-mcp.ts http       # serve http://127.0.0.1:4019/mcp until Ctrl-C
```

The server refreshes the index at start. Run `index` again (or restart) to pick up new notes.

### Connecting assistants

**Claude Code on the Mac (stdio, recommended):**
```sh
claude mcp add atlas -- /opt/homebrew/bin/node --no-warnings \
  /Users/atlasai/atlas-astra-handoff-2026-09-10/implementation/atlas-mcp-20261021/atlas-mcp/bin/atlas-mcp.ts \
  stdio --token-file /Users/atlasai/.config/atlas/atlas-mcp/tokens/rhys.token
```

**Claude Code over HTTP** (with `atlas-mcp.ts http` running):
```sh
claude mcp add --transport http atlas http://127.0.0.1:4019/mcp --header "Authorization: Bearer $(cat ~/.config/atlas/atlas-mcp/tokens/rhys.token)"
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.atlas]
command = "/opt/homebrew/bin/node"
args = ["--no-warnings", "/Users/atlasai/atlas-astra-handoff-2026-09-10/implementation/atlas-mcp-20261021/atlas-mcp/bin/atlas-mcp.ts",
        "stdio", "--token-file", "/Users/atlasai/.config/atlas/atlas-mcp/tokens/rhys.token"]
```

**Grok (Natalie):** Grok runs off the Mac, so it can only reach this server after an exposure decision. See [EXPOSURE.md](EXPOSURE.md). It would use the `grok_as_nat` token over streamable HTTP. Nothing is enabled.

None of these registrations has been made on any machine. This README only documents them.

## Layout

```
atlas-mcp/
  bin/atlas-mcp.ts        CLI: http | stdio | index | mint-token | revoke
  src/config.ts           strict config + budget loaders (127.0.0.1 only, known tools, sonnet-5-5/low)
  src/protocol.ts         MCP JSON-RPC core (initialize, ping, tools/list, tools/call)
  src/server.ts           assembly, streamable HTTP (loopback) and stdio transports
  src/tools.ts            the seven read tools, scope checks, audit
  src/hosted.ts           read-only hosted client (existing principal JWTs)
  src/call-index.ts       SQLite FTS5 index over masked brain notes
  src/notes.ts            call-note parser (both layouts)
  src/ask-call.ts         one Claude call, structured output, quote verification
  src/ledger.ts           audit log and ask_call budget ledger
  src/mask.ts, vendor/card-mask.mjs   Lane P masking
  config/                 example config and the proposed ask_call budget
  test/                   node:test suites (synthetic data only)
```

Tests: `node --test atlas-mcp/test/*.test.ts`. These cover:
- scope isolation for `nat` and `grok_as_nat` through every tool;
- masking (index file, results, model request, audit);
- quote verification;
- budget refusal and the unresolved-at-bound rule;
- rate limits;
- token rejection over HTTP and stdio;
- Host and Origin checks;
- the read-only hosted allowlist;
- the loopback-only config.

## Known limits (Phase A)

- **Timestamps.** Brain notes have no timestamps; quotes from them carry a turn number. Calls in the hosted catalog (intake) have timestamps, and ask_call prefers the hosted transcript when the caller can see that call.
- **Client field.** For brain notes, `client` comes from a hosted task on the same call. Otherwise the client filter matches the call title and attendee emails (prefix match). The 2,800 historical notes are not client-mapped. This is why scoped callers see only hosted-granted calls.
- **Hosted-only calls.** search_calls matches calls in the hosted catalog but not yet in the brain on their title only.
- **Index size.** The index is a local derivative of atlas-brain: about 230 MB, 0600, masked.

## Behaviour added after review R14 (Lane G2)

- **Task-only rows give task fields only.** The hosted queue can return a `taskOnly: true` meeting: reviewed task context for a call the actor may not read in full. Such a row never unlocks full-call access. That covers brain search results, summaries, snippets, `ask_call`, hosted transcript reads and model input. Its tasks still appear in `list_tasks` and `get_task`, with `source.access = "task_only"`. Unknown, ungranted and task-only call ids all get the same `not_found`, before any hosted read or model call. A hosted transcript refusal is final; there is no fallback to the brain copy.
- **More fields are masked.** Masking now also covers:
  - note attendees;
  - the caller's question, before it reaches the model;
  - the whole model answer, masked before it is clipped to 2,000 characters;
  - task client labels;
  - hosted draft reasons.

  `transcript_url` is accepted only in the exact `https://app.fireflies.ai/view/<id>` shape.
- **The index rebuilds when the masking policy changes.** The index records its masking policy (`INDEX_POLICY`). When the policy changes, opening the index wipes it and runs `VACUUM`, and the next refresh rebuilds every record. `secure_delete` is on.
- **The audit log is schema-bound.** `tool` is either a known tool name or `unknown_tool`; a rejected name is stored only as a SHA-256 hash. The ledger outcome is limited to a fixed set: `end_turn`, `max_tokens`, `refusal`, `unresolved`, `invalid_usage`, `other`.
- **Revoking a token ends a stdio session.** The token is re-checked against the current registry before every stdio message. A revoked token gets error `-32001` and the session ends. An `ask_call` already sent to the model can only be interrupted by stopping the process.
- **Token files are hardened.** The token files and the registry must not be symlinks. Each must be a regular file owned by this user with no group or other permissions, in a directory owned by this user that is not group- or world-writable. They are opened with `O_NOFOLLOW`.
- **The budget fails closed.**
  - Provider usage must be nonnegative safe integers, with output no larger than `max_tokens`. Otherwise the full reservation is kept and the outcome is recorded as `invalid_usage`.
  - Usage above the byte-floor bound is recorded as reported, and it halts every further dispatch until a person reconciles the ledger.
  - A malformed ledger row (negative amount, duplicate settle, unknown kind, bad JSON) marks the ledger invalid, and every new reservation is refused.
- **Scoped callers see less metadata.** For `nat` and `grok_as_nat`, `capabilities` omits the global indexed-call count and `whoami` omits shared ask_call usage; they see the caps only.
- **`ask_call` is not idempotent.** Its `idempotentHint` is now `false`, because a repeated call spends again.
- **HTTP tests skip when binding is denied.** If the environment denies binding to loopback (`EPERM`/`EACCES`), the three HTTP tests are skipped instead of failing.
