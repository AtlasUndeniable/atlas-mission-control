I have complete, live-grounded evidence. The last log lines (12:29:30-31) show the exact bug in real time: an asset request â†’ "Asset job queued" ack sent â†’ then immediately "Asset job blocked: no verified workflow matched" â€” and the job ledger confirms that request landed as `st=blocked, files=0`. The `too_many_websockets` disconnects also confirm a Socket Mode owner conflict episode.

I also have the key architectural distinction nailed down: the long-running asset lane is fully synchronous and never reaches the gateway, while the fallback conversational lane uses `openclaw agent` (the Gateway). I have everything I need to write the report.

---

# Slack DM Asset Request â†’ Delivery Trace (Atlas, live runtime)

All paths under `/Users/atlasai/.openclaw/workspace/`. Line numbers cite the live runtime copies read in full this session. Runtime verified: listener is **PID 1622** under active LaunchAgent `com.atlas.slack-listener` (~53 min uptime at trace time), socket owner status `ok`, sole inbound DM handler.

## Critical runtime correction (affects how you read the code)

`listener.mjs` lines 182-189 carry a stale comment claiming *"slack-listener is currently DISABLED (LaunchAgent suffixed .plist.disabled)... The active reply path runs through the gateway's compiled @openclaw/slack plugin."* **This comment is FALSE in the live runtime.** Evidence:
- `ps` shows `node .../services/slack-listener/listener.mjs` running as PID 1622.
- `launchctl list` shows `1622  0  com.atlas.slack-listener` (active, exit 0).
- The active plist `com.atlas.slack-listener.plist` (RunAtLoad=true) is the LIVE one; the `.plist.disabled` is a separate old file from Mar 23.
- `listener.log` tail shows live inbound: `[11/06/2026, 12:29:30 pm] ðŸ“© From U068FRX5423 ... 12:29:31 ? Asset job queued ... 12:29:31 ?? Asset job blocked`.

So `listener.mjs` IS the canonical inbound DM path. Treat its gate at lines 191-235 as live, not "defense-in-depth for if/when re-enabled."

`slack-bridge.mjs` (PID 1626, active LaunchAgent `com.atlas.slack-bridge`) is **NOT** a competing Socket Mode listener â€” it is an MCP tool server (`server.registerTool("slack_search_messages", ...)` etc., zod schemas, HTTP at line ~485-487). It gives the gateway agent read/post Slack tools. It does not consume the events WebSocket, so it does not race the listener for inbound DMs. RULED-OUT as a cause of the no-file bug.

---

## 1. Order of operations on DM arrival, and exactly where the ack is sent

Entry: `listener.mjs` `handleMessage(event)` (line 324). Sequence:

1. **324-343** Filter bots/subtypes, strip mentions, DM-only guard, authorise (`AUTHORISED_USERS` = Rhys only).
2. **349-353** Fire-and-forget âš¡ reaction (typing indicator) â€” non-blocking.
3. **354-362** `upsertSlackDmJob(...)` creates the job at status `received` (idempotent on `slackdm-<channel>-<ts>`). Duplicate events return early (364-366).
4. **368-373** Compute + persist `preferredDelivery`.
5. **374-467** **Delivery-request follow-up branch** (`isDeliveryRequestFollowup`): "send it here" â†’ looks up a prior `findLatestDeliveryCandidate` and tries `sendRhysDmArtifact`. This is the branch that *retroactively* delivers a previously-built file.
6. **469-490** Status follow-up â†’ answered from cache.
7. **492-505** Timeout-debug follow-up â†’ canned text, no gateway.
8. **507-693** **Long-running asset lane** (the asset-request path). THIS is where the ack/build relationship lives.
9. **695-976** Fallback **conversational gateway lane** (`openclaw agent` subprocess).

### The ack ("Got it / creating now") â€” exact lines

For an asset request, the ack is sent at **line 513**, BEFORE any build:

```
510   const ack = workspaceAckForRequest({ jobId: assetJobId, state: "queued" });
512     await sendSlackMessage(channel, ack, threadTs, { kind: "summary", callerSite: "asset-job-queued-ack" });
513-521  await transitionSlackDmJob(job.id, "queued", {...});
```

Ack text (`slack-listener-reply.mjs:94-98`):
```
"Got it. I'm creating the asset now. No verified file exists yet, and I won't call it done until the actual file is returned here."
```

