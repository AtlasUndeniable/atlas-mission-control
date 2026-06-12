/**
 * Pending-disambiguation state for the retrieval lane (F3.1).
 *
 * THE LIVE FAILURE THIS FIXES (2026-06-12): retrieval found candidates and
 * asked Rhys "which one?" — but the offer was STATELESS. The pick ("first
 * 10k month bible") carries no retrieval verb, so it failed
 * isRetrievalRequest, fell through normal routing, and hit the gateway
 * timeout lane: "needs workspace time, no verified file exists yet" —
 * about a file that was sitting on disk, already found.
 *
 * This module gives the offer memory:
 *   - setPendingDisambiguation   persists the offered candidates, keyed by
 *                                channel+user, with a TTL (default 12 min)
 *   - readPendingDisambiguation  returns the live offer or null (expired
 *                                offers are invisible)
 *   - clearPendingDisambiguation removes it
 *   - resolveDisambiguationPick  deterministically matches a reply against
 *                                the offered candidate names
 *   - enqueueRetrievalCarrier    the ONE ledger mutation both the clean
 *                                retrieval match and a disambiguation pick
 *                                use to queue delivery for the worker —
 *                                single-owner delivery (F2.1) is preserved:
 *                                nothing here sends; the worker uploads.
 *
 * Storage uses the house queue-writer (same advisory-lock pattern as the
 * jobs ledger). All paths/clocks injectable for the proof harness.
 */

import { mutateQueueSync, peekQueue } from "./queue-writer.mjs";
import { findCarrierJobForArtifactGroup, listSlackDmJobs, updateSlackDmJob } from "./slack-dm-jobs.mjs";
import { extractRetrievalTerms, scoreGroup, MIN_MATCH_SCORE } from "./slack-retrieval.mjs";

export const RETRIEVAL_PENDING_PATH = "/Users/atlasai/.openclaw/data/slack-retrieval-pending.json";
// 5 minutes: picks land within seconds. A longer window arms a stale offer
// against later, unrelated messages (adversarial finding: an 11-minute-old
// offer hijacked a fresh verbless request that happened to share words).
export const DEFAULT_DISAMBIGUATION_TTL_MS = 5 * 60_000;

// Slack channel/user ids are [A-Z0-9] so "|" can never occur — but that is a
// load-bearing assumption, so the separator is enforced rather than assumed.
function keyOf(channel, userId) {
  const clean = (v) => String(v).replaceAll("|", "_");
  return `${clean(channel)}|${clean(userId)}`;
}

function liveRecords(records, nowMs) {
  return (Array.isArray(records) ? records : []).filter(
    (r) => r && Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt) > nowMs,
  );
}

/**
 * Persist (or replace) the pending offer for this channel+user. Candidates
 * are trimmed to what a pick needs: name identity + the artifact group.
 */
export function setPendingDisambiguation(
  { channel, userId, candidates = [], offerJobId = null } = {},
  { filePath = RETRIEVAL_PENDING_PATH, ttlMs = DEFAULT_DISAMBIGUATION_TTL_MS, now = () => new Date() } = {},
) {
  const nowMs = now().getTime();
  const record = {
    key: keyOf(channel, userId),
    channel,
    userId,
    offerJobId,
    offeredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    candidates: candidates.map((c) => ({
      artifactKey: c.artifactKey || null,
      title: c.title || null,
      artifactPaths: Array.isArray(c.artifactPaths) ? c.artifactPaths.filter(Boolean) : [],
    })),
  };
  mutateQueueSync((records) => {
    const kept = liveRecords(records, nowMs).filter((r) => r.key !== record.key);
    return [...kept, record];
  }, { queuePath: filePath });
  return record;
}

/** The live offer for this channel+user, or null. Read-only (no pruning). */
export function readPendingDisambiguation(
  { channel, userId } = {},
  { filePath = RETRIEVAL_PENDING_PATH, now = () => new Date() } = {},
) {
  const nowMs = now().getTime();
  return liveRecords(peekQueue({ queuePath: filePath }), nowMs)
    .find((r) => r.key === keyOf(channel, userId)) || null;
}

export function clearPendingDisambiguation(
  { channel, userId } = {},
  { filePath = RETRIEVAL_PENDING_PATH, now = () => new Date() } = {},
) {
  const nowMs = now().getTime();
  mutateQueueSync(
    (records) => liveRecords(records, nowMs).filter((r) => r.key !== keyOf(channel, userId)),
    { queuePath: filePath },
  );
}

