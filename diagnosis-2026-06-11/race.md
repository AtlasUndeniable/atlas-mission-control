I now have complete, corroborated evidence for both findings, grounded in source code AND live runtime data. I have everything needed. Let me compile the report.

---

# Atlas Slack-Asset Pipeline â€” Code-Level Diagnosis

**Live runtime:** `/Users/atlasai/.openclaw/workspace/` (launchctl `com.atlas.slack-listener` â†’ `services/slack-listener/listener.mjs`, last-modified files Jun 9). Three other copies exist (`atlas-mission-control/openclaw-runtime/...`, `atlas-slack-dm-delivery-release/...`, `atlas-hotfix-20260522/...`) but are byte-identical or stale; the `.openclaw/workspace` tree is what the running daemon loads.

All paths below are absolute. Line numbers in `handleMessage`/gateway sections are given as file-absolute where I re-derived them; where I quote from a `sed -n` window I note the base offset.

---

## A) THE "FOLLOW-UP SOMETIMES WORKS" MECHANISM

### The architecture: gateway runs synchronously inside the Slack reply, with a hard kill timer

`forwardToGateway()` (file `services/slack-listener/listener.mjs`, lines 238â€“286) shells out to the LLM agent **synchronously inside the request handler** with a hard `timeout`:

```js
// listener.mjs:54
const GATEWAY_TIMEOUT_MS = Number(process.env.SLACK_LISTENER_GATEWAY_TIMEOUT_MS || 240_000);
// listener.mjs:243-249
execFile("/opt/homebrew/bin/openclaw", ["agent","--message", text,"--session-id", sessionId], {
  timeout: GATEWAY_TIMEOUT_MS,
  maxBuffer: 10 * 1024 * 1024,
  ...
```

When that 240s timer fires, Node sends **SIGTERM** to the `openclaw agent` subprocess. The handler detects it via `err.killed`/`SIGTERM` (lines 261â€“263, 277) and routes to a *terminal-but-incomplete* job state â€” **not** a delivery:

```js
// listener.mjs gateway tail (base offset 700), G64-66:
await updateSlackDmJob(job.id, {
  status: isTimeout ? "needs_workspace_job" : "failed",
  ...
// G80:
await sendSlackMessage(channel, fallback, threadTs, { kind: "summary", callerSite: "gateway-timeout-status" });
return;
```

`fallback = liveTimeoutHandoffText()` â†’ *"This needs workspace time, so I won't keep trying to finish it inside the live Slack reply window. I have it logged, but no verified file exists yet."* **This is the "ack but no file" message the user sees.**

**ROOT-CAUSE (A):** The build/agent work and the *delivery* are bound to one synchronous request. If the agent's work (or a Codex/workspace build it kicked off) finishes writing a file to `exports/` *after* the 240s SIGTERM, the artifact lands on disk but the request that would have delivered it is already dead and the job is parked in `needs_workspace_job`. Delivery was tied to the now-dead request. **Confirmed live:** job `slackdm-D0AM2R3H6SE-1780918664` ("and the asset I asked for before that?") = `needs_workspace_job`, `safeErrorSummary: failure_type=timeout | provider=openai-codex | model=gpt-5.5 | summary=Live Slack agent window timed out`.

### Why a SECOND message then succeeds: two independent re-discovery paths

A later message re-scans persisted state and advances/delivers what the first request left behind. There are **two distinct paths**, both keyed off the *follow-up* text, not off any callback from the original build:

**Path 1 â€” explicit "send it here" â†’ `findLatestDeliveryCandidate` re-reads the job ledger** (listener.mjs `handleMessage`, base offset 324, lines L51â€“L142):

```js
// L51-L57
if (isDeliveryRequestFollowup(text)) {
  const deliveryJob = findLatestDeliveryCandidate({ channel, userId, excludeId: job.id, maxAgeMinutes: 720 });
  if (deliveryJob) {
    const artifactPaths = Array.isArray(deliveryJob.artifactPaths) ? deliveryJob.artifactPaths : [];
    const artifactPath = selectPreferredArtifactPath(artifactPaths);
    if (artifactPath) {
      const result = await sendRhysDmArtifact({ artifactPath, ... });   // L59
      recordSlackDmJobDelivered(deliveryJob.id, { ... });               // L68
```

`findLatestDeliveryCandidate` (`lib/slack-dm-jobs.mjs:199-228`) explicitly scoops up jobs the first request left non-terminal â€” its `deliverableStatuses` set **includes `building`, `artifact_ready`, `delivery_requested`, `needs_workspace`, `needs_workspace_job`** â€” and sorts so any job that *has* `artifactPaths` wins:

```js
// slack-dm-jobs.mjs:201-211
const deliverableStatuses = new Set([
  "queued","building","artifact_ready","delivery_requested",
  "blocked_needs_approval","answered","completed",
  "needs_workspace","needs_workspace_job",
]);
// :222-226  prefers jobs that already have files on disk
const aFiles = Array.isArray(a.artifactPaths) && a.artifactPaths.length ? 1 : 0;
...
if (aFiles !== bFiles) return bFiles - aFiles;
```

So: request #1 builds a file but dies before delivering (job stuck in `building`/`needs_workspace_job` with `artifactPaths` populated). Request #2 says "send it here" â†’ `findLatestDeliveryCandidate` finds that stranded job, `selectPreferredArtifactPath` picks the PDF, and it delivers. **The second request delivers the first request's artifact.**

**Path 2 â€” status follow-up â†’ `findRecentSlackDmJob` reads cached job summary** (listener.mjs L146â€“L167):

```js
const recentJob = isStatusFollowup(text)
  ? findRecentSlackDmJob({ channel, userId, excludeId: job.id, maxAgeMinutes: 240 })
  : null;
if (recentJob && [...,"artifact_ready","delivery_requested",...].includes(recentJob.status)) {
  const summary = summarizeSlackDmJob(recentJob);   // surfaces "The file is ready..." or files list
```

This doesn't re-deliver but *surfaces* that the first job is now `artifact_ready` with files â€” which is why a follow-up "where's that doc?" suddenly reports a file that "didn't exist" on the first ack.

### The `reusedExistingArtifact` flag (existing-artifact reuse path)

`executeSlackAssetWorkflow` (`lib/slack-asset-workflows.mjs:136-188`) sets `reusedExistingArtifact` whenever the matched workflow's `adapter === "existing-export-package"`:

```js
// slack-asset-workflows.mjs:175
reusedExistingArtifact: selected.adapter === "existing-export-package",
```

For the `first-10k-online-coach` workflow (`adapter: "existing-export-package"`, lines 23-26) there is **no build at all** â€” it points straight at a pre-existing file `${WORKSPACE_EXPORTS_ROOT}/2026-05-20-first-10k-month-bible-branded.pdf` (line 28) and just validates+delivers it. So any matching request â€” first OR second â€” "succeeds" instantly because the artifact already exists on disk. This is a *second* way a re-ask succeeds where intervening state changed: if the artifact got created out-of-band between attempts, the re-ask reuses it.

### Live corroboration (the Jess sequence â€” the textbook case)

From `/Users/atlasai/.openclaw/data/slack-dm-jobs.json`, same verbatim request text, four jobs:

| job id (ts) | time (UTC) | status | wfKey | files |
|---|---|---|---|---|
| `...1780990473` | Jun 9 **07:34:34** | **blocked** | None | 0 |
| `...1780992328` | Jun 9 08:05:29 | **delivered** | jess-endure-ad-cta-dm-follow-up | 3 |
| `...1780992358` | Jun 9 08:05:59 | delivered | jess-endure-... | 3 |
| `...1780993900` | Jun 9 08:31:42 | delivered | jess-endure-... | 3 |

The first attempt at 07:34 was `blocked` ("No verified Slack asset workflow matched this request") because the `jess-endure` workflow **did not yet exist** in the registry â€” `slack-asset-workflows.mjs` was modified later (`Jun 9 18:20`, and bak files at 07:58/08:20 show it was being edited that morning). Once the workflow was hand-added, the identical re-send delivered in ~3.5s (`buildStartedAt 08:05:29.403 â†’ artifactReadyAt 08:05:30.407 â†’ deliveredAt 08:05:32.570`). The delivery ledger (`artifact-deliveries.jsonl`) shows **three separate `art_*` delivery IDs** for "Jess Endure Mentoring: Ad CTA + DM Follow-Up Playbook" all "delivered via narrow artifact helper" â€” i.e., each re-ask rebuilt+redelivered fresh (here `reused=False`).

**RULED-OUT â€” inbound dedupe is NOT the mechanism.** There *is* an idempotency guard, but it suppresses the duplicate rather than letting it deliver:

```js
// slack-dm-jobs.mjs:96-97  (upsertSlackDmJob)
const existing = jobs.find((job) => job.id === id);
if (existing) return { job: existing, created: false };
// listener.mjs L40-43
if (!jobCreated) { log("â†©ï¸", `Duplicate Slack event ignored ...`); return; }
```

Job id is `slackdm-${channel}-${messageTs}` (`makeSlackDmJobId`, line 59-61), so only *Slack-redelivered identical events* dedupe. A human re-typing the request has a new `messageTs` â†’ new job â†’ full re-run. So "second request succeeds" is **not** dedupe; it's the timeout-orphan + ledger-rediscovery race above.