Only AFTER the ack does workflow matching happen (line 536), then `transitionSlackDmJob(..., "building", ...)` at **557**, then the actual build at **567** `const workflowResult = await executeSlackAssetWorkflow({ text, workflow })`.

**ROOT-CAUSE / desync point #1:** The ack is unconditional and precedes workflow resolution. If `findSlackAssetWorkflowForRequest(text)` returns null (line 536-537), the code has already told Rhys "I'm creating the asset now," then immediately sends the blocked message (552) and sets status `blocked`. The user sees: ack â†’ "I'm blocked... I do not have a verified workflow." **This is the live failure captured at 12:29:30-31 and in the ledger** (`slackdm-...1781144970 | st=blocked | files=0 | "i have sent clients a vsl framework..."`).

---

## 2. WHERE the language-model call lives, and exactly how

There are **two entirely different content paths**, and only one calls an LLM:

### (a) Asset lane (Section 8) â€” NO LLM CALL AT ALL
`executeSlackAssetWorkflow` (`slack-asset-workflows.mjs:137`) does not invoke any model. It either reuses a hardcoded existing artifact (`first-10k-online-coach`, adapter `existing-export-package`, fixed `artifactPaths` at lines 29-33) or runs a **deterministic, pre-written code builder** (`buildJessEndureAdCtaPlaybook`, line 83). The "content" is a hardcoded template string (`renderJessEndureAdCtaPlaybookMarkdown`, 232; `...Html`, 359; `...Css`, 541). The only subprocesses are **weasyprint** (HTMLâ†’PDF) and **pandoc** (MDâ†’DOCX):

```
197 async function runWeasyPrintPdf(...) { return runCommand(weasyprintBin, [htmlPath, pdfPath], ...); }
201 async function runPandocDocx(...)    { return runCommand(pandocBin, [sourcePath,"-o",docxPath,"-f","markdown-...","--metadata",`title=${title}`], ...); }
213 async function runCommand(command, args, { label }) {
215   execFile(command, args, {
216     env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
219     maxBuffer: 1024 * 1024,
220   }, (error, stdout, stderr) => { if (error) { ... reject(...) } else resolvePromise({stdout,stderr}); });
```
- Binaries: `/opt/homebrew/bin/weasyprint`, `/opt/homebrew/bin/pandoc` (lines 8-9).
- **No `timeout` set** on these execFile calls (only `maxBuffer: 1MB`). stdout/stderr captured in callback; on error, `stderr || stdout || error.message` is thrown.

So an asset request that matches a verified workflow produces a file with zero model involvement â€” fully deterministic.

### (b) Conversational fallback lane (Section 9) â€” `openclaw agent` subprocess (the Gateway)
`forwardToGateway` (`listener.mjs:238`):

```
243   execFile("/opt/homebrew/bin/openclaw", [
244     "agent",
245     "--message", text,
246     "--session-id", sessionId,
247   ], {
248     timeout: GATEWAY_TIMEOUT_MS,            // 240_000 ms (line 54), env-overridable
249     maxBuffer: 10 * 1024 * 1024,            // 10 MB
250     env: { ...process.env, HOME: "/Users/atlasai",
253            PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
255     cwd: "/Users/atlasai/.openclaw/workspace",
256   }, (err, stdout, stderr) => {
257     const reply = extractGatewayReply(stdout);
258     const stdoutText = String(stdout || "").slice(0, 4000);
259     const stderrText = String(stderr || "").slice(0, 4000);
```

Verified live: `openclaw agent` is a real subcommand â€” `openclaw agent --help` â†’ *"Run an agent turn via the Gateway (use --local for embedded)"*, flags include `-m, --message`, `--session-id`, `--timeout`. So this is **an `openclaw agent` child process (execFile)** that routes through the **OpenClaw Gateway daemon** â€” NOT a direct Anthropic/OpenAI API call from the listener, NOT `claude -p`, NOT an HTTP fetch to a gateway port. The model is whatever the gateway's `agents.defaults.model.primary` resolves to (read via `readBrainProvenance`, lines 75-83).

It is **fire-and-forget on the OS process** but **awaited in JS**: `forwardToGateway` returns a Promise resolved in the execFile callback; the caller `await`s it at line 730 (`const gatewayResult = await forwardToGateway(text, userId)`).

**Note:** the asset lane (the path that actually makes deliverable files) NEVER reaches this gateway call â€” it `return`s at 631/665/692 before line 695. So for a genuine "build me an asset" request, no LLM ever runs; the system is entirely dependent on the two hardcoded workflows in `VERIFIED_SLACK_ASSET_WORKFLOWS`.

