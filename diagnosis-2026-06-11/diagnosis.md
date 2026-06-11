Below is my synthesis. This is the final diagnostician's report. No mutations were performed â€” all four reports were read-only, and what follows are findings plus single-purpose prompts for the operator to fire.

---

# Atlas Slack Asset Pipeline â€” Definitive Root Cause + Permanent Fix

## 1. ROOT CAUSE

**For the client (plain version):** Atlas has two completely separate ways of answering a Slack request, and *neither one can actually build and deliver a new file reliably*. The fast "asset" path can only produce two specific, hand-coded documents â€” anything else is refused on sight, even a doc you already have. The slow "thinking" path runs the AI in a way that times out before it finishes and then hands the job to a worker that *does not exist on the machine*. In both cases Atlas says "got it, building now" the instant your message arrives â€” before it has checked whether it can actually do the job â€” so you always get an acknowledgement and usually get no file. A second message sometimes works only because it stumbles onto a file an earlier dead request left half-finished on disk. None of this is a tuning problem; the delivery of a file is glued to a single live chat reply that is designed to die.

**The single architectural root cause:** *Asset building and asset delivery are bound to one synchronous, hard-killed Slack request, with no durable worker consuming the job queue and no completion-keyed delivery.* The acknowledgement is emitted before capability is resolved, so "ack with no file" is the system's default behavior, not its failure mode.

**Technical version with the load-bearing evidence:**

There are two content paths and both are structurally incapable of durable build-and-deliver:

- **Asset lane** (`listener.mjs:507-693`): fully synchronous inside the WebSocket message handler. The ack fires *unconditionally* at `listener.mjs:512-513` *before* workflow resolution at `listener.mjs:536`. Resolution is an allow-list of exactly two hardcoded keys â€” `first-10k-online-coach` and `jess-endure-ad-cta-dm-follow-up` (`slack-asset-workflows.mjs:21-66`); `findSlackAssetWorkflowForRequest` returns `null` for everything else (`slack-asset-workflows.mjs:74-80`) â†’ instant `blocked` (`listener.mjs:544-554`). This is the live-captured failure at 12:29:30-31 and ledger job `asset-893ab97fd4` / `slackdm-...1781144970` (Report 2 Â§ROOT-CAUSE-4, Report 4 trace B). No LLM is ever invoked in this lane (Report 1 Â§2a).

- **Gateway lane** (`listener.mjs:695-976`): `execFile("openclaw","agent","--message",text,"--session-id",sessionId)` with a 240s hard SIGTERM (`listener.mjs:54,243-256`). On timeout the job is parked at `needs_workspace_job` and the user gets `liveTimeoutHandoffText()` â€” "logged, but no verified file exists yet" (Report 4 Â§A). **No worker ever consumes that queue:** `launchctl list` shows only `com.atlas.slack-listener` (PID 1622) â€” there is no workspace/Codex LaunchAgent (Report 2 Â§ROOT-CAUSE-1). The ledger's own `safeErrorSummary` confesses it: *"Workspace handoff is recorded but no automatic workspace worker has claimed it yet."* 22 of 51 jobs (43%) are stranded in this dead-letter state.

**The precise "follow-up sometimes works" mechanism** (Report 4 Â§A, the smoking gun): delivery is decoupled from the build that produced the file and re-attached by a *later* request reading the persisted ledger. `findLatestDeliveryCandidate` (`slack-dm-jobs.mjs:199-228`) deliberately includes non-terminal statuses (`building`, `artifact_ready`, `delivery_requested`, `needs_workspace_job`) in its `deliverableStatuses` set and sorts jobs-that-already-have-files-on-disk first (`:222-226`). So when request #1's agent finishes writing a PDF to `exports/` *after* its 240s SIGTERM (the build outlived its delivery channel), request #2 â€” if its text happens to match `isDeliveryRequestFollowup` (`slack-listener-reply.mjs:33-39`) â€” scoops up that orphan and delivers it. It "sometimes" works because it depends on: (a) the follow-up phrasing matching, (b) the orphan still being inside `maxAgeMinutes:720` and the last-200-job window (`slack-dm-jobs.mjs:122`), (c) the 8-minute `GATEWAY_COOLDOWN_MS` having elapsed (`listener.mjs:55` â€” too-soon retries get brushed off to `needs_workspace_job` without even running), and (d) a file actually having been written. Miss any one and the re-ask fails too. **That is why smoke tests pass and real use breaks in 1-2 days: a warm, single, fast, registry-matching request exercises none of these failure conditions.**

