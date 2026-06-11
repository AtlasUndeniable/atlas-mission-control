import { basename } from "node:path";
import { findSlackAssetWorkflowForRequest } from "./slack-asset-workflows.mjs";

const NON_USEFUL_PATTERNS = [
  /Atlas stalled mid-thought/i,
  /Re-ask in a moment/i,
  /Request timed out before a response was generated/i,
];
export const SLACK_SAFE_MESSAGE_LIMIT = 3400;

export function isStatusFollowup(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  return /\bhow\s+(are\s+you\s+)?(going|tracking)\b/.test(normalized)
    || /\bwhat'?s\s+the\s+status\b/.test(normalized)
    || /\bwhere\s+are\s+we\s+at\b/.test(normalized)
    || /\bthat\s+request\b/.test(normalized)
    || /\bany\s+update\b/.test(normalized)
    || /\b(asset|doc|document|file|pdf|deck|brief|thing|request)\b.{0,80}\b(i|we)\s+asked\s+for\b/.test(normalized)
    || /\bwhat\s+about\b.{0,80}\b(asset|doc|document|file|pdf|deck|brief|request)\b/.test(normalized)
    || isTimeoutDebugFollowup(normalized);
}

export function isTimeoutDebugFollowup(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  return /\blive slack reply window\b/.test(normalized)
    || /\boutgrew\b.*\breply window\b/.test(normalized)
    || /\boperator review as slackdm-/.test(normalized)
    || /\btimeout issue\b/.test(normalized)
    || /\bfix\b.*\btimeout\b/.test(normalized)
    || /\bwhat does that actually mean\??$/.test(normalized);
}

export function isDeliveryRequestFollowup(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  return /\b(send|attach|drop|put|post|share)\s+(it|this|that|the file|the doc|the pdf|the output)\s+(here|to me here|in here|through here|to me)\b/.test(normalized)
    || /\b(just|please)?\s*send\s+(it|this|that|the file|the doc|the pdf|the output)\s+(to me\s+)?here\b/.test(normalized)
    || /\bcomplete\s+it\s+and\s+then\s+send\b.*\b(here|to me)\b/.test(normalized)
    || /\bbring\s+(it|this|that|the file|the doc|the pdf|the output)\s+back\s+here\b/.test(normalized);
}

export function isExplicitEmailDeliveryRequest(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  return /\b(e-?mail|gmail)\b/.test(normalized) || /mailto:/i.test(String(text || ""));
}

export function isExplicitMissionControlDeliveryRequest(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  return /\bmission\s+control\b/.test(normalized)
    || /\b(open|show|put|send|upload|route|leave|review|approve)\b.{0,60}\b(workspace|atlas workspace)\b/.test(normalized)
    || /\b(workspace|atlas workspace)\b.{0,60}\b(open|show|review|approve|mission control)\b/.test(normalized);
}

export function preferredDeliveryForSlackRequest({ text = "", isSlackDm = true } = {}) {
  if (isExplicitEmailDeliveryRequest(text)) {
    return { preferredDelivery: "email", reason: "request explicitly asked for email delivery" };
  }
  if (isExplicitMissionControlDeliveryRequest(text)) {
    return { preferredDelivery: "mission_control", reason: "request explicitly asked for Workspace/Mission Control" };
  }
  if (isSlackDm) {
    return { preferredDelivery: "slack_dm", reason: "source is Slack DM" };
  }
  return { preferredDelivery: "slack_thread", reason: "source is Slack channel/thread" };
}

export function findKnownArtifactForRequest(text = "") {
  const workflow = findSlackAssetWorkflowForRequest(text);
  if (!workflow) return null;
  return {
    key: workflow.key,
    workflowId: workflow.workflowId,
    adapter: workflow.adapter,
    artifactPath: workflow.artifactPath,
    artifactPaths: workflow.artifactPaths || [workflow.artifactPath].filter(Boolean),
    sourcePaths: workflow.sourcePaths || [],
    title: workflow.title,
    message: workflow.message,
  };
}

