import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { Artifact } from "./workspace-demo-events.ts";
import type {
  WorkspaceRealArtifactFormat,
  WorkspaceRealArtifactRenderer,
} from "./workspace-real-artifact-workflow.ts";

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
  realArtifactRenderer?: WorkspaceRealArtifactRenderer;
}

export interface WorkspaceDraftArtifactMetadata {
  id: string;
  title: string;
  type: "markdown" | "pdf" | "docx";
  createdAt: string;
  taskTitle: string;
  runtimeProvider: WorkspaceDraftArtifactProvider;
  requestedFormat: WorkspaceDraftArtifactRequestedFormat;
  intentReason: string;
  exportLimitation?: string;
  localPath: string;
  sourceMarkdownPath?: string;
  pdfPath?: string;
  docxPath?: string;
  metadataPath: string;
  userFacingName: string;
  sourceWorkflow?: "atlas-rhys-ricky-handover-archive" | typeof ATLAS_DOCUMENT_WORKFLOW_ID;
  sourceArtifactTitle?: string;
  sourceArchivePdfPath?: string;
  sourceArchiveMarkdownPath?: string;
  sourceRenderMarkdownPath?: string;
  sourceExportPdfPath?: string;
  sourceExportDocxPath?: string;
}

export interface WorkspaceDraftArtifactResult {
  artifact: Artifact;
  metadata: WorkspaceDraftArtifactMetadata;
  markdown: string;
  pdf?: Buffer;
  docx?: Buffer;
}

export const WORKSPACE_DEMO_ARTIFACT_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-demo-artifacts";
const ATLAS_DOCUMENT_WORKFLOW_ID = "atlas-undeniable-doc-converter";

const REAL_RICKY_HANDOVER_ROOT = "/Users/atlasai/.openclaw/workspace/memory/PARA/Archives/undeniable-os/client-archives/ricky-calder/ricky-calder-coach-hire-pay-model-handover-2026-06-01";
const REAL_RICKY_HANDOVER_TITLE = "Ricky Calder Coach Hire Pay Model Handover";
const REAL_RICKY_HANDOVER_PDF_PATH = join(REAL_RICKY_HANDOVER_ROOT, "ricky-calder-coach-hire-pay-model-handover-2026-06-01.pdf");
const REAL_RICKY_HANDOVER_MARKDOWN_PATH = join(REAL_RICKY_HANDOVER_ROOT, "ricky-calder-coach-hire-pay-model-handover-2026-06-01.md");
const REAL_PDF_WORKFLOW_BLOCKER = "Internal markdown draft saved; PDF rendering is blocked until the real Atlas/Rhys document workflow is wired for this artifact.";