A secondary, independent root cause compounds the gateway lane: the listener doesn't call an API â€” it scrapes the CLI's human-formatted, diagnostic-polluted stdout and runs `JSON.parse` on it (`listener.mjs:257` â†’ `extractGatewayReply`, `slack-listener-reply.mjs:144-163`). The parse throws on any `[trace:embedded-run]`/`[plugins] bonjour` log line, falls through to `return raw`, and the raw blob is then rejected as "empty response" (Report 3 Â§2,Â§6). The 9-candidate parse fallback and the `redactSlackDiagnostic` token-scrubber exist *only* because there is no machine-readable contract â€” `grep` finds no `result.payloads` shape in the real dist (Report 3 Â§2).

---

## 2. Why every prior fix failed

| Band-aid | Symptom it treated | Root it missed |
|---|---|---|
| **Timeout bump 60â†’120â†’240s** (`GATEWAY_TIMEOUT_MS`, `listener.mjs:54`) | "Runs die too early" | Delivery is bound to the live request *at all*. Document tasks blow even 180-240s every time (Report 2 Â§ROOT-CAUSE-2: five `EMPTY_RESPONSE` at exactly 180s) and the underlying agent is allowed 1800s (`timeoutSeconds`, Report 3 Â§3) â€” so the listener kills mid-stream no matter the bump. A bigger number just moves the wall. |
| **stderr preservation / output sanitizing** (`redactSlackDiagnostic`, `slice(0,4000)`) | "Replies come back garbled/leaky" | The output was never the problem with *file delivery*. Sanitizing stdout treats the symptom of scraping a non-JSON CLI stream (Report 3 Â§6); it can't make a file appear. Report 2 explicitly RULES OUT truncation/maxBuffer/0-chars: zero hits in current logs. |
| **Retry scripts** | "Sometimes it doesn't deliver" | Retries re-fire the same synchronous-build-or-block path. Inside the 8-min cooldown they're deflected without running (`listener.mjs:55`); the "success" on retry is the ledger-rediscovery race, not the retry working (Report 4 Â§A, fact 5). It's nondeterministic by construction. |
| **Minimal constraints / two verified workflows** (the anti-fake-PDF allow-list) | "It hallucinated generic PDFs" | Over-corrected into a 2-item allow-list that blocks *everything else*, including legitimate retrieval (Report 4 Â§B). Fixed the hallucination, created the over-block. |
| **Durable job ledger** (`slack-dm-jobs.json`) | "We lose track of jobs" | The ledger *records* state but nothing *drives* it. `findUndeliveredArtifacts` exists (`artifact-delivery.mjs:232`) but is **never called by the listener** (Report 1 Â§3). A ledger with no consumer is a graveyard â€” hence 22/51 stranded. The durable store was built and left unwired. |

Every fix treated a downstream symptom of the same upstream fact: **there is no durable worker, and delivery is welded to a disposable chat turn.** The smoke tests passed because they never cold-start, never run concurrently, never hit the dead lane, and always match a registered workflow.

---

## 3. THE PERMANENT FIX â€” the decision

**Primary recommendation: (a) Keep OpenClaw, but stop using it as the builder.** Move all asset build-and-deliver onto a **deterministic worker that consumes the already-existing durable job store**, behind the already-existing event-log seam. OpenClaw's *only* remaining job is conversation: classify intent, write the job to the store, ack honestly, and answer chat. It never builds, never delivers files, never owns the completion guarantee.

