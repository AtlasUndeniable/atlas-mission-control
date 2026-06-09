/**
 * Slack outbound validation gates — five-stage pre-flight check.
 *
 * Architecture: pure functions. No I/O. Hold/alert side effects live in
 * `slack-gate-actions.mjs`. Regex universe lives in `error-redaction-patterns.mjs`
 * (the single source of truth — see that file's header for SOUL.md linkage).
 *
 * Entry point:
 *   runGates({ text, channel, kind, isClientFacing, attachments, payload })
 *     → { pass: true,  scrubbed?: string }
 *     | { pass: false, gate: 1|2|3|4|5, reason: string, pattern?: string }
 *
 * Gate order is fixed. First failure short-circuits.
 *
 * `isClientFacing` is resolved by the caller (the bridge or service) via the
 * internal-channel allowlist (see INTERNAL_CHANNELS below).
 */

import {
  SUBPROCESS_LEAK_PATTERNS,
  VOICE_FORMALITY_PATTERNS,
  SOURCE_LINE_PATTERNS,
  CITATION_PATTERNS,
  DELIVERABLE_PHRASE_PATTERNS,
} from "./error-redaction-patterns.mjs";

// ─── INTERNAL CHANNEL ALLOWLIST ─────────────────────────────────────────────
// Default-deny: any channel NOT in this list is considered client-facing and
// runs gate 3 voice scrub. Add channels here as new internal ones are created.
export const INTERNAL_CHANNELS = new Set([
  "mondayboard-approvals",     // Jian approval gate
  "rhys-jian-matt",            // Internal triage thread
  "fluxgate-atlas-build",      // Dante ↔ Rhys build chatter
  "fluxgate-atlas-ops",
  "atlas-internal",
  "atlas-logs",
  "atlas-alerts",
]);

export const RHYS_DM_CHANNEL_ID = "D0AM2R3H6SE";

function isApprovalPrompt(text) {
  if (!text) return false;
  if (/\bReply Y to approve\b/i.test(text)) return true;
  return /tagged you\b/i.test(text)
    && /\bAsk:\s*/i.test(text)
    && /\bDraft:\s*/i.test(text);
}

export function gate0_approvalDmRouting({ text, channelId }) {
  if (!channelId || !channelId.startsWith("D")) return { pass: true };
  if (channelId === RHYS_DM_CHANNEL_ID) return { pass: true };
  if (!isApprovalPrompt(text)) return { pass: true };
  return {
    pass: false,
    reason: "approval-style Rhys comms draft attempted to route to a non-Rhys DM",
    sample: channelId,
  };
}

