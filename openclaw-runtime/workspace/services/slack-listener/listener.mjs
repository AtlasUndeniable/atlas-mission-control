import https from "node:https";
import http from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { execFile, execFileSync } from "node:child_process";
import { runGates } from "../../lib/slack-gates.mjs";
import { holdAndAlert } from "../../lib/slack-gate-actions.mjs";
// SINGLE-OWNER DELIVERY (2026-06-11 race fix): the listener deliberately does
// NOT import sendRhysDmArtifact or recordSlackDmJobDelivered any more. Every
// artifact upload to Rhys goes through the workspace worker; the listener only
// queues delivery (delivery_requested + deliveryMessage) and acks in text.
import { recordArtifactCreated, readDeliveryLedger, scanExportArtifactGroups } from "../../lib/artifact-delivery.mjs";
import { RHYS_USER_ID, selectPreferredArtifactPath } from "../../lib/slack-rhys-dm-artifact.mjs";
import { executeSlackAssetWorkflow, findSlackAssetWorkflowForRequest } from "../../lib/slack-asset-workflows.mjs";
import { runRetrievalLane } from "../../lib/slack-retrieval.mjs";
import {
  findCarrierJobForArtifactGroup,
  findLatestDeliveryCandidate,
  findRecentSlackDmJob,
  listSlackDmJobs,
  summarizeSlackDmJob,
  transitionSlackDmJob,
  upsertSlackDmJob,
  updateSlackDmJob,
} from "../../lib/slack-dm-jobs.mjs";
import {
  approvalBlockedArtifactText,
  assetWorkflowBlockedText,
  deliveryQueuedText,
  deliveryRequestedText,
  extractGatewayReply,
  draftFailedHandoffText,
  formatGatewayFailureDetails,
  gatewayFailureDetails,
  gatewayFailureSummary,
  handoffSummaryForRequest,
  isDeliveryRequestFollowup,
  isMisdirectedDeliveryReply,
  isLikelyLongRunningRequest,
  isRetrievalIntentRequest,
  isRetrievalRequest,
  isStatusFollowup,
  isTimeoutDebugFollowup,
  isUsefulGatewayReply,
  liveTimeoutHandoffText,
  misroutedDeliveryReplyText,
  noCapabilityText,
  prepareSlackReply,
  preferredDeliveryForSlackRequest,
  retrievalAckText,
  retrievalQueuedText,
  splitProviderModel,
  workspaceAckForRequest,
} from "../../lib/slack-listener-reply.mjs";

// ── Config ──
const APP_TOKEN = process.env.SLACK_APP_TOKEN || "";
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const AUTHORISED_USERS = (process.env.AUTHORISED_USERS || "").split(",").filter(Boolean);
const LOG_FILE = "/Users/atlasai/.openclaw/logs/listener.log";
const OPENCLAW_CONFIG_FILE = "/Users/atlasai/.openclaw/openclaw.json";
const INTENDED_SOCKET_OWNER = process.env.OPENCLAW_SLACK_SOCKET_OWNER || "slack-listener";

const PING_INTERVAL_MS = 60_000;
const RHYS_DM_CHANNEL = "D0AM2R3H6SE"; // Rhys's DM with the bot (U068FRX5423)
const GATEWAY_TIMEOUT_MS = Number(process.env.SLACK_LISTENER_GATEWAY_TIMEOUT_MS || 240_000);
const GATEWAY_COOLDOWN_MS = 8 * 60_000;
const MAX_MISSED_PONGS = 3;
const DM_ONLY_MODE = process.env.SLACK_LISTENER_DM_ONLY !== "0";

let botUserId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
let activeWs = null;
const activeGatewaySessions = new Map();
const gatewaySessionCooldownUntil = new Map();

function ts() {
  return new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" });
}
function log(emoji, msg) {
  const line = `[${ts()}] ${emoji} ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function readBrainProvenance() {
  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, "utf8"));
    const modelId = config?.agents?.defaults?.model?.primary || "";
    return splitProviderModel(modelId);
  } catch {
    return splitProviderModel(process.env.OPENCLAW_DEFAULT_MODEL || "");
  }
}

function readOpenClawSlackConfig() {
  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, "utf8"));
    return {
      enabled: config?.channels?.slack?.enabled === true,
      mode: config?.channels?.slack?.mode || "unknown",
    };
  } catch {
    return { enabled: false, mode: "unknown" };
  }
}

function currentSocketOwnerStatus() {
  const owners = [];
  try {
    const ps = execFileSync("ps", ["-axo", "pid,ppid,command"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (/services\/slack-listener\/listener\.mjs/.test(ps)) owners.push("slack-listener");
    const gatewaySlack = readOpenClawSlackConfig();
    if (gatewaySlack.enabled && gatewaySlack.mode === "socket" && /(?:^|\n)\s*\d+\s+\d+\s+.*(?:^|\s)openclaw(?:\s|$)/m.test(ps)) {
      owners.push("openclaw-gateway");
    }
  } catch {
    owners.push("unknown");
  }
  const uniqueOwners = [...new Set(owners)];
  const status = uniqueOwners.length > 1
    ? "conflict"
    : uniqueOwners.length === 0
      ? "no_active_socket_owner"
      : uniqueOwners.includes(INTENDED_SOCKET_OWNER)
        ? "ok"
        : "wrong_owner";
  return { status, owners: uniqueOwners };
}

function logSocketOwnerStatus() {
  const socketOwner = currentSocketOwnerStatus();
  log("🔒", `SOCKET_OWNER_STATUS status=${socketOwner.status} intended_owner=${INTENDED_SOCKET_OWNER} active_socket_owners=${socketOwner.owners.join(",") || "none"}`);
  if (socketOwner.status === "conflict") {
    log("⚠️", "SOCKET_OWNER_CONFLICT multiple active Slack Socket Mode owners detected; listener will continue, but live Slack may disconnect with too_many_websockets.");
  }
}

function gatewayCooldownRemainingMs(sessionId) {
  const until = gatewaySessionCooldownUntil.get(sessionId) || 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    gatewaySessionCooldownUntil.delete(sessionId);
    return 0;
  }
  return remaining;
}

function setGatewayCooldown(sessionId) {
  gatewaySessionCooldownUntil.set(sessionId, Date.now() + GATEWAY_COOLDOWN_MS);
}

function currentActiveGateway(sessionId) {
  const active = activeGatewaySessions.get(sessionId);
  if (!active) return null;
  if (Date.now() - active.startedAt > GATEWAY_TIMEOUT_MS + GATEWAY_COOLDOWN_MS) {
    activeGatewaySessions.delete(sessionId);
    return null;
  }
  return active;
}

// ── Slack API ──
function slackApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: "slack.com",
      path: `/api/${method}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ ok: false, error: chunks }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Atlas conversational reply send path. Gates apply: this is the slack-listener