This is decisive and it is *not* a band-aid because it removes the root cause rather than tuning around it: build and delivery are pulled off the disposable synchronous request onto a durable consumer keyed on job completion. Crucially, **the Workspace + durable core job store + doc-converter pipeline + delivery-receipt invariants already exist in the repo, largely unwired** (per your locked-architecture constraint). This is wiring, not a rewrite.

**Why not the other three:**

- **(b) Switch the harness â€” NO.** The harness is genuinely brittle (CLI-stdout scraping, in-place-patched dist that reverts on `brew upgrade`, Report 3 Â§8). But swapping harnesses doesn't give you a durable worker or completion-keyed delivery â€” you'd rebuild the *same* synchronous-request architecture on a new harness and reproduce the bug. Harness brittleness is a *contributing* fault on the conversational lane, not the root cause of non-delivery.
- **(c) Switch the model â€” NO, and address it directly: GPT-5.5-via-OpenClaw is a contributing factor, not the root.** The evidence is real: sole provider `openai-codex/gpt-5.5` with `fallbacks:[]` / `next=none` (Report 3 Â§1), 117 `fetch failed` timeouts, OAuth `codex-cli credential unavailable`, context overflow at ~108 messages cascading into a 630s lane timeout + session-lock deadlock with passive `observe_only` recovery (Report 2 Â§ROOT-CAUSE-3,Â§CONTRIBUTING). But note: **a real "build an asset" request never calls the model at all** (Report 1 Â§2a). The model can't be the root cause of non-delivery for the path that doesn't use it. Switching to Opus 4.8 would make the *conversational* lane more reliable and is worth doing for chat â€” but if you only switched the model, the asset lane still blocks and the dead worker queue still strands 43% of jobs. Do add a fallback (`next=none` is indefensible) â€” but as hardening, not as the fix.
- **(d) Full Lane-B cutover now â€” NO, not as step one.** It's the correct *destination* (the durable Workspace builder on the client's own Opus 4.8/GPT-5.5 behind the event-log seam is exactly Lane B), but a big-bang cutover under a client-at-risk deadline is the highest-variance move. The right path is to *wire the deterministic worker into the existing store as the seam*, prove it cold/concurrent, then let Lane-B grow into that worker. You reach Lane B by walking, not leaping â€” and the first step already de-risks the client relationship.

**What role OpenClaw keeps:** Lane A, conversation only. It owns the single Slack Socket-Mode identity (honoring the hard rule: no parallel Slack identities, gated sends, never send-as-Rhys), it classifies and writes jobs to the durable store, and it answers chat. It is *forbidden* from being the build-or-deliver path. This also lets you fix the harness brittleness opportunistically (pin the dist, add a model fallback, switch chat to Opus 4.8) without it being on the critical path for file delivery.

---

## 4. The over-blocking fix (retrieval without reopening the fake-PDF hole)

The over-block is two specific code facts (Report 4 Â§B): (1) `classifySlackRequest` has **no retrieval class** â€” "find it and send it" hits the `\bdoc\b` test in the `document_request` branch *before* the `find`-based `general_research` branch (`slack-dm-jobs.mjs:72-80`), and (2) the only doc path is the produce-or-block 2-key registry, and **no Slack-history / export-search retrieval capability exists** (`slack-rhys-dm-artifact.mjs:89` is a post-upload `ts` dedup helper, not retrieval).

The fix is a **new, separate retrieval lane that is read-only and therefore cannot fabricate anything:**