export function isLikelyLongRunningRequest(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  const hasResearchVerb = /\b(find|search|look for|pull|gather|source|research|examples?)\b/.test(normalized);
  const hasBuildVerb = /\b(add|create|make|build|generate|turn it into|update|revise)\b/.test(normalized);
  const hasArtifactCue = /\b(doc|document|pdf|brief|audit|report|transcript|deck|visual|diagram|pyramid|recommendation|recommendations|pay structure|pay bands|client bands|per client|calls?|source-backed)\b/.test(normalized);
  return /\b(doc|document|pdf|deck|brief|audit|report|transcript|transcripts|call library|all the calls|every call|framework|playbook)\b/.test(normalized)
    || /\b(build|generate|create|make)\b.*\b(doc|document|pdf|brief|audit|report|transcript|deck|framework|playbook)\b/.test(normalized)
    || /\bwith links to every call\b/.test(normalized)
    || /\bexamples in other calls\b/.test(normalized)
    || (hasResearchVerb && hasArtifactCue)
    || (hasResearchVerb && hasBuildVerb && /\b(call|calls|client|ricky|visual|recommendation|pay)\b/.test(normalized));
}

// Retrieval intent — same predicate as the routing decision so the asset
// lane's fall-through ack can never call a retrieval a "can't build".
export function isRetrievalIntentRequest(text = "") {
  return isRetrievalRequest(text);
}

// Document referents that name an EXISTING deliverable kind. Used to tell a
// retrieve-existing request apart from a build-new one.
const RETRIEVAL_REFERENT = /\b(vsl|framework|handover|hand-?over|playbook|sop|template|script|doc|document|pdf|file|guide|brief|deck|audit|report)\b/;
const RETRIEVAL_VERB = /\b(find|locate|look for|search for|search|dig up|pull up|resend|re-send|fetch|grab|get me|send me)\b/;
const EXISTING_REFERENT_CUE = /\b(again|before|previous|previously|earlier|existing|original|already|last time|last week|yesterday|the one|that doc|that file)\b/;
// Past-tense send against a recipient — "i sent the client", "shared with
// clients", "gave a client" — marks the referent as already existing even
// without a "before/already" temporal cue.
const PAST_SEND_CUE = /\b(sent|shared|gave|made|created)\b.{0,80}\b((to|with|for)\s+)?(a|the|my|our)?\s*clients?\b|\b(sent|shared|gave)\b.{0,40}\b(in slack|over slack|via slack)\b|\b(i|we)\s+(have\s+)?(sent|shared|gave|made|created)\b/;

/**
 * ROUTING predicate: should this request enter the read-only retrieval lane
 * (ahead of the produce-or-block asset lane AND ahead of the bare
 * delivery-followup lane)? Fires on a retrieval verb against an existing
 * referent — anaphoric ("find it and send it"), temporally cued ("...I sent
 * before"), past-sent ("...I shared with clients"), or a plainly named doc
 * kind with no build ask ("pull up the vsl framework"). A bare "send it to
 * me here" with no retrieval verb is NOT retrieval and falls through to the
 * delivery-followup lane. "find the top objections and build a summary doc"
 * is a build, not retrieval.
 */
export function isRetrievalRequest(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (/\bresend\b/.test(normalized)) return true;
  if (!RETRIEVAL_VERB.test(normalized)) return false;
  // A build verb anywhere means the request wants something NEW created —
  // never capture it into the read-only lane.
  const asksToBuild = /\b(build|create|make|generate|draft|write|turn it into)\b/.test(normalized);
  const anaphoric = /\b(find|locate|fetch|grab|pull up|dig up)\s+(it|that|this)\b/.test(normalized);
  const existing = EXISTING_REFERENT_CUE.test(normalized) || PAST_SEND_CUE.test(normalized);
  const named = RETRIEVAL_REFERENT.test(normalized);
  // Strong retrieval signals capture even alongside a build verb — a mixed
  // "find the X I sent before and build a new one" delivers the existing
  // file now; the lane appends an honest note that the build is a separate
  // ask. Weak signals defer to the build lane.
  if (anaphoric) return true;
  if (existing && named) return true;
  if (existing && !asksToBuild) return true;
  // Named doc kind + retrieval verb + no build ask: "pull up the vsl
  // framework", "can you locate the onboarding sop".
  if (named && !asksToBuild) return true;
  return false;
}

export function workspaceAckForRequest({ jobId, state = "queued" } = {}) {
  void jobId;
  void state;
  return "Got it. I'm creating the asset now. No verified file exists yet, and I won't call it done until the actual file is returned here.";
}

export function retrievalAckText() {
  return "Let me find that.";
}

export function noCapabilityText() {
  return "I can't build that one yet. There's no verified workflow for it, so I've flagged it for review instead of inventing a generic file.";
}

export function assetWorkflowBlockedText({ jobId, state = "blocked", reason } = {}) {
  void jobId;
  void state;
  return `I'm blocked on this asset. ${reason || "I do not have a verified workflow for it yet, so I am not inventing a generic file."}`;
}

