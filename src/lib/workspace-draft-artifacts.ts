import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

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
  type: "markdown" | "pdf";
  createdAt: string;
  taskTitle: string;
  runtimeProvider: WorkspaceDraftArtifactProvider;
  requestedFormat: WorkspaceDraftArtifactRequestedFormat;
  intentReason: string;
  exportLimitation?: string;
  localPath: string;
  sourceMarkdownPath?: string;
  pdfPath?: string;
  metadataPath: string;
  userFacingName: string;
  sourceWorkflow?: "atlas-rhys-ricky-handover-archive";
  sourceArtifactTitle?: string;
  sourceArchivePdfPath?: string;
  sourceArchiveMarkdownPath?: string;
}

export interface WorkspaceDraftArtifactResult {
  artifact: Artifact;
  metadata: WorkspaceDraftArtifactMetadata;
  markdown: string;
  pdf?: Buffer;
}

export const WORKSPACE_DEMO_ARTIFACT_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-demo-artifacts";

const REAL_RICKY_HANDOVER_ROOT = "/Users/atlasai/.openclaw/workspace/memory/PARA/Archives/undeniable-os/client-archives/ricky-calder/ricky-calder-coach-hire-pay-model-handover-2026-06-01";
const REAL_RICKY_HANDOVER_TITLE = "Ricky Calder Coach Hire Pay Model Handover";
const REAL_RICKY_HANDOVER_PDF_PATH = join(REAL_RICKY_HANDOVER_ROOT, "ricky-calder-coach-hire-pay-model-handover-2026-06-01.pdf");
const REAL_RICKY_HANDOVER_MARKDOWN_PATH = join(REAL_RICKY_HANDOVER_ROOT, "ricky-calder-coach-hire-pay-model-handover-2026-06-01.md");
const REAL_PDF_WORKFLOW_BLOCKER = "Internal markdown draft saved; PDF rendering is blocked until the real Atlas/Rhys document workflow is wired for this artifact.";

