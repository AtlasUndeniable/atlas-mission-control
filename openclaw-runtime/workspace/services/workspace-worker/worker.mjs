#!/usr/bin/env node
/**
 * ATLAS Workspace Worker — deterministic artifact delivery.
 *
 * THE guarantee this process owns: a file that has been built must ALWAYS
 * reach Rhys, even when the Slack request that triggered it is dead. The
 * listener acks and builds; THIS worker owns completion. It polls the durable
 * Slack DM job ledger for jobs that have a validated artifact on disk and no
 * delivery receipt (the post-SIGTERM orphan state), and drives each one to
 * `delivered` through the EXISTING gated send path:
 *
 *   sendRhysDmArtifact — bot identity, Rhys DM only, never as-Rhys,
 *   approved roots + extension allowlist, receipt recorded in the
 *   artifact-deliveries ledger inside the send call.
 *
 * Exactly-once model (approval-claim pattern, commit c462651, hardened after
 * adversarial review):
 *   1. CLAIM under the queue lock BEFORE any send (timestamp taken INSIDE the
 *      lock). A concurrent worker sees a fresh foreign claim and conflicts.
 *   2. RECONCILE before send: the artifact ledger (written inside the send)
 *      is the send-side source of truth; a delivered receipt for this job's
 *      deterministic deliveryId finalizes WITHOUT resending. Dry-run mock
 *      receipts are explicitly ignored.
 *   3. ATTEMPT JOURNAL: an attempt line is journaled before the first Slack
 *      call. attempt-without-receipt on a later pass means "a send may have
 *      landed without its receipt" (SIGKILL between Slack accept and the
 *      ledger append) — the worker then VERIFIES via conversations.history
 *      before it will ever resend.
 *   4. GUARDED SEND: every Slack call carries an abort timeout (bounded send
 *      ≪ claim TTL); the claim is heartbeat-renewed before each call and the
 *      pass ABORTS if ownership was lost; immediately before the only
 *      user-visible call (files.completeUploadExternal) ownership AND the
 *      ledger are re-checked.
 *   5. POST-COMPLETE capture: if Slack accepted the upload but the send threw
 *      afterwards (e.g. receipt append failed), the wrapper has the receipt —
 *      the job is finalized delivered, NEVER retried as a failed send.
 *   6. FINALIZE under the lock only while our claim still owns the job; a
 *      superseded finalize after a real send is counted and logged loudly.
 *
 * SINGLE-OWNER DELIVERY (2026-06-11 race fix): this worker is the ONLY
 * process that uploads artifacts to Rhys. The listener never calls the gated
 * send any more — it stops at `delivery_requested` (with the caption stashed
 * in job.deliveryMessage) and this worker drives the upload. Hardened after
 * the Codex review:
 *   - POST-CLAIM DATA ONLY: every send input (artifact path, filename, title,
 *     caption, attempt counters, deliveryId) derives from claimResult.job —
 *     the record as it existed INSIDE the claim lock — never from the
 *     pre-claim candidate snapshot, which the listener may have mutated in
 *     the scan→claim window.
 *   - SAME-ASSET GUARD: a delivered receipt for the same filename newer than
 *     this job's creation finalizes the job WITHOUT a second upload (two
 *     ledger jobs pointing at one file can never DM Rhys twice).
 *   - VERIFY-FAILURE PARKING: repeated conversations.history verification
 *     failures are counted (workerVerifyFailures) and the job PARKS visibly
 *     in blocked_needs_approval after maxAttempts — never an infinite
 *     silent retry loop.
 *   - SCOPE PREFLIGHT: the daemon entrypoint refuses to run at all unless
 *     the bot token carries REQUIRED_WORKER_SCOPES (history verification is
 *     the resend safety net; sending without it is not safe).
 *
 * Scope: delivery ONLY. The exports scan (findUndeliveredArtifacts) is an
 * AUDIT METRIC — the jobs ledger is the only delivery source. This worker
 * never builds, never generates, never touches client channels, never sends
 * as Rhys, and never delivers through the blocked_needs_approval human gate.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  hasSlackDeliveryReceipt,
  recordSlackDmJobDelivered,
  SLACK_DM_JOBS_PATH,
} from "../../lib/slack-dm-jobs.mjs";
import {
  findUndeliveredArtifacts,
  readDeliveryLedger,
  recordDeliveryState,
  EXPORTS_DIR,
  LEDGER_PATH,
} from "../../lib/artifact-delivery.mjs";
import {
  ALLOWED_ARTIFACT_ROOTS,
  RHYS_DM_CHANNEL_ID,
  RHYS_USER_ID,
  selectPreferredArtifactPath,
  sendRhysDmArtifact,
} from "../../lib/slack-rhys-dm-artifact.mjs";
import { mutateQueue, peekQueue } from "../../lib/queue-writer.mjs";

// Statuses a dead request can strand a deliverable job in. Deliberately
// EXCLUDES blocked_needs_approval (human gate — auto-delivering would bypass
// approval) and all terminal states.
export const WORKER_DELIVERABLE_STATUSES = new Set([
  "queued",
  "building",
  "artifact_ready",
  "delivery_requested",
  "needs_workspace",
  "needs_workspace_job",
]);

export const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const MAX_WORKER_ATTEMPTS = 3;

// Scopes the delivery pipeline depends on. im:history is the resend safety
// net (verifyPriorDeliveryViaHistory); im:write opens the Rhys DM;
// files:write performs the upload. Without all three the worker must not run.
export const REQUIRED_WORKER_SCOPES = ["im:history", "im:write", "files:write"];

/**
 * Read the bot token's granted scopes from the x-oauth-scopes header Slack
 * returns on every Web API response (auth.test is the cheapest probe).
 */