// egress that wraps every chat.postMessage with runGates + holdAndAlert.
//
// NOTE on the live path: slack-listener is currently DISABLED (LaunchAgent
// suffixed .plist.disabled). The active reply path runs through the gateway's
// compiled @openclaw/slack plugin which cannot be wrapped without patching
// vendor code. This gate is defense-in-depth for if/when slack-listener gets
// re-enabled as the canonical reply path. Until then, leak prevention relies
// on (a) disabling source-leak plugins via `openclaw plugins disable`, and
// (b) Phase 3 tool-result-boundary filtering before subprocess stdout enters
// next-turn context. Phase 2 #5 from Session 53.
async function sendSlackMessage(channel, text, threadTs, gateCtx = {}) {
  const prepared = prepareSlackReply(text, { preferredDelivery: "slack_thread" });
  const chunks = prepared.chunks?.length ? prepared.chunks : [String(text || "")];
  const results = [];
  let index = 0;
  for (const chunk of chunks) {
    const suffix = chunks.length > 1 ? `\n\n(${index + 1}/${chunks.length})` : "";
    results.push(await sendSlackMessageChunk(channel, `${chunk}${suffix}`, threadTs, gateCtx));
    index++;
  }
  return results.length === 1 ? results[0] : { ok: results.every((result) => result.ok), chunks: results.length, results };
}

async function sendSlackMessageChunk(channel, text, threadTs, gateCtx = {}) {
  const isDM = typeof channel === "string" && channel.startsWith("D");
  const gateResult = runGates({
    text,
    channelId: channel,
    channelName: gateCtx.channelName,
    // Rhys DM is client-facing per Session 53 gate policy.
    isClientFacing: gateCtx.isClientFacing !== undefined ? gateCtx.isClientFacing : isDM,
    kind: gateCtx.kind || "chat",
    payload: { channel, text, thread_ts: threadTs },
  });
  if (!gateResult.pass) {
    await holdAndAlert({
      text,
      channelId: channel,
      channelName: gateCtx.channelName || null,
      asRhys: false,
      gateResult,
      callerService: `slack-listener:${gateCtx.callerSite || "sendSlackMessage"}`,
    });
    log("⛔", `HELD outbound to ${channel}: gate ${gateResult.gate} — ${gateResult.reason}`);
    return { ok: false, held: true, gate: gateResult.gate, reason: gateResult.reason };
  }
  if (gateResult.voiceWarnings?.length) {
    log("👁️", `voice warnings (${channel}): ${gateResult.voiceWarnings.length}`);
  }
  const finalText = gateResult.scrubbed || text;
  const body = { channel, text: finalText };
  if (threadTs) body.thread_ts = threadTs;
  const result = await slackApi("chat.postMessage", body);
  if (!result.ok) log("❌", `Send failed: ${result.error}`);
  return result;
}

// ── Forward to OpenClaw Gateway via CLI ──
function forwardToGateway(text, userId) {
  return new Promise((resolve) => {
    const sessionId = `slack-${userId}`;
    const brain = readBrainProvenance();
    log("🧠", `Gateway dispatch session=${sessionId} provider=${brain.provider} model=${brain.model} timeoutMs=${GATEWAY_TIMEOUT_MS}`);
    execFile("/opt/homebrew/bin/openclaw", [
      "agent",
      "--message", text,
      "--session-id", sessionId,
    ], {
      timeout: GATEWAY_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: "/Users/atlasai",
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      },
      cwd: "/Users/atlasai/.openclaw/workspace",
    }, (err, stdout, stderr) => {
      const reply = extractGatewayReply(stdout);
      const stdoutText = String(stdout || "").slice(0, 4000);
      const stderrText = String(stderr || "").slice(0, 4000);
      if (err) {
        const failureDetails = gatewayFailureDetails({
          timedOut: err.killed || err.code === "ETIMEDOUT" || err.signal === "SIGTERM",
          errorMessage: err.message,
          stderr: stderrText,
          stdout: stdoutText,
          reply,
          provider: brain.provider,
          model: brain.model,
        });
        log("❌", `Agent error: ${formatGatewayFailureDetails(failureDetails)}`);
        resolve({
          ok: false,
          reply,
          error: err,
          stdout: stdoutText,
          stderr: stderrText,
          timedOut: err.killed || err.code === "ETIMEDOUT" || err.signal === "SIGTERM",
          brain,
          failureDetails,
        });
        return;
      }
      resolve({ ok: true, reply, error: null, stdout: stdoutText, stderr: stderrText, timedOut: false, brain });
    });
  });
}

async function recordReplyArtifacts({ mediaPaths, userId, channel, messageTs, text, explicitDeliveryApproval = false }) {
  if (!mediaPaths.length) return null;
  try {
    return await recordArtifactCreated({
      artifactPaths: mediaPaths,
      title: "Slack generated artifact",
      requestedBy: userId,
      targetUser: "Rhys",
      source: `slack-listener:${channel}:${messageTs}`,
      summary: String(text || "").replace(/\s+/g, " ").slice(0, 300),
      suggestedDeliveryNote: "Generated file is ready for Rhys DM delivery review. Approve before live send.",
      explicitDeliveryApproval,
      queueReview: !explicitDeliveryApproval,
    });
  } catch (err) {
    log("⚠️", `Artifact ledger record failed: ${err.message}`);
    return null;
  }
}

// ── Fallback: DM Rhys when things go wrong ──
async function notifyRhysFallback(senderId, channel, messageSnippet, reason) {
  // Log full technical details for debugging — never expose to Rhys
  log("🔔", `FALLBACK reason="${reason}" from=${senderId} channel=${channel} msg="${messageSnippet}"`);

  // Human-friendly message only — no error codes, paths, or internals
  const fallback = "I picked up the message, but the Slack reply path failed before I could produce a safe response. It is logged for operator review.";
  try {
    await sendSlackMessage(RHYS_DM_CHANNEL, fallback, null);
    log("🔔", `Fallback DM sent to Rhys for ${senderId} in ${channel}`);
  } catch (dmErr) {
    log("❌", `RHYS_DM_FAILED error="${dmErr.message}" — original from=${senderId} channel=${channel} msg="${messageSnippet}"`);
  }
}

// Delivery may only be QUEUED for the Rhys DM — the worker filters on the
// same pair, and the gated send enforces it again at upload time. Queueing
// anything else would strand a job in delivery_requested that no process is
// allowed to deliver (the old inline send surfaced this by throwing).
function canQueueRhysDmDelivery(channel, userId) {
  return channel === RHYS_DM_CHANNEL && userId === RHYS_USER_ID;
}

