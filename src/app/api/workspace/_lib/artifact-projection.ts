import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

export const EXPORTS_ROOT = "/Users/atlasai/.openclaw/workspace/exports";
export const LOGS_ROOT = "/Users/atlasai/.openclaw/logs";

const MAX_SCAN_DEPTH = 4;
const ARTIFACT_EXTENSIONS = new Set([
  ".css",
  ".docx",
  ".html",
  ".json",
  ".md",
  ".pdf",
  ".png",
  ".py",
  ".txt",
  ".zip",
]);

export interface WorkspaceArtifact {
  id: string;
  title: string;
  kind: string;
  format: string;
  path: string;
  relativePath: string;
  sizeBytes: number;
  createdAt: string | null;
  modifiedAt: string;
  inferredWorkflow: string;
  previewPath: string | null;
  validationStatus: "unknown" | "sidecars_present";
}

export interface ArtifactGroup {
  groupKey: string;
  title: string;
  workflow: string;
  artifacts: WorkspaceArtifact[];
  createdAt: string | null;
  updatedAt: string | null;
  confidence: "high" | "medium" | "low";
}

export interface LogMetadata {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

function hashId(prefix: string, value: string): string {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 12);
  return `${prefix}_${hash}`;
}

function toIso(date: Date): string | null {
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function titleize(stem: string): string {
  return stem
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || stem;
}

function stemOf(filePath: string): string {
  return basename(filePath, extname(filePath));
}

function normalizeStem(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-(branded|fixed|clean|one-doc|strategy-brief|cover-preview|cover|logo-crop)$/g, "")
    .replace(/-v\d+$/g, "")
    .replace(/-page\d+$/g, "")
    .replace(/-page-\d+$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferWorkflow(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.startsWith("audits/") || lower.includes("executive-audit")) return "audit";
  if (lower.startsWith("strategy/") || lower.includes("strategy-brief")) return "strategist";
  if (lower.startsWith("previews/") || lower.includes("/preview") || lower.endsWith("-cover.png") || lower.includes("cover-preview")) return "preview";
  if (lower.startsWith("brand-assets/") || lower.includes("undeniable-")) return "brand_asset";
  if (lower.endsWith(".zip") || lower.includes("complete-export")) return "export_bundle";
  if (lower.includes("playbook") || lower.includes("branded")) return "doc_converter";
  return "unknown";
}

function inferKind(relativePath: string, extension: string, workflow: string): string {
  const lower = relativePath.toLowerCase();
  if (workflow === "audit") return "executive_audit";
  if (lower.includes("strategy-brief")) return "strategy_brief";
  if (workflow === "strategist") return "strategy_document";
  if (workflow === "preview" && extension === ".png") return "preview_image";
  if (workflow === "brand_asset") return "brand_asset";
  if (extension === ".zip") return "archive";
  if (extension === ".json" || extension === ".txt") return "data_export";
  if ([".md", ".html", ".css", ".py"].includes(extension)) return "source_sidecar";
  if (extension === ".docx") return "document_docx";
  if (extension === ".pdf") return "document_pdf";
  return "artifact";
}

function groupKeyFor(artifact: WorkspaceArtifact): string {
  const relDir = dirname(artifact.relativePath);
  const normalized = normalizeStem(stemOf(artifact.relativePath));
  return `${artifact.inferredWorkflow}:${relDir}:${normalized}`;
}

async function walkExports(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || !existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkExports(fullPath, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    files.push(fullPath);
  }
  return files;
}

function pairPreviews(artifacts: WorkspaceArtifact[]): Map<string, string> {
  const previews = artifacts.filter((artifact) => {
    const lower = artifact.relativePath.toLowerCase();
    return artifact.format === "PNG" && (
      lower.startsWith("previews/")
      || lower.includes("/preview")
      || lower.includes("cover")
    );
  });
  const byArtifactId = new Map<string, string>();

  for (const artifact of artifacts) {
    if (artifact.format === "PNG") continue;
    const artifactStem = normalizeStem(stemOf(artifact.relativePath));
    if (!artifactStem) continue;
    const match = previews.find((preview) => {
      const previewStem = normalizeStem(stemOf(preview.relativePath));
      if (!preview.relativePath.toLowerCase().includes("cover")) return false;
      return previewStem.startsWith(artifactStem) || artifactStem.startsWith(previewStem);
    });
    if (match) byArtifactId.set(artifact.id, match.path);
  }

  return byArtifactId;
}

export async function getWorkspaceArtifacts(): Promise<WorkspaceArtifact[]> {
  const files = await walkExports(EXPORTS_ROOT);
  const artifacts: WorkspaceArtifact[] = [];

  for (const filePath of files) {
    const info = await stat(filePath).catch(() => null);
    if (!info) continue;
    const relativePath = relative(EXPORTS_ROOT, filePath);
    const extension = extname(filePath).toLowerCase();
    const workflow = inferWorkflow(relativePath);
    artifacts.push({
      id: hashId("artifact", relativePath),
      title: titleize(stemOf(filePath)),
      kind: inferKind(relativePath, extension, workflow),
      format: extension.slice(1).toUpperCase() || "UNKNOWN",
      path: filePath,
      relativePath,
      sizeBytes: info.size,
      createdAt: toIso(info.birthtime),
      modifiedAt: info.mtime.toISOString(),
      inferredWorkflow: workflow,
      previewPath: null,
      validationStatus: "unknown",
    });
  }

  const previewPairs = pairPreviews(artifacts);
  const sidecarGroups = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    const key = groupKeyFor(artifact);
    const ext = artifact.format.toLowerCase();
    const set = sidecarGroups.get(key) ?? new Set<string>();
    set.add(ext);
    sidecarGroups.set(key, set);
  }

  return artifacts
    .map((artifact) => {
      const sidecars = sidecarGroups.get(groupKeyFor(artifact)) ?? new Set<string>();
      const hasSidecars = sidecars.has("pdf") && (sidecars.has("md") || sidecars.has("html") || sidecars.has("docx"));
      const validationStatus: WorkspaceArtifact["validationStatus"] = hasSidecars ? "sidecars_present" : "unknown";
      return {
        ...artifact,
        previewPath: previewPairs.get(artifact.id) ?? null,
        validationStatus,
      };
    })
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
}

