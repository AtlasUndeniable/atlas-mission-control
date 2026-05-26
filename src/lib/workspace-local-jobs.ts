import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const WORKSPACE_LOCAL_JOBS_ROOT = "/Users/atlasai/.openclaw/workspace/state/workspace-local-jobs";
export const WORKSPACE_LOCAL_JOBS_FILE = "local-jobs.jsonl";

export const WORKSPACE_LOCAL_JOB_STATUSES = ["draft", "queued_local", "not_executing"] as const;
export const WORKSPACE_LOCAL_JOB_WORKFLOWS = [
  "ask_atlas",
  "audit",
  "content_batch",
  "call_archive",
  "training_session",
  "general",
] as const;

export type WorkspaceLocalJobStatus = typeof WORKSPACE_LOCAL_JOB_STATUSES[number];
export type WorkspaceLocalJobWorkflow = typeof WORKSPACE_LOCAL_JOB_WORKFLOWS[number];

export type WorkspaceLocalJob = {
  schemaVersion: 1;
  id: string;
  title: string;
  prompt: string;
  project: string;
  room: string;
  requesterRole: string;
  createdAt: string;
  updatedAt: string;
  status: WorkspaceLocalJobStatus;
  intendedWorkflow: WorkspaceLocalJobWorkflow;
  source: "workspace";
  execution: {
    state: "not_executing";
    reason: string;
  };
};

export type WorkspaceLocalJobInput = {
  prompt: string;
  project: string;
  room: string;
  requesterRole: string;
  intendedWorkflow?: WorkspaceLocalJobWorkflow;
};

export type WorkspaceLocalJobValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type WorkspaceLocalJobsProjection = {
  root: string;
  file: string;
  records: WorkspaceLocalJob[];
  health: {
    present: boolean;
    recordCount: number;
    validRecordCount: number;
    invalidRecordCount: number;
    lastModified: string | null;
    errors: Array<{
      source: string;
      ref?: string;
      message: string;
    }>;
  };
};

type WorkspaceLocalJobStorageOptions = {
  root?: string;
  now?: Date;
  idFactory?: () => string;
};

const MAX_PROMPT_LENGTH = 8000;
const MAX_FIELD_LENGTH = 120;
const STATUS_SET = new Set<string>(WORKSPACE_LOCAL_JOB_STATUSES);
const WORKFLOW_SET = new Set<string>(WORKSPACE_LOCAL_JOB_WORKFLOWS);

function storagePath(root = WORKSPACE_LOCAL_JOBS_ROOT): string {
  return join(root, WORKSPACE_LOCAL_JOBS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.slice(0, MAX_FIELD_LENGTH) || fallback;
}

function cleanPrompt(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_PROMPT_LENGTH) : "";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "Workspace request";
  const withoutTrailing = firstLine.replace(/[.!?]+$/, "");
  return withoutTrailing.length > 72 ? `${withoutTrailing.slice(0, 69).trim()}...` : withoutTrailing;
}

export function inferWorkspaceLocalJobWorkflow(prompt: string): WorkspaceLocalJobWorkflow {
  const normalized = prompt.toLowerCase();
  if (/\baudit\b|l2|typeform|qa/.test(normalized)) return "audit";
  if (/call archive|transcript|call notes|recording|archive/.test(normalized)) return "call_archive";
  if (/content|\bscript\b|batch|\bpost\b|caption|newsletter/.test(normalized)) return "content_batch";
  if (/train|training|brain dump|principle|memory|context/.test(normalized)) return "training_session";
  if (/ask atlas|question|solve|think through/.test(normalized)) return "ask_atlas";
  return "general";
}

export function validateWorkspaceLocalJobInput(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalJobInput> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Input must be an object."] };

  const prompt = cleanPrompt(value.prompt);
  if (!prompt) errors.push("Prompt is required.");
  if (typeof value.prompt === "string" && value.prompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
  }

  const requestedWorkflow = value.intendedWorkflow;
  const intendedWorkflow = typeof requestedWorkflow === "string" && WORKFLOW_SET.has(requestedWorkflow)
    ? requestedWorkflow as WorkspaceLocalJobWorkflow
    : inferWorkspaceLocalJobWorkflow(prompt);
  if (requestedWorkflow !== undefined && (typeof requestedWorkflow !== "string" || !WORKFLOW_SET.has(requestedWorkflow))) {
    errors.push("Intended workflow is not supported.");
  }

  const project = cleanField(value.project, "undeniable-os");
  const room = cleanField(value.room, "home");
  const requesterRole = cleanField(value.requesterRole, "rhys");

  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          prompt,
          project,
          room,
          requesterRole,
          intendedWorkflow,
        },
      };
}