export async function getWorkerTokenScopes({ token, fetchImpl = fetch, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  if (!token) throw new Error("Slack bot token is unavailable");
  const resp = await fetchImpl("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(callTimeoutMs),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`auth.test failed: ${data.error || "unknown_error"}`);
  const header = resp.headers?.get?.("x-oauth-scopes") || "";
  return header.split(",").map((scope) => scope.trim()).filter(Boolean);
}

/**
 * Startup preflight. Refuses (ok:false) when any required scope is missing
 * OR when the scopes cannot be PROVEN (auth.test unreachable) — the
 * history-verify safety net depends on im:history, and sending without
 * proving it risks a resend Rhys would see twice.
 */
export async function preflightWorkerScopes({ token, getScopes, required = REQUIRED_WORKER_SCOPES, fetchImpl, callTimeoutMs } = {}) {
  try {
    const scopes = await (getScopes ? getScopes() : getWorkerTokenScopes({ token, fetchImpl, callTimeoutMs }));
    const have = new Set(Array.isArray(scopes) ? scopes : []);
    const missing = required.filter((scope) => !have.has(scope));
    return missing.length ? { ok: false, scopes, missing } : { ok: true, scopes, missing: [] };
  } catch (err) {
    return { ok: false, scopes: null, missing: required.slice(), error: String(err?.message || err) };
  }
}

class ClaimLostError extends Error {
  constructor(jobId) { super(`delivery claim lost for ${jobId}`); this.code = "CLAIM_LOST"; }
}
class AlreadyDeliveredError extends Error {
  constructor(receipt) { super("receipt appeared mid-send"); this.code = "ALREADY_DELIVERED"; this.receipt = receipt; }
}

export function workerDeliveryIdForJob(job) {
  if (job.deliveryId) return job.deliveryId;
  return `art_wkr_${createHash("sha256").update(String(job.id)).digest("hex").slice(0, 16)}`;
}

// queue-writer degrades a corrupt/unreadable file to [] and would then
// atomically WRITE [] back. Throwing inside the mutator aborts the write,
// so a transient read failure can never wipe the jobs ledger.
function guardQueue(queue) {
  if (!Array.isArray(queue) || queue.length === 0) {
    throw new Error("jobs ledger read empty/corrupt - refusing to write");
  }
  return queue;
}

function claimIsFresh(claim, nowMs, claimTtlMs) {
  if (!claim?.id || !claim?.at) return false;
  const at = Date.parse(claim.at);
  return Number.isFinite(at) && nowMs - at < claimTtlMs;
}

/**
 * Pure candidate filter. A job is worker-deliverable when a dead request left
 * it non-terminal with a real artifact and no receipt, and delivery to the
 * Rhys DM was the recorded preference (the same explicit-approval rule the
 * listener applies at artifact creation).
 */
export function findWorkerCandidates(jobs, { fileExists = existsSync } = {}) {
  return jobs.filter((job) => {
    if (job.channel !== RHYS_DM_CHANNEL_ID || job.userId !== RHYS_USER_ID) return false;
    if (!WORKER_DELIVERABLE_STATUSES.has(job.status)) return false;
    if (job.preferredDelivery !== "slack_dm") return false;
    if (hasSlackDeliveryReceipt(job.deliveryResult)) return false;
    const artifactPath = selectPreferredArtifactPath(job.artifactPaths);
    if (!artifactPath) return false;
    return fileExists(artifactPath);
  });
}

/**
 * Atomic claim transform — approval-claim pattern. MUST run inside the queue
 * lock (mutateQueue mutator). Claims only candidate-shaped jobs; a fresh
 * foreign claim conflicts; a stale claim is reclaimed. The claim timestamp is
 * taken inside the mutator so lock wait time never shortens the effective TTL.
 */
export function claimJobForDelivery(jobs, jobId, claimId, nowIso, claimTtlMs = DEFAULT_CLAIM_TTL_MS) {
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return { jobs, result: { kind: "not_found" } };
  const current = jobs[idx];

  if (!WORKER_DELIVERABLE_STATUSES.has(current.status)) {
    return { jobs, result: { kind: "conflict", status: current.status } };
  }
  if (hasSlackDeliveryReceipt(current.deliveryResult)) {
    return { jobs, result: { kind: "already_delivered" } };
  }
  if (claimIsFresh(current.deliveryClaim, Date.parse(nowIso), claimTtlMs) && current.deliveryClaim.id !== claimId) {
    return { jobs, result: { kind: "claimed_elsewhere", claim: current.deliveryClaim } };
  }

  const claimed = {
    ...current,
    deliveryClaim: { id: claimId, at: nowIso },
    updatedAt: nowIso,
  };
  const next = jobs.slice();
  next[idx] = claimed;
  return { jobs: next, result: { kind: "claimed", job: claimed } };
}

/** Release our claim (only if we still own it), optionally patching fields. */
export function releaseJobClaim(jobs, jobId, claimId, patch = {}, nowIso) {
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return { jobs, released: false };
  const current = jobs[idx];
  if (current.deliveryClaim?.id !== claimId) return { jobs, released: false };
  const next = jobs.slice();
  next[idx] = { ...current, ...patch, deliveryClaim: null, updatedAt: nowIso };
  return { jobs: next, released: true };
}

/**
 * Find a REAL delivered receipt for this deliveryId in the artifact ledger.
 * Dry-run/mock events are explicitly excluded — a mock receipt must never
 * finalize a job as delivered.
 */
export function findLedgerReceipt(ledgerEvents, deliveryId) {
  for (let i = ledgerEvents.length - 1; i >= 0; i -= 1) {
    const event = ledgerEvents[i];
    if (
      event.eventType === "delivery_state"
      && event.deliveryId === deliveryId
      && event.status === "delivered"
      && event.metadata?.dryRun !== true
      && event.fileId !== "mock-file-id"
      && hasSlackDeliveryReceipt({ channelId: event.channelId, fileId: event.fileId, messageTs: event.messageTs })
    ) {
      return { channelId: event.channelId, fileId: event.fileId, messageTs: event.messageTs };
    }
  }
  return null;
}

/**
 * SAME-ASSET GUARD: a REAL delivered receipt for this exact filename stamped
 * at-or-after `sinceIso` (the claimed job's creation). Two ledger jobs can end
 * up pointing at the same file (retrieval resolving an orphan's artifact, a
 * re-ask while the original is still pending) — when the file already reached
 * Rhys after this job was asked for, the job finalizes on that receipt instead
 * of uploading a second copy. A receipt OLDER than the job never matches, so a
 * genuine later re-ask ("send it again") still delivers.
 */
export function findRecentFilenameReceipt(ledgerEvents, filename, sinceIso) {
  if (!filename) return null;
  const since = Date.parse(sinceIso || "") || 0;
  for (let i = ledgerEvents.length - 1; i >= 0; i -= 1) {
    const event = ledgerEvents[i];
    if (
      event.eventType === "delivery_state"
      && event.status === "delivered"
      && event.metadata?.dryRun !== true
      && event.fileId !== "mock-file-id"
      && event.metadata?.filename === filename
      && (Date.parse(event.eventAt || "") || 0) >= since
      && hasSlackDeliveryReceipt({ channelId: event.channelId, fileId: event.fileId, messageTs: event.messageTs })
    ) {
      return { channelId: event.channelId, fileId: event.fileId, messageTs: event.messageTs, filename };
    }
  }
  return null;
}

// ── Attempt journal: "a send may have started" marker, written before the
// first Slack call. attempt-without-receipt ⇒ verify history before resend.
export function attemptJournalPath(ledgerPath) {
  return `${ledgerPath}.attempts.jsonl`;
}

function readAttempts(journalPath) {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8")
    .split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function journalAttempt(journalPath, record) {
  appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");
}

// Default Slack Web API client (the lib's default is not exported); every
// call is bounded so a hung send can never outlive the claim TTL.
function makeDefaultSlackClient(callTimeoutMs) {
  return async (method, body, { token, form = false } = {}) => {
    if (!token) throw new Error("Slack bot token is unavailable");
    const resp = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json; charset=utf-8" }),
      },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(callTimeoutMs),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`${method} failed: ${data.error || "unknown_error"}`);
    return data;
  };
}

/**
 * Look for a prior bot upload of this artifact in the Rhys DM — the recovery
 * read when an attempt was journaled but no receipt exists (a send may have
 * landed right before a crash). Returns a receipt or null.
 */
export async function verifyPriorDeliveryViaHistory({ slackClient, token, filename, sinceIso }) {
  const history = await slackClient("conversations.history", { channel: RHYS_DM_CHANNEL_ID, limit: 50 }, { token });
  const sinceTs = sinceIso ? Date.parse(sinceIso) / 1000 - 60 : 0;
  const match = (history.messages || []).find((msg) => Number(msg.ts || 0) >= sinceTs
    && (msg.files || []).some((file) => (file.name === filename || file.title === filename)));
  if (!match) return null;
  const file = match.files.find((f) => f.name === filename || f.title === filename);
  return { channelId: RHYS_DM_CHANNEL_ID, fileId: file.id, messageTs: match.ts };
}

function tr6Message(job) {
  // TR-6: no ids, no states, no paths. Honest about why it arrives late.
  return job.status === "artifact_ready" || job.status === "delivery_requested" || job.status === "building"
    ? "Done. This is the file from your earlier request — it finished after my last reply."
    : "Done. I attached the file here.";
}

// The listener stashes the workflow's intended caption in job.deliveryMessage
// when it queues delivery; fall back to honest late-delivery copy. The gated
// send sanitizes paths out of whatever is here before Rhys sees it.
function deliveryCaption(job) {
  const message = typeof job.deliveryMessage === "string" ? job.deliveryMessage.trim() : "";
  return message || tr6Message(job);
}

// PARK NOTIFICATION: the listener's last message promised delivery; a silent
// park leaves that promise standing forever. Best-effort text (TR-6: no ids,
// no states, no paths) — never blocks the park itself, never required scopes.
const PARK_NOTICE_TEXT = "I hit a snag delivering that file, so it has not been sent. It's flagged for operator review — I won't pretend it went through.";
async function notifyRhysOfPark({ slackClient, token, log }) {
  try {
    await slackClient("chat.postMessage", { channel: RHYS_DM_CHANNEL_ID, text: PARK_NOTICE_TEXT }, { token });
  } catch (notifyErr) {
    log(`park notification failed (delivery state is still parked + visible in the ledger): ${notifyErr.message}`);
  }
}

/**
 * One worker pass. Everything injectable so the proof harness runs entirely
 * against fixtures; production CLI passes nothing and gets live defaults.
 */
export async function runWorkerPass({
  jobsPath = SLACK_DM_JOBS_PATH,
  ledgerPath = LEDGER_PATH,
  exportsDir = EXPORTS_DIR,
  allowedRoots = ALLOWED_ARTIFACT_ROOTS,
  token = process.env.SLACK_BOT_TOKEN,
  slackClient,
  uploadFetch,
  now = () => new Date(),
  claimTtlMs = DEFAULT_CLAIM_TTL_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  maxAttempts = MAX_WORKER_ATTEMPTS,
  fileExists = existsSync,
  log = () => {},
  workerId = `wkr-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  preflight = null,
} = {}) {
  const summary = {
    scanned: 0,
    candidates: 0,
    delivered: 0,
    reconciled: 0,
    recoveredFromHistory: 0,
    conflicts: 0,
    aborted: 0,
    failures: 0,
    parked: 0,
    staleCandidates: 0,
    sentButSuperseded: 0,
    untrackedExportGroups: null,
    preflight: null,
  };

  // SCOPE PREFLIGHT (opt-in here; ALWAYS on at the daemon entrypoint): a
  // refused preflight processes nothing — no claims, no sends, no writes.
  if (preflight) {
    const result = await preflightWorkerScopes({
      token,
      getScopes: preflight.getScopes,
      fetchImpl: preflight.fetchImpl,
      callTimeoutMs,
    });
    summary.preflight = result;
    if (!result.ok) {
      log(`PREFLIGHT REFUSED: missing Slack scopes [${(result.missing || []).join(", ")}]${result.error ? ` (${result.error})` : ""} — refusing to run the delivery pass`);
      return summary;
    }
  }

  const journalPath = attemptJournalPath(ledgerPath);
  const baseSlack = slackClient || makeDefaultSlackClient(callTimeoutMs);
  const baseUpload = uploadFetch || ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(callTimeoutMs) }));

  // Read-only audit metric (diagnosis §6): exports groups with no terminal
  // delivery. AUDIT ONLY — the jobs ledger is the only delivery source.
  try {
    const audit = findUndeliveredArtifacts({ maxAgeMinutes: 24 * 60, exportsDir }, { ledgerPath });
    summary.untrackedExportGroups = audit.untracked.length;
  } catch {
    summary.untrackedExportGroups = null;
  }

  const jobs = peekQueue({ queuePath: jobsPath });
  summary.scanned = jobs.length;
  const candidates = findWorkerCandidates(jobs, { fileExists });
  summary.candidates = candidates.length;

  for (const candidate of candidates) {
    const claimId = `${workerId}-${candidate.id}`;

    // 1. CLAIM under the lock before anything else.
    let claimResult = null;
    await mutateQueue((queue) => {
      guardQueue(queue);
      const { jobs: nextJobs, result } = claimJobForDelivery(queue, candidate.id, claimId, now().toISOString(), claimTtlMs);
      claimResult = result;
      return result.kind === "claimed" ? nextJobs : null;
    }, { queuePath: jobsPath });

    if (claimResult.kind !== "claimed") {
      summary.conflicts += 1;
      log(`claim ${claimResult.kind} job=${candidate.id}`);
      continue;
    }

    // POST-CLAIM DATA ONLY (P2): `job` is the record as it existed inside the
    // claim lock. The pre-claim `candidate` snapshot is dead from here on —
    // the listener mutates jobs in the scan→claim window (paths, captions,
    // counters, deliveryId), and sending from stale fields is how a wrong or
    // duplicate file reaches Rhys.
    const job = claimResult.job;
    const deliveryId = workerDeliveryIdForJob(job);

    const releaseClaim = async (patch = {}) => {
      await mutateQueue((queue) => {
        guardQueue(queue);
        return releaseJobClaim(queue, job.id, claimId, patch, now().toISOString()).jobs;
      }, { queuePath: jobsPath });
    };

    const finalizeDelivered = async (receipt, via) => {
      let applied = false;
      await mutateQueue((queue) => {
        guardQueue(queue);
        const idx = queue.findIndex((j) => j.id === job.id);
        if (idx === -1) return null;
        if (via !== "reconcile" && queue[idx].deliveryClaim?.id !== claimId) return null;
        const finalizedAt = now().toISOString();
        const next = queue.slice();
        next[idx] = {
          ...next[idx],
          status: "delivered",
          deliveryId,
          deliveryResult: receipt,
          replyText: next[idx].replyText || deliveryCaption(job),
          deliveredAt: next[idx].deliveredAt || finalizedAt,
          completedAt: next[idx].completedAt || finalizedAt,
          deliveredBy: `workspace-worker:${via}`,
          deliveryClaim: null,
          updatedAt: finalizedAt,
        };
        applied = true;
        return next;
      }, { queuePath: jobsPath });
      return applied;
    };

    const ledgerEvents = readDeliveryLedger({ ledgerPath });

    // 2. RECONCILE: receipt already in the send-side ledger (crash after
    //    send, before finalize) → finalize without sending.
    const priorReceipt = findLedgerReceipt(ledgerEvents, deliveryId);
    if (priorReceipt) {
      await finalizeDelivered(priorReceipt, "reconcile");
      summary.reconciled += 1;
      log(`reconciled job=${job.id} from ledger receipt (no send)`);
      continue;
    }

    // POST-CLAIM REVALIDATION: the claim transform re-checks status and
    // receipt under the lock; everything else in the candidate predicate is
    // re-checked here against the claimed record. A job that drifted out of
    // candidate shape is released untouched, never sent.
    const artifactPath = selectPreferredArtifactPath(job.artifactPaths);
    if (
      job.channel !== RHYS_DM_CHANNEL_ID
      || job.userId !== RHYS_USER_ID
      || job.preferredDelivery !== "slack_dm"
      || !artifactPath
      || !fileExists(artifactPath)
    ) {
      await releaseClaim();
      summary.staleCandidates += 1;
      log(`released job=${job.id}: no longer candidate-shaped after claim (no send)`);
      continue;
    }
    const filename = basename(artifactPath);

    // SAME-ASSET GUARD: this exact file already reached Rhys after this job
    // was asked for (another job delivered it) → finalize on that receipt,
    // never upload a second copy.
    const duplicateReceipt = findRecentFilenameReceipt(ledgerEvents, filename, job.createdAt);
    if (duplicateReceipt) {
      await finalizeDelivered(duplicateReceipt, "duplicate-path-reconcile");
      summary.reconciled += 1;
      log(`reconciled job=${job.id}: ${filename} already delivered after this request (no second send)`);
      continue;
    }

    // 3. ATTEMPT JOURNAL: a prior attempt with no receipt means a send may
    //    have landed without its bookkeeping (SIGKILL window). Verify via
    //    history BEFORE ever resending.
    const priorAttempt = readAttempts(journalPath).find((a) => a.deliveryId === deliveryId);
    if (priorAttempt) {
      let recovered = null;
      try {
        recovered = await verifyPriorDeliveryViaHistory({ slackClient: baseSlack, token, filename, sinceIso: priorAttempt.at });
      } catch (err) {
        // VERIFY-FAILURE PARKING (P2): count the failure and park VISIBLY
        // after maxAttempts. An un-counted verify failure (e.g. missing
        // im:history scope) would otherwise retry silently forever.
        const verifyFailures = (job.workerVerifyFailures || 0) + 1;
        const park = verifyFailures >= maxAttempts;
        log(`history verification failed job=${job.id} (failure ${verifyFailures}/${maxAttempts}): ${err.message} — NOT resending this pass${park ? "; PARKED for operator review" : ""}`);
        await releaseClaim({
          workerVerifyFailures: verifyFailures,
          lastWorkerError: `history verification failed: ${String(err.message).slice(0, 200)}`,
          lastWorkerAttemptAt: now().toISOString(),
          ...(park ? {
            status: "blocked_needs_approval",
            safeErrorSummary: "Workspace worker could not verify whether an earlier send already reached Rhys (Slack history check failed repeatedly); operator review required before any resend.",
          } : {}),
        });
        summary[park ? "parked" : "failures"] += 1;
        if (park) await notifyRhysOfPark({ slackClient: baseSlack, token, log });
        continue;
      }
      if (recovered) {
        try {
          recordDeliveryState({
            deliveryId, status: "delivered",
            reason: "Recovered via Slack history after an interrupted send (attempt journal had no receipt).",
            channelId: recovered.channelId, messageTs: recovered.messageTs, fileId: recovered.fileId,
            metadata: { recoveredBy: "workspace-worker", filename },
          }, { ledgerPath });
        } catch { /* receipt persists on the job record below regardless */ }
        await finalizeDelivered(recovered, "history-recovery");
        summary.recoveredFromHistory += 1;
        log(`recovered job=${job.id} from Slack history (no resend)`);
        continue;
      }
    }
    journalAttempt(journalPath, { deliveryId, jobId: job.id, claimId, filename, at: now().toISOString() });

    // 4. GUARDED SEND: heartbeat + ownership check before every Slack call;
    //    ledger re-check immediately before the user-visible completeUpload.
    let completedReceipt = null; // captured even if the send throws afterwards
    const renewClaimOrAbort = async () => {
      let owned = false;
      await mutateQueue((queue) => {
        guardQueue(queue);
        const idx = queue.findIndex((j) => j.id === job.id);
        if (idx === -1) return null;
        if (queue[idx].deliveryClaim?.id !== claimId) return null;
        owned = true;
        const next = queue.slice();
        next[idx] = { ...next[idx], deliveryClaim: { id: claimId, at: now().toISOString() } };
        return next;
      }, { queuePath: jobsPath });
      if (!owned) throw new ClaimLostError(job.id);
    };
    const guardedSlack = async (method, body, opts) => {
      await renewClaimOrAbort();
      if (method === "files.completeUploadExternal") {
        // Re-check BOTH walls immediately before the only user-visible call:
        // our own deliveryId (same job) AND the same-filename guard (a
        // concurrent worker delivering a DIFFERENT job that carries this
        // exact file — two jobs, one asset, must still be one upload).
        const ledgerNow = readDeliveryLedger({ ledgerPath });
        const lateReceipt = findLedgerReceipt(ledgerNow, deliveryId)
          || findRecentFilenameReceipt(ledgerNow, filename, job.createdAt);
        if (lateReceipt) throw new AlreadyDeliveredError(lateReceipt);
      }
      const response = await baseSlack(method, body, opts);
      if (method === "files.completeUploadExternal") {
        const fileId = body.files?.[0]?.id;
        const ts = response.files?.[0]?.shares?.private?.[RHYS_DM_CHANNEL_ID]?.[0]?.ts
          || response.file?.shares?.private?.[RHYS_DM_CHANNEL_ID]?.[0]?.ts
          || null;
        completedReceipt = { channelId: RHYS_DM_CHANNEL_ID, fileId, messageTs: ts, filename };
      }
      return response;
    };

    let sendResult = null;
    let sendError = null;
    try {
      sendResult = await sendRhysDmArtifact({
        artifactPath,
        sourceChannel: RHYS_DM_CHANNEL_ID,
        requestedBy: RHYS_USER_ID,
        deliveryId,
        title: job.title || "Atlas artifact",
        message: deliveryCaption(job),
        token,
        slackClient: guardedSlack,
        uploadFetch: baseUpload,
        allowedRoots,
        ledgerOptions: { ledgerPath },
      });
    } catch (err) {
      sendError = err;
    }

    if (sendError?.code === "CLAIM_LOST") {
      summary.aborted += 1;
      log(`send aborted (claim lost before user-visible call) job=${job.id}`);
      continue;
    }
    if (sendError?.code === "ALREADY_DELIVERED") {
      await finalizeDelivered(sendError.receipt, "reconcile");
      summary.reconciled += 1;
      log(`receipt appeared mid-send job=${job.id} — finalized without completing upload`);
      continue;
    }
    if (sendError && completedReceipt) {
      // 5. POST-COMPLETE failure: Slack accepted the upload; the throw was
      //    bookkeeping. NEVER retryable — that path is how duplicates happen.
      try {
        recordDeliveryState({
          deliveryId, status: "delivered",
          reason: "Delivered; receipt re-recorded by worker after post-upload bookkeeping failure.",
          channelId: completedReceipt.channelId, messageTs: completedReceipt.messageTs, fileId: completedReceipt.fileId,
          metadata: { postCompleteRecovery: true, filename },
        }, { ledgerPath });
      } catch { /* job record below still carries the receipt */ }
      const applied = await finalizeDelivered(completedReceipt, "post-complete-recovery");
      if (applied) summary.delivered += 1; else summary.sentButSuperseded += 1;
      log(`delivered with post-complete recovery job=${job.id} (bookkeeping error: ${String(sendError.message).slice(0, 120)})`);
      continue;
    }
    if (sendError) {
      const attempts = (job.workerAttempts || 0) + 1;
      const park = attempts >= maxAttempts;
      await releaseClaim({
        workerAttempts: attempts,
        lastWorkerError: String(sendError.message || sendError).slice(0, 300),
        lastWorkerAttemptAt: now().toISOString(),
        ...(park ? {
          status: "blocked_needs_approval",
          safeErrorSummary: "Workspace worker could not deliver this artifact after repeated attempts; operator review required.",
        } : {}),
      });
      summary[park ? "parked" : "failures"] += 1;
      log(`send failed job=${job.id} attempt=${attempts}${park ? " -> parked for review" : ""}: ${sendError.message}`);
      if (park) await notifyRhysOfPark({ slackClient: baseSlack, token, log });
      continue;
    }

    // 6. FINALIZE while our claim still owns the job.
    const receipt = {
      channelId: sendResult.channelId,
      fileId: sendResult.fileId,
      messageTs: sendResult.messageTs,
      filename: sendResult.filename,
    };
    const applied = await finalizeDelivered(receipt, "send");
    if (applied) {
      summary.delivered += 1;
      log(`delivered job=${job.id} file=${receipt.fileId} ts=${receipt.messageTs}`);
    } else {
      summary.sentButSuperseded += 1;
      log(`WARN: send completed but finalize was superseded job=${job.id} — receipt is in the ledger; investigate for duplicate delivery`);
    }
  }

  return summary;
}

// hasSlackDeliveryReceipt + recordSlackDmJobDelivered stay the canonical
// invariant elsewhere; re-export for the harness's invariant assertions.
export { hasSlackDeliveryReceipt, recordSlackDmJobDelivered };

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const logLine = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
  // STARTUP PREFLIGHT: refuse to run at all without the scopes the delivery
  // pipeline depends on. EX_CONFIG keeps launchd logs unambiguous.
  const pre = await preflightWorkerScopes({ token: process.env.SLACK_BOT_TOKEN });
  if (!pre.ok) {
    logLine(`REFUSING TO RUN: Slack token preflight failed — missing scopes [${pre.missing.join(", ")}]${pre.error ? ` (${pre.error})` : ""}. Required: ${REQUIRED_WORKER_SCOPES.join(", ")}.`);
    process.exit(78);
  }
  const summary = await runWorkerPass({ log: logLine });
  logLine(`pass complete ${JSON.stringify(summary)}`);
}