// DM channels (start with "D") and ATLAS bot DMs are always internal.
function isInternalByChannelName(channelName, channelId) {
  if (!channelName && !channelId) return false; // unknown → default-deny
  if (channelId && channelId.startsWith("D")) return true; // Slack DM channels
  if (channelName && INTERNAL_CHANNELS.has(channelName.toLowerCase().replace(/^#/, ""))) return true;
  return false;
}

// ─── GATE BOUNDS ────────────────────────────────────────────────────────────
export const MIN_MEANINGFUL_LENGTH = 30;   // chars after strip(whitespace + quotes)

// Per-kind minimum length overrides. Short thread acks ("Noted, skipping.",
// "OK.", "Done") are legitimate outputs from approval-reply confirm paths.
// Default stays 30 for unmapped kinds (chat, client-message, etc.).
export const MIN_LENGTH_BY_KIND = {
  "thread-ack": 5,
  "thread-reply": 5,
};

// Per-kind length caps. Defaults to MAX_MESSAGE_LENGTH_DEFAULT for unknown kinds.
//   approval-request → 30000 chars: the rebuilt tiered approval body for a busy
//                                    coaching call routinely runs 12-20k chars.
//                                    Slack's actual chat.postMessage text limit
//                                    is 40000, giving headroom.
//   pdf-attachment   → 1000 chars:   the chat caption only; PDF carries content.
//   (everything else) → 6000 chars:  conversational default for chat / dm /
//                                    client-message / escalation / thread reply.
export const MAX_LENGTH_BY_KIND = {
  "approval-request": 30000,
  "pdf-attachment": 1000,
};
export const MAX_MESSAGE_LENGTH_DEFAULT = 6000;
// Back-compat: older callers may import MAX_MESSAGE_LENGTH directly.
export const MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH_DEFAULT;

// Kinds exempt from Gate 4 (deliverable-presence).
//
// Gate 4 enforces the contract: "if a message claims a deliverable exists,
// the attachment/file URL must be present." That contract applies to skills
// producing artifacts (audit-subagent, doc-convert, post-as-Rhys client
// messages claiming actions completed).
//
// Briefings, summaries, digests, comms-triage drafts, and approval-requests
// REFERENCE completed work in their normal informational content without
// claiming the message itself is the deliverable. Subjecting them to Gate 4
// produces false positives on legitimate "317 done" / "5 tasks ready" /
// "email sent yesterday" status reporting.
//
// Per-kind exemption mirrors the gate-2 per-kind length cap pattern.
export const KINDS_EXEMPT_FROM_DELIVERABLE_CHECK = [
  "briefing",
  "summary",
  "digest",
  "comms-triage",
  "approval-request",
];

// ─── GATE 1: subprocess / log leakage ───────────────────────────────────────
export function gate1_subprocessLeak(text) {
  if (!text) return { pass: true };
  for (const pat of SUBPROCESS_LEAK_PATTERNS) {
    if (pat.test(text)) {
      return {
        pass: false,
        reason: "subprocess/log output detected in outbound text",
        pattern: pat.toString(),
        sample: extractMatch(text, pat),
      };
    }
  }
  return { pass: true };
}

// ─── GATE 2: length sanity ──────────────────────────────────────────────────
// `kind` argument selects both upper cap and lower floor.
export function gate2_lengthSanity(text, kind) {
  const stripped = (text || "").replace(/[\s"'`]+/g, "").length;
  const minLen = Object.prototype.hasOwnProperty.call(MIN_LENGTH_BY_KIND, kind)
    ? MIN_LENGTH_BY_KIND[kind]
    : MIN_MEANINGFUL_LENGTH;
  if (stripped < minLen) {
    return {
      pass: false,
      reason: `too short (${stripped} meaningful chars, min ${minLen})`,
    };
  }
  const cap = Object.prototype.hasOwnProperty.call(MAX_LENGTH_BY_KIND, kind)
    ? MAX_LENGTH_BY_KIND[kind]
    : MAX_MESSAGE_LENGTH_DEFAULT;
  if (text && text.length > cap) {
    return {
      pass: false,
      reason: `too long (${text.length} chars, max ${cap} for kind="${kind || "chat"}") — split or summarise`,
    };
  }
  return { pass: true };
}

// ─── GATE 3: client-facing scrub + voice check ──────────────────────────────
// Behaviour:
//   - Strips source-reference lines (Source:, Reference:, From:, Based on:)
//   - Strips lines containing third-party citations (Hormozi/Leila/$100M)
//   - Soft voice check: warns on FORMALITY blacklist matches (logged, not blocking)
// Returns scrubbed text on pass. Caller MUST use scrubbed text for the send.
export function gate3_clientVoiceScrub(text, isClientFacing) {
  if (!isClientFacing) return { pass: true, scrubbed: text };
  if (!text) return { pass: true, scrubbed: text };

  let scrubbed = text;

  // 1. Strip source-reference lines
  for (const pat of SOURCE_LINE_PATTERNS) scrubbed = scrubbed.replace(pat, "");

  // 2. Strip lines containing third-party citations
  scrubbed = scrubbed
    .split("\n")
    .filter((line) => !CITATION_PATTERNS.some((p) => p.test(line)))
    .join("\n");

  // Collapse 3+ consecutive newlines from the strips
  scrubbed = scrubbed.replace(/\n{3,}/g, "\n\n").trim();

  // Re-check length AFTER scrub — could have dropped below threshold
  const postScrubLen = scrubbed.replace(/[\s"'`]+/g, "").length;
  if (postScrubLen < MIN_MEANINGFUL_LENGTH) {
    return {
      pass: false,
      reason: `client-facing message scrubbed to ${postScrubLen} chars — too thin after stripping citations/sources`,
      scrubbed,
    };
  }

  // Soft voice check — log warnings, don't block.
  const voiceWarnings = [];
  for (const pat of VOICE_FORMALITY_PATTERNS) {
    if (pat.test(scrubbed)) voiceWarnings.push(pat.toString());
  }

  return { pass: true, scrubbed, voiceWarnings };
}

// ─── GATE 4: deliverable presence check ─────────────────────────────────────
// If text triggers a "delivered" phrase (fixed/v2/rebuilt/here it is/etc.)
// and no artifact (file/attachment/block) is present, reject.
export function gate4_deliverablePresence({ text, attachments, payload }) {
  if (!text) return { pass: true };

  const triggered = DELIVERABLE_PHRASE_PATTERNS.find((p) => p.test(text));
  if (!triggered) return { pass: true };

  // Look for an artifact in multiple places:
  //   - payload.attachments[]
  //   - payload.blocks[] with type "image" | "file"
  //   - explicit `attachments` arg
  //   - text contains a recognisable file URL (Slack file or http(s) pdf/png/etc.)
  const hasAttachmentArr = Array.isArray(attachments) && attachments.length > 0;
  const hasPayloadAttachments = Array.isArray(payload?.attachments) && payload.attachments.length > 0;
  const hasFileBlock = Array.isArray(payload?.blocks) &&
    payload.blocks.some((b) => b?.type === "image" || b?.type === "file" || b?.image_url || b?.image_block);
  const hasFileUrl = /\bhttps?:\/\/\S+\.(?:pdf|png|jpg|jpeg|gif|csv|xlsx|docx|md)\b/i.test(text)
    || /\bhttps?:\/\/files\.slack\.com\/\S+/i.test(text);

  if (hasAttachmentArr || hasPayloadAttachments || hasFileBlock || hasFileUrl) {
    return { pass: true };
  }

  return {
    pass: false,
    reason: `deliverable claim "${extractMatch(text, triggered).slice(0, 60)}" with no artifact (no attachments, blocks, or file URL)`,
    pattern: triggered.toString(),
  };
}

// ─── GATE 5: PDF preflight (STUB) ───────────────────────────────────────────
// Phase 1 stub. Real implementation requires pdfjs-dist or shelling to
// pdftotext/pdfinfo. Only invoked when caller passes kind === "pdf-attachment".
// Returns pass with warning so the call path is wired but inert tonight.
export function gate5_pdfPreflight({ pdfBuffer } = {}) {
  if (!pdfBuffer) {
    return {
      pass: false,
      reason: "gate5 invoked without pdfBuffer — cannot preflight",
    };
  }
  // TODO Phase 2: implement page-count, blank-page, layout-overlap, dup-H2 checks.
  // For now: minimal sanity — non-empty buffer, PDF magic bytes.
  if (pdfBuffer.length < 100) {
    return { pass: false, reason: `PDF buffer suspiciously small (${pdfBuffer.length} bytes)` };
  }
  const head = pdfBuffer.subarray(0, 5).toString("ascii");
  if (head !== "%PDF-") {
    return { pass: false, reason: `PDF magic bytes missing (got "${head}")` };
  }
  return {
    pass: true,
    stub: true,
    note: "gate5 minimal preflight only — full PDF-render check pending Phase 2 (pdfjs-dist)",
  };
}

// ─── runGates: orchestrator ─────────────────────────────────────────────────
export function runGates({
  text,
  channel,
  channelId,
  channelName,
  kind,
  isClientFacing,
  attachments,
  payload,
}) {
  const resolvedChannelId = channelId || channel || payload?.channel || payload?.channelId;
  const routing = gate0_approvalDmRouting({ text, channelId: resolvedChannelId });
  if (!routing.pass) return { pass: false, gate: 0, ...routing };

  // Resolve client-facing if not explicitly provided.
  const cfResolved = typeof isClientFacing === "boolean"
    ? isClientFacing
    : !isInternalByChannelName(channelName || channel, resolvedChannelId);

  // Gate 1
  let r = gate1_subprocessLeak(text);
  if (!r.pass) return { pass: false, gate: 1, ...r };

  // Gate 2 (per-kind cap)
  r = gate2_lengthSanity(text, kind);
  if (!r.pass) return { pass: false, gate: 2, ...r };

  // Gate 3 (only for client-facing; returns scrubbed text)
  const g3 = gate3_clientVoiceScrub(text, cfResolved);
  if (!g3.pass) return { pass: false, gate: 3, ...g3 };
  const scrubbed = g3.scrubbed;

  // Gate 4 (use scrubbed text). Per-kind exemption: briefings / summaries /
  // digests / comms-triage / approval-requests reference completed work
  // informationally without claiming the message itself is the deliverable.
  // Returns scrubbed + voiceWarnings so callers preserve gate 3's work.
  if (KINDS_EXEMPT_FROM_DELIVERABLE_CHECK.includes(kind)) {
    return {
      pass: true,
      gate: 4,
      skipped: true,
      reason: `kind=${kind} exempt from deliverable-presence check`,
      scrubbed,
      voiceWarnings: g3.voiceWarnings || [],
      isClientFacing: cfResolved,
    };
  }
  r = gate4_deliverablePresence({ text: scrubbed, attachments, payload });
  if (!r.pass) return { pass: false, gate: 4, ...r };

  // Gate 5 (only if kind matches)
  if (kind === "pdf-attachment") {
    r = gate5_pdfPreflight(payload);
    if (!r.pass) return { pass: false, gate: 5, ...r };
  }

  return {
    pass: true,
    scrubbed,
    voiceWarnings: g3.voiceWarnings || [],
    isClientFacing: cfResolved,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function extractMatch(text, pattern) {
  const m = text.match(pattern);
  return m ? m[0] : "";
}