export interface WorkspaceDraftArtifactPreview {
  id: string;
  title: string;
  type: "markdown" | "pdf" | "docx";
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
  docx?: {
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
  const text = normalizeIntentText(input.prompt);
  if (hasExplicitPdfArtifactIntent(text)) {
    return createIntent("pdf", "PDF export requested.");
  }
  if (hasExplicitDocxArtifactIntent(text)) {
    return limitedExportIntent("docx", "DOCX export requested.");
  }
  if (hasExplicitMarkdownArtifactIntent(text)) return createIntent("markdown", "Markdown draft requested.");
  if (hasExplicitNamedDeliverableIntent(text, /\bhandover(?:s)?\b/)) return createIntent("handover", "Handover deliverable requested.");
  if (hasExplicitNamedDeliverableIntent(text, /\bdocs?\b|\bdocument(?:s|ation)?\b/)) return createIntent("document", "Document deliverable requested.");
  if (hasExplicitNamedDeliverableIntent(text, /\breport(?:s)?\b/)) return createIntent("report", "Report deliverable requested.");
  if (hasExplicitNamedDeliverableIntent(text, /\bdeck(?:s)?\b|\bslide deck\b|\bslides\b/)) return createIntent("deck", "Deck deliverable requested.");
  if (hasExplicitExportIntent(text)) return createIntent("export", "Export/package requested.");
  if (hasExplicitSaveOrFileIntent(text)) return createIntent("file", "File/save requested.");
  if (hasExplicitNamedDeliverableIntent(text, /\bdeliverable(?:s)?\b/)) return createIntent("deliverable", "Deliverable requested.");
  if (hasExplicitNamedDeliverableIntent(text, /\baudit(?:s)?\b|\bplaybook(?:s)?\b/)) return createIntent("document", "Document-style deliverable requested.");
  return {
    shouldCreate: false,
    requestedFormat: null,
    reason: "No explicit artifact or deliverable intent detected.",
  };
}

function normalizeIntentText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasExplicitPdfArtifactIntent(text: string): boolean {
  return (
    /\b(?:do|redo|render|create|draft|build|generate|write|prepare|save|download|produce)\b.{0,80}\bpdfs?\b/.test(text) ||
    /\b(?:return|send|bring|give|provide)\s+(?:this|it|that|the\s+\w+)?\s*(?:back\s+)?as\s+a\s+pdf\b/.test(text) ||
    /\bdownloadable\s+pdf\b/.test(text) ||
    /\bexport\s+(?:this|it|that|the\s+\w+)?\s*(?:to|as)\s+(?:a\s+)?pdf\b/.test(text) ||
    /\bsave\s+(?:this|it|that|the\s+\w+)?\s*(?:to|as)\s+(?:a\s+)?pdf\b/.test(text) ||
    /\bmake\s+(?:this|it|that)?\s*(?:a\s+)?pdf\b/.test(text)
  );
}

function hasExplicitDocxArtifactIntent(text: string): boolean {
  return /\b(?:render|create|draft|build|generate|write|prepare|save|download|produce)\b.{0,80}\b(?:docx|word doc|word document)\b/.test(text)
    || /\b(?:return|send|bring|give|provide|export|save)\s+(?:this|it|that|the\s+\w+)?\s*(?:back\s+)?(?:as|to)\s+(?:a\s+)?(?:docx|word doc|word document)\b/.test(text)
    || /\bturn\s+(?:this|it|that)\s+into\s+(?:a\s+)?(?:docx|word doc|word document)\b/.test(text)
    || /\bmake\s+(?:this|it|that)\s+(?:a\s+)?(?:docx|word doc|word document)\b/.test(text);
}

function hasExplicitMarkdownArtifactIntent(text: string): boolean {
  return /\b(?:render|create|draft|build|generate|write|prepare|save|download|produce)\b.{0,80}\b(?:markdown|md)\b/.test(text)
    || /\b(?:return|send|bring|give|provide|export|save)\s+(?:this|it|that|the\s+\w+)?\s*(?:back\s+)?(?:as|to)\s+(?:a\s+)?(?:markdown|md)\b/.test(text)
    || /\bturn\s+(?:this|it|that)\s+into\s+(?:a\s+)?(?:markdown|md)\b/.test(text)
    || /\bmake\s+(?:this|it|that)\s+(?:a\s+)?(?:markdown|md)\b/.test(text);
}

function hasExplicitNamedDeliverableIntent(text: string, nounPattern: RegExp): boolean {
  const noun = nounPattern.source;
  return new RegExp(`\\b(?:create|draft|build|generate|write|prepare|render|produce)\\b.{0,80}(?:${noun})`).test(text)
    || new RegExp(`(?:${noun}).{0,80}\\b(?:create|draft|build|generate|write|prepare|render|save|export|produce)\\b`).test(text)
    || /\bturn\s+(?:this|it|that)\s+into\b/.test(text) && nounPattern.test(text)
    || /\bmake\s+(?:this|it|that|a|an|the)\b.{0,80}/.test(text) && nounPattern.test(text)
    || /\bupdate\b.{0,80}/.test(text) && nounPattern.test(text);
}

function hasExplicitExportIntent(text: string): boolean {
  return /\bexport(?:s|ed|ing)?\b/.test(text)
    || /\bpackage\s+(?:this|it|that|the\s+\w+)\b/.test(text);
}

function hasExplicitSaveOrFileIntent(text: string): boolean {
  return /\bsave\s+(?:this|it|that|the\s+\w+)/.test(text)
    || /\b(?:create|draft|build|generate|write|prepare|render|produce)\b.{0,80}\bfile(?:s)?\b/.test(text);
}

export async function maybeWriteWorkspaceDraftArtifact(
  input: WorkspaceDraftArtifactInput,
): Promise<WorkspaceDraftArtifactResult | null> {
  const intent = detectWorkspaceDraftArtifactIntent(input);
  if (!intent.shouldCreate) return null;
  const canRenderRealWorkflow = canUseAtlasDocumentWorkflow(input, intent);
  if (
    (intent.requestedFormat === "pdf" || intent.requestedFormat === "docx") &&
    !canRenderRealWorkflow &&
    !(await resolveRealWorkspacePdfSource(input, intent))
  ) {
    return null;
  }
  return writeWorkspaceDraftArtifact(input, intent);
}

export async function writeWorkspaceDraftArtifact(
  input: WorkspaceDraftArtifactInput,
  intent = detectWorkspaceDraftArtifactIntent(input),
): Promise<WorkspaceDraftArtifactResult> {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const taskTitle = input.taskTitle?.trim() || "Workspace draft";
  const realPdfSource = await resolveRealWorkspacePdfSource(input, intent);
  const realWorkflow = !realPdfSource && canUseAtlasDocumentWorkflow(input, intent)
    ? await renderRealAtlasDocumentWorkflow(input, intent, { createdAt, taskTitle })
    : null;
  const pdfRequested = intent.requestedFormat === "pdf";
  const docxRequested = intent.requestedFormat === "docx";
  const shouldWritePdf = Boolean(realPdfSource || realWorkflow?.pdf);
  const shouldWriteDocx = Boolean(realWorkflow?.docx && !shouldWritePdf);
  const artifactType = shouldWritePdf ? "pdf" : shouldWriteDocx ? "docx" : "markdown";
  const exportLimitation = realWorkflow
    ? undefined
    : intent.exportLimitation ?? ((pdfRequested || docxRequested) && !realPdfSource ? REAL_PDF_WORKFLOW_BLOCKER : undefined);
  const userFacingName = realPdfSource?.userFacingName
    ?? (realWorkflow ? realWorkflow.userFacingName : artifactTitleForIntent(taskTitle, intent));
  const id = draftArtifactId({ taskTitle, runId: input.runId, createdAt });
  const root = input.root ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const markdownPath = join(root, `${id}.md`);
  const pdfPath = join(root, `${id}.pdf`);
  const docxPath = join(root, `${id}.docx`);
  const metadataPath = join(root, `${id}.metadata.json`);
  const markdown = realWorkflow
    ? realWorkflow.markdown
    : buildDraftMarkdown({
        prompt: input.prompt,
        content: input.content,
        taskTitle,
        runtimeProvider: input.runtimeProvider,
        createdAt,
      });
  const pdf = realPdfSource ? await readFile(realPdfSource.pdfPath) : null;
  const finalPdf = realWorkflow?.pdf ?? pdf;
  const finalDocx = realWorkflow?.docx ?? null;
  const metadata: WorkspaceDraftArtifactMetadata = {
    id,
    title: taskTitle,
    type: artifactType,
    createdAt,
    taskTitle,
    runtimeProvider: input.runtimeProvider,
    requestedFormat: intent.requestedFormat ?? "document",
    intentReason: intent.reason,
    ...(exportLimitation ? { exportLimitation } : {}),
    localPath: shouldWritePdf ? pdfPath : shouldWriteDocx ? docxPath : markdownPath,
    ...(shouldWritePdf || shouldWriteDocx ? { sourceMarkdownPath: markdownPath } : {}),
    ...(shouldWritePdf ? { pdfPath } : {}),
    ...(finalDocx ? { docxPath } : {}),
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
    ...(realWorkflow
      ? {
          sourceWorkflow: ATLAS_DOCUMENT_WORKFLOW_ID,
          sourceArtifactTitle: realWorkflow.userFacingName,
          sourceRenderMarkdownPath: realWorkflow.sourceMarkdownPath,
          ...(realWorkflow.sourceExportPdfPath ? { sourceExportPdfPath: realWorkflow.sourceExportPdfPath } : {}),
          ...(realWorkflow.sourceExportDocxPath ? { sourceExportDocxPath: realWorkflow.sourceExportDocxPath } : {}),
        }
      : {}),
  };

  await mkdir(root, { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  if (finalPdf) await writeFile(pdfPath, finalPdf);
  if (finalDocx) await writeFile(docxPath, finalDocx);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return {
    artifact: {
      id,
      type: artifactType,
      title: userFacingName,
      subtitle: artifactSubtitleForIntent(input.runtimeProvider, intent, exportLimitation, realPdfSource, realWorkflow),
      preview: artifactPreviewForResult(input.content, realPdfSource, realWorkflow),
    },
    metadata,
    markdown,
    ...(finalPdf ? { pdf: finalPdf } : {}),
    ...(finalDocx ? { docx: finalDocx } : {}),
  };
}

export function summarizeWorkspaceDraftArtifactForChat(result: WorkspaceDraftArtifactResult): string {
  const formatLabel = result.metadata.type === "pdf"
    ? "PDF draft saved."
    : result.metadata.type === "docx"
      ? "DOCX draft saved."
    : result.metadata.requestedFormat === "docx"
      ? "Markdown draft saved; DOCX export is not wired yet."
      : result.metadata.requestedFormat === "pdf" && result.metadata.exportLimitation
        ? "Internal markdown draft saved; PDF rendering is blocked for this request."
      : "Markdown draft saved.";
  const openLine = result.metadata.type === "pdf"
    ? "- Open the artifact card to preview and download the PDF."
    : result.metadata.type === "docx"
      ? "- Open the artifact card to download the DOCX and inspect the source preview."
    : "- Open the artifact card to preview the full draft.";
  const sourceLine = result.metadata.sourceWorkflow
    ? result.metadata.sourceWorkflow === ATLAS_DOCUMENT_WORKFLOW_ID
      ? "- Source: real Atlas/Undeniable document converter; local copy only."
      : "- Source: existing Atlas/Rhys Ricky handover package; local copy only."
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
    if (metadata.type === "pdf" || metadata.type === "docx") {
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
      const docxPath = safeWorkspaceDraftArtifactPath(root, `${id}.docx`);
      const [markdown, pdf, docx] = await Promise.all([
        readFile(markdownPath, "utf8").catch(() => ""),
        metadata.pdfPath ? readFile(pdfPath).catch(() => null) : Promise.resolve(null),
        metadata.docxPath ? readFile(docxPath).catch(() => null) : Promise.resolve(null),
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
        ...(pdf ? {
          pdf: {
            url: `/api/workspace-demo/artifacts/${encodeURIComponent(metadata.id)}?format=pdf`,
            downloadUrl: `/api/workspace-demo/artifacts/${encodeURIComponent(metadata.id)}?format=pdf&download=1`,
            filename: `${slugify(metadata.userFacingName || metadata.title)}.pdf`,
            byteLength: pdf.byteLength,
          },
        } : {}),
        ...(docx ? {
          docx: {
            downloadUrl: `/api/workspace-demo/artifacts/${encodeURIComponent(metadata.id)}?format=docx&download=1`,
            filename: `${slugify(metadata.userFacingName || metadata.title)}.docx`,
            byteLength: docx.byteLength,
          },
        } : {}),
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

function artifactPreviewForResult(
  content: string,
  realPdfSource: RealWorkspacePdfSource | null,
  realWorkflow?: RealAtlasDocumentWorkflowResult | null,
): string {
  if (realWorkflow) {
    return "Real Atlas/Undeniable document workflow rendered this artifact locally. Review before any external use.";
  }
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
  if (parsed.type !== "markdown" && parsed.type !== "pdf" && parsed.type !== "docx") {
    throw new Error("Only markdown, PDF, and DOCX draft artifacts can be previewed.");
  }
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
  realWorkflow?: RealAtlasDocumentWorkflowResult | null,
): string {
  if (realWorkflow) return `Atlas / ${runtimeProvider} / real document workflow`;
  if (realPdfSource) return `Atlas / ${runtimeProvider} / Ricky handover PDF`;
  if (exportLimitation) return exportLimitation;
  if (intent.requestedFormat === "pdf") return `Atlas / ${runtimeProvider} / PDF draft`;
  if (intent.requestedFormat === "docx") return `Atlas / ${runtimeProvider} / DOCX draft`;
  return `Atlas / ${runtimeProvider} / markdown draft`;
}

interface RealWorkspacePdfSource {
  sourceWorkflow: "atlas-rhys-ricky-handover-archive";
  sourceArtifactTitle: string;
  userFacingName: string;
  pdfPath: string;
  markdownPath: string;
}

interface RealAtlasDocumentWorkflowResult {
  userFacingName: string;
  markdown: string;
  sourceMarkdownPath: string;
  pdf: Buffer | null;
  docx: Buffer | null;
  sourceExportPdfPath?: string;
  sourceExportDocxPath?: string;
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

function canUseAtlasDocumentWorkflow(
  input: WorkspaceDraftArtifactInput,
  intent: WorkspaceDraftArtifactIntent,
): boolean {
  return (
    (intent.requestedFormat === "pdf" || intent.requestedFormat === "docx") &&
    hasExplicitAtlasDocumentWorkflowSelectionLocal(input)
  );
}

async function renderRealAtlasDocumentWorkflow(
  input: WorkspaceDraftArtifactInput,
  intent: WorkspaceDraftArtifactIntent,
  context: { createdAt: string; taskTitle: string },
): Promise<RealAtlasDocumentWorkflowResult> {
  const markdown = buildProductionMarkdownSource({
    taskTitle: context.taskTitle,
    content: input.content,
  });
  const formats: WorkspaceRealArtifactFormat[] = intent.requestedFormat === "docx"
    ? ["docx"]
    : ["pdf", "docx"];
  const renderer = input.realArtifactRenderer ?? (await import("./workspace-real-artifact-workflow.ts")).renderAtlasDocumentArtifact;
  const result = await renderer({
    markdown,
    title: context.taskTitle,
    outputStem: realArtifactOutputStemLocal({
      taskTitle: context.taskTitle,
      runId: input.runId,
      createdAt: context.createdAt,
    }),
    formats,
  });
  const pdf = result.outputs.find((output) => output.format === "pdf");
  const docx = result.outputs.find((output) => output.format === "docx");
  return {
    userFacingName: `${context.taskTitle} ${intent.requestedFormat === "docx" ? "DOCX" : "PDF"}`,
    markdown,
    sourceMarkdownPath: result.sourceMarkdownPath,
    pdf: pdf?.bytes ?? null,
    docx: docx?.bytes ?? null,
    ...(pdf?.exportPath ? { sourceExportPdfPath: pdf.exportPath } : {}),
    ...(docx?.exportPath ? { sourceExportDocxPath: docx.exportPath } : {}),
  };
}

function hasExplicitAtlasDocumentWorkflowSelectionLocal(input: {
  prompt: string;
  taskTitle?: string;
}): boolean {
  const text = `${input.prompt} ${input.taskTitle ?? ""}`.toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(?:use|select|run|invoke|wrap|route to|via)\b.{0,90}\b(?:real|actual|production|proper|existing|source-of-truth)\b.{0,90}\b(?:atlas|rhys|undeniable)\b.{0,90}\b(?:document|doc|pdf|docx|converter|workflow)\b/.test(text) ||
    /\b(?:real|actual|production|proper|existing|source-of-truth)\b.{0,90}\b(?:atlas|rhys|undeniable)\b.{0,90}\b(?:document|doc|pdf|docx|converter|workflow)\b/.test(text) ||
    /\b(?:atlas|rhys|undeniable)\b.{0,90}\b(?:doc-converter|document converter|document workflow|pdf workflow|docx workflow)\b/.test(text)
  );
}

function realArtifactOutputStemLocal(input: {
  taskTitle: string;
  runId: string;
  createdAt: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.taskTitle}\n${input.runId}\n${input.createdAt}`)
    .digest("hex")
    .slice(0, 10);
  return `${input.createdAt.slice(0, 10)}-${input.taskTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${digest}-branded`;
}

function buildProductionMarkdownSource(input: {
  taskTitle: string;
  content: string;
}): string {
  const content = input.content.trim();
  if (/^#\s+/m.test(content)) return `${content}\n`;
  return [`# ${input.taskTitle}`, "", content, ""].join("\n");
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
    if (!metadata.pdfPath || !isSupportedWorkspacePdfArtifact(metadata)) return null;
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

export async function readWorkspaceDraftArtifactDocx(
  id: string,
  options: { root?: string } = {},
): Promise<{ bytes: Buffer; filename: string } | null> {
  if (!isSafeWorkspaceDraftArtifactId(id)) {
    throw new Error("Unsafe artifact id.");
  }

  const root = options.root ?? WORKSPACE_DEMO_ARTIFACT_ROOT;
  const metadataPath = safeWorkspaceDraftArtifactPath(root, `${id}.metadata.json`);
  const docxPath = safeWorkspaceDraftArtifactPath(root, `${id}.docx`);
  try {
    const metadata = parseWorkspaceDraftArtifactMetadata(await readFile(metadataPath, "utf8"), id);
    if (!metadata.docxPath || !isSupportedWorkspacePdfArtifact(metadata)) return null;
    return {
      bytes: await readFile(docxPath),
      filename: `${slugify(metadata.userFacingName || metadata.title)}.docx`,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isSupportedWorkspacePdfArtifact(metadata: WorkspaceDraftArtifactMetadata): boolean {
  return metadata.sourceWorkflow === "atlas-rhys-ricky-handover-archive" ||
    metadata.sourceWorkflow === ATLAS_DOCUMENT_WORKFLOW_ID;
}
