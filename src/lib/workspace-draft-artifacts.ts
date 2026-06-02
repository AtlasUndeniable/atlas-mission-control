import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Artifact } from "./workspace-demo-events.ts";

export type WorkspaceDraftArtifactProvider = "mock" | "local-codex" | "mastra";

export interface WorkspaceDraftArtifactInput {
  prompt: string;
  content: string;
  taskTitle?: string;
  runtimeProvider: WorkspaceDraftArtifactProvider;
  runId: string;
  taskId: string;
  now?: () => Date;
  root?: string;
}

export interface WorkspaceDraftArtifactMetadata {
  id: string;
  title: string;
  type: "markdown";
  createdAt: string;
  taskTitle: string;
  runtimeProvider: WorkspaceDraftArtifactProvider;
  requestedFormat: WorkspaceDraftArtifactRequestedFormat;
  intentReason: string;
  exportLimitation?: string;
  localPath: string;
  metadataPath: string;
  userFacingName: string;
}

export interface WorkspaceDraftArtifactResult {
  artifact: Artifact;
  metadata: WorkspaceDraftArtifactMetadata;
  markdown: string;
}

export const WORKSPACE_DEMO_ARTIFACT_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-demo-artifacts";

export type WorkspaceDraftArtifactRequestedFormat =
  | "document"
  | "markdown"
  | "pdf"
  | "docx"
  | "report"
  | "handover"
  | "deck"
  | "export"
  | "file"
  | "deliverable";

export interface WorkspaceDraftArtifactIntent {
  shouldCreate: boolean;
  requestedFormat: WorkspaceDraftArtifactRequestedFormat | null;
  reason: string;
  exportLimitation?: string;
}

export function shouldCreateWorkspaceDraftArtifact(input: Pick<WorkspaceDraftArtifactInput, "prompt" | "taskTitle">): boolean {
  return detectWorkspaceDraftArtifactIntent(input).shouldCreate;
}

export function detectWorkspaceDraftArtifactIntent(
  input: Pick<WorkspaceDraftArtifactInput, "prompt" | "taskTitle">,
): WorkspaceDraftArtifactIntent {
  const text = `${input.prompt} ${input.taskTitle ?? ""}`.toLowerCase();
  if (/\bpdfs?\b|make this a pdf|as a pdf/.test(text)) {
    return limitedExportIntent("pdf", "PDF export requested.");
  }
  if (/\bdocx\b|\bword doc\b|\bword document\b|as a docx|make this a docx/.test(text)) {
    return limitedExportIntent("docx", "DOCX export requested.");
  }
  if (/\bmarkdown\b|\bmd\b/.test(text)) return createIntent("markdown", "Markdown draft requested.");
  if (/\bhandover(?:s)?\b/.test(text)) return createIntent("handover", "Handover deliverable requested.");
  if (/\bdocs?\b|\bdocument(?:s|ation)?\b/.test(text)) return createIntent("document", "Document deliverable requested.");
  if (/\breport(?:s)?\b/.test(text)) return createIntent("report", "Report deliverable requested.");
  if (/\bdeck(?:s)?\b|\bslide deck\b|\bslides\b/.test(text)) return createIntent("deck", "Deck deliverable requested.");
  if (/\bexport(?:s|ed|ing)?\b|\bpackage this\b|\bpackage it\b/.test(text)) return createIntent("export", "Export/package requested.");
  if (/\bfile(?:s)?\b|\bsave this\b|\bsave it\b|\bsave the\b/.test(text)) return createIntent("file", "File/save requested.");
  if (/\bdeliverable(?:s)?\b/.test(text)) return createIntent("deliverable", "Deliverable requested.");
  if (/\baudit(?:s)?\b|\bplaybook(?:s)?\b/.test(text)) return createIntent("document", "Document-style deliverable requested.");
  return {
    shouldCreate: false,
    requestedFormat: null,
    reason: "No explicit artifact or deliverable intent detected.",
  };
}

export async function maybeWriteWorkspaceDraftArtifact(
  input: WorkspaceDraftArtifactInput,
): Promise<WorkspaceDraftArtifactResult | null> {
  const intent = detectWorkspaceDraftArtifactIntent(input);
  if (!intent.shouldCreate) return null;
  return writeWorkspaceDraftArtifact(input, intent);
}