**CONTRIBUTING:** `GATEWAY_COOLDOWN_MS = 8 * 60_000` (line 55) + `setGatewayCooldown` means after a timeout the *next* request within 8 min is deflected to `needs_workspace_job` without even calling the gateway (lines G13-25) â€” so the "sometimes" is timing-dependent: too-soon retries get the cooldown brush-off; a retry after cooldown (or one that hits the synchronous asset-workflow path instead of the gateway) succeeds.

---

## B) THE MISCLASSIFICATION â€” retrieval request â†’ "no verified workflow" block

### Live proof (exact screenshot request)

`slack-dm-jobs.json`, last job `slackdm-D0AM2R3H6SE-1781144970` (Jun 11 02:29:30):
- `originalMessage`: *"i have sent clients a vsl framework before in slack as a hand[over] doc. find it and send..."*
- `classification: document_request`
- `status: blocked`
- `safeErrorSummary: "No verified Slack asset workflow matched this request."`
- `workflowKey: None`, `files: 0`

### Trace 1 â€” classification has no "retrieval" class

`classifySlackRequest` (`lib/slack-dm-jobs.mjs:72-80`):

```js
export function classifySlackRequest(text = "") {
  ...
  if (/\b(asset|playbook|workbook|worksheet|guide)\b/.test(normalized) && /\b(create|make|build|generate|pdf|doc|document|deck)\b/.test(normalized)) return "asset_request";
  if (/\b(audit|typeform|executive audit)\b/.test(normalized)) return "audit_request";
  if (/\b(doc|document|pdf|deck|brief|transcript|transcripts|call library|all the calls|every call)\b/.test(normalized)) return "document_request";
  if (/\b(content|hooks|posts|angles|topics|batch)\b/.test(normalized)) return "content_request";
  if (/\b(research|find|look up|analyse|analyze)\b/.test(normalized)) return "general_research";
  return "quick_reply";
}
```

**ROOT-CAUSE (B-1):** There is **no `retrieval` / `find_existing` class**. "find it and send it to me" contains "doc" â†’ it matches the `document_request` branch *before* the `find`-based `general_research` branch. The word "find" (the actual retrieval intent) is never reached. The taxonomy treats every doc reference as something to *produce*, never to *retrieve*.

### Trace 2 â€” routing sends it to the produce-or-block matcher

`document_request` + the phrasing trips `isLikelyLongRunningRequest` (`lib/slack-listener-reply.mjs:81-92`) â€” `hasResearchVerb` (`find`) `&& hasArtifactCue` (`doc`) is true, and the leading regex matches `\bdoc\b`. So it enters the synchronous asset-workflow lane (listener.mjs L184), which calls:

```js
// listener.mjs L213
const workflow = findSlackAssetWorkflowForRequest(text);
if (!workflow) {                                        // L214
  const reply = assetWorkflowBlockedText({ ...
    reason: "I checked the asset registry, but I do not have a verified workflow for that asset yet. I will not invent a generic PDF; ..." });
  await transitionSlackDmJob(job.id, "blocked", { ... safeErrorSummary: "No verified Slack asset workflow matched this request." });
```

### Trace 3 â€” the registry is only two keys

`findSlackAssetWorkflowForRequest` (`lib/slack-asset-workflows.mjs:74-80`) iterates `VERIFIED_SLACK_ASSET_WORKFLOWS` (lines 21-66), which contains **exactly two entries**:

1. `key: "first-10k-online-coach"` â€” matches only if `asksFirst10k && asksOnlineCoach && asksAsset` (lines 39-44).
2. `key: "jess-endure-ad-cta-dm-follow-up"` â€” matches only if `asksJess && asksCta && asksDm && asksAsset` (lines 57-63).

A "VSL framework handover doc" matches **neither** `match()` predicate â†’ `findSlackAssetWorkflowForRequest` returns `null` â†’ block. The fallback in `executeSlackAssetWorkflow` (lines 138-145) hard-codes the same refusal:

```js
if (!selected) {
  return { ok: false, status: "blocked",
    userMessage: "I checked the asset registry, but I do not have a verified workflow for that asset yet. I will not invent a generic PDF; this needs a real Atlas/Undeniable workflow or source package first." };
}
```

**ROOT-CAUSE (B-2):** The registry is a 2-item hardcoded allow-list of *producible* assets. Anything outside it over-blocks. The anti-hallucination guard ("I will not invent a generic PDF") is doing exactly what it was built to do â€” but it's the *only* response available for an unmatched request, so a legitimate **retrieval** of an already-sent doc gets the same refusal as a request to fabricate one.

