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
}

export interface WorkspaceDraftArtifactResult {
  artifact: Artifact;
  metadata: WorkspaceDraftArtifactMetadata;
  markdown: string;
  pdf?: Buffer;
}

export const WORKSPACE_DEMO_ARTIFACT_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-demo-artifacts";

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
  const text = `${input.prompt} ${input.taskTitle ?? ""}`.toLowerCase();
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
  const userFacingName = artifactTitleForIntent(taskTitle, intent);
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
  const shouldWritePdf = intent.requestedFormat === "pdf";
  const pdf = shouldWritePdf ? renderWorkspaceDraftPdf({
    title: userFacingName,
    createdAt,
    markdown,
  }) : null;
  const metadata: WorkspaceDraftArtifactMetadata = {
    id,
    title: taskTitle,
    type: shouldWritePdf ? "pdf" : "markdown",
    createdAt,
    taskTitle,
    runtimeProvider: input.runtimeProvider,
    requestedFormat: intent.requestedFormat ?? "document",
    intentReason: intent.reason,
    ...(intent.exportLimitation ? { exportLimitation: intent.exportLimitation } : {}),
    localPath: shouldWritePdf ? pdfPath : markdownPath,
    ...(shouldWritePdf ? { sourceMarkdownPath: markdownPath, pdfPath } : {}),
    metadataPath,
    userFacingName,
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
      subtitle: artifactSubtitleForIntent(input.runtimeProvider, intent),
      preview: input.content.replace(/\s+/g, " ").slice(0, 160),
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
      : "Markdown draft saved.";
  const openLine = result.metadata.type === "pdf"
    ? "- Open the artifact card to preview and download the PDF."
    : "- Open the artifact card to preview the full draft.";
  const preview = cleanArtifactPreview(result.artifact.preview);
  return [
    `${formatLabel}`,
    "",
    `**${result.artifact.title}**`,
    "",
    preview ? `- Draft focus: ${preview}` : "- Draft focus: Ready for review in the artifact card.",
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
  if (intent.requestedFormat === "pdf") return `Atlas / ${runtimeProvider} / PDF draft`;
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
    if (metadata.type !== "pdf") return null;
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

function renderWorkspaceDraftPdf({
  title,
  createdAt,
  markdown,
}: {
  title: string;
  createdAt: string;
  markdown: string;
}): Buffer {
  const lines = markdownToPdfLines(markdown, title, createdAt);
  const pages = paginateLines(lines, 44);
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const addObject = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("__PAGES__");
  const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  void catalogId;
  void pagesId;

  for (const pageLines of pages) {
    const content = pageContentStream(pageLines);
    const contentId = addObject(`<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`);
    const pageId = addObject([
      "<< /Type /Page",
      "/Parent 2 0 R",
      "/MediaBox [0 0 612 792]",
      `/Resources << /Font << /F1 ${fontId} 0 R >> >>`,
      `/Contents ${contentId} 0 R`,
      ">>",
    ].join(" "));
    pageObjectIds.push(pageId);
  }

  objects[pagesId - 1] = [
    "<< /Type /Pages",
    `/Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}]`,
    `/Count ${pageObjectIds.length}`,
    ">>",
  ].join(" ");

  return buildPdf(objects);
}

function markdownToPdfLines(markdown: string, title: string, createdAt: string): string[] {
  const source = [
    "Atlas for Undeniable",
    "Undeniable OS",
    "",
    title,
    `Created: ${createdAt}`,
    "",
    ...markdown
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[-*]\s+/, "- ")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .trimEnd()),
  ];
  return source.flatMap((line) => wrapPdfLine(normalizePdfText(line), 88));
}

function normalizePdfText(value: string): string {
  return value
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .trimEnd();
}

function wrapPdfLine(line: string, width: number): string[] {
  if (!line.trim()) return [""];
  const words = line.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function paginateLines(lines: string[], linesPerPage: number): string[][] {
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage));
  }
  return pages.length ? pages : [[""]];
}

function pageContentStream(lines: string[]): string {
  const content = ["BT", "/F1 10 Tf", "50 742 Td", "14 TL"];
  lines.forEach((line, index) => {
    if (index > 0) content.push("T*");
    content.push(`(${escapePdfString(line)}) Tj`);
  });
  content.push("ET");
  return content.join("\n");
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(objects: string[]): Buffer {
  const chunks = ["%PDF-1.4\n"];
  const offsets: number[] = [0];
  let byteLength = Buffer.byteLength(chunks[0], "ascii");
  objects.forEach((body, index) => {
    offsets.push(byteLength);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    byteLength += Buffer.byteLength(chunk, "ascii");
  });
  const xrefOffset = byteLength;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  for (let index = 1; index < offsets.length; index += 1) {
    chunks.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push([
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n"));
  return Buffer.from(chunks.join(""), "ascii");
}