---

## 3. Synchronous vs fire-and-forget; delivery guarantee

**The asset build is fully SYNCHRONOUS within the inbound request handler.** `handleMessage` awaits each step inline: ack (512) â†’ `executeSlackAssetWorkflow` (567) â†’ `recordArtifactCreated` (591) â†’ `transitionSlackDmJob "artifact_ready"` (603) â†’ `transitionSlackDmJob "delivery_requested"` (633) â†’ `sendRhysDmArtifact` (640). On success it returns at 665. There is **no background worker and no queue consumer** â€” `executeSlackAssetWorkflow` runs in-process inside the WebSocket `message` handler.

Consequences:
- **CONTRIBUTING:** Because it's synchronous inside the socket message handler, a slow build (weasyprint/pandoc have **no timeout** at line 215) blocks that handler. The WebSocket has a heartbeat (`PING_INTERVAL_MS` 60s, `MAX_MISSED_PONGS` 3, lines 52/56) but pings are sent from a `setInterval`, so a long synchronous build can still complete; however the listener gets `too_many_websockets`/`Disconnect requested: warning` churn (seen repeatedly in the log 1:46-8:46am), and a disconnect mid-build means the in-memory job advance still completes but the Slack ack/reply may target a torn-down socket.
- **ROOT-CAUSE / desync point #2 (the core bug):** There is **NO delivery step keyed off build completion that survives the request.** Delivery (`sendRhysDmArtifact`) happens only inside the same synchronous request. If that request returns early at a `blocked`/`needs_workspace`/`failed`/`needs_workspace_job` branch, OR if the process/socket dies mid-build, **nothing re-drives delivery.** The job sits in `slack-dm-jobs.json` at a non-terminal status with no worker. There is no cron/sweeper that reads `findUndeliveredArtifacts` (that function exists in `artifact-delivery.mjs:232` but **nothing in the listener calls it**). Delivery only resumes if Rhys sends a *follow-up* that hits `isDeliveryRequestFollowup` (374) which calls `findLatestDeliveryCandidate` (375) and tries to deliver an already-built file. **That is the "follow-up SOMETIMES produces it" behavior, by design-gap.**