export interface WorkspaceDraftArtifactPreview {
  id: string;
  title: string;
  type: "markdown" | "pdf";
  createdAt: string;
  taskTitle: string;
  runtimeProvider: WorkspaceDraftArtifactProvider;
  requestedFormat: WorkspaceDraftArtifactRequestedFormat;
  markdown?: string;
  pdf?: {
    url: string;
    downloadUrl: string;
    filename: string;
    byteLength: number;
  };
}

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
  const text = input.prompt.toLowerCase();
  if (hasExplicitPdfArtifactIntent(text)) {
    return createIntent("pdf", "PDF export requested.");
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

function hasExplicitPdfArtifactIntent(text: string): boolean {
  return (
    /\bpdfs?\b/.test(text) ||
    /\b(?:return|send|bring|give|provide)\s+(?:this|it|that|the\s+\w+)?\s*(?:back\s+)?as\s+a\s+pdf\b/.test(text) ||
    /\bdownloadable\s+pdf\b/.test(text) ||
    /\bexport\s+(?:this|it|that|the\s+\w+)?\s*(?:to|as)\s+(?:a\s+)?pdf\b/.test(text) ||
    /\bmake\s+(?:this|it|that)?\s*(?:a\s+)?pdf\b/.test(text)
  );
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
  const realPdfSource = await resolveRealWorkspacePdfSource(input, intent);
  const pdfRequested = intent.requestedFormat === "pdf";
  const shouldWritePdf = Boolean(realPdfSource);
  const exportLimitation = intent.exportLimitation ?? (pdfRequested && !realPdfSource ? REAL_PDF_WORKFLOW_BLOCKER : undefined);
  const userFacingName = realPdfSource?.userFacingName ?? artifactTitleForIntent(taskTitle, intent);
  const id = draftArtifactId({ taskTitle, runId: input.runId, createdAt });
  const root = input.root ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const markdownPath = join(root, `${id}.md`);
  const pdfPath = join(root, `${id}.pdf`);
  const metadataPath = join(root, `${id}.metadata.json`);
  const markdown = buildDraftMarkdown({
    prompt: input.prompt,
    content: input.content,
    taskTitle,
    runtimeProvider: input.runtimeProvider,
    createdAt,
  });
  const pdf = realPdfSource ? await readFile(realPdfSource.pdfPath) : null;
  const metadata: WorkspaceDraftArtifactMetadata = {
    id,
    title: taskTitle,
    type: shouldWritePdf ? "pdf" : "markdown",
    createdAt,
    taskTitle,
    runtimeProvider: input.runtimeProvider,
    requestedFormat: intent.requestedFormat ?? "document",
    intentReason: intent.reason,
    ...(exportLimitation ? { exportLimitation } : {}),
    localPath: shouldWritePdf ? pdfPath : markdownPath,
    ...(shouldWritePdf ? { sourceMarkdownPath: markdownPath, pdfPath } : {}),
    metadataPath,
    userFacingName,
    ...(realPdfSource
      ? {
          sourceWorkflow: realPdfSource.sourceWorkflow,
          sourceArtifactTitle: realPdfSource.sourceArtifactTitle,
          sourceArchivePdfPath: realPdfSource.pdfPath,
          sourceArchiveMarkdownPath: realPdfSource.markdownPath,
        }
      : {}),
  };

  await mkdir(root, { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  if (pdf) await writeFile(pdfPath, pdf);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    artifact: {
      id,
      type: shouldWritePdf ? "pdf" : "markdown",
      title: userFacingName,
      subtitle: artifactSubtitleForIntent(input.runtimeProvider, intent, exportLimitation, realPdfSource),
      preview: artifactPreviewForResult(input.content, realPdfSource),
    },
    metadata,
    markdown,
    ...(pdf ? { pdf } : {}),
  };
}

export function summarizeWorkspaceDraftArtifactForChat(result: WorkspaceDraftArtifactResult): string {
  const formatLabel = result.metadata.type === "pdf"
    ? "PDF draft saved."
    : result.metadata.requestedFormat === "docx"
      ? "Markdown draft saved; DOCX export is not wired yet."
      : result.metadata.requestedFormat === "pdf" && result.metadata.exportLimitation
        ? "Internal markdown draft saved; PDF rendering is blocked for this request."
      : "Markdown draft saved.";
  const openLine = result.metadata.type === "pdf"
    ? "- Open the artifact card to preview and download the PDF."
    : "- Open the artifact card to preview the full draft.";
  const sourceLine = result.metadata.sourceWorkflow
    ? "- Source: existing Atlas/Rhys Ricky handover package; local copy only."
    : null;
  const preview = cleanArtifactPreview(result.artifact.preview);
  return [
    `${formatLabel}`,
    "",
    `**${result.artifact.title}**`,
    "",
    preview ? `- Draft focus: ${preview}` : "- Draft focus: Ready for review in the artifact card.",
    ...(sourceLine ? [sourceLine] : []),
    openLine,
    "- Delivery: local artifact only; no external send performed.",
  ].join("\n");
}

export async function readWorkspaceDraftArtifactPreview(
  id: string,
  options: { root?: string } = {},
): Promise<WorkspaceDraftArtifactPreview | null> {
  if (!isSafeWorkspaceDraftArtifactId(id)) {
    throw new Error("Unsafe artifact id.");
  }

  const root = options.root ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const markdownPath = safeWorkspaceDraftArtifactPath(root, `${id}.md`);
  const pdfPath = safeWorkspaceDraftArtifactPath(root, `${id}.pdf`);
  const metadataPath = safeWorkspaceDraftArtifactPath(root, `${id}.metadata.json`);
  try {
    const metadataText = await readFile(metadataPath, "utf8");
    const metadata = parseWorkspaceDraftArtifactMetadata(metadataText, id);
    if (metadata.type === "pdf") {
      if (!isSupportedWorkspacePdfArtifact(metadata)) {
        const markdown = await readFile(markdownPath, "utf8");
        return {
          id: metadata.id,
          title: metadata.userFacingName || metadata.title,
          type: "markdown",
          createdAt: metadata.createdAt,
          taskTitle: metadata.taskTitle,
          runtimeProvider: metadata.runtimeProvider,
          requestedFormat: metadata.requestedFormat,
          markdown,
        };
      }
      const [markdown, pdf] = await Promise.all([
        readFile(markdownPath, "utf8").catch(() => ""),
        readFile(pdfPath),
      ]);
      return {
        id: metadata.id,
        title: metadata.userFacingName || metadata.title,
        type: metadata.type,
        createdAt: metadata.createdAt,
        taskTitle: metadata.taskTitle,
        runtimeProvider: metadata.runtimeProvider,
        requestedFormat: metadata.requestedFormat,
        ...(markdown ? { markdown } : {}),
        pdf: {
          url: `/api/workspace-demo/artifacts/${encodeURIComponent(metadata.id)}?format=pdf`,
          downloadUrl: `/api/workspace-demo/artifacts/${encodeURIComponent(metadata.id)}?format=pdf&download=1`,
          filename: `${slugify(metadata.userFacingName || metadata.title)}.pdf`,
          byteLength: pdf.byteLength,
        },
      };
    }
    const markdown = await readFile(markdownPath, "utf8");
    return {
      id: metadata.id,
      title: metadata.userFacingName || metadata.title,
      type: metadata.type,
      createdAt: metadata.createdAt,
      taskTitle: metadata.taskTitle,
      runtimeProvider: metadata.runtimeProvider,
      requestedFormat: metadata.requestedFormat,
      markdown,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isSafeWorkspaceDraftArtifactId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id);
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

function artifactPreviewForResult(content: string, realPdfSource: RealWorkspacePdfSource | null): string {
  if (realPdfSource) {
    return "Existing Atlas/Rhys Ricky handover package copied into Workspace. Review the PDF before any external use.";
  }
  return content.replace(/\s+/g, " ").slice(0, 160);
}

function safeWorkspaceDraftArtifactPath(root: string, filename: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, filename);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("Artifact path escaped controlled root.");
  }
  return resolvedPath;
}

function parseWorkspaceDraftArtifactMetadata(value: string, expectedId: string): WorkspaceDraftArtifactMetadata {
  const parsed = JSON.parse(value) as Partial<WorkspaceDraftArtifactMetadata>;
  if (!parsed || typeof parsed !== "object") throw new Error("Artifact metadata is invalid.");
  if (parsed.id !== expectedId) throw new Error("Artifact metadata id mismatch.");
  if (parsed.type !== "markdown" && parsed.type !== "pdf") throw new Error("Only markdown and PDF draft artifacts can be previewed.");
  if (typeof parsed.title !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.taskTitle !== "string") {
    throw new Error("Artifact metadata is incomplete.");
  }
  if (parsed.runtimeProvider !== "mock" && parsed.runtimeProvider !== "local-codex" && parsed.runtimeProvider !== "mastra") {
    throw new Error("Artifact runtime provider is invalid.");
  }
  if (!isWorkspaceDraftArtifactRequestedFormat(parsed.requestedFormat)) {
    throw new Error("Artifact requested format is invalid.");
  }
  return parsed as WorkspaceDraftArtifactMetadata;
}

function isWorkspaceDraftArtifactRequestedFormat(value: unknown): value is WorkspaceDraftArtifactRequestedFormat {
  return (
    value === "document" ||
    value === "markdown" ||
    value === "pdf" ||
    value === "docx" ||
    value === "report" ||
    value === "handover" ||
    value === "deck" ||
    value === "export" ||
    value === "file" ||
    value === "deliverable"
  );
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
  const normalizedTaskTitle = taskTitle.trim().toLowerCase();
  if (intent.requestedFormat === "pdf" && normalizedTaskTitle === "atlas workspace session") return "Undeniable OS workspace PDF draft";
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
  exportLimitation?: string,
  realPdfSource?: RealWorkspacePdfSource | null,
): string {
  if (realPdfSource) return `Atlas / ${runtimeProvider} / Ricky handover PDF`;
  if (exportLimitation) return exportLimitation;
  if (intent.requestedFormat === "pdf") return `Atlas / ${runtimeProvider} / PDF draft`;
  return `Atlas / ${runtimeProvider} / markdown draft`;
}

interface RealWorkspacePdfSource {
  sourceWorkflow: "atlas-rhys-ricky-handover-archive";
  sourceArtifactTitle: string;
  userFacingName: string;
  pdfPath: string;
  markdownPath: string;
}

async function resolveRealWorkspacePdfSource(
  input: WorkspaceDraftArtifactInput,
  intent: WorkspaceDraftArtifactIntent,
): Promise<RealWorkspacePdfSource | null> {
  if (intent.requestedFormat !== "pdf") return null;
  if (!isRickyPayHandoverRequest(input)) return null;
  try {
    const pdf = await readFile(REAL_RICKY_HANDOVER_PDF_PATH);
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") return null;
    return {
      sourceWorkflow: "atlas-rhys-ricky-handover-archive",
      sourceArtifactTitle: REAL_RICKY_HANDOVER_TITLE,
      userFacingName: REAL_RICKY_HANDOVER_TITLE,
      pdfPath: REAL_RICKY_HANDOVER_PDF_PATH,
      markdownPath: REAL_RICKY_HANDOVER_MARKDOWN_PATH,
    };
  } catch {
    return null;
  }
}

function isRickyPayHandoverRequest(input: Pick<WorkspaceDraftArtifactInput, "prompt" | "taskTitle">): boolean {
  const text = `${input.prompt} ${input.taskTitle ?? ""}`.toLowerCase();
  return (
    /\bricky\b|\bcalder\b/.test(text) &&
    /\bpay\b|\bcoach\s+hire\b|\bhandover\b|\bpay\s+structure\b|\bpay\s+model\b/.test(text)
  );
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

export async function readWorkspaceDraftArtifactPdf(
  id: string,
  options: { root?: string } = {},
): Promise<{ bytes: Buffer; filename: string } | null> {
  if (!isSafeWorkspaceDraftArtifactId(id)) {
    throw new Error("Unsafe artifact id.");
  }

  const root = options.root ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const metadataPath = safeWorkspaceDraftArtifactPath(root, `${id}.metadata.json`);
  const pdfPath = safeWorkspaceDraftArtifactPath(root, `${id}.pdf`);
  try {
    const metadata = parseWorkspaceDraftArtifactMetadata(await readFile(metadataPath, "utf8"), id);
    if (metadata.type !== "pdf" || !isSupportedWorkspacePdfArtifact(metadata)) return null;
    return {
      bytes: await readFile(pdfPath),
      filename: `${slugify(metadata.userFacingName || metadata.title)}.pdf`,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isSupportedWorkspacePdfArtifact(metadata: WorkspaceDraftArtifactMetadata): boolean {
  return metadata.sourceWorkflow === "atlas-rhys-ricky-handover-archive";
}