export function validateWorkspaceLocalJob(value: unknown): WorkspaceLocalJobValidationResult<WorkspaceLocalJob> {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["Record must be an object."] };

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof value.id !== "string" || !value.id.trim()) errors.push("id is required.");
  if (typeof value.title !== "string" || !value.title.trim()) errors.push("title is required.");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) errors.push("prompt is required.");
  if (typeof value.project !== "string" || !value.project.trim()) errors.push("project is required.");
  if (typeof value.room !== "string" || !value.room.trim()) errors.push("room is required.");
  if (typeof value.requesterRole !== "string" || !value.requesterRole.trim()) errors.push("requesterRole is required.");
  if (!isIsoDate(value.createdAt)) errors.push("createdAt must be an ISO timestamp.");
  if (!isIsoDate(value.updatedAt)) errors.push("updatedAt must be an ISO timestamp.");
  if (typeof value.status !== "string" || !STATUS_SET.has(value.status)) errors.push("status is not supported.");
  if (typeof value.intendedWorkflow !== "string" || !WORKFLOW_SET.has(value.intendedWorkflow)) {
    errors.push("intendedWorkflow is not supported.");
  }
  if (value.source !== "workspace") errors.push("source must be workspace.");
  if (!isRecord(value.execution) || value.execution.state !== "not_executing") {
    errors.push("execution.state must be not_executing.");
  }
  if (!isRecord(value.execution) || typeof value.execution.reason !== "string" || !value.execution.reason.trim()) {
    errors.push("execution.reason is required.");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: value as WorkspaceLocalJob };
}

export async function createWorkspaceLocalJob(
  input: WorkspaceLocalJobInput,
  options: WorkspaceLocalJobStorageOptions = {},
): Promise<WorkspaceLocalJob> {
  const checked = validateWorkspaceLocalJobInput(input);
  if (!checked.ok) {
    throw new Error(checked.errors.join(" "));
  }

  const root = options.root ?? WORKSPACE_LOCAL_JOBS_ROOT;
  const now = (options.now ?? new Date()).toISOString();
  const job: WorkspaceLocalJob = {
    schemaVersion: 1,
    id: `local_job_${(options.idFactory ?? randomUUID)().replace(/[^a-zA-Z0-9_-]/g, "")}`,
    title: titleFromPrompt(checked.value.prompt),
    prompt: checked.value.prompt,
    project: checked.value.project,
    room: checked.value.room,
    requesterRole: checked.value.requesterRole,
    createdAt: now,
    updatedAt: now,
    status: "queued_local",
    intendedWorkflow: checked.value.intendedWorkflow ?? inferWorkspaceLocalJobWorkflow(checked.value.prompt),
    source: "workspace",
    execution: {
      state: "not_executing",
      reason: "Saved by Workspace local intake only. No worker, model, delivery, or external platform was invoked.",
    },
  };

  const validated = validateWorkspaceLocalJob(job);
  if (!validated.ok) throw new Error(validated.errors.join(" "));

  await mkdir(root, { recursive: true });
  await appendFile(storagePath(root), `${JSON.stringify(job)}\n`, "utf8");

  return job;
}

export async function getWorkspaceLocalJobs(
  options: Pick<WorkspaceLocalJobStorageOptions, "root"> = {},
): Promise<WorkspaceLocalJobsProjection> {
  const root = options.root ?? WORKSPACE_LOCAL_JOBS_ROOT;
  const file = storagePath(root);
  const projection: WorkspaceLocalJobsProjection = {
    root,
    file,
    records: [],
    health: {
      present: false,
      recordCount: 0,
      validRecordCount: 0,
      invalidRecordCount: 0,
      lastModified: null,
      errors: [],
    },
  };

  if (!existsSync(file)) return projection;

  try {
    const info = await stat(file);
    if (!info.isFile()) return projection;
    projection.health.present = true;
    projection.health.lastModified = new Date(info.mtimeMs).toISOString();

    const content = await readFile(file, "utf8");
    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      projection.health.recordCount += 1;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const checked = validateWorkspaceLocalJob(parsed);
        if (checked.ok) {
          projection.records.push(checked.value);
          projection.health.validRecordCount += 1;
        } else {
          projection.health.invalidRecordCount += 1;
          projection.health.errors.push({
            source: file,
            ref: `line:${index + 1}`,
            message: checked.errors.join(" "),
          });
        }
      } catch (error) {
        projection.health.invalidRecordCount += 1;
        projection.health.errors.push({
          source: file,
          ref: `line:${index + 1}`,
          message: error instanceof Error ? error.message : "Invalid JSONL record",
        });
      }
    }
  } catch (error) {
    projection.health.errors.push({
      source: file,
      message: error instanceof Error ? error.message : "Unable to read local job records",
    });
  }

  projection.records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return projection;
}