function collapse(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Deterministically match a reply against the OFFERED candidates.
 *
 * Hardened after adversarial review:
 *
 * 1. The collapsed-name rule fires only when the pick IS a candidate name
 *    or a FRAGMENT of one (name-contains-pick). The reverse direction —
 *    pick-contains-name — was the wrong-candidate hole: "the offer letter"
 *    contains the generic name "Offer" but not "Offer Letter Template",
 *    so the user's distinguishing word was discarded and the WRONG file
 *    matched decisively. Picks longer than a name now fall through to
 *    token scoring, which weighs every word.
 *
 * 2. Token scoring accepts a UNIQUE top scorer at score >= 1 (the user is
 *    choosing among a handful of names we just showed them; the original
 *    MIN_MATCH_SCORE=2 turned natural single-token picks — "the bible" —
 *    into "none" and re-ran the exact live failure this module exists to
 *    fix). Ties of any score re-ask with the narrowed set; uniqueness is
 *    the safety property, not the score floor.
 *
 * Returns {kind:"match", candidate} | {kind:"still_ambiguous", candidates}
 *       | {kind:"none"}.
 */
export function resolveDisambiguationPick(text, candidates = []) {
  const list = candidates.filter((c) => c && (c.title || c.artifactKey));
  if (!list.length) return { kind: "none" };

  const collapsedText = collapse(text);
  if (collapsedText.length >= 6) {
    const exact = list.filter((c) =>
      [c.title, c.artifactKey].filter(Boolean).some((name) => {
        const collapsedName = collapse(name);
        return collapsedName === collapsedText || collapsedName.includes(collapsedText);
      }));
    if (exact.length === 1) return { kind: "match", candidate: exact[0] };
  }

  const terms = extractRetrievalTerms(text);
  if (!terms.length) return { kind: "none" };
  const nameTokens = (candidate) =>
    `${candidate.artifactKey || ""} ${candidate.title || ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored = list
    .map((candidate) => ({
      candidate,
      score: scoreGroup(terms, candidate).score,
      // exact whole-token hits — a single hit is only decisive when the
      // word IS a candidate token ("bible"), never a prefix ("check" must
      // not match "checklist": an unrelated message mentioning "check my
      // calendar" would otherwise deliver a file — adversarial finding).
      exactHits: terms.filter((t) => nameTokens(candidate).includes(t)).length,
    }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < 1) return { kind: "none" };
  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length > 1) return { kind: "still_ambiguous", candidates: tied.map((s) => s.candidate) };
  if (top.score >= MIN_MATCH_SCORE) return { kind: "match", candidate: top.candidate };
  // score exactly 1: decisive only on an exact token hit unique to this candidate
  if (top.exactHits >= 1 && scored.every((s) => s === top || s.exactHits === 0)) {
    return { kind: "match", candidate: top.candidate };
  }
  return { kind: "none" };
}

/**
 * Queue a RESOLVED retrieval delivery for the workspace worker — the single
 * ledger mutation shared by the clean-match lane and the disambiguation
 * pick. Carrier-group logic: if a pending ledger job already carries ANY
 * file of the resolved group, queue THAT job (two pending jobs pointing at
 * one artifact is the two-filename double-send). Counters reset: an explicit
 * request earns fresh worker attempts. NOTHING here sends to Slack — the
 * worker owns delivery (F2.1).
 *
 * Returns { carrierId, usedExistingCarrier }.
 */
export function enqueueRetrievalCarrier(
  { requestJobId, channel, userId, artifactPath, groupPaths = [], title = null, message, fileExists = () => true } = {},
  { jobsPath, now = () => new Date() } = {},
) {
  const nowIso = now().toISOString();
  const allPaths = [...new Set([artifactPath, ...groupPaths])].filter(Boolean);
  const jobsOptions = jobsPath ? { filePath: jobsPath } : {};
  const existingCarrier = findCarrierJobForArtifactGroup(listSlackDmJobs(jobsOptions), {
    channel, userId, excludeId: requestJobId, groupPaths: allPaths,
  });
  const carrierId = existingCarrier ? existingCarrier.id : requestJobId;
  updateSlackDmJob(carrierId, {
    status: "delivery_requested",
    preferredDelivery: "slack_dm",
    deliveryRequestedAt: nowIso,
    artifactPaths: [...new Set([artifactPath, ...((existingCarrier?.artifactPaths) || []).filter((p) => fileExists(p))])],
    // The RESOLVED name is the user-facing truth: a reused carrier may carry
    // an unrelated title from its original request (adversarial finding —
    // the right file delivered under the wrong label).
    title: title || (existingCarrier?.title) || null,
    deliveryMessage: message,
    retrievalResolved: "match",
    workerAttempts: 0,
    workerVerifyFailures: 0,
  }, jobsOptions);
  if (existingCarrier) {
    updateSlackDmJob(requestJobId, {
      status: "answered",
      completedAt: nowIso,
      relatedJobId: existingCarrier.id,
      preferredDelivery: "slack_dm",
      retrievalResolved: "match",
    }, jobsOptions);
  }
  return { carrierId, usedExistingCarrier: Boolean(existingCarrier) };
}