export function liveTimeoutHandoffText() {
  return "I'm still here. This needs workspace time, so I won't keep trying to finish it inside the live Slack reply window. I have it logged, but no verified file exists yet.";
}

export function draftFailedHandoffText() {
  return "I picked this up, but the Slack reply path failed before I could produce a usable response. It is logged, but no verified result exists yet.";
}

export function deliveryRequestedText() {
  return "I don't have a verified file to send yet. I have the request logged, but delivery cannot happen until an artifact exists.";
}

// Single-owner delivery (race fix): the listener never uploads a file itself.
// It queues the verified artifact for the workspace worker and says so
// honestly — TR-6 clean, no ids, no states, no paths.
export function deliveryQueuedText() {
  return "The file is verified and queued for delivery. It will land in this DM shortly — I won't call it done until Slack confirms the upload.";
}

export function retrievalQueuedText() {
  return "Found it. Sending it here now — it will land in this DM shortly.";
}

export function approvalBlockedArtifactText({ artifactPaths = [] } = {}) {
  const files = artifactPaths
    .map((path) => basename(path))
    .filter(Boolean)
    .join(", ");
  return `It's ready, but I need approval before sending this file. Draft: ${files || "generated file"}.`;
}

export function misroutedDeliveryReplyText() {
  return "The file route selected the wrong delivery path. This Slack request should come back here, so I need the ready PDF or DOCX sent through the Rhys DM artifact helper.";
}

