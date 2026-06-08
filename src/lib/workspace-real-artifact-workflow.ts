import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const ATLAS_DOCUMENT_CONVERTER_SCRIPT =
  "/Users/atlasai/.openclaw/workspace/skills/doc-converter/scripts/convert.sh";
export const ATLAS_DOCUMENT_EXPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/exports";
export const ATLAS_DOCUMENT_WORKFLOW_ID = "atlas-undeniable-doc-converter";

export type WorkspaceRealArtifactWorkflowId = typeof ATLAS_DOCUMENT_WORKFLOW_ID;
export type WorkspaceRealArtifactFormat = "pdf" | "docx";

export interface WorkspaceRealArtifactRenderInput {
  markdown: string;
  title: string;
  outputStem: string;
  formats: WorkspaceRealArtifactFormat[];
  tmpRoot?: string;
  converterScript?: string;
}

export interface WorkspaceRealArtifactOutput {
  format: WorkspaceRealArtifactFormat;
  filename: string;
  bytes: Buffer;
  exportPath: string;
}

export interface WorkspaceRealArtifactRenderResult {
  workflowId: WorkspaceRealArtifactWorkflowId;
  sourceMarkdownPath: string;
  outputs: WorkspaceRealArtifactOutput[];
}

export type WorkspaceRealArtifactRenderer = (
  input: WorkspaceRealArtifactRenderInput,
) => Promise<WorkspaceRealArtifactRenderResult>;

export function hasExplicitAtlasDocumentWorkflowSelection(input: {
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

export async function renderAtlasDocumentArtifact(
  input: WorkspaceRealArtifactRenderInput,
): Promise<WorkspaceRealArtifactRenderResult> {
  const formats = [...new Set(input.formats)];
  if (formats.length === 0) throw new Error("No artifact formats requested.");
  for (const format of formats) {
    if (format !== "pdf" && format !== "docx") throw new Error(`Unsupported artifact format: ${format}`);
  }

  const converterScript = input.converterScript ?? ATLAS_DOCUMENT_CONVERTER_SCRIPT;
  const tmpRoot = input.tmpRoot ?? `/tmp/atlas-workspace-real-artifact-${Date.now()}-${process.pid}`;
  await mkdir(tmpRoot, { recursive: true });
  const sourceMarkdownPath = join(tmpRoot, `${safeStem(input.outputStem)}.md`);
  await writeFile(sourceMarkdownPath, input.markdown, "utf8");

  const outputs: WorkspaceRealArtifactOutput[] = [];
  for (const format of formats) {
    const filename = `${safeStem(input.outputStem)}.${format}`;
    await execFileP("bash", [
      converterScript,
      sourceMarkdownPath,
      filename,
      "--title",
      input.title,
    ], { timeout: 180_000, maxBuffer: 1024 * 1024 });

    const exportPath = join(ATLAS_DOCUMENT_EXPORTS_ROOT, basename(filename));
    const bytes = await readFile(exportPath);
    assertRealOutput(format, bytes);
    outputs.push({ format, filename, bytes, exportPath });
  }

  return {
    workflowId: ATLAS_DOCUMENT_WORKFLOW_ID,
    sourceMarkdownPath,
    outputs,
  };
}

export function realArtifactOutputStem(input: {
  taskTitle: string;
  runId: string;
  createdAt: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.taskTitle}\n${input.runId}\n${input.createdAt}`)
    .digest("hex")
    .slice(0, 10);
  return `${input.createdAt.slice(0, 10)}-${slugify(input.taskTitle)}-${digest}-branded`;
}

export function buildProductionMarkdownSource(input: {
  taskTitle: string;
  content: string;
}): string {
  const content = input.content.trim();
  if (/^#\s+/m.test(content)) return `${content}\n`;
  return [`# ${input.taskTitle}`, "", content, ""].join("\n");
}

function assertRealOutput(format: WorkspaceRealArtifactFormat, bytes: Buffer): void {
  if (bytes.byteLength === 0) throw new Error(`${format.toUpperCase()} output is empty.`);
  if (format === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("PDF output failed real PDF validation.");
  }
  if (format === "docx" && bytes.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error("DOCX output failed zip validation.");
  }
}

function safeStem(value: string): string {
  return slugify(value).slice(0, 96) || "atlas-document";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