1. **Add a `retrieval` intent** that fires when the request contains retrieval verbs against an *existing* referent â€” "find / send me / the one I already / that doc from / you sent before" â€” and route it *ahead of* the produce-or-block matcher.
2. **Resolve it against real, already-created artifacts only:** search the durable artifact ledger + `exports/` archive (reuse `scanExportArtifactGroups`/`findUndeliveredArtifacts`, `artifact-delivery.mjs:102-127,232`, which already enumerate real on-disk files) and, if needed, Slack file history via `files.list`/`search.messages` scoped to the bot's own prior uploads.
3. **This re-uses the anti-fake-PDF invariant rather than bypassing it:** retrieval can *only* return a file that demonstrably already exists on disk or in Slack history. If nothing matches, it says "I couldn't find a doc matching that â€” want me to build one?" â€” it never invents a PDF. The guardrail's purpose (don't fabricate) is preserved; what's removed is the false equivalence between "I can't *build* this" and "I can't *find* this."

This closes the over-block while keeping the fake-PDF hole shut, because retrieval has no generation code path at all.

---

## 5. MIGRATION PLAN

Each prompt is single-purpose, fired by Dante at Mac Studio Claude Code. Diagnosis/drafting is read-only; the prompts themselves mutate. Verifications are designed to catch **cold/concurrent** failure, not warm smoke.

**Prompt 0 â€” "Freeze and snapshot the live runtime" (read-only safety baseline).**
Job: capture current state before any change. Read and record: `launchctl list` (confirm only `com.atlas.slack-listener`), the 51-record ledger status distribution, `slack-asset-workflows.mjs` registry contents, OpenClaw version (`2026.4.29`) and `brew pin` status, and the dist-patch list (`openclaw-dist-patches.md`). Output a baseline doc. *Verify:* baseline matches the four reports (22 `needs_workspace*`, 2-key registry, no worker LaunchAgent). No mutation.

**Prompt 1 â€” "Make the ack honest" (smallest decoupling, stops the contradiction).**
Job: in `listener.mjs`, move the ack at lines 512-513 to *after* workflow/route resolution, so the user is never told "creating now" before capability is known. For unmatched asset requests, send the route-appropriate message (queued-to-worker, retrieving, or "I can build this â€” confirm"), never "creating now â†’ blocked" one second apart. *Verify (cold):* restart the listener fresh, send one request that matches no registry workflow; confirm the ledger shows a single coherent state and the user never receives the self-contradictory ackâ†’blocked pair seen at 12:29:30-31.

**Prompt 2 â€” "Stand up the deterministic delivery worker as a LaunchAgent" (the core fix â€” wires the existing store).**
Job: create `com.atlas.workspace-worker` LaunchAgent that polls the durable job store for non-terminal jobs with artifacts (wire the *existing* `findUndeliveredArtifacts`, `artifact-delivery.mjs:232`) and drives delivery to completion via the existing receipt invariant (`hasSlackDeliveryReceipt`), independent of any live Slack request. Build and delivery move here; the listener stops delivering inline. Honor the hard rule: worker delivers only to Rhys via the gated send, never send-as-Rhys, single identity. *Verify (the real-use test â€” see below):* must pass the cold/concurrent/orphan-recovery test, not a warm smoke test.

**Prompt 3 â€” "Add the read-only retrieval lane" (over-block fix).**
Job: add a `retrieval` intent to `classifySlackRequest` routed *ahead of* the produce-or-block matcher (`slack-dm-jobs.mjs:72-80`), backed by a search over the existing artifact ledger + `exports/` (`scanExportArtifactGroups`) + bot's own Slack file history. No generation path. *Verify (cold + over-block):* cold-start, send the exact live failing request ("i have sent clients a vsl framework beforeâ€¦ find it and send it"); confirm it routes to retrieval and returns the existing file (or an honest "not found, want me to build it?"), and that ledger no longer shows `blocked: No verified Slack asset workflow`.

