import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { recordDeliveryState } from "./artifact-delivery.mjs";

export const RHYS_USER_ID = "U068FRX5423";
export const RHYS_DM_CHANNEL_ID = "D0AM2R3H6SE";

export const ALLOWED_ARTIFACT_ROOTS = [
  "/Users/atlasai/.openclaw/workspace/exports",
  "/Users/atlasai/.openclaw/workspace/memory/PARA/Archives",
];

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".md",
  ".html",
  ".png",
]);

function isInsideRoot(filePath, root) {
  const normalizedPath = resolve(filePath);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function selectPreferredArtifactPath(artifactPaths = []) {
  const paths = Array.isArray(artifactPaths) ? artifactPaths.filter(Boolean) : [];
  return paths.find((path) => extname(path).toLowerCase() === ".pdf")
    || paths.find((path) => [".docx", ".xlsx", ".pptx"].includes(extname(path).toLowerCase()))
    || paths[0]
    || null;
}

export function sanitizeSlackArtifactText(text = "") {
  return String(text || "")
    .replace(/\/Users\/atlasai\/[^\s)]+/g, "the attached file")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validateRhysDmArtifactRequest({
  artifactPath,
  sourceChannel,
  requestedBy,
  asRhys = false,
  allowedRoots = ALLOWED_ARTIFACT_ROOTS,
} = {}) {
  if (asRhys) throw new Error("send-as-Rhys is not allowed for artifact delivery");
  if (requestedBy !== RHYS_USER_ID) throw new Error("artifact delivery is restricted to Rhys requests");
  if (sourceChannel !== RHYS_DM_CHANNEL_ID) throw new Error("artifact delivery is restricted to Rhys DM only");
  if (!artifactPath) throw new Error("artifactPath is required");

  const normalized = resolve(String(artifactPath));
  if (!allowedRoots.some((root) => isInsideRoot(normalized, root))) {
    throw new Error("artifact path is outside approved artifact roots");
  }
  const ext = extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`artifact extension is not allowed: ${ext || "none"}`);
  }
  if (!existsSync(normalized)) throw new Error("artifact file does not exist");
  const stat = statSync(normalized);
  if (!stat.isFile()) throw new Error("artifact path is not a file");
  if (stat.size <= 0) throw new Error("artifact file is empty");
  readFileSync(normalized);
  return { artifactPath: normalized, filename: basename(normalized), size: stat.size, ext };
}

async function defaultSlackClient(method, body, { token, form = false } = {}) {
  if (!token) throw new Error("Slack bot token is unavailable");
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : { "Content-Type": "application/json; charset=utf-8" }),
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.error || "unknown_error"}`);
  return data;
}

async function resolveUploadedMessageTs({ slackClient, channelId, fileId, token }) {
  try {
    const history = await slackClient("conversations.history", { channel: channelId, limit: 10 }, { token });
    const match = (history.messages || []).find((msg) => (msg.files || []).some((file) => file.id === fileId));
    return match?.ts || null;
  } catch {
    return null;
  }
}

export async function sendRhysDmArtifact({
  artifactPath,
  sourceChannel,
  requestedBy,
  deliveryId,
  title,
  message,
  token,
  asRhys = false,
  dryRun = false,
  slackClient = defaultSlackClient,
  uploadFetch = fetch,
  allowedRoots = ALLOWED_ARTIFACT_ROOTS,
  ledgerOptions = {},
} = {}) {
  const artifact = validateRhysDmArtifactRequest({
    artifactPath,
    sourceChannel,
    requestedBy,
    asRhys,
    allowedRoots,
  });
  const safeTitle = String(title || artifact.filename)
    .replace(/[^\w .()_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || artifact.filename;
  const safeMessage = sanitizeSlackArtifactText(message || "Done. I attached the file here.");
  if (!safeMessage) throw new Error("user-facing Slack message is empty after sanitization");
  if (/\/Users\/atlasai\//.test(safeMessage)) throw new Error("user-facing Slack message contains an internal path");

  if (dryRun) {
    const result = {
      ok: true,
      dryRun: true,
      channelId: RHYS_DM_CHANNEL_ID,
      fileId: "mock-file-id",
      messageTs: "mock-message-ts",
      filename: artifact.filename,
      title: safeTitle,
      text: safeMessage,
    };
    if (deliveryId) {
      recordDeliveryState({
        deliveryId,
        status: "delivered",
        reason: "Mock Rhys DM artifact delivery completed in dry-run mode.",
        channelId: result.channelId,
        messageTs: result.messageTs,
        fileId: result.fileId,
        metadata: { dryRun: true, filename: artifact.filename },
      }, ledgerOptions);
    }
    return result;
  }

  const opened = await slackClient("conversations.open", { users: RHYS_USER_ID, return_im: true }, { token });
  const channelId = opened.channel?.id;
  if (channelId !== RHYS_DM_CHANNEL_ID) {
    throw new Error("resolved Slack channel did not match Rhys DM");
  }
  if (opened.channel?.user && opened.channel.user !== RHYS_USER_ID) {
    throw new Error("resolved Slack IM user did not match Rhys");
  }

  const upload = await slackClient("files.getUploadURLExternal", {
    filename: artifact.filename,
    length: String(artifact.size),
  }, { token, form: true });
  const fileId = upload.file_id;
  if (!fileId || !upload.upload_url) throw new Error("Slack upload URL response was incomplete");

  const form = new FormData();
  form.append("file", new Blob([readFileSync(artifact.artifactPath)]), artifact.filename);
  const uploadResp = await uploadFetch(upload.upload_url, { method: "POST", body: form });
  if (!uploadResp.ok) throw new Error(`Slack upload URL failed: HTTP ${uploadResp.status}`);

  const completed = await slackClient("files.completeUploadExternal", {
    files: [{ id: fileId, title: safeTitle }],
    channel_id: RHYS_DM_CHANNEL_ID,
    initial_comment: safeMessage,
  }, { token });
  const messageTs = completed.files?.[0]?.shares?.private?.[RHYS_DM_CHANNEL_ID]?.[0]?.ts
    || completed.file?.shares?.private?.[RHYS_DM_CHANNEL_ID]?.[0]?.ts
    || await resolveUploadedMessageTs({ slackClient, channelId: RHYS_DM_CHANNEL_ID, fileId, token });

  if (deliveryId) {
    recordDeliveryState({
      deliveryId,
      status: "delivered",
      reason: "Approved artifact delivered to Rhys DM via narrow artifact helper.",
      channelId: RHYS_DM_CHANNEL_ID,
      messageTs,
      fileId,
      metadata: { filename: artifact.filename, dryRun: false },
    }, ledgerOptions);
  }

  return {
    ok: true,
    dryRun: false,
    channelId: RHYS_DM_CHANNEL_ID,
    fileId,
    messageTs,
    filename: artifact.filename,
    title: safeTitle,
  };
}