// ── Handle Message ──
async function handleMessage(event) {
  if (event.bot_id || event.subtype) return;

  const userId = event.user;
  const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  const channel = event.channel;
  const isDM = event.channel_type === "im";
  if (DM_ONLY_MODE && !isDM) {
    log("↩️", `Ignored non-DM event from=${userId} channel=${channel}`);
    return;
  }
  const threadTs = event.channel_type === "im" ? null : (event.thread_ts || event.ts);

  const isAuthorised = AUTHORISED_USERS.length === 0 || AUTHORISED_USERS.includes(userId);
  if (!isAuthorised) {
    log("🚫", `Unauthorised: ${userId}`);
    return;
  }

  const snippet = text.substring(0, 150);
  log("📩", `From ${userId} in ${channel}: ${snippet}`);

  // Fire-and-forget: add ⚡ reaction as typing indicator
  const msgTs = event.ts;
  slackApi("reactions.add", { channel, timestamp: msgTs, name: "zap" })
    .then(r => { if (!r.ok) log("⚠️", `Reaction add failed: ${r.error}`); })
    .catch(e => log("⚠️", `Reaction add error: ${e.message}`));

  const { job, created: jobCreated } = upsertSlackDmJob({
    channel,
    messageTs: msgTs,
    userId,
    text,
    sessionId: `slack-${userId}`,
    kind: isStatusFollowup(text) ? "status_check" : "request",
  });

  if (!jobCreated) {
    log("↩️", `Duplicate Slack event ignored id=${job.id} status=${job.status}`);
    return;
  }

  const deliveryPreference = preferredDeliveryForSlackRequest({ text, isSlackDm: isDM });
  await updateSlackDmJob(job.id, {
    preferredDelivery: deliveryPreference.preferredDelivery,
    preferredDeliveryReason: deliveryPreference.reason,
  });

  // Read-only retrieval lane — AHEAD of the delivery-followup lane. A request
  // that names a referent to find ("find the VSL framework I sent before and
  // send it to me") resolves against files that already exist; it must never
  // fall into the produce-or-block asset lane (the over-block) nor be hijacked
  // by findLatestDeliveryCandidate (which would deliver a different recent
  // job's file). Bare "send it to me here" has no retrieval verb and falls
  // through to the delivery-followup lane below. Status follow-ups phrased
  // with a retrieval verb ("any update — did you find the doc?") keep their
  // status_check kind and go to the status lane, not here.
  if (job.kind !== "status_check" && isRetrievalRequest(text)) {
    const now = new Date().toISOString();
    let queuedCarrierId = null;
    try {
      const result = await runRetrievalLane({
        text,
        channel,
        userId,
        scanExports: () => scanExportArtifactGroups(),
        readLedger: () => readDeliveryLedger(),
        // Ledger rows can reference files deleted since; resolving a dead
        // path would queue a delivery the worker can never perform.
        fileExists: existsSync,
        listBotFiles: async () => {
          // files.list needs files:read; if the token lacks it Slack returns
          // ok:false (missing_scope) → degrade to exports+ledger. Slack files
          // only confirm existence — the resolver never surfaces a Slack-only
          // file as deliverable (the gated send needs a local on-disk path).
          const res = await slackApi("files.list", { count: 100 });
          if (res?.ok) return { ok: true, files: res.files || [] };
          return { ok: false, scope_missing: res?.error === "missing_scope" };
        },
        selectArtifactPath: selectPreferredArtifactPath,
        // SINGLE-OWNER DELIVERY (2026-06-11 race fix): retrieval resolves the
        // file but never uploads it — the workspace worker owns ALL uploads.
        // A resolved file can belong to a still-pending ledger job the worker
        // also targets; an inline send here is the double-DM race again.
        sendArtifact: async ({ artifactPath, title, message }) => ({ queued: true, artifactPath, title, message }),
      });

      if (result.kind === "delivered") {
        const queued = result.receipt; // { queued, artifactPath, title, message }
        if (!canQueueRhysDmDelivery(channel, userId)) {
          const reply = approvalBlockedArtifactText({ artifactPaths: [queued.artifactPath] });
          await updateSlackDmJob(job.id, {
            status: "blocked_needs_approval",
            completedAt: now,
            replyText: reply,
            safeErrorSummary: "Artifact delivery is restricted to Rhys's DM; operator review required.",
            retrievalResolved: "match",
          });
          await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "retrieval-not-rhys-dm" });
          log("⚠️", `Retrieval delivery blocked (not Rhys DM) job=${job.id}`);
          return;
        }
        // The file must exist NOW — queueing a dead path strands the job in
        // delivery_requested forever (the worker requires the file on disk).
        if (!existsSync(queued.artifactPath)) {
          const reply = "I found a record of that doc, but the file itself isn't available any more. Want me to rebuild it?";
          await updateSlackDmJob(job.id, {
            status: "answered",
            completedAt: now,
            replyText: reply,
            retrievalResolved: "missing_file",
            safeErrorSummary: "Retrieval resolved an artifact whose file no longer exists on disk; nothing was queued.",
          });
          await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "retrieval-missing-file" });
          log("⚠️", `Retrieval resolved a missing file job=${job.id} — not queued`);
          return;
        }
        // If a pending ledger job already carries ANY file of this resolved
        // group, queue THAT job. Matching the single preferred path missed
        // sibling formats of the same asset (.md vs .pdf), letting a second
        // job queue the SAME asset under another filename — the two-filename
        // double-send. Counters reset: an explicit re-request earns fresh
        // worker attempts instead of an instant re-park.
        const groupPaths = [...new Set([queued.artifactPath, ...((result.match?.artifactPaths) || [])])].filter(Boolean);
        const existingCarrier = findCarrierJobForArtifactGroup(listSlackDmJobs(), {
          channel, userId, excludeId: job.id, groupPaths,
        });
        const carrier = existingCarrier || job;
        await updateSlackDmJob(carrier.id, {
          status: "delivery_requested",
          preferredDelivery: "slack_dm",
          deliveryRequestedAt: now,
          artifactPaths: [...new Set([queued.artifactPath, ...((existingCarrier?.artifactPaths) || []).filter((p) => existsSync(p))])],
          title: carrier.title || queued.title,
          deliveryMessage: queued.message,
          retrievalResolved: "match",
          workerAttempts: 0,
          workerVerifyFailures: 0,
        });
        queuedCarrierId = carrier.id;
        if (existingCarrier) {
          await updateSlackDmJob(job.id, {
            status: "answered",
            completedAt: now,
            relatedJobId: existingCarrier.id,
            replyText: retrievalQueuedText(),
            preferredDelivery: "slack_dm",
            retrievalResolved: "match",
          });
        }
        await sendSlackMessage(channel, retrievalQueuedText(), threadTs, { kind: "summary", callerSite: "retrieval-queued" });
        log("✅", `Retrieval resolved and queued for worker delivery job=${carrier.id}`);
        return;
      }
      if (result.kind === "ambiguous") {
        await updateSlackDmJob(job.id, {
          status: "answered",
          completedAt: now,
          replyText: result.reply,
          retrievalResolved: "ambiguous",
          preferredDelivery: "slack_dm",
        });
        await sendSlackMessage(channel, result.reply, threadTs, { kind: "summary", callerSite: "retrieval-ambiguous" });
        log("✅", `Retrieval ambiguous job=${job.id} candidates=${result.candidates.length}`);
        return;
      }
      // not_found — honest, never fabricates.
      await updateSlackDmJob(job.id, {
        status: "answered",
        completedAt: now,
        replyText: result.reply,
        retrievalResolved: "not_found",
        safeErrorSummary: "Retrieval found no existing file matching the request; offered to build instead.",
        preferredDelivery: "slack_dm",
      });
      await sendSlackMessage(channel, result.reply, threadTs, { kind: "summary", callerSite: "retrieval-not-found" });
      log("ℹ️", `Retrieval no-match job=${job.id}${result.slackScopeMissing ? " (files:read scope missing)" : ""}`);
      return;
    } catch (retrErr) {
      // A failure AFTER the delivery was queued (e.g. the ack send threw)
      // must never clobber the queued state — the worker will deliver it.
      if (queuedCarrierId) {
        log("⚠️", `Retrieval queued ${queuedCarrierId} but post-queue step failed: ${retrErr.message} — delivery stays queued`);
        return;
      }
      // Retrieval failure must not fabricate or fall through to produce-or-block.
      const reply = "I couldn't search for that just now. Want me to try again or build one?";
      await updateSlackDmJob(job.id, {
        status: "answered",
        completedAt: now,
        replyText: reply,
        retrievalResolved: "error",
        safeErrorSummary: "Retrieval lane error; no file sent.",
      });
      await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "retrieval-error" });
      log("⚠️", `Retrieval error job=${job.id}: ${retrErr.message}`);
      return;
    }
  }

  if (isDeliveryRequestFollowup(text)) {
    const deliveryJob = findLatestDeliveryCandidate({ channel, userId, excludeId: job.id, maxAgeMinutes: 720 });
    if (deliveryJob) {
      const artifactPaths = Array.isArray(deliveryJob.artifactPaths) ? deliveryJob.artifactPaths : [];
      const now = new Date().toISOString();
      const artifactPath = selectPreferredArtifactPath(artifactPaths);
      if (artifactPath && !existsSync(artifactPath)) {
        // Queueing a dead path strands delivery_requested forever (the
        // worker requires the file on disk). Honest answer instead.
        const reply = "I have a record of that file, but it isn't available any more. Want me to rebuild it?";
        await updateSlackDmJob(deliveryJob.id, {
          safeErrorSummary: "Delivery follow-up matched this job, but its artifact no longer exists on disk.",
        });
        await updateSlackDmJob(job.id, {
          status: "answered",
          completedAt: now,
          relatedJobId: deliveryJob.id,
          replyText: reply,
        });
        await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "delivery-request-missing-file" });
        log("⚠️", `Delivery follow-up matched a missing file job=${deliveryJob.id} — not queued`);
        return;
      }
      if (artifactPath) {
        if (!canQueueRhysDmDelivery(channel, userId)) {
          const reply = approvalBlockedArtifactText({ artifactPaths: [artifactPath] });
          await updateSlackDmJob(deliveryJob.id, {
            status: "blocked_needs_approval",
            deliveryRequestedAt: now,
            deliveryRequestJobId: job.id,
            safeErrorSummary: "Artifact delivery is restricted to Rhys's DM; operator review required.",
          });
          await updateSlackDmJob(job.id, {
            status: "blocked_needs_approval",
            completedAt: now,
            relatedJobId: deliveryJob.id,
            replyText: reply,
            safeErrorSummary: "Artifact delivery is restricted to Rhys's DM; operator review required.",
          });
          await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "delivery-request-not-rhys-dm" });
          log("⚠️", `Delivery follow-up blocked (not Rhys DM) job=${deliveryJob.id}`);
          return;
        }
        // SINGLE-OWNER DELIVERY (2026-06-11 race fix): this follow-up no
        // longer uploads the orphan's file itself — that inline send raced
        // the workspace worker (which targets the same job) into a double
        // DM. The follow-up is Rhys's explicit go-ahead: record it
        // (slack_dm preference + delivery_requested) and the worker — the
        // ONLY process that uploads to Rhys — delivers within its poll
        // interval. updateSlackDmJob is used deliberately: the orphan may
        // sit in states (building, needs_workspace_job) whose formal
        // transition map predates worker-owned delivery.
        const reply = deliveryQueuedText();
        await updateSlackDmJob(deliveryJob.id, {
          status: "delivery_requested",
          preferredDelivery: "slack_dm",
          deliveryRequestedAt: now,
          deliveryRequestJobId: job.id,
          deliveryMessage: "Done. I attached the file here.",
          // Explicit re-request earns fresh worker attempts — without the
          // reset, a previously parked job re-parks after a single attempt
          // and Rhys loops on a promise that can never be kept.
          workerAttempts: 0,
          workerVerifyFailures: 0,
        });
        await updateSlackDmJob(job.id, {
          status: "answered",
          completedAt: now,
          relatedJobId: deliveryJob.id,
          replyText: reply,
          preferredDelivery: "slack_dm",
        });
        await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "delivery-request-queued" });
        log("✅", `Delivery follow-up queued ${deliveryJob.id} for worker delivery in ${channel}`);
        return;
      }
      const reply = artifactPaths.length
        ? approvalBlockedArtifactText({ artifactPaths })
        : deliveryRequestedText();
      await updateSlackDmJob(deliveryJob.id, {
        status: artifactPaths.length ? "blocked_needs_approval" : "delivery_requested",
        deliveryRequestedAt: now,
        deliveryRequestJobId: job.id,
        safeErrorSummary: artifactPaths.length
          ? "A generated artifact is ready, but slack-listener has no approved Rhys-DM file delivery helper wired for automatic send."
          : null,
      });
      await updateSlackDmJob(job.id, {
        status: "delivery_requested",
        completedAt: now,
        relatedJobId: deliveryJob.id,
        replyText: reply,
        preferredDelivery: "slack_dm",
      });
      await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "delivery-request-followup" });
      log("✅", `Delivery request mapped to ${deliveryJob.id} in ${channel} for ${userId}`);
      return;
    }
  }

  const recentJob = isStatusFollowup(text)
    ? findRecentSlackDmJob({ channel, userId, excludeId: job.id, maxAgeMinutes: 240 })
    : null;
  if (recentJob && [
    "answered",
    "queued",
    "building",
    "needs_workspace",
    "needs_workspace_job",
    "artifact_ready",
    "delivery_requested",
    "blocked_needs_approval",
    "delivered",
    "blocked",
    "failed",
  ].includes(recentJob.status)) {
    const summary = summarizeSlackDmJob(recentJob);
    await updateSlackDmJob(job.id, { status: "answered", completedAt: new Date().toISOString(), replyText: summary });
    await sendSlackMessage(channel, summary, threadTs, { kind: "summary", callerSite: "status-followup-cache" });
    log("✅", `Status follow-up answered from cache in ${channel} for ${userId}`);
    return;
  }

  if (isTimeoutDebugFollowup(text)) {
    const reply = liveTimeoutHandoffText();
    await updateSlackDmJob(job.id, {
      status: "answered",
      completedAt: new Date().toISOString(),
      replyText: reply,
      safeErrorSummary: "Timeout follow-up answered without entering the live gateway lane.",
      preferredDelivery: deliveryPreference.preferredDelivery,
      preferredDeliveryReason: deliveryPreference.reason,
    });
    await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "timeout-debug-followup" });
    log("✅", `Timeout follow-up answered without gateway in ${channel} for ${userId}`);
    return;
  }

  if (job.kind === "request" && isLikelyLongRunningRequest(text)) {
    const handoffSummary = handoffSummaryForRequest({ text, classification: job.classification });
    const assetJobId = job.assetJobId;

    // Resolve the route BEFORE any acknowledgement so the ack matches the
    // route actually taken. Unmatched requests must never hear "creating
    // now" followed by "blocked" a second later.
    const workflow = findSlackAssetWorkflowForRequest(text);

    if (!workflow) {
      const route = isRetrievalIntentRequest(text) ? "retrieval" : "no-capability";
      const reply = route === "retrieval" ? retrievalAckText() : noCapabilityText();
      try {
        await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: `asset-route-${route}` });
        await transitionSlackDmJob(job.id, "blocked", {
          completedAt: new Date().toISOString(),
          lastAckAt: new Date().toISOString(),
          ackText: reply,
          replyText: reply,
          routeResolved: route,
          safeErrorSummary: route === "retrieval"
            ? "Retrieval request handed to the operator lane; no automated search workflow exists yet."
            : "No verified Slack asset workflow matched this request.",
          handoffSummary,
          preferredDelivery: deliveryPreference.preferredDelivery,
          preferredDeliveryReason: deliveryPreference.reason,
        });
        log("?", `Asset job blocked id=${assetJobId}: no verified workflow matched route=${route}`);
      } catch (ackErr) {
        await updateSlackDmJob(job.id, {
          status: "failed",
          safeErrorSummary: "Slack acknowledgement send failed.",
          ackError: ackErr.message,
          lastAckAttemptAt: new Date().toISOString(),
          handoffSummary,
          preferredDelivery: deliveryPreference.preferredDelivery,
          preferredDeliveryReason: deliveryPreference.reason,
        });
        log("?", `ACK_SEND_FAILED channel=${channel} error="${ackErr.message}"`);
      }
      return;
    }

    const ack = workspaceAckForRequest({ jobId: assetJobId, state: "queued" });
    try {
      await sendSlackMessage(channel, ack, threadTs, { kind: "summary", callerSite: "asset-job-queued-ack" });
      await transitionSlackDmJob(job.id, "queued", {
        lastAckAt: new Date().toISOString(),
        ackText: ack,
        replyText: ack,
        routeResolved: "build-workflow-matched",
        handoffSummary,
        preferredDelivery: deliveryPreference.preferredDelivery,
        preferredDeliveryReason: deliveryPreference.reason,
      });
      log("?", `Asset job queued id=${assetJobId} in ${channel} for ${userId}`);
    } catch (ackErr) {
      await updateSlackDmJob(job.id, {
        status: "failed",
        safeErrorSummary: "Slack acknowledgement send failed.",
        ackError: ackErr.message,
        lastAckAttemptAt: new Date().toISOString(),
        handoffSummary,
        preferredDelivery: deliveryPreference.preferredDelivery,
        preferredDeliveryReason: deliveryPreference.reason,
      });
      log("?", `ACK_SEND_FAILED channel=${channel} error="${ackErr.message}"`);
      return;
    }

    await transitionSlackDmJob(job.id, "building", {
      workflowKey: workflow.key,
      workflowId: workflow.workflowId,
      workflowAdapter: workflow.adapter || "existing-artifact-package",
      buildStartedAt: new Date().toISOString(),
      handoffSummary,
      preferredDelivery: deliveryPreference.preferredDelivery,
      preferredDeliveryReason: deliveryPreference.reason,
    });

    const workflowResult = await executeSlackAssetWorkflow({ text, workflow });
    if (!workflowResult.ok) {
      const status = workflowResult.status === "failed" ? "failed" : "blocked";
      const reply = assetWorkflowBlockedText({
        jobId: assetJobId,
        state: status,
        reason: workflowResult.userMessage,
      });
      await transitionSlackDmJob(job.id, status, {
        failedAt: status === "failed" ? new Date().toISOString() : null,
        completedAt: status === "blocked" ? new Date().toISOString() : null,
        replyText: reply,
        safeErrorSummary: workflowResult.safeErrorSummary,
        workflowKey: workflowResult.workflowKey || workflow.key,
        workflowId: workflowResult.workflowId || workflow.workflowId,
        workflowAdapter: workflowResult.adapter || workflow.adapter || "existing-artifact-package",
        handoffSummary,
        preferredDelivery: deliveryPreference.preferredDelivery,
        preferredDeliveryReason: deliveryPreference.reason,
      });
      await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "asset-workflow-failed" });
      log("??", `Asset workflow ${status} id=${assetJobId}: ${workflowResult.safeErrorSummary}`);
      return;
    }

    const artifactRecord = await recordArtifactCreated({
      artifactPaths: workflowResult.artifactPaths,
      title: workflowResult.title,
      requestedBy: userId,
      targetUser: "Rhys",
      source: `slack-asset-job:${job.id}`,
      summary: handoffSummary,
      explicitDeliveryApproval: deliveryPreference.preferredDelivery === "slack_dm",
      queueReview: deliveryPreference.preferredDelivery !== "slack_dm",
      suggestedDeliveryNote: "Verified asset is ready for Rhys DM delivery.",
    });

    await transitionSlackDmJob(job.id, "artifact_ready", {
      title: workflowResult.title,
      artifactPath: workflowResult.artifactPath,
      artifactPaths: workflowResult.artifactPaths,
      sourcePaths: workflowResult.sourcePaths,
      deliveryId: artifactRecord?.deliveryId || null,
      reviewQueueId: artifactRecord?.reviewQueueId || null,
      artifactReadyAt: new Date().toISOString(),
      workflowKey: workflowResult.workflowKey,
      workflowId: workflowResult.workflowId,
      workflowAdapter: workflowResult.adapter,
      reusedExistingArtifact: workflowResult.reusedExistingArtifact,
      handoffSummary,
      preferredDelivery: deliveryPreference.preferredDelivery,
      preferredDeliveryReason: deliveryPreference.reason,
    });

    if (deliveryPreference.preferredDelivery !== "slack_dm") {
      const reply = approvalBlockedArtifactText({ artifactPaths: workflowResult.artifactPaths });
      await transitionSlackDmJob(job.id, "blocked_needs_approval", {
        completedAt: new Date().toISOString(),
        replyText: reply,
        safeErrorSummary: `Verified asset is ready, but preferred delivery is ${deliveryPreference.preferredDelivery}.`,
        deliveryId: artifactRecord?.deliveryId || null,
      });
      await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "asset-delivery-preference-blocked" });
      log("??", `Asset job ready but delivery preference blocked id=${assetJobId} preference=${deliveryPreference.preferredDelivery}`);
      return;
    }

    if (!canQueueRhysDmDelivery(channel, userId)) {
      // Old behaviour parity: the inline send used to throw for non-Rhys
      // requesters and land here-equivalent. Visible state, never a strand.
      const reply = approvalBlockedArtifactText({ artifactPaths: workflowResult.artifactPaths });
      await transitionSlackDmJob(job.id, "blocked_needs_approval", {
        completedAt: new Date().toISOString(),
        replyText: reply,
        safeErrorSummary: "Artifact delivery is restricted to Rhys's DM; operator review required.",
        deliveryId: artifactRecord?.deliveryId || null,
      });
      await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "asset-delivery-not-rhys-dm" });
      log("??", `Asset delivery blocked (not Rhys DM) id=${assetJobId}`);
      return;
    }

    // SINGLE-OWNER DELIVERY (2026-06-11 race fix): the listener's part ends
    // at delivery_requested. The workspace worker is the ONLY process that
    // uploads artifacts to Rhys — it claims this job and drives the upload
    // through the gated send. The inline sendRhysDmArtifact that used to
    // follow this transition raced the worker (delivery_requested is a
    // worker-deliverable status) into double-DMing the same asset.
    try {
      await transitionSlackDmJob(job.id, "delivery_requested", {
        deliveryRequestedAt: new Date().toISOString(),
        deliveryId: artifactRecord?.deliveryId || null,
        deliveryMessage: workflowResult.message,
      });
    } catch (transitionErr) {
      // artifact_ready is already worker-deliverable: the worker may have
      // claimed and DELIVERED between the artifact_ready transition above
      // and here, making this transition illegal (delivered is terminal).
      // The worker winning the window is success — never an error.
      const current = listSlackDmJobs().find((j) => j.id === job.id);
      if (current?.status === "delivered") {
        log("?", `Asset job already delivered by the workspace worker id=${assetJobId} — no queueing needed`);
        return;
      }
      throw transitionErr;
    }
    try {
      await sendSlackMessage(channel, deliveryQueuedText(), threadTs, { kind: "summary", callerSite: "asset-delivery-queued" });
    } catch (ackErr) {
      // The queued job is durable — the worker delivers it whether or not
      // this ack reached Slack. Never fail the job over ack copy.
      log("??", `Delivery-queued ack send failed id=${assetJobId}: ${ackErr.message}`);
    }
    log("?", `Asset job queued for worker delivery id=${assetJobId} workflow=${workflowResult.workflowKey}`);
    return;
  }

  const sessionId = job.sessionId || `slack-${userId}`;
  const activeGateway = currentActiveGateway(sessionId);
  if (activeGateway) {
    const reply = liveTimeoutHandoffText();
    await updateSlackDmJob(job.id, {
      status: "needs_workspace_job",
      relatedJobId: activeGateway.jobId,
      replyText: reply,
      safeErrorSummary: "Another Slack DM agent run is already active for this session.",
      preferredDelivery: deliveryPreference.preferredDelivery,
      preferredDeliveryReason: deliveryPreference.reason,
    });
    await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "gateway-session-active" });
    log("⚠️", `Skipped gateway call because session=${sessionId} is already active job=${activeGateway.jobId}`);
    return;
  }

  if (gatewayCooldownRemainingMs(sessionId) > 0) {
    const reply = liveTimeoutHandoffText();
    await updateSlackDmJob(job.id, {
      status: "needs_workspace_job",
      replyText: reply,
      safeErrorSummary: "Recent live Slack agent timeout; workspace handoff required before retry.",
      preferredDelivery: deliveryPreference.preferredDelivery,
      preferredDeliveryReason: deliveryPreference.reason,
    });
    await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "gateway-timeout-cooldown" });
    log("⚠️", `Skipped gateway call during cooldown for session=${sessionId}`);
    return;
  }

  try {
    activeGatewaySessions.set(sessionId, { jobId: job.id, startedAt: Date.now() });
    const startMs = Date.now();
    const gatewayResult = await forwardToGateway(text, userId);
    const durationMs = Date.now() - startMs;
    const gatewayReply = gatewayResult.reply || null;
    activeGatewaySessions.delete(sessionId);

    if (!gatewayReply) {
      log("⚠️", `EMPTY_RESPONSE from=${userId} channel=${channel} duration=${durationMs}ms msg="${snippet}"`);
    } else {
      log("📤", `Gateway replied in ${durationMs}ms for ${userId}`);
    }

    if (!isUsefulGatewayReply(gatewayReply)) {
      const isTimeout = gatewayResult.timedOut;
      if (isTimeout) setGatewayCooldown(sessionId);
      const fallback = isTimeout
        ? liveTimeoutHandoffText()
        : (recentJob
          ? summarizeSlackDmJob(recentJob)
          : draftFailedHandoffText());
      const safeErrorSummary = gatewayFailureSummary({
        timedOut: isTimeout,
        errorMessage: gatewayResult.error?.message || "",
        stderr: gatewayResult.stderr || "",
        stdout: gatewayResult.stdout || "",
        reply: gatewayReply || "",
      });
      const failureDetails = gatewayResult.failureDetails || gatewayFailureDetails({
        timedOut: isTimeout,
        errorMessage: gatewayResult.error?.message || "",
        stderr: gatewayResult.stderr || "",
        stdout: gatewayResult.stdout || "",
        reply: gatewayReply || "",
        provider: gatewayResult.brain?.provider,
        model: gatewayResult.brain?.model,
      });
      await updateSlackDmJob(job.id, {
        status: isTimeout ? "needs_workspace_job" : "failed",
        failedAt: new Date().toISOString(),
        safeErrorSummary: formatGatewayFailureDetails({ ...failureDetails, summary: safeErrorSummary }),
        failureType: failureDetails.failureType,
        brainProvider: failureDetails.provider,
        brainModel: failureDetails.model,
        error: gatewayResult.error?.message || safeErrorSummary,
        stdout: gatewayResult.stdout || null,
        stderr: gatewayResult.stderr || null,
        replyText: fallback,
        gatewayTimedOut: isTimeout,
        preferredDelivery: deliveryPreference.preferredDelivery,
        preferredDeliveryReason: deliveryPreference.reason,
      });
      await sendSlackMessage(channel, fallback, threadTs, { kind: "summary", callerSite: "gateway-timeout-status" });
      log("✅", `Useful gateway failure status sent in ${channel} for ${userId} ${formatGatewayFailureDetails(failureDetails)}`);
      return;
    }

    const rawReplyText = gatewayReply || "I processed your message but got an empty response.";
    if (isMisdirectedDeliveryReply({
      reply: rawReplyText,
      preferredDelivery: deliveryPreference.preferredDelivery,
    })) {
      const reply = misroutedDeliveryReplyText();
      await updateSlackDmJob(job.id, {
        status: "needs_workspace_job",
        completedAt: null,
        replyText: reply,
        safeErrorSummary: "Gateway selected email or Mission Control instead of the Slack DM delivery path.",
        gatewayTimedOut: !gatewayResult.ok && gatewayResult.timedOut,
        gatewayError: gatewayResult.error?.message || null,
        brainProvider: gatewayResult.brain?.provider || null,
        brainModel: gatewayResult.brain?.model || null,
        preferredDelivery: deliveryPreference.preferredDelivery,
        preferredDeliveryReason: deliveryPreference.reason,
      });
      await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "misrouted-delivery-reply" });
      log("⚠️", `Blocked misdirected delivery reply for ${userId} in ${channel}`);
      return;
    }

    const prepared = prepareSlackReply(rawReplyText, {
      preferredDelivery: deliveryPreference.preferredDelivery,
    });
    const artifactRecord = await recordReplyArtifacts({
      mediaPaths: prepared.mediaPaths,
      userId,
      channel,
      messageTs: msgTs,
      text: prepared.text,
      explicitDeliveryApproval: prepared.deliveryAction === "send_rhys_dm_artifact",
    });

    if (prepared.deliveryAction === "send_rhys_dm_artifact") {
      // MEDIA: lines in gateway free text are unvalidated — queueing a path
      // that does not exist strands delivery_requested forever (the worker
      // requires the file on disk). Honest handoff instead of a false
      // "queued" promise.
      const gatewayArtifactPath = selectPreferredArtifactPath(prepared.mediaPaths);
      if (!gatewayArtifactPath || !existsSync(gatewayArtifactPath)) {
        const reply = liveTimeoutHandoffText();
        await updateSlackDmJob(job.id, {
          status: "needs_workspace_job",
          replyText: reply,
          artifactPaths: prepared.mediaPaths,
          safeErrorSummary: "Gateway reply referenced a file that does not exist on disk; nothing was queued for delivery.",
          preferredDelivery: "slack_dm",
          gatewayTimedOut: !gatewayResult.ok && gatewayResult.timedOut,
          gatewayError: gatewayResult.error?.message || null,
        });
        await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "gateway-artifact-missing" });
        log("⚠️", `Gateway artifact path missing on disk job=${job.id} — not queued`);
        return;
      }
      if (!canQueueRhysDmDelivery(channel, userId)) {
        const reply = approvalBlockedArtifactText({ artifactPaths: prepared.mediaPaths });
        await updateSlackDmJob(job.id, {
          status: "blocked_needs_approval",
          completedAt: new Date().toISOString(),
          replyText: reply,
          artifactPaths: prepared.mediaPaths,
          deliveryId: artifactRecord?.deliveryId || null,
          reviewQueueId: artifactRecord?.reviewQueueId || null,
          safeErrorSummary: "Artifact delivery is restricted to Rhys's DM; operator review required.",
        });
        await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "gateway-artifact-not-rhys-dm" });
        log("⚠️", `Gateway artifact delivery blocked (not Rhys DM) job=${job.id}`);
        return;
      }
      // SINGLE-OWNER DELIVERY (2026-06-11 race fix): the gateway lane stores
      // the artifact on the job and queues delivery; the workspace worker —
      // the ONLY process that uploads to Rhys — claims it and performs the
      // gated send (roots/extension validation included) within its poll
      // interval. updateSlackDmJob is deliberate: this job's current status
      // predates the delivery_requested transition in the formal map.
      const reply = deliveryQueuedText();
      try {
        await updateSlackDmJob(job.id, {
          status: "delivery_requested",
          completedAt: null,
          replyText: reply,
          artifactPaths: prepared.mediaPaths,
          deliveryId: artifactRecord?.deliveryId || null,
          reviewQueueId: artifactRecord?.reviewQueueId || null,
          artifactReadyAt: new Date().toISOString(),
          deliveryRequestedAt: new Date().toISOString(),
          deliveryMessage: prepared.text || "Done. I attached the file here.",
          preferredDelivery: "slack_dm",
          preferredDeliveryReason: "Gateway reply produced a Rhys DM artifact; queued for worker delivery.",
          gatewayTimedOut: !gatewayResult.ok && gatewayResult.timedOut,
          gatewayError: gatewayResult.error?.message || null,
          brainProvider: gatewayResult.brain?.provider || null,
          brainModel: gatewayResult.brain?.model || null,
        });
        await sendSlackMessage(channel, reply, threadTs, { kind: "summary", callerSite: "gateway-artifact-queued" });
        log("✅", `Gateway artifact queued for worker delivery job=${job.id}`);
        return;
      } catch (queueErr) {
        await updateSlackDmJob(job.id, {
          status: "needs_workspace_job",
          replyText: liveTimeoutHandoffText(),
          safeErrorSummary: `Gateway artifact could not be queued for delivery: ${String(queueErr.message).slice(0, 200)}`,
          preferredDelivery: "slack_dm",
        });
        await sendSlackMessage(channel, liveTimeoutHandoffText(), threadTs, { kind: "summary", callerSite: "gateway-artifact-queue-failed" });
        log("⚠️", `Gateway artifact delivery queueing failed job=${job.id}: ${queueErr.message}`);
        return;
      }
    }

    await updateSlackDmJob(job.id, {
      status: prepared.mediaPaths.length ? "artifact_ready" : "answered",
      completedAt: new Date().toISOString(),
      replyText: prepared.text,
      artifactPaths: prepared.mediaPaths,
      deliveryId: artifactRecord?.deliveryId || null,
      reviewQueueId: artifactRecord?.reviewQueueId || null,
      artifactReadyAt: prepared.mediaPaths.length ? new Date().toISOString() : null,
      gatewayTimedOut: !gatewayResult.ok && gatewayResult.timedOut,
      gatewayError: gatewayResult.error?.message || null,
      brainProvider: gatewayResult.brain?.provider || null,
      brainModel: gatewayResult.brain?.model || null,
      preferredDelivery: deliveryPreference.preferredDelivery,
      preferredDeliveryReason: deliveryPreference.reason,
    });

    try {
      await sendSlackMessage(channel, prepared.text, threadTs, {
        kind: prepared.kind,
        callerSite: prepared.mediaPaths.length ? "gateway-media-reply" : "gateway-reply",
      });
      log("✅", `Replied in ${channel} to ${userId}`);
    } catch (sendErr) {
      log("❌", `SEND_FAILED channel=${channel} from=${userId} error="${sendErr.message}" msg="${snippet}"`);
      await updateSlackDmJob(job.id, {
        status: "failed",
        failedAt: new Date().toISOString(),
        safeErrorSummary: "Slack send failed after a reply was prepared.",
        error: `send failed: ${sendErr.message}`,
      });
      // Notify Rhys that we couldn't send the reply
      await notifyRhysFallback(userId, channel, snippet, `Reply drafted but send failed: ${sendErr.message}`);
    }
  } catch (err) {
    activeGatewaySessions.delete(sessionId);
    const isTimeout = err.killed || err.message?.includes("TIMEOUT") || err.message?.includes("timed out") || err.signal === "SIGTERM";
    const errorType = isTimeout ? "TIMEOUT" : "ERROR";
    if (isTimeout) setGatewayCooldown(sessionId);
    const brain = readBrainProvenance();
    const failureDetails = gatewayFailureDetails({
      timedOut: isTimeout,
      errorMessage: err.message,
      provider: brain.provider,
      model: brain.model,
    });

    log("❌", `GATEWAY_${errorType} from=${userId} channel=${channel} ${formatGatewayFailureDetails(failureDetails)} msg="${snippet}"`);
    await updateSlackDmJob(job.id, {
      status: isTimeout ? "needs_workspace_job" : "failed",
      failedAt: new Date().toISOString(),
      safeErrorSummary: formatGatewayFailureDetails(failureDetails),
      failureType: failureDetails.failureType,
      brainProvider: failureDetails.provider,
      brainModel: failureDetails.model,
      error: err.message,
      gatewayTimedOut: isTimeout,
    });

    // Send an operator-useful fallback to the original channel. Avoid the old
    // generic "hiccup" loop; status follow-ups should surface the tracked job.
    try {
      const fallback = isTimeout
        ? liveTimeoutHandoffText()
        : (recentJob
          ? summarizeSlackDmJob(recentJob)
          : draftFailedHandoffText());
      await sendSlackMessage(channel, fallback, threadTs, { kind: "summary", callerSite: "gateway-exception-status" });
    } catch (sendErr) {
      log("❌", `FALLBACK_SEND_FAILED channel=${channel} error="${sendErr.message}"`);
    }

    // DM Rhys only if this was not already his DM; otherwise the channel
    // fallback above is enough and avoids duplicate useless messages.
    if (channel !== RHYS_DM_CHANNEL) {
      await notifyRhysFallback(userId, channel, snippet, `Gateway ${errorType.toLowerCase()}: ${err.message}`);
    }
  } finally {
    // Remove ⚡ reaction — non-fatal but log failures for debugging
    try {
      const r = await slackApi("reactions.remove", { channel, timestamp: msgTs, name: "zap" });
      if (!r.ok) log("⚠️", `Reaction remove failed: ${r.error}`);
    } catch (e) {
      log("⚠️", `Reaction remove error: ${e.message}`);
    }
  }
}