export async function writeWorkspaceDraftArtifact(
  input: WorkspaceDraftArtifactInput,
  intent = detectWorkspaceDraftArtifactIntent(input),
): Promise<WorkspaceDraftArtifactResult> {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const taskTitle = input.taskTitle?.trim() || "Workspace draft";
  const userFacingName = artifactTitleForIntent(taskTitle, intent);
  const id = draftArtifactId({ taskTitle, runId: input.runId, createdAt });
  const root = input.root ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const filename = `${id}.md`;
  const localPath = join(root, filename);
  const metadataPath = join(root, `${id}.metadata.json`);
  const markdown = buildDraftMarkdown({
    prompt: input.prompt,
    content: input.content,
    taskTitle,
    runtimeProvider: input.runtimeProvider,
    createdAt,
  });
  const metadata: WorkspaceDraftArtifactMetadata = {
    id,
    title: taskTitle,
    type: "markdown",
    createdAt,
    taskTitle,
    runtimeProvider: input.runtimeProvider,
    requestedFormat: intent.requestedFormat ?? "document",
    intentReason: intent.reason,
    ...(intent.exportLimitation ? { exportLimitation: intent.exportLimitation } : {}),
    localPath,
    metadataPath,
    userFacingName,
  };

  await mkdir(root, { recursive: true });
  await writeFile(localPath, markdown, "utf8");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    artifact: {
      id,
      type: "markdown",
      title: userFacingName,
      subtitle: artifactSubtitleForIntent(input.runtimeProvider, intent),
      preview: input.content.replace(/\s+/g, " ").slice(0, 160),
    },
    metadata,
    markdown,
  };
}

export function summarizeWorkspaceDraftArtifactForChat(result: WorkspaceDraftArtifactResult): string {
  const formatLabel = result.metadata.requestedFormat === "pdf"
    ? "Markdown draft saved; PDF export is not wired yet."
    : result.metadata.requestedFormat === "docx"
      ? "Markdown draft saved; DOCX export is not wired yet."
      : "Markdown draft saved.";
  const preview = cleanArtifactPreview(result.artifact.preview);
  return [
    `${formatLabel}`,
    "",
    `**${result.artifact.title}**`,
    "",
    preview ? `- Draft focus: ${preview}` : "- Draft focus: Ready for review in the artifact card.",
    "- Full draft body is in the artifact card. Preview panel comes next.",
    "- Next: review the confirmation fields before this becomes a real export.",
  ].join("\n");
}

function cleanArtifactPreview(value: string): string {
  const cleaned = value
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned
    .replace(/^I(?:'ll| will)\s+(?:update|create|draft|build|generate|prepare)\s+/i, "")
    .replace(/^I'm\s+(?:going to\s+)?(?:update|creating|drafting|building|generating|preparing)\s+/i, "")
    .replace(/\s+(?:Update|Draft|Document)$/i, "")
    .trim();
}

function createIntent(
  requestedFormat: WorkspaceDraftArtifactRequestedFormat,
  reason: string,
): WorkspaceDraftArtifactIntent {
  return {
    shouldCreate: true,
    requestedFormat,
    reason,
  };
}

function limitedExportIntent(
  requestedFormat: "pdf" | "docx",
  reason: string,
): WorkspaceDraftArtifactIntent {
  const label = requestedFormat.toUpperCase();
  return {
    shouldCreate: true,
    requestedFormat,
    reason,
    exportLimitation: `Draft saved; ${label} export is not wired yet.`,
  };
}

function artifactTitleForIntent(taskTitle: string, intent: WorkspaceDraftArtifactIntent): string {
  if (intent.requestedFormat === "pdf") return `${taskTitle} PDF draft`;
  if (intent.requestedFormat === "docx") return `${taskTitle} DOCX draft`;
  if (intent.requestedFormat === "markdown") return `${taskTitle} markdown draft`;
  if (intent.requestedFormat === "deck") return `${taskTitle} deck draft`;
  if (intent.requestedFormat === "report") return `${taskTitle} report draft`;
  return `${taskTitle} draft`;
}

function artifactSubtitleForIntent(
  runtimeProvider: WorkspaceDraftArtifactProvider,
  intent: WorkspaceDraftArtifactIntent,
): string {
  if (intent.exportLimitation) return intent.exportLimitation;
  return `Atlas / ${runtimeProvider} / markdown draft`;
}

function buildDraftMarkdown({
  prompt,
  content,
  taskTitle,
  runtimeProvider,
  createdAt,
}: {
  prompt: string;
  content: string;
  taskTitle: string;
  runtimeProvider: WorkspaceDraftArtifactProvider;
  createdAt: string;
}): string {
  return [
    `# ${taskTitle}`,
    "",
    `Created: ${createdAt}`,
    `Runtime provider: ${runtimeProvider}`,
    "Delivery: local draft only; no external send performed.",
    "",
    "## Task Prompt",
    "",
    prompt.trim(),
    "",
    "## Draft",
    "",
    content.trim(),
    "",
  ].join("\n");
}

function draftArtifactId({
  taskTitle,
  runId,
  createdAt,
}: {
  taskTitle: string;
  runId: string;
  createdAt: string;
}): string {
  const digest = createHash("sha256").update(`${taskTitle}\n${runId}\n${createdAt}`).digest("hex").slice(0, 10);
  return `artifact_demo_${slugify(taskTitle)}_${digest}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 44) || "draft";
}