### Trace 4 â€” there is NO retrieval-from-Slack capability wired (confirmed)

Grep across `lib/` + `services/slack-listener/` for `conversations.history|search.messages|conversations.replies|files.list|retriev` returns **one** hit:

```
lib/slack-rhys-dm-artifact.mjs:89:  const history = await slackClient("conversations.history", { channel: channelId, limit: 10 }, { token });
```

That single call is `resolveUploadedMessageTs()` (`slack-rhys-dm-artifact.mjs:87-95`) â€” a post-upload dedup helper that looks back 10 messages to find the `ts` of a file the bot *just* uploaded. **It is not a retrieval feature.** There is:
- No `search.messages` (Slack search API) call anywhere.
- No `files.list` / file-history scan.
- No "search prior exports for a doc the user described" path â€” `scanExportArtifactGroups`/`findUndeliveredArtifacts` (`lib/artifact-delivery.mjs:102-127, 232-263`) scan `exports/` only by recency/age for *delivery reconciliation*, and are never invoked for an inbound "find the doc I sent" request.

**CONFIRMED:** Atlas has no capability to retrieve a previously-sent document from Slack history or from its own export archive in response to a user request. Every inbound doc request is forced through the produce-or-block registry.

---

## Top facts for the diagnostician

1. **The gateway is synchronous with a 240s SIGTERM kill** (`listener.mjs:54,243-249`). On timeout the job â†’ `needs_workspace_job` and the user gets `liveTimeoutHandoffText()` ("logged, but no verified file exists yet") â€” this is the "ack, no file" symptom. Live proof: job `...1780918664`, `failure_type=timeout, provider=openai-codex, model=gpt-5.5`.

2. **A second message re-delivers the first's orphaned artifact** via `findLatestDeliveryCandidate` (`slack-dm-jobs.mjs:199-228`), whose `deliverableStatuses` set deliberately includes `building`/`needs_workspace_job`/`artifact_ready` and sorts jobs-with-files first. Triggered only when the follow-up text matches `isDeliveryRequestFollowup` (`slack-listener-reply.mjs:33-39`). This is the smoking gun: delivery is decoupled from the build that produced the file, and re-attached by a later request reading the persisted job ledger.

3. **`reusedExistingArtifact` = `adapter === "existing-export-package"`** (`slack-asset-workflows.mjs:175`); the `first-10k` workflow (line 25-28) does zero building and just re-validates a fixed on-disk PDF â€” a second route by which a re-ask "succeeds" instantly.

4. **Inbound dedupe is real but suppresses, not delivers** â€” job id = `slackdm-{channel}-{messageTs}` (`slack-dm-jobs.mjs:59-61`); duplicate Slack events are dropped (`listener.mjs L40-43`). A human re-type gets a new `messageTs` â†’ full re-run. So "follow-up works" is the timeout-orphan race, NOT dedupe. (RULED-OUT.)

5. **8-minute gateway cooldown** (`listener.mjs:55,128-142`, G13-25) makes the success/failure timing-dependent â€” retries inside the window get deflected to `needs_workspace_job` without running; retries after it (or ones hitting the synchronous asset lane) succeed. Explains "sometimes."

6. **The classifier has no retrieval class** (`classifySlackRequest`, `slack-dm-jobs.mjs:72-80`). "find it and send it" â†’ the `\bdoc\b` test in the `document_request` branch fires *before* the `find`-based `general_research` branch. Live proof: VSL job `...1781144970` classified `document_request` â†’ `blocked`.

7. **The verified-workflow registry is exactly 2 hardcoded keys** â€” `first-10k-online-coach` and `jess-endure-ad-cta-dm-follow-up` (`slack-asset-workflows.mjs:21-66`). `findSlackAssetWorkflowForRequest` returns `null` for everything else â†’ `executeSlackAssetWorkflow` returns the hardcoded `"no verified workflow ... will not invent a generic PDF"` block (lines 138-145; mirrored at `listener.mjs L214-219`).

8. **No Slack-history / export-search retrieval exists.** Only `conversations.history` use is a post-upload `ts` dedup helper (`slack-rhys-dm-artifact.mjs:89`). No `search.messages`, no `files.list`. The registry is the only doc path, so it structurally cannot answer "find the doc I already sent." (ROOT-CAUSE for the misclassification block.)

9. **Delivery is gated to Rhys-as-target** unless `explicitDeliveryApproval`/`slack_dm` preference is set (`artifact-delivery.mjs:190-210` queues a review item instead of sending when `targetUser==="Rhys"`), adding another branch where a built artifact sits undelivered until a follow-up advances it. (CONTRIBUTING.)