// ── Socket Mode ──
async function getSocketUrl() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "slack.com",
      path: "/api/apps.connections.open",
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": 0,
      },
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        try {
          const result = JSON.parse(chunks);
          if (result.ok) resolve(result.url);
          else reject(new Error(result.error));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write("");
    req.end();
  });
}

async function connect() {
  try {
    log("🔌", "Requesting Socket Mode URL...");
    const url = await getSocketUrl();
    log("🔗", "Connecting to Slack WebSocket...");

    const ws = new WebSocket(url);
    activeWs = ws;
    let pingInterval = null;
    let missedPongs = 0;

    function startHeartbeat() {
      missedPongs = 0;
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        missedPongs++;
        if (missedPongs > MAX_MISSED_PONGS) {
          log("💔", `${missedPongs} consecutive pings unanswered. Forcing reconnect.`);
          clearInterval(pingInterval);
          pingInterval = null;
          ws.terminate();
          return;
        }
        ws.ping();
      }, PING_INTERVAL_MS);
    }

    function stopHeartbeat() {
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    }

    ws.on("open", () => {
      reconnectAttempts = 0;
      log("🚀", "ATLAS Slack Listener — CONNECTED");
      log("📋", `Authorised users: ${AUTHORISED_USERS.length > 0 ? AUTHORISED_USERS.join(", ") : "ALL"}`);
      log("🛡️", `DM-only mode: ${DM_ONLY_MODE ? "on" : "off"}`);
      startHeartbeat();
    });

    ws.on("pong", () => {
      missedPongs = 0;
    });

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.envelope_id) ws.send(JSON.stringify({ envelope_id: data.envelope_id }));

        if (data.type === "events_api") {
          const event = data.payload?.event;
          if (!event) return;
          if (event.type === "message" && event.channel_type === "im") await handleMessage(event);
          if (!DM_ONLY_MODE && event.type === "app_mention") await handleMessage(event);
        }
        if (data.type === "disconnect") {
          log("⚠️", `Disconnect requested: ${data.reason}`);
          ws.close();
        }
      } catch (err) {
        log("❌", `Parse error: ${err.message}`);
      }
    });

    ws.on("close", (code) => {
      stopHeartbeat();
      log("🔌", `WebSocket closed (${code})`);
      scheduleReconnect();
    });

    ws.on("error", (err) => log("❌", `WS error: ${err.message}`));
  } catch (err) {
    log("❌", `Connect failed: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT) {
    log("💀", "Max reconnects reached. Exiting.");
    process.exit(1);
  }
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  log("🔄", `Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`);
  setTimeout(connect, delay);
}

// ── Health ──
let healthServer = null;

function startHealthServer() {
  healthServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "atlas-slack-listener", uptime: process.uptime() }));
    } else { res.writeHead(404); res.end(); }
  });

  healthServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log("⚠️", `Health port 4009 in use — listener running without health endpoint`);
      healthServer = null;
    } else {
      log("❌", `Health server error: ${err.message}`);
    }
  });

  healthServer.listen(4009, "127.0.0.1", () => log("💊", "Health check on port 4009"));
}

startHealthServer();

// ── Graceful Shutdown ──
function shutdown(signal) {
  log("🛑", `${signal} received. Shutting down gracefully...`);
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.close(1000, "shutdown");
    activeWs = null;
  }
  if (healthServer) {
    healthServer.close();
    healthServer = null;
  }
  log("👋", "Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ──
async function main() {
  // Startup self-check: verify required env vars
  const required = {
    SLACK_APP_TOKEN: APP_TOKEN,
    SLACK_BOT_TOKEN: BOT_TOKEN,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) {
      log("💀", `FATAL: ${name} not set. Cannot start listener.`);
      process.exit(1);
    }
  }
  if (!process.env.SLACK_USER_TOKEN) {
    log("⚠️", "SLACK_USER_TOKEN not set — some features may be limited");
  }
  logSocketOwnerStatus();

  const result = await slackApi("auth.test", {});
  if (result.ok) { botUserId = result.user_id; log("🤖", `Bot user ID: ${botUserId}`); }
  else { log("⚠️", `auth.test failed: ${result.error} — continuing anyway`); }

  await connect();
}

main().catch((err) => { log("💀", `Fatal: ${err.message}`); process.exit(1); });
