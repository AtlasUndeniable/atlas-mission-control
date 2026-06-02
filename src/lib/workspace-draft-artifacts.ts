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

const DRAFT_INTENT_PATTERN = /\b(doc|document|handover|brief|plan|audit|report|playbook|draft|artifact)\b|content plan/i;

export function shouldCreateWorkspaceDraftArtifact(input: Pick<WorkspaceDraftArtifactInput, "prompt" | "taskTitle">): boolean {
  return DRAFT_INTENT_PATTERN.test(`${input.prompt} ${input.taskTitle ?? ""}`);
}

export async function maybeWriteWorkspaceDraftArtifact(
  input: WorkspaceDraftArtifactInput,
): Promise<WorkspaceDraftArtifactResult | null> {
  if (!shouldCreateWorkspaceDraftArtifact(input)) return null;
  return writeWorkspaceDraftArtifact(input);
}

export async function writeWorkspaceDraftArtifact(
  input: WorkspaceDraftArtifactInput,
): Promise<WorkspaceDraftArtifactResult> {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const taskTitle = input.taskTitle?.trim() || "Workspace draft";
  const userFacingName = `${taskTitle} draft`;
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
      subtitle: `Atlas / ${input.runtimeProvider} / markdown draft`,
      preview: input.content.replace(/\s+/g, " ").slice(0, 160),
    },
    metadata,
    markdown,
  };
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