export function groupArtifacts(artifacts: WorkspaceArtifact[]): ArtifactGroup[] {
  const groups = new Map<string, WorkspaceArtifact[]>();
  for (const artifact of artifacts) {
    const key = groupKeyFor(artifact);
    const list = groups.get(key) ?? [];
    list.push(artifact);
    groups.set(key, list);
  }

  return [...groups.entries()].map(([groupKey, groupArtifactsForKey]) => {
    const sorted = groupArtifactsForKey.sort((a, b) => Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt));
    const primary = sorted.find((artifact) => artifact.format === "PDF")
      ?? sorted.find((artifact) => artifact.format === "DOCX")
      ?? sorted[0];
    const formats = new Set(sorted.map((artifact) => artifact.format));
    const workflow = primary.inferredWorkflow;
    const confidence: ArtifactGroup["confidence"] = formats.has("PDF") && sorted.length > 1
      ? "high"
      : sorted.length > 1
        ? "medium"
        : "low";

    return {
      groupKey,
      title: primary.title,
      workflow,
      artifacts: sorted,
      createdAt: sorted[0]?.createdAt ?? null,
      updatedAt: sorted.at(-1)?.modifiedAt ?? null,
      confidence,
    };
  }).sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
}

export async function getKnownLogMetadata(): Promise<LogMetadata[]> {
  const names = [
    "audit-webhook.log",
    "audit-webhook-error.log",
    "audit.jsonl",
    "call-processor.log",
    "metrics-engine.log",
    "mission-control.log",
  ];
  const logs: LogMetadata[] = [];

  for (const name of names) {
    const path = join(LOGS_ROOT, name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    logs.push({
      name,
      path,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }

  return logs;
}