export function isMisdirectedDeliveryReply({ reply = "", preferredDelivery = "slack_dm" } = {}) {
  if (preferredDelivery !== "slack_dm") return false;
  const text = String(reply || "");
  return /gmail|e-?mail did(?:n'?t| not) send|reauth|mission control|approve the delivery path/i.test(text);
}

export function handoffSummaryForRequest({ text = "", classification = "quick_reply" } = {}) {
  return [
    `classification=${classification}`,
    `request=${String(text || "").replace(/\s+/g, " ").trim().slice(0, 500)}`,
    "required_next_step=Workspace Codex lane should gather source material, create verified artifacts, then record delivery state before any Slack/client delivery.",
  ].join(" | ");
}

export function extractGatewayReply(stdout = "") {
  const raw = String(stdout || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const text = parsed?.result?.payloads?.[0]?.text
      || parsed?.payloads?.[0]?.text
      || parsed?.result?.reply
      || parsed?.result?.text
      || parsed?.reply
      || parsed?.message
      || parsed?.content
      || parsed?.text
      || parsed?.answer;
    if (typeof text === "string" && text.trim()) return text.trim();
  } catch {
    // Plain text stdout is the common slack-listener path.
  }
  return raw;
}

export function redactSlackDiagnostic(value = "") {
  return String(value || "")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\/Users\/atlasai\/[^\s"'`),;]+/g, "[workspace-path]")
    .replace(/\.openclaw\/[^\s"'`),;]+/g, "[workspace-path]")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitProviderModel(modelId = "") {
  const text = String(modelId || "").trim();
  if (!text) return { provider: "unknown", model: "unknown", modelId: "unknown" };
  const [provider, ...modelParts] = text.split("/");
  return {
    provider: provider || "unknown",
    model: modelParts.join("/") || text,
    modelId: text,
  };
}

export function classifyGatewayFailure({
  timedOut = false,
  errorMessage = "",
  stderr = "",
  stdout = "",
  reply = "",
} = {}) {
  const diagnostic = `${errorMessage}\n${stderr}\n${stdout}\n${reply}`.toLowerCase();
  if (/context overflow|estimated context size exceeds/.test(diagnostic)) return "context_overflow";
  if (/sessionwritelocktimeouterror|session-write-lock|lock held/.test(diagnostic)) return "session_lock_timeout";
  if (timedOut || /timed out|timeout|etimedout|sigterm|killed/.test(diagnostic)) return "timeout";
  if (/invalid_auth|not_authed|account_inactive|token_revoked|auth\.test failed|device identity required|unauthori[sz]ed/.test(diagnostic)) return "auth_error";
  if (/rate_limited|ratelimited|too_many_requests|429|too_many_websockets/.test(diagnostic)) return "rate_or_socket_limit";
  if (/provider|model fallback|llm request failed|fetch failed|openai|anthropic|claude|gpt-|codex/.test(diagnostic)) return "provider_error";
  if (!isUsefulGatewayReply(reply)) return "empty_response";
  return "gateway_error";
}

export function gatewayFailureDetails({
  timedOut = false,
  errorMessage = "",
  stderr = "",
  stdout = "",
  reply = "",
  provider = "unknown",
  model = "unknown",
  modelId = "",
} = {}) {
  const modelParts = splitProviderModel(modelId || (provider !== "unknown" && model !== "unknown" ? `${provider}/${model}` : ""));
  const failureType = classifyGatewayFailure({ timedOut, errorMessage, stderr, stdout, reply });
  return {
    failureType,
    provider: provider === "unknown" ? modelParts.provider : provider,
    model: model === "unknown" ? modelParts.model : model,
    summary: gatewayFailureSummary({ timedOut, errorMessage, stderr, stdout, reply }),
  };
}

export function gatewayFailureSummary({
  timedOut = false,
  errorMessage = "",
  stderr = "",
  stdout = "",
  reply = "",
} = {}) {
  const base = timedOut
    ? "Live Slack agent window timed out; workspace handoff required."
    : !isUsefulGatewayReply(reply)
      ? "Gateway returned no usable reply."
      : "Gateway failed before a usable reply.";
  const diagnostic = [
    redactSlackDiagnostic(errorMessage),
    stderr ? `stderr: ${redactSlackDiagnostic(stderr)}` : "",
    !stderr && stdout ? `stdout: ${redactSlackDiagnostic(stdout)}` : "",
  ].filter(Boolean).join(" | ");
  return diagnostic ? `${base} ${diagnostic}`.slice(0, 900) : base;
}

export function formatGatewayFailureDetails(details = {}) {
  const failureType = redactSlackDiagnostic(details.failureType || "gateway_error");
  const provider = redactSlackDiagnostic(details.provider || "unknown");
  const model = redactSlackDiagnostic(details.model || "unknown");
  const summary = redactSlackDiagnostic(details.summary || "");
  return [
    `failure_type=${failureType}`,
    `provider=${provider}`,
    `model=${model}`,
    summary ? `summary=${summary}` : "",
  ].filter(Boolean).join(" | ");
}

export function chunkSlackText(text = "", limit = SLACK_SAFE_MESSAGE_LIMIT) {
  const safeLimit = Math.max(500, Math.min(Number(limit) || SLACK_SAFE_MESSAGE_LIMIT, SLACK_SAFE_MESSAGE_LIMIT));
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= safeLimit) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > safeLimit) {
    const window = remaining.slice(0, safeLimit + 1);
    const paragraphBreak = window.lastIndexOf("\n\n");
    const lineBreak = window.lastIndexOf("\n");
    const sentenceBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    const spaceBreak = window.lastIndexOf(" ");
    const cut = [paragraphBreak, lineBreak, sentenceBreak > 0 ? sentenceBreak + 1 : -1, spaceBreak]
      .find((index) => index >= Math.floor(safeLimit * 0.55)) ?? safeLimit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function isUsefulGatewayReply(reply = "") {
  const text = String(reply || "").trim();
  if (text.length < 20) return false;
  return !NON_USEFUL_PATTERNS.some((pattern) => pattern.test(text));
}

export function extractMediaPaths(reply = "") {
  return String(reply || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("MEDIA:/"))
    .map((line) => line.slice("MEDIA:".length).trim())
    .filter(Boolean);
}

export function prepareSlackReply(reply = "", { preferredDelivery = "manual_review" } = {}) {
  const mediaPaths = extractMediaPaths(reply);
  const textWithoutMedia = String(reply || "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("MEDIA:/"))
    .join("\n")
    .replace(/\/Users\/atlasai\/[^\s)]+/g, "[file ready]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!mediaPaths.length) {
    return { text: textWithoutMedia, mediaPaths, kind: "chat", chunks: chunkSlackText(textWithoutMedia) };
  }

  if (preferredDelivery === "slack_dm") {
    return {
      text: textWithoutMedia || "Done. I attached the file here.",
      mediaPaths,
      kind: "artifact_ready",
      deliveryAction: "send_rhys_dm_artifact",
      chunks: chunkSlackText(textWithoutMedia || "Done. I attached the file here."),
    };
  }

  const text = [
    textWithoutMedia || "That output is ready.",
    "",
    approvalBlockedArtifactText({ artifactPaths: mediaPaths }),
  ].join("\n").trim();

  return { text, mediaPaths, kind: "artifact_ready", deliveryAction: "manual_review", chunks: chunkSlackText(text) };
}
