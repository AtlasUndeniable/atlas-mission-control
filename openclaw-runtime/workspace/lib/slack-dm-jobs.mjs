import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

export const SLACK_DM_JOBS_PATH = "/Users/atlasai/.openclaw/data/slack-dm-jobs.json";

export const SLACK_ASSET_JOB_STATES = Object.freeze({
  RECEIVED: "received",
  QUEUED: "queued",
  BUILDING: "building",
  ARTIFACT_READY: "artifact_ready",
  DELIVERY_REQUESTED: "delivery_requested",
  DELIVERED: "delivered",
  BLOCKED: "blocked",
  FAILED: "failed",
});

export const SLACK_ASSET_JOB_TRANSITIONS = Object.freeze({
  received: ["queued", "answered", "needs_workspace", "needs_workspace_job", "failed", "blocked"],
  queued: ["building", "delivery_requested", "blocked", "failed"],
  building: ["artifact_ready", "blocked", "failed"],
  artifact_ready: ["delivery_requested", "blocked_needs_approval", "blocked", "failed"],
  delivery_requested: ["delivered", "blocked_needs_approval", "blocked", "failed"],
  blocked_needs_approval: ["delivery_requested", "delivered", "blocked", "failed"],
  needs_workspace: ["queued", "delivery_requested", "blocked", "failed"],
  needs_workspace_job: ["queued", "delivery_requested", "blocked", "failed"],
  answered: ["delivery_requested", "delivered", "blocked", "failed"],
  completed: ["delivery_requested", "delivered", "blocked", "failed"],
  delivered: [],
  blocked: [],
  failed: [],
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath = SLACK_DM_JOBS_PATH) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readJobs(filePath = SLACK_DM_JOBS_PATH) {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJobs(jobs, filePath = SLACK_DM_JOBS_PATH) {
  ensureDir(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  renameSync(tmp, filePath);
}

export function makeSlackDmJobId(channel, messageTs) {
  return `slackdm-${channel}-${messageTs}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function makeSlackAssetJobId(value = "") {
  const seed = typeof value === "string" ? value : JSON.stringify(value || {});
  return `asset-${createHash("sha256").update(seed).digest("hex").slice(0, 10)}`;
}

export function hasSlackDeliveryReceipt(deliveryResult = {}) {
  return Boolean(deliveryResult?.channelId && (deliveryResult?.fileId || deliveryResult?.messageTs));
}

export function classifySlackRequest(text = "") {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ").trim();
  if (/\b(asset|playbook|workbook|worksheet|guide)\b/.test(normalized) && /\b(create|make|build|generate|pdf|doc|document|deck)\b/.test(normalized)) return "asset_request";
  if (/\b(audit|typeform|executive audit)\b/.test(normalized)) return "audit_request";
  if (/\b(doc|document|pdf|deck|brief|transcript|transcripts|call library|all the calls|every call)\b/.test(normalized)) return "document_request";
  if (/\b(content|hooks|posts|angles|topics|batch)\b/.test(normalized)) return "content_request";
  if (/\b(research|find|look up|analyse|analyze)\b/.test(normalized)) return "general_research";
  return "quick_reply";
}

export function sourceFields({ channel, messageTs, userId, text }) {
  return {
    sourceType: "slack",
    sourceChannel: channel,
    sourceTs: messageTs,
    requester: userId,
    requestText: String(text || "").slice(0, 2000),
  };
}

export function upsertSlackDmJob({ channel, messageTs, userId, text, sessionId, kind = "request", status = "received" }, options = {}) {
  const filePath = options.filePath || SLACK_DM_JOBS_PATH;
  const jobs = readJobs(filePath);
  const id = makeSlackDmJobId(channel, messageTs);
  const existing = jobs.find((job) => job.id === id);
  if (existing) return { job: existing, created: false };
  const job = {
    id,
    assetJobId: makeSlackAssetJobId(id),
    ...sourceFields({ channel, messageTs, userId, text }),
    kind,
    classification: classifySlackRequest(text),
    channel,
    messageTs,
    userId,
    sessionId,
    originalMessage: String(text || "").slice(0, 2000),
    status,
    safeErrorSummary: null,
    handoffSummary: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    failedAt: null,
    replyText: null,
    artifactPaths: [],
    error: null,
  };
  jobs.push(job);
  writeJobs(jobs.slice(-200), filePath);
  return { job, created: true };
}

export function createSlackDmJob(args, options = {}) {
  return upsertSlackDmJob(args, options).job;
}

export function updateSlackDmJob(id, patch, options = {}) {
  const filePath = options.filePath || SLACK_DM_JOBS_PATH;
  const jobs = readJobs(filePath);
  let updated = null;
  const next = jobs.map((job) => {
    if (job.id !== id) return job;
    const nextDeliveryResult = patch.deliveryResult ?? job.deliveryResult;
    if (patch.status === "delivered" && !hasSlackDeliveryReceipt(nextDeliveryResult)) {
      throw new Error("Slack DM job cannot be marked delivered without a Slack file/message receipt");
    }
    updated = {
      ...job,
      ...patch,
      updatedAt: nowIso(),
    };
    return updated;
  });
  if (!updated) return null;
  writeJobs(next, filePath);
  return updated;
}


export function canTransitionSlackAssetJob(fromStatus, toStatus) {
  if (!toStatus || fromStatus === toStatus) return true;
  const allowed = SLACK_ASSET_JOB_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export function transitionSlackDmJob(id, nextStatus, patch = {}, options = {}) {
  const filePath = options.filePath || SLACK_DM_JOBS_PATH;
  const existing = readJobs(filePath).find((job) => job.id === id);
  if (!existing) return null;
  if (!canTransitionSlackAssetJob(existing.status, nextStatus)) {
    throw new Error(`Invalid Slack asset job transition: ${existing.status} -> ${nextStatus}`);
  }
  return updateSlackDmJob(id, { ...patch, status: nextStatus }, options);
}

export function recordSlackDmJobDelivered(id, patch = {}, options = {}) {
  if (!hasSlackDeliveryReceipt(patch.deliveryResult)) {
    throw new Error("Slack DM job cannot be marked delivered without a Slack file/message receipt");
  }
  const at = nowIso();
  return updateSlackDmJob(id, {
    ...patch,
    status: "delivered",
    deliveredAt: patch.deliveredAt || at,
    completedAt: patch.completedAt || at,
  }, options);
}

export function listSlackDmJobs(options = {}) {
  return readJobs(options.filePath || SLACK_DM_JOBS_PATH);
}

export function findRecentSlackDmJob({ channel, userId, excludeId, maxAgeMinutes = 240 }, options = {}) {
  const cutoff = Date.now() - maxAgeMinutes * 60_000;
  return readJobs(options.filePath || SLACK_DM_JOBS_PATH)
    .filter((job) => job.id !== excludeId)
    .filter((job) => !channel || job.channel === channel)
    .filter((job) => !userId || job.userId === userId)
    .filter((job) => job.kind !== "status_check")
    .filter((job) => {
      const created = Date.parse(job.createdAt || "");
      return Number.isFinite(created) && created >= cutoff;
    })
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))[0] || null;
}

export function findLatestDeliveryCandidate({ channel, userId, excludeId, maxAgeMinutes = 720 }, options = {}) {
  const cutoff = Date.now() - maxAgeMinutes * 60_000;
  const deliverableStatuses = new Set([
    "queued",
    "building",
    "artifact_ready",
    "delivery_requested",
    "blocked_needs_approval",
    "answered",
    "completed",
    "needs_workspace",
    "needs_workspace_job",
  ]);
  return readJobs(options.filePath || SLACK_DM_JOBS_PATH)
    .filter((job) => job.id !== excludeId)
    .filter((job) => !channel || job.channel === channel)
    .filter((job) => !userId || job.userId === userId)
    .filter((job) => job.kind !== "status_check")
    .filter((job) => deliverableStatuses.has(job.status))
    .filter((job) => {
      const created = Date.parse(job.createdAt || "");
      return Number.isFinite(created) && created >= cutoff;
    })
    .sort((a, b) => {
      const aFiles = Array.isArray(a.artifactPaths) && a.artifactPaths.length ? 1 : 0;
      const bFiles = Array.isArray(b.artifactPaths) && b.artifactPaths.length ? 1 : 0;
      if (aFiles !== bFiles) return bFiles - aFiles;
      return Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || "");
    })[0] || null;
}

export function summarizeSlackDmJob(job) {
  if (!job) return null;
  const assetJobId = job.assetJobId || makeSlackAssetJobId(job.id || "unknown");
  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt || new Date().toISOString())) / 60000));
  const files = Array.isArray(job.artifactPaths) && job.artifactPaths.length
    ? job.artifactPaths.map((path) => basename(path)).join(", ")
    : null;
  const statePrefix = `Asset job ${assetJobId} is state=${job.status}.`;
  if (job.status === "delivered") {
    const receipt = job.deliveryResult?.fileId || job.deliveryResult?.messageTs || "recorded";
    return `That file has been sent here. Slack receipt: ${receipt}.`;
  }
  if (job.status === "queued") {
    return `${statePrefix} It is queued from your Slack request, but no verified file exists yet.`;
  }
  if (job.status === "building") {
    return `${statePrefix} I am using ${job.workflowKey || "the selected verified artifact workflow"}; no delivery receipt exists yet.`;
  }
  if (job.status === "artifact_ready" || job.status === "blocked_needs_approval") {
    return `${statePrefix} The file is ready, but it is not delivered until Slack returns a file/message receipt. Draft: ${files || job.title || "generated file"}.`;
  }
  if (job.status === "delivery_requested") {
    return files
      ? `${statePrefix} Delivery is requested for ${files}; I will only mark it delivered after Slack returns a file/message receipt.`
      : `${statePrefix} Delivery is requested, but no verified file exists yet. I should not call this done until an artifact exists.`;
  }
  if (job.status === "answered" || job.status === "completed") {
    return [
      "That request has completed.",
      files ? `Files ready for delivery review: ${files}` : null,
    ].filter(Boolean).join("\n");
  }
  if (job.status === "received") {
    return `I have that request logged as ${assetJobId}. It started ${ageMinutes}m ago with state=received.`;
  }
  if (job.status === "needs_workspace") {
    return "I have that request logged, but no verified file exists yet. I should not have promised delivery until a real artifact or worker existed.";
  }
  if (job.status === "needs_workspace_job") {
    if (/timed out|live slack agent window/i.test(job.safeErrorSummary || "")) {
      return "That request needs workspace time, so I won't keep retrying it inside the live Slack reply window. It is logged, but no verified result exists yet.";
    }
    return "I have that request in the workspace job lane, but no verified result exists yet. Delivery preference remains this Slack DM once an artifact is real.";
  }
  if (job.status === "failed") {
    if (/timed out|live slack agent window/i.test(job.safeErrorSummary || "")) {
      return "That request needs workspace time, so I won't keep retrying it inside the live Slack reply window. It is logged, but no verified result exists yet.";
    }
    return `That request failed locally and needs review. Summary: ${job.safeErrorSummary || "unknown failure"}.`;
  }
  if (job.status === "blocked") {
    return `${statePrefix} Summary: ${job.safeErrorSummary || "operator review required"}.`;
  }
  return `That request is tracked locally as ${job.id} with status=${job.status}.`;
}