**Prompt 4 â€” "Harden the conversational lane" (model + harness, off the critical path).**
Job: switch the chat model to the client's Opus 4.8 (or keep gpt-5.5 but add a real fallback â€” `next=none` is the indefensible part, Report 3 Â§1), `brew pin openclaw` and re-apply the dist patch per `openclaw-dist-patches.md`, and replace stdout-scraping with `--deliver` or a structured output contract so `extractGatewayReply` stops `JSON.parse`-ing log-polluted text (Report 3 Â§2). *Verify:* run a long conversational (non-asset) request; confirm no `EMPTY_RESPONSE`-from-parse-failure and that a provider blip degrades gracefully via fallback instead of `next=none` terminal failure.

**Prompt 5 â€” "Kill the dead handoff path + sweep orphans" (close the dead-letter queue).**
Job: now that Prompt 2's worker exists, repoint the `needs_workspace`/`needs_workspace_job` transitions to enqueue onto the real worker, and add a one-time sweep that re-drives the 22 stranded jobs. *Verify:* ledger `needs_workspace*` count drops to ~0; any stranded job with an on-disk artifact gets delivered; the `summarizeSlackDmJob` "I'm building itâ€¦" forever-lie (Report 1 Â§5) no longer occurs because building state now has a live consumer.

**THE PROOF-IT'S-FIXED TEST FOR RHYS (mimics real use â€” cold, concurrent, retrieval):**
1. **Cold start:** fully restart the listener and worker; wait past the 8-min cooldown window so nothing is warm.
2. **Two different requests, fired close together (concurrency):**
   - Request A (build): a *novel* asset request not in the old 2-key registry.
   - Request B (retrieval): "find the [VSL framework] doc I already sent and send it here" â€” the exact live-failed shape.
3. **Sever the channel mid-build** (simulate the `too_many_websockets`/SIGTERM orphan, Report 2 Â§7): bounce the socket while A is building.
4. **Pass criteria:** A's file is delivered by the *worker* after the socket bounce (proving delivery survives the dead request â€” the thing every prior fix failed); B returns the existing file via retrieval with no `blocked` (proving the over-block is fixed); no self-contradictory ack; ledger ends with both jobs terminal-`delivered`, zero new `needs_workspace*`. Run this **twice, 24h apart**, because the failure mode is "breaks in real use within 1-2 days" â€” a single green run is exactly what the old smoke tests gave you.

---

## 6. Honest risk read

**What could still bite:**
- **The dist is patched in-place and brew-managed (Report 3 Â§8).** Any `brew upgrade openclaw` reverts the timeout-text patch, and the workspace rejection regex (`NON_USEFUL_PATTERNS`) is coupled to those exact strings â€” an upgrade silently re-leaks config jargon to Rhys. `brew pin` is mandatory, not optional.
- **The gateway event loop is pegged ~0.7-0.97 ELU with 7-12s stalls 24/7 (Report 3 Â§4).** Even after decoupling delivery, a saturated event loop will keep conversational replies slow and can starve the worker's I/O if they share the box. Watch resource headroom on Mac Studio.
- **Secret exposure (Report 3 Â§0):** plaintext API keys/tokens in all three plists and `openclaw.json`, gateway runs `--auth none`. Not a delivery bug, but a live client-data risk that should be remediated as its own task.
- **Retrieval scope creep:** if Prompt 3's retrieval search is too permissive (e.g., returns the wrong old doc), it erodes trust differently than over-blocking did. Keep it tightly scoped to exact-ish matches and confirm-before-send on ambiguity.

**The one thing to watch:** the **orphan-recovery path under the worker (Prompt 2/5).** The entire root cause is "a build finishes after its delivery channel dies, and nothing re-drives it." The worker fixes this *only if* it reliably claims and delivers jobs whose build completed out-of-band. Watch the `needs_workspace*` count and the count of on-disk artifacts in `exports/` that lack a delivery receipt â€” those two numbers trending to zero, and *staying* there across a socket bounce, is the single signal that the real bug is dead. If either number creeps back up, the worker isn't actually owning completion and you're back to the ledger-rediscovery race in a new costume.