This is confirmed in the live ledger:
- `slackdm-...1780917689 "i want to creat an asset..."` â†’ `delivered, files=1`
- `slackdm-...1780918664 "and the asset I asked for before that?"` â†’ `needs_workspace_job, files=0` (follow-up did NOT recover a file â€” the candidate lookup didn't map it)
- The Jess Endure request appears as `blocked` (1780990473) then later `delivered` x3 (1780992328 / 1780992358 / 1780993900) â€” repeated retries, multiple delivered duplicates.

---

## 4. Where output can come back EMPTY or TRUNCATED

- **`listener.mjs:258-259`** `stdout.slice(0, 4000)` / `stderr.slice(0, 4000)` â€” gateway stdout/stderr truncated to 4 KB for logging/diagnostics (not the reply itself, but failure summaries are derived from these).
- **`listener.mjs:249`** `maxBuffer: 10 * 1024 * 1024` â€” gateway reply >10 MB â†’ execFile errors with ENOBUFS, treated as failure. **RISK** for very large agent outputs.
- **`slack-asset-workflows.mjs:219`** `maxBuffer: 1024 * 1024` (1 MB) on weasyprint/pandoc â€” **RISK:** a verbose weasyprint warning stream >1 MB would kill an otherwise-successful PDF build and throw, sending the user a "failed validation" message even though the file may exist.
- **`slack-listener-reply.mjs:144-163`** `extractGatewayReply`: `JSON.parse(raw)` on stdout; if parse fails it falls back to raw text (`catch {}` â†’ `return raw`). **RISK:** if the gateway emits JSON-with-trailing-log-noise, `JSON.parse` throws and the *entire raw blob* (including log noise) becomes the "reply," which then hits `isUsefulGatewayReply`/gates. If gateway emits partial JSON, the text-field extraction yields `undefined` â†’ returns raw.
- **`slack-listener-reply.mjs:280-284`** `isUsefulGatewayReply`: any reply `< 20` chars is treated as not-useful â†’ routed to failure/handoff path (line 741). **CONTRIBUTING:** legitimately short agent answers are discarded.
- **`slack-listener-reply.mjs:257-278`** `chunkSlackText` caps at `SLACK_SAFE_MESSAGE_LIMIT = 3400` and **splits** (not truncates) â€” multi-part sends. Not a data-loss point, but reorders/suffixes `(n/m)`.
- **`slack-dm-jobs.mjs:89, 108-109`** request text stored `.slice(0, 2000)`; **122** `writeJobs(jobs.slice(-200))` â€” only last 200 jobs retained (older jobs silently dropped, so `findLatestDeliveryCandidate` can't see them). **CONTRIBUTING** to follow-ups failing to find the prior build.
- **`slack-rhys-dm-artifact.mjs:170`** reads whole file into a Blob (`readFileSync(artifact.artifactPath)`) â€” no truncation, but whole-file read into memory.

---

## 5. Job lifecycle writes and orphaned states

State machine: `slack-dm-jobs.mjs:18-32` `SLACK_ASSET_JOB_TRANSITIONS`. `delivered`/`blocked`/`failed` are terminal (empty arrays). `transitionSlackDmJob` (159) enforces legality and **throws** on illegal transitions; `updateSlackDmJob` (130) bypasses the state machine (raw patch) and is used for most status writes in the listener.

Status writes in the asset lane:
- `received` (upsert, line 354) â†’ `queued` (513, after ack) â†’ `building` (557) â†’ `artifact_ready` (603) â†’ `delivery_requested` (633) â†’ `recordSlackDmJobDelivered` (649, terminal `delivered`).
- Branch exits set `blocked` (544), `failed`/`blocked` (575), `blocked_needs_approval` (623/681).

**Orphaned-state findings:**

- **ROOT-CAUSE:** `queued` and `building` are written *before* the synchronous build, and the only thing that advances them is the *same* request continuing. If the request throws between 557 (`building`) and 603 (`artifact_ready`) outside the try at 567's handled path â€” e.g. the WebSocket dies, the process is SIGTERM'd by launchd, or weasyprint hangs with no timeout â€” the job is **stranded at `building` with no worker**. Nothing sweeps `building` jobs. `summarizeSlackDmJob` will answer a status follow-up with *"I'm building it with ..."* (line 242-244) forever, even though no process is building anything.
- **ROOT-CAUSE:** `delivery_requested` set at line 633 *before* `sendRhysDmArtifact` at 640. If `sendRhysDmArtifact` throws (Slack API error, file validation), the catch (665) moves it to `blocked_needs_approval`. But if the **process dies between 633 and 649**, the job is stranded at `delivery_requested` â€” `findLatestDeliveryCandidate` (200, deliverable set includes `delivery_requested`) WILL pick it up on a follow-up, but only if (a) it's within `maxAgeMinutes: 720`, (b) it still has `artifactPaths`, and (c) it's within the last-200 window. Otherwise permanently orphaned. **No automatic advancement.**
- **`needs_workspace` / `needs_workspace_job`** (17 + 5 = 22 of 51 jobs live!) are explicitly orphan-by-design: set when the gateway times out (765), session already active (700), cooldown (715), or misrouted reply (791). These represent **"acknowledged, no file, no worker assigned."** Nothing converts them to a real build â€” they require a human/workspace-Codex lane that, per the handoff text (`handoffSummaryForRequest`, 136-142), is described but **not implemented in this codebase**. 22/51 jobs in this dead-end state is the dominant failure mode in the ledger.
- **`recordSlackDmJobDelivered`** (169) and `updateSlackDmJob` (137) both refuse to mark `delivered` without a Slack receipt (`hasSlackDeliveryReceipt`, 68-70) â€” good integrity guard, RULED-OUT as a false-delivered source.

---

## Sequence diagram (prose, asset request happy path vs failure)

1. DM arrives â†’ WS `message` handler (1052) â†’ `handleMessage` (324).
2. âš¡ reaction (351). `upsertSlackDmJob` â†’ `received` (354).
3. `isLikelyLongRunningRequest(text)` true (508) â†’ **ACK SENT** (512) "Got it. I'm creating the asset now." â†’ job `queued` (513). **[DESYNC POINT #1: ack precedes workflow match]**
4. `findSlackAssetWorkflowForRequest` (536).
   - **null â†’** send "I'm blocked... no verified workflow" (552), job `blocked`, RETURN (554). **User saw ack, gets no file. â† live-observed 12:29:31 + ledger `blocked`.**
5. job `building` (557). `executeSlackAssetWorkflow` (567) runs weasyprint+pandoc **synchronously, no timeout** (`slack-asset-workflows.mjs:215`). **[ORPHAN RISK: crash here strands `building`]**
6. `recordArtifactCreated` (591) â†’ ledger + maybe Rhys review queue. job `artifact_ready` (603).
7. If `preferredDelivery !== "slack_dm"` (621) â†’ `blocked_needs_approval`, RETURN (631). **Built but not sent.**
8. job `delivery_requested` (633). **[ORPHAN RISK: crash between 633 and 649 strands `delivery_requested`]**
9. `sendRhysDmArtifact` (640) â†’ Slack files.completeUploadExternal (`slack-rhys-dm-artifact.mjs:174`). Success â†’ `recordSlackDmJobDelivered` (649) terminal `delivered`. RETURN (665).
   - throw â†’ `blocked_needs_approval` (681), send "needs approval" (690). RETURN.

Recovery only via a later DM matching `isDeliveryRequestFollowup` (374) â†’ `findLatestDeliveryCandidate` (375) â†’ re-attempt delivery of an already-built file. **[This is the "follow-up sometimes produces it."]** It fails when the candidate is older than 720 min, lost from the last-200 window, has no `artifactPaths`, or the original never produced a file (the common `blocked`/`needs_workspace_job` case).

---

## Top facts for the diagnostician

1. **The ack at `listener.mjs:512` is sent unconditionally BEFORE workflow resolution (`findSlackAssetWorkflowForRequest` at 536).** Any unmatched asset request yields "Got it, creating now" immediately followed by a `blocked` with no file. Live-reproduced at 12:29:30-31 and in the ledger.
2. **A real "build an asset" request never calls an LLM.** Content comes only from two hardcoded entries in `VERIFIED_SLACK_ASSET_WORKFLOWS` (`slack-asset-workflows.mjs:21-66`). Match logic is narrow regex (`first-10k` requires first10k+coach+asset keywords; `jess-endure` requires jess+cta+dm+asset). Anything else â†’ `blocked, no verified workflow`. This is the single biggest "acknowledges, never delivers" cause.
3. **The gateway/LLM path is a separate fallback** that only runs for non-asset chat: `execFile("/opt/homebrew/bin/openclaw", ["agent","--message",text,"--session-id",sessionId], { timeout: 240000, maxBuffer: 10MB })` (`listener.mjs:243-256`). Verified `openclaw agent` = "Run an agent turn via the Gateway." Not an HTTP call, not `claude -p`, not a direct API call.
4. **The build is synchronous inside the WebSocket message handler with no background worker and no completion-keyed delivery.** Delivery happens only within the same request; if it returns early or the process dies, the job is stranded. There is NO sweeper â€” `findUndeliveredArtifacts` (`artifact-delivery.mjs:232`) exists but is never invoked by the listener.
5. **22 of 51 live jobs are in `needs_workspace`/`needs_workspace_job`** â€” an "acknowledged, no file, no worker" dead-end with no code path that ever advances them. The "workspace Codex lane" referenced in `handoffSummaryForRequest` is not implemented here.
6. **Orphan windows:** `queued`(513)/`building`(557)/`delivery_requested`(633) are all written before their corresponding work completes; a crash/disconnect/SIGTERM in those gaps strands the job, and `summarizeSlackDmJob` will then report "I'm building it..." indefinitely.
7. **No timeout on the actual file builders** (`slack-asset-workflows.mjs:215`, weasyprint/pandoc) and only 1 MB `maxBuffer` â€” a hung or chatty build blocks the socket handler and can throw on buffer overflow, surfacing as "failed validation."
8. **The stale comment at `listener.mjs:182-189` claiming the listener is disabled is wrong** â€” it is the live, sole inbound DM path (PID 1622, active LaunchAgent). `too_many_websockets` disconnects in the log (4:45am) indicate intermittent dual-socket-owner episodes that tear down the connection mid-session, compounding the orphan risk.
9. **`slack-bridge.mjs` (PID 1626) is an MCP tool server, not a competing listener** â€” RULED-OUT as an inbound race.
10. **`writeJobs(jobs.slice(-200))` (`slack-dm-jobs.mjs:122`) + `maxAgeMinutes:720` in `findLatestDeliveryCandidate`** mean a delayed follow-up can no longer find the earlier build, so even the manual-recovery path silently fails for old or high-volume sessions.