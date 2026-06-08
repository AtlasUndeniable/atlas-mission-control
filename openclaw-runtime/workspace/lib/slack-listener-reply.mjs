import { basename } from "node:path";

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
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  const asksFirst10k = /\b(first|1st)?\s*\$?10k\b|\bfirst\s+ten\s+k\b|\bfirst\s+10\s*k\b/.test(normalized);
  const asksOnlineCoach = /\b(online\s+coach|coach|coaching)\b/.test(normalized);
  const asksAsset = /\b(asset|doc|document|pdf|playbook|strategy|strategic|model|pricing|offer|retention|sales)\b/.test(normalized);

  if (asksFirst10k && asksOnlineCoach && asksAsset) {
    return {
      key: "first-10k-online-coach",
      artifactPath: "/Users/atlasai/.openclaw/workspace/exports/2026-05-20-first-10k-month-bible-branded.pdf",
      title: "First $10K Month coaching playbook",
      message: "Done. I found the verified First $10K Month branded asset and attached it here. This is the existing Atlas/Undeniable artifact, not a fresh hallucinated draft.",
    };
  }

  return null;
}

export function isLikelyLongRunningRequest(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  const hasResearchVerb = /\b(find|search|look for|pull|gather|source|research|examples?)\b/.test(normalized);
  const hasBuildVerb = /\b(add|create|make|build|generate|turn it into|update|revise)\b/.test(normalized);
  const hasArtifactCue = /\b(doc|document|pdf|brief|audit|report|transcript|deck|visual|diagram|pyramid|recommendation|recommendations|pay structure|pay bands|client bands|per client|calls?|source-backed)\b/.test(normalized);
  return /\b(doc|document|pdf|deck|brief|audit|report|transcript|transcripts|call library|all the calls|every call)\b/.test(normalized)
    || /\b(build|generate|create|make)\b.*\b(doc|document|pdf|brief|audit|report|transcript|deck)\b/.test(normalized)
    || /\bwith links to every call\b/.test(normalized)
    || /\bexamples in other calls\b/.test(normalized)
    || (hasResearchVerb && hasArtifactCue)
    || (hasResearchVerb && hasBuildVerb && /\b(call|calls|client|ricky|visual|recommendation|pay)\b/.test(normalized));
}

export function workspaceAckForRequest() {
  return "I have this logged as an asset request, but no verified file exists yet. I won't call it done until I return the actual file here.";
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
