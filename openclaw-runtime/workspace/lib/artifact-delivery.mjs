import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mutateQueue } from "./queue-writer.mjs";

export const LEDGER_PATH = "/Users/atlasai/.openclaw/data/artifact-deliveries.jsonl";
export const EXPORTS_DIR = "/Users/atlasai/.openclaw/workspace/exports";

export const TERMINAL_DELIVERY_STATES = new Set([
  "delivered",
  "queued_for_approval",
  "blocked_needs_human",
  "failed_with_reason",
]);

function nowIso() {
  return new Date().toISOString();
}

function ensureLedgerDir(ledgerPath = LEDGER_PATH) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
}

function normalizePath(filePath) {
  return resolve(String(filePath));
}

function makeDeliveryId({ artifactPaths = [], title = "", source = "" }) {
  const seed = JSON.stringify({
    artifactPaths: artifactPaths.map(normalizePath).sort(),
    title,
    source,
  });
  return `art_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function appendLedgerEvent(event, options = {}) {
  const ledgerPath = options.ledgerPath || LEDGER_PATH;
  ensureLedgerDir(ledgerPath);
  const entry = {
    eventId: randomUUID(),
    eventAt: nowIso(),
    ...event,
  };
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readDeliveryLedger(options = {}) {
  const ledgerPath = options.ledgerPath || LEDGER_PATH;
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return { eventType: "parse_error", raw: line }; }
    });
}

export function summarizeDeliveryLedger(options = {}) {
  const deliveries = new Map();
  for (const event of readDeliveryLedger(options)) {
    if (!event.deliveryId) continue;
    const current = deliveries.get(event.deliveryId) || {
      deliveryId: event.deliveryId,
      artifactPaths: [],
      states: [],
    };
    if (event.eventType === "artifact_created") {
      Object.assign(current, {
        title: event.title || current.title || null,
        requestedBy: event.requestedBy || current.requestedBy || null,
        targetUser: event.targetUser || current.targetUser || null,
        source: event.source || current.source || null,
        summary: event.summary || current.summary || null,
        artifactCreatedAt: event.artifactCreatedAt || event.eventAt,
        artifactPaths: Array.isArray(event.artifactPaths) ? event.artifactPaths : current.artifactPaths,
      });
    }
    if (event.eventType === "delivery_state") {
      current.states.push(event);
      current.status = event.status;
      current.reason = event.reason || null;
      current.channelId = event.channelId || null;
      current.messageTs = event.messageTs || null;
      current.statusAt = event.eventAt;
    }
    deliveries.set(event.deliveryId, current);
  }
  return [...deliveries.values()];
}

function artifactGroupKey(filePath) {
  const name = basename(filePath, extname(filePath));
  return name
    .replace(/-branded(?:-v\d+)?$/i, "")
    .replace(/-cover(?:-preview)?$/i, "");
}

export function scanExportArtifactGroups(options = {}) {
  const exportsDir = options.exportsDir || EXPORTS_DIR;
  if (!existsSync(exportsDir)) return [];
  const groups = new Map();
  for (const name of readdirSync(exportsDir)) {
    const fullPath = join(exportsDir, name);
    let st;
    try { st = statSync(fullPath); }
    catch { continue; }
    if (!st.isFile()) continue;
    const ext = extname(name).toLowerCase();
    if (![".pdf", ".docx", ".md", ".html", ".css", ".png"].includes(ext)) continue;
    const key = artifactGroupKey(name);
    const group = groups.get(key) || { artifactKey: key, artifactPaths: [], newestMtimeMs: 0 };
    group.artifactPaths.push(fullPath);
    group.newestMtimeMs = Math.max(group.newestMtimeMs, st.mtimeMs);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      artifactPaths: group.artifactPaths.sort(),
      newestMtime: new Date(group.newestMtimeMs).toISOString(),
    }))
    .sort((a, b) => b.newestMtimeMs - a.newestMtimeMs);
}

function pathsOverlap(left = [], right = []) {
  const rightSet = new Set(right.map(normalizePath));
  return left.map(normalizePath).some((path) => rightSet.has(path));
}

async function queueRhysReviewItem({ deliveryId, artifactPaths, title, summary, requestedBy, source, suggestedDeliveryNote, queuePath }) {
  const id = `artifact-review-${deliveryId}`;
  const item = {
    id,
    type: "artifact_delivery_review",
    status: "artifact_review",
    targetUser: "Rhys",
    title: title || "Generated artifact",
    artifactPaths,
    suggestedDeliveryNote: suggestedDeliveryNote || `Artifact ready for review: ${title || basename(artifactPaths[0] || "artifact")}`,
    summary: summary || null,
    requestedBy: requestedBy || null,
    source: source || null,
    timestamp: Date.now(),
    createdAt: nowIso(),
  };
  await mutateQueue((queue) => {
    if (queue.some((entry) => entry.id === id)) return queue;
    queue.push(item);
    return queue;
  }, queuePath ? { queuePath } : {});
  return id;
}

export async function recordArtifactCreated({
  artifactPaths,
  title,
  requestedBy,
  targetUser,
  source,
  summary,
  artifactCreatedAt,
  deliveryId,
  explicitDeliveryApproval = false,
  queueReview = true,
  suggestedDeliveryNote,
} = {}, options = {}) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) {
    throw new Error("recordArtifactCreated requires at least one artifact path");
  }

  const normalizedPaths = artifactPaths.map(normalizePath);
  const id = deliveryId || makeDeliveryId({ artifactPaths: normalizedPaths, title, source });
  const created = appendLedgerEvent({
    eventType: "artifact_created",
    deliveryId: id,
    artifactPaths: normalizedPaths,
    title: title || null,
    requestedBy: requestedBy || null,
    targetUser: targetUser || null,
    source: source || null,
    summary: summary || null,
    artifactCreatedAt: artifactCreatedAt || nowIso(),
  }, options);

  let reviewQueueId = null;
  if (queueReview && /^rhys$/i.test(String(targetUser || "")) && explicitDeliveryApproval !== true) {
    reviewQueueId = await queueRhysReviewItem({
      deliveryId: id,
      artifactPaths: normalizedPaths,
      title,
      summary,
      requestedBy,
      source,
      suggestedDeliveryNote,
      queuePath: options.queuePath,
    });
    appendLedgerEvent({
      eventType: "delivery_state",
      deliveryId: id,
      status: "queued_for_approval",
      reason: "Target is Rhys and no explicit delivery approval was recorded; queued safe review item instead of sending.",
      reviewQueueId,
      channelId: null,
      messageTs: null,
    }, options);
  }

  return { deliveryId: id, created, reviewQueueId };
}

export function recordDeliveryState({ deliveryId, status, reason, channelId, messageTs, fileId, metadata } = {}, options = {}) {
  if (!deliveryId) throw new Error("recordDeliveryState requires deliveryId");
  if (!TERMINAL_DELIVERY_STATES.has(status)) {
    throw new Error(`recordDeliveryState status must be terminal: ${[...TERMINAL_DELIVERY_STATES].join(", ")}`);
  }
  return appendLedgerEvent({
    eventType: "delivery_state",
    deliveryId,
    status,
    reason: reason || null,
    channelId: channelId || null,
    messageTs: messageTs || null,
    fileId: fileId || null,
    metadata: metadata || null,
  }, options);
}

export function findUndeliveredArtifacts({ maxAgeMinutes = 60, exportsDir = EXPORTS_DIR, now = Date.now(), match } = {}, options = {}) {
  const cutoffMs = now - (Number(maxAgeMinutes) * 60 * 1000);
  const deliveries = summarizeDeliveryLedger(options);
  const terminalDeliveries = deliveries.filter((delivery) => TERMINAL_DELIVERY_STATES.has(delivery.status));
  const nonTerminalDeliveries = deliveries.filter((delivery) => !TERMINAL_DELIVERY_STATES.has(delivery.status));
  const groups = scanExportArtifactGroups({ exportsDir })
    .filter((group) => group.newestMtimeMs >= cutoffMs)
    .filter((group) => !match || group.artifactKey.includes(match) || group.artifactPaths.some((path) => path.includes(match)));

  const untracked = groups.filter((group) => (
    !terminalDeliveries.some((delivery) => pathsOverlap(group.artifactPaths, delivery.artifactPaths))
  ));

  const pending = nonTerminalDeliveries.filter((delivery) => {
    if (!delivery.artifactCreatedAt) return true;
    const createdMs = new Date(delivery.artifactCreatedAt).getTime();
    const matchesAge = Number.isFinite(createdMs) ? createdMs >= cutoffMs : true;
    const matchesText = !match
      || String(delivery.title || "").includes(match)
      || delivery.artifactPaths.some((path) => path.includes(match));
    return matchesAge && matchesText;
  });

  const blocked = terminalDeliveries.filter((delivery) => {
    if (delivery.status !== "blocked_needs_human") return false;
    return !match
      || String(delivery.title || "").includes(match)
      || delivery.artifactPaths.some((path) => path.includes(match));
  });

  return { untracked, pending, blocked, terminal: terminalDeliveries, deliveries };
}
