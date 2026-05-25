import Link from "next/link";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { groupArtifacts, getWorkspaceArtifacts } from "@/app/api/workspace/_lib/artifact-projection";
import type { ArtifactGroup, WorkspaceArtifact as ScannedWorkspaceArtifact } from "@/app/api/workspace/_lib/artifact-projection";
import { buildReaperData } from "@/lib/reaper";
import { getWorkspaceArtifactControlProjection } from "@/lib/workspace-artifact-control-projection";
import type { WorkspaceArtifactControlProjection } from "@/lib/workspace-artifact-control-projection";
import { getWorkspaceMemoryMaintenanceProjection } from "@/lib/workspace-memory-maintenance-projection";
import type { WorkspaceMemoryMaintenanceProjection } from "@/lib/workspace-memory-maintenance-projection";
import { workspaceArtifactControlFixtures, workspaceTrainingGroundsFixtures } from "@/lib/workspace-contract-fixtures";
import {
  validateAgentRun,
  validateArtifactCollection,
  validateApproval,
  validateAuditRun,
  validateContentBatch,
  validateMemoryMaintenanceRun,
  validateTrainingGroundsSession,
  validateWorkspaceArtifact,
  validateWorkspaceProject,
} from "@/lib/workspace-contracts";
import type {
  AgentRun,
  AgentRunStatus,
  Approval,
  ArtifactReference,
  AuditRun,
  ContentBatch,
  TrainingGroundsSession,
  WorkspaceArtifact,
  MemoryMaintenanceRun,
  ValidationSummary,
} from "@/lib/workspace-contracts";
import { getWorkspaceRunsProjection } from "@/lib/workspace-runs-projection";
import type { WorkspaceRunsProjection } from "@/lib/workspace-runs-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SLACK_QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";
const JIAN_APPROVALS_FILE = "/Users/atlasai/.openclaw/data/pending-approvals.json";

const VISIBLE_SLACK_STATUSES = new Set(["pending", "needs_draft", "drafted", "send_failed", "held"]);
const ACTIVE_JIAN_STATUSES = new Set(["pending", "redirected"]);

type JobStatus = "ready" | "collecting" | "needs_review";

interface SlackQueueItem {
  id?: string;
  status?: string;
  draftReply?: string | null;
  intendedText?: string | null;
}

interface JianApprovalItem {
  id?: string;
  status?: string;
  createdAt?: string | null;
  resolvedAt?: string | null;
}

interface WorkspaceJob {
  id: string;
  title: string;
  type: string;
  status: JobStatus;
  currentStep: string;
  updatedAt: string | null;
  artifactCount: number;
  formats: string[];
  confidence: "high" | "medium" | "low";
}

interface WorkspaceSnapshot {
  generatedAt: string;
  approvals: {
    totalPending: number;
    slackVisible: number;
    jianActive: number;
    draftedSlack: number;
    heldSlack: number;
  };
  artifacts: {
    total: number;
    recent: ScannedWorkspaceArtifact[];
    latestAudit: ArtifactGroup | null;
  };
  artifactControl: WorkspaceArtifactControlProjection;
  memoryMaintenance: WorkspaceMemoryMaintenanceProjection;
  jobs: {
    total: number;
    ready: number;
    collecting: number;
    needsReview: number;
    recent: WorkspaceJob[];
  };
  runs: WorkspaceRunsProjection;
  reaper: {
    totalPending: number;
    stale: number;
    ancient: number;
    withDraft: number;
    withSuggestion: number;
    updatedAt: string | null;
  };
}

type WorkspaceRoomId =
  | "home"
  | "audits"
  | "content"
  | "approvals"
  | "agent-runs"
  | "training"
  | "knowledge"
  | "team"
  | "readiness";

type WorkspaceRoleId = "rhys" | "pat" | "corey" | "jian" | "dante";

type WorkspaceProjectId =
  | "undeniable-os"
  | "l2-audits"
  | "content-engine"
  | "monday-delivery"
  | "memory-knowledge";

type WorkspaceSearchParams = Record<string, string | string[] | undefined>;

const ROOMS: Array<{
  id: WorkspaceRoomId;
  label: string;
  description: string;
}> = [
  { id: "home", label: "Home", description: "Workspace overview and saved project context." },
  { id: "audits", label: "Audits", description: "L2 intake, generation, QA, review state, and artifact packages." },
  { id: "content", label: "Content", description: "Corey-facing weekly batches, scripts, frameworks, and assets." },
  { id: "approvals", label: "Approvals", description: "Pat-facing review queues and read-only approval visibility." },
  { id: "agent-runs", label: "Agent Runs", description: "Agent work history, blocked runs, events, and recovery notes." },
  { id: "training", label: "Training Grounds", description: "Rhys teaching Atlas how to think through brain dumps, challenges, and reviewable learning packets." },
  { id: "knowledge", label: "Knowledge", description: "Memory maintenance, Rhys strategy docs, and artifact archives." },
  { id: "team", label: "Team", description: "Trial guidance and read-only launch checks for the Atlas team." },
  { id: "readiness", label: "Settings / Readiness", description: "Source health, disabled integrations, and launch guardrails." },
];

const PROJECTS: Array<{
  id: WorkspaceProjectId;
  label: string;
  detail: string;
}> = [
  { id: "undeniable-os", label: "Undeniable OS", detail: "Primary Atlas operating workspace." },
  { id: "l2-audits", label: "L2 Audits", detail: "Executive audit intake, QA, and artifact review." },
  { id: "content-engine", label: "Content Engine", detail: "Weekly content batches, scripts, and assets." },
  { id: "monday-delivery", label: "Monday Delivery", detail: "Task delivery visibility and review state." },
  { id: "memory-knowledge", label: "Memory/Knowledge", detail: "Librarian runs, saved docs, and knowledge health." },
];

const ROOM_IDS = new Set(ROOMS.map((room) => room.id));
const ROLE_IDS = new Set<WorkspaceRoleId>(["rhys", "pat", "corey", "jian", "dante"]);
const PROJECT_IDS = new Set(PROJECTS.map((project) => project.id));

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function jobTypeFor(workflow: string): string {
  if (workflow === "audit") return "Audit";
  if (workflow === "strategist") return "Strategy";
  if (workflow === "doc_converter") return "Document";
  if (workflow === "brand_asset") return "Brand asset";
  if (workflow === "preview") return "Preview";
  if (workflow === "export_bundle") return "Export";
  return "Artifact";
}

function workspaceFor(workflow: string): string {
  if (workflow === "audit") return "Client audit";
  if (workflow === "strategist") return "Strategy desk";
  if (workflow === "doc_converter") return "Document studio";
  if (workflow === "brand_asset") return "Brand library";
  if (workflow === "preview") return "Preview lane";
  if (workflow === "export_bundle") return "Export room";
  return "Workspace";
}

function jobStatusFor(formats: Set<string>, workflow: string, confidence: WorkspaceJob["confidence"]): JobStatus {
  if (formats.has("PDF") || formats.has("DOCX") || formats.has("ZIP")) return "ready";
  if (workflow === "preview" || workflow === "brand_asset") return "ready";
  if (confidence === "low") return "needs_review";
  return "collecting";
}

function jobStepFor(status: JobStatus, formats: string[]): string {
  if (status === "ready") return `Deliverable packaged with ${formats.slice(0, 3).join(", ") || "artifact"} output`;
  if (status === "needs_review") return "Needs review before it is promoted into the workspace history";
  return "Still gathering related files and context";
}

function buildJobs(groups: ArtifactGroup[]): WorkspaceJob[] {
  return groups.map((group) => {
    const formats = [...new Set(group.artifacts.map((artifact) => artifact.format))].sort();
    const status = jobStatusFor(new Set(formats), group.workflow, group.confidence);

    return {
      id: group.groupKey,
      title: group.title,
      type: jobTypeFor(group.workflow),
      status,
      currentStep: jobStepFor(status, formats),
      updatedAt: group.updatedAt,
      artifactCount: group.artifacts.length,
      formats,
      confidence: group.confidence,
    };
  });
}

async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const [slackQueue, jianApprovals, artifacts, runs, artifactControl, memoryMaintenance] = await Promise.all([
    readJsonArray<SlackQueueItem>(SLACK_QUEUE_FILE),
    readJsonArray<JianApprovalItem>(JIAN_APPROVALS_FILE),
    getWorkspaceArtifacts(),
    getWorkspaceRunsProjection({
      validators: {
        agentRuns: validateAgentRun,
        auditRuns: validateAuditRun,
        contentBatches: validateContentBatch,
        approvals: validateApproval,
        memoryMaintenanceRuns: validateMemoryMaintenanceRun,
      },
    }),
    getWorkspaceArtifactControlProjection({
      fixtureFallbackCount: workspaceArtifactControlFixtures.artifacts.length,
      validators: {
        projects: validateWorkspaceProject,
        collections: validateArtifactCollection,
        artifacts: validateWorkspaceArtifact,
      },
    }),
    getWorkspaceMemoryMaintenanceProjection(),
  ]);
  const reaper = buildReaperData();
  const visibleSlack = slackQueue.filter((item) => item.status && VISIBLE_SLACK_STATUSES.has(item.status));
  const activeJian = jianApprovals.filter((item) => item.status && ACTIVE_JIAN_STATUSES.has(item.status));
  const groups = groupArtifacts(artifacts);
  const jobs = buildJobs(groups);
  const latestAudit = groups.find((group) => group.workflow === "audit") ?? null;
  const recentArtifacts = artifacts
    .filter((artifact) => !["source_sidecar", "data_export"].includes(artifact.kind))
    .slice(0, 6);

  return {
    generatedAt: new Date().toISOString(),
    approvals: {
      totalPending: visibleSlack.length + activeJian.length,
      slackVisible: visibleSlack.length,
      jianActive: activeJian.length,
      draftedSlack: visibleSlack.filter((item) => item.status === "drafted").length,
      heldSlack: visibleSlack.filter((item) => item.status === "held").length,
    },
    artifacts: {
      total: artifacts.length,
      recent: recentArtifacts,
      latestAudit,
    },
    artifactControl,
    memoryMaintenance,
    jobs: {
      total: jobs.length,
      ready: jobs.filter((job) => job.status === "ready").length,
      collecting: jobs.filter((job) => job.status === "collecting").length,
      needsReview: jobs.filter((job) => job.status === "needs_review").length,
      recent: jobs.slice(0, 6),
    },
    runs,
    reaper: {
      totalPending: reaper.summary.totalPending,
      stale: reaper.summary.stale,
      ancient: reaper.summary.ancient,
      withDraft: reaper.summary.withDraft,
      withSuggestion: reaper.summary.withSuggestion,
      updatedAt: reaper.updatedAt,
    },
  };
}

function classNames(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getWorkspaceSelection(params: WorkspaceSearchParams): {
  room: WorkspaceRoomId;
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
} {
  const requestedRoom = firstParam(params.room);
  const requestedRole = firstParam(params.role);
  const requestedProject = firstParam(params.project);

  return {
    room: ROOM_IDS.has(requestedRoom as WorkspaceRoomId) ? requestedRoom as WorkspaceRoomId : "home",
    role: ROLE_IDS.has(requestedRole as WorkspaceRoleId) ? requestedRole as WorkspaceRoleId : "rhys",
    project: PROJECT_IDS.has(requestedProject as WorkspaceProjectId) ? requestedProject as WorkspaceProjectId : "undeniable-os",
  };
}

function workspaceHref({
  room,
  role,
  project,
}: {
  room: WorkspaceRoomId;
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
}): string {
  const params = new URLSearchParams({ room, role, project });
  return `/workspace?${params.toString()}`;
}

function selectedProject(projectId: WorkspaceProjectId) {
  return PROJECTS.find((project) => project.id === projectId) ?? PROJECTS[0];
}

function selectedRoom(roomId: WorkspaceRoomId) {
  return ROOMS.find((room) => room.id === roomId) ?? ROOMS[0];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Unknown";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "Unknown";
  return new Date(ts).toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusClasses(status: JobStatus): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "collecting") return "border-blue-200 bg-blue-50 text-blue-800";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function statusLabel(status: JobStatus): string {
  if (status === "ready") return "Delivered";
  if (status === "collecting") return "Working";
  return "Review";
}

function runStatusLabel(status: AgentRunStatus): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function runStatusClasses(status: AgentRunStatus | ContentBatch["status"] | Approval["workspaceStatus"]): string {
  if (["completed", "approved", "passed"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["running", "queued", "drafting", "ready_for_review", "awaiting_review"].includes(status)) {
    return "border-blue-200 bg-blue-50 text-blue-800";
  }
  if (["waiting_for_input", "waiting_for_approval", "needs_changes", "held"].includes(status)) {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (["failed_recoverable", "failed_blocked", "failed", "blocked"].includes(status)) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-stone-200 bg-stone-50 text-stone-700";
}

function validationLabel(validation?: ValidationSummary): string {
  if (!validation) return "QA pending";
  if (validation.status === "passed") return "QA passed";
  if (validation.status === "failed") return "QA failed";
  if (validation.status === "warning") return "QA warning";
  if (validation.status === "pending") return "QA pending";
  return "QA unknown";
}

function auditSourceLabel(source: AuditRun["source"]): string {
  if (source === "typeform") return "Typeform intake";
  if (source === "slack_dm") return "Workspace message";
  return "Manual intake";
}

function auditStageLabel(stage: AuditRun["stages"][number]["name"]): string {
  if (stage === "parse") return "Parse";
  if (stage === "retrieve") return "Retrieve";
  if (stage === "generate") return "Generate";
  if (stage === "render") return "Render";
  if (stage === "validate") return "Validate";
  return "Review";
}

function reviewerStateForAudit(run: AuditRun): { label: string; detail: string; required: boolean } {
  if (run.delivery.state === "blocked") {
    return { label: "Required", detail: "Blocked before any external delivery.", required: true };
  }
  if (run.delivery.state === "waiting_for_approval" || run.relatedApprovalIds.length > 0) {
    return { label: "Required", detail: "Waiting for a human review record.", required: true };
  }
  if (run.validation.status === "failed" || run.status === "failed_blocked" || run.status === "failed_recoverable") {
    return { label: "Required", detail: "QA or worker state needs review.", required: true };
  }
  return { label: "Not required", detail: "No review gate emitted for this run.", required: false };
}

function sourceHealthLabel(present: boolean, validCount: number, invalidCount: number): string {
  if (!present) return "Not emitting";
  if (invalidCount > 0) return "Needs cleanup";
  if (validCount > 0) return "Emitting";
  return "Present";
}

function countLinkedArtifacts(runs: WorkspaceRunsProjection): number {
  return [
    ...runs.records.agentRuns,
    ...runs.records.auditRuns,
    ...runs.records.contentBatches,
    ...runs.records.memoryMaintenanceRuns,
  ].reduce((total, record) => total + record.artifacts.length, 0);
}

function countLinkedApprovals(runs: WorkspaceRunsProjection): number {
  return [
    ...runs.records.agentRuns,
    ...runs.records.auditRuns,
    ...runs.records.contentBatches,
    ...runs.records.memoryMaintenanceRuns,
  ].reduce((total, record) => total + record.relatedApprovalIds.length, runs.records.approvals.length);
}

function workflowAccent(workflow: string): string {
  if (workflow === "audit") return "bg-emerald-500";
  if (workflow === "brand_asset") return "bg-sky-500";
  if (workflow === "doc_converter") return "bg-violet-500";
  if (workflow === "strategist") return "bg-amber-500";
  return "bg-stone-500";
}

function ReadOnlyBadge() {
  return (
    <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-white/20 bg-white px-3 text-xs font-medium text-stone-700 shadow-sm">
      Preview mode
    </span>
  );
}

function RailItem({
  label,
  meta,
  href,
  active,
  disabled,
}: {
  label: string;
  meta?: string;
  href?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  const body = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      {meta ? (
        <span className="ml-auto shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-stone-300">{meta}</span>
      ) : null}
    </>
  );
  const classes = classNames(
    "flex min-h-10 min-w-0 items-center gap-3 rounded-md px-3 text-sm transition",
    active ? "bg-white text-stone-950" : "text-stone-300 hover:bg-white/8 hover:text-white",
    disabled && "cursor-not-allowed text-stone-500 hover:bg-transparent hover:text-stone-500",
  );

  if (href && !disabled) {
    return <a className={classes} href={href}>{body}</a>;
  }
  return <div aria-disabled={disabled ? "true" : undefined} className={classes}>{body}</div>;
}

function RoomNavItem({
  room,
  activeRoom,
  role,
  project,
  meta,
}: {
  room: (typeof ROOMS)[number];
  activeRoom: WorkspaceRoomId;
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
  meta?: string;
}) {
  const active = room.id === activeRoom;

  return (
    <Link
      href={workspaceHref({ room: room.id, role, project })}
      className={classNames(
        "flex min-h-10 min-w-0 items-center gap-3 rounded-md px-3 text-sm transition",
        active ? "bg-white text-stone-950" : "text-stone-300 hover:bg-white/8 hover:text-white",
      )}
    >
      <span className="min-w-0 truncate">{room.label}</span>
      {meta ? (
        <span className={classNames(
          "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px]",
          active ? "bg-stone-100 text-stone-700" : "bg-white/10 text-stone-300",
        )}>
          {meta}
        </span>
      ) : null}
    </Link>
  );
}

function ArtifactResultCard({ group }: { group: ArtifactGroup }) {
  const primary = group.artifacts.find((artifact) => artifact.format === "PDF")
    ?? group.artifacts.find((artifact) => artifact.format === "DOCX")
    ?? group.artifacts[0];
  const formats = [...new Set(group.artifacts.map((artifact) => artifact.format))].slice(0, 5);

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="border-b border-stone-100 bg-stone-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={classNames("h-2 w-2 rounded-full", workflowAccent(group.workflow))} />
          <p className="text-xs font-semibold uppercase text-stone-500">{workspaceFor(group.workflow)}</p>
          <span className="ml-auto rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-700">
            Latest deliverable
          </span>
        </div>
      </div>
      <div className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-base font-semibold text-stone-950" title={group.title}>{group.title}</h3>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Packaged result with the core files grouped together for review.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-700">
          {jobTypeFor(group.workflow)}
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="flex min-w-0 flex-wrap gap-2">
          {formats.map((format) => (
            <span key={format} className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-600">
              {format}
            </span>
          ))}
          <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-600">
            {group.artifacts.length} files
          </span>
        </div>
        <p className="text-xs text-stone-500">
          {primary ? `${formatBytes(primary.sizeBytes)} - ${formatDate(group.updatedAt)}` : formatDate(group.updatedAt)}
        </p>
      </div>
      </div>
    </div>
  );
}

function ArtifactList({ artifacts }: { artifacts: ScannedWorkspaceArtifact[] }) {
  return (
    <div className="grid gap-2">
      {artifacts.map((artifact) => (
        <div
          key={artifact.id}
          className="grid gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-sm transition hover:border-stone-300 sm:grid-cols-[72px_minmax(0,1fr)_108px]"
        >
          <span className="inline-flex h-7 w-fit items-center rounded-md border border-stone-200 bg-stone-50 px-2 text-xs font-semibold text-stone-600">
            {artifact.format}
          </span>
          <div className="min-w-0">
            <p className="line-clamp-1 text-sm font-medium text-stone-950" title={artifact.title}>{artifact.title}</p>
            <p className="mt-1 line-clamp-1 text-xs text-stone-500" title={artifact.relativePath}>{workspaceFor(artifact.inferredWorkflow)}</p>
          </div>
          <div className="text-left text-xs text-stone-500 sm:text-right">
            <p>{formatBytes(artifact.sizeBytes)}</p>
            <p className="mt-1">{formatDate(artifact.modifiedAt)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function JobTimeline({ jobs }: { jobs: WorkspaceJob[] }) {
  return (
    <div className="relative space-y-3 before:absolute before:bottom-4 before:left-[19px] before:top-4 before:w-px before:bg-stone-200 sm:before:left-[25px]">
      {jobs.map((job, index) => (
        <div key={job.id} className="relative rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-[88px_minmax(0,1fr)]">
            <div className="flex items-start gap-3">
              <span className={classNames("relative z-10 mt-1 h-3 w-3 shrink-0 rounded-full ring-4 ring-white", index === 0 ? "bg-emerald-500" : job.status === "collecting" ? "bg-blue-500" : job.status === "ready" ? "bg-stone-400" : "bg-amber-500")} />
              <div>
                <p className="text-xs font-semibold text-stone-500">{job.type}</p>
                <p className="mt-1 text-xs text-stone-500">{formatDate(job.updatedAt)}</p>
              </div>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 text-sm font-semibold text-stone-950" title={job.title}>{job.title}</h3>
                <span className={classNames("rounded-full border px-2 py-0.5 text-[11px] font-medium", statusClasses(job.status))}>
                  {statusLabel(job.status)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-stone-600">{job.currentStep}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                  {job.artifactCount} artifact{job.artifactCount === 1 ? "" : "s"}
                </span>
                {job.formats.slice(0, 3).map((format) => (
                  <span key={format} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                    {format}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function QueueRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-stone-950">{label}</h3>
        <p className="text-2xl font-semibold text-stone-950">{value}</p>
      </div>
      <p className="mt-2 text-sm leading-6 text-stone-600">{detail}</p>
    </div>
  );
}

function EmptyRunState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white/70 p-4 text-sm leading-6 text-stone-600">
      <p className="font-medium text-stone-800">{title}</p>
      <p className="mt-1">{detail}</p>
    </div>
  );
}

function TrialGuidePanel() {
  const checks = [
    {
      name: "Audit readiness",
      focus: "Browse L2 intake status, blocked items, QA state, and generated packages. Audit outputs are intended to appear in Workspace, not external delivery channels.",
    },
    {
      name: "Review queues",
      focus: "Use approval and task surfaces for visibility. Decision and edit controls are not live in this Workspace preview unless they already exist on another Atlas page.",
    },
    {
      name: "Content batches",
      focus: "Check the Content room to see where future batches, scripts, assets, and QA notes will land. There is no live content push from this page.",
    },
    {
      name: "Artifact library",
      focus: "Inspect project, collection, and artifact metadata. Move, rename, archive, attach, share, and export controls remain planned only.",
    },
    {
      name: "Source health",
      focus: "Check missing emitters, invalid record counts, artifact sidecar discovery, and disabled integrations before any live wiring is considered.",
    },
  ];

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-stone-950">How to test Atlas Workspace</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Today this surface is for browsing only. It shows projections from local workflow records and readiness checks; it does not start jobs, wire Typeform, or perform external delivery.
          </p>
        </div>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 text-xs font-medium text-stone-600">
          Read-only trial
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {checks.map((check) => (
          <section key={check.name} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-sm font-semibold text-stone-950">{check.name}</p>
            <p className="mt-1 text-sm leading-6 text-stone-600">{check.focus}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

function ReadinessSignal({
  label,
  active,
  detail,
}: {
  label: string;
  active: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-stone-200 bg-white p-3">
      <span className={classNames("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", active ? "bg-emerald-500" : "bg-stone-300")} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-950">{label}</p>
        <p className="mt-1 text-xs leading-5 text-stone-500">{detail}</p>
      </div>
    </div>
  );
}

function ContractReadinessPanel({ runs }: { runs: WorkspaceRunsProjection }) {
  const stableIds = runs.counts.totalValidRecords > 0;
  const eventsPresent = runs.records.agentRuns.some((run) => run.events.length > 0);
  const artifactsLinked = countLinkedArtifacts(runs) > 0;
  const approvalsLinked = countLinkedApprovals(runs) > 0;
  const validationPresent = [
    ...runs.records.agentRuns,
    ...runs.records.auditRuns,
    ...runs.records.contentBatches,
    ...runs.records.memoryMaintenanceRuns,
  ].some((record) => Boolean(record.validation));

  return (
    <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Contract readiness</p>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            {runs.counts.sourcesPresent} of 5 emitters detected.
          </p>
        </div>
        <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
          Read-only
        </span>
      </div>
      <div className="mt-4 grid gap-2">
        <ReadinessSignal
          label="Stable ids"
          active={stableIds}
          detail={stableIds ? `${runs.counts.totalValidRecords} validated records.` : "No contract records detected yet."}
        />
        <ReadinessSignal
          label="Events present"
          active={eventsPresent}
          detail={eventsPresent ? "Agent timelines can render." : "Awaiting AgentRun event arrays."}
        />
        <ReadinessSignal
          label="Artifacts linked"
          active={artifactsLinked}
          detail={artifactsLinked ? `${countLinkedArtifacts(runs)} artifact references.` : "No contract artifact references yet."}
        />
        <ReadinessSignal
          label="Approvals linked"
          active={approvalsLinked}
          detail={approvalsLinked ? `${countLinkedApprovals(runs)} review references.` : "No related review records yet."}
        />
        <ReadinessSignal
          label="QA present"
          active={validationPresent}
          detail={validationPresent ? "Validation summaries are available." : "No QA summaries emitted yet."}
        />
      </div>
    </section>
  );
}

function AgentActivityPanel({ runs }: { runs: AgentRun[] }) {
  if (!runs.length) {
    return (
      <EmptyRunState
        title="No agent activity records yet"
        detail="The workspace is ready to display validated AgentRun records as soon as workflow emitters produce them."
      />
    );
  }

  return (
    <div className="space-y-3">
      {runs.slice(0, 5).map((run) => (
        <article key={run.id} className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-stone-500">{run.workflow.replaceAll("_", " ")}</p>
              <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-stone-950" title={run.title}>{run.title}</h3>
            </div>
            <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", runStatusClasses(run.status))}>
              {runStatusLabel(run.status)}
            </span>
          </div>
          <div className="mt-3 grid gap-2 text-xs text-stone-500 sm:grid-cols-3">
            <p>{run.currentStep ?? "Step not reported"}</p>
            <p>{run.events.length} event{run.events.length === 1 ? "" : "s"}</p>
            <p>{run.artifacts.length} artifact link{run.artifacts.length === 1 ? "" : "s"}</p>
          </div>
          <p className="mt-3 text-xs text-stone-500">Updated {formatDate(run.updatedAt)}</p>
        </article>
      ))}
    </div>
  );
}

function AuditArtifactStrip({ artifacts }: { artifacts: ArtifactReference[] }) {
  if (!artifacts.length) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/80 p-3 text-sm text-stone-500">
        No artifact references emitted yet.
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {artifacts.slice(0, 4).map((artifact) => (
        <div key={`${artifact.artifactId}-${artifact.role ?? artifact.kind}`} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="line-clamp-1 text-sm font-medium text-stone-900" title={artifact.title ?? artifact.artifactId}>
                {artifact.title ?? artifact.artifactId}
              </p>
              <p className="mt-1 text-xs text-stone-500">{artifact.kind.replaceAll("_", " ")}</p>
            </div>
            <span className="shrink-0 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-600">
              {artifact.validationStatus ?? "unknown"}
            </span>
          </div>
          {artifact.path ? (
            <p className="mt-2 line-clamp-1 text-xs text-stone-500" title={artifact.path}>{artifact.path}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AuditStageTimeline({ stages }: { stages: AuditRun["stages"] }) {
  if (!stages.length) {
    return (
      <div className="rounded-lg border border-dashed border-stone-300 bg-white/70 p-3 text-sm text-stone-500">
        No stage timeline emitted yet.
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {stages.map((stage) => (
        <div key={stage.name} className="rounded-lg border border-stone-200 bg-white p-3">
          <div className="flex items-center gap-2">
            <span className={classNames("h-2.5 w-2.5 rounded-full", stage.status === "completed" ? "bg-emerald-500" : stage.status.startsWith("failed") ? "bg-rose-500" : "bg-blue-500")} />
            <p className="text-xs font-semibold uppercase text-stone-500">{auditStageLabel(stage.name)}</p>
          </div>
          <p className="mt-2 text-sm font-medium text-stone-900">{runStatusLabel(stage.status)}</p>
          <p className="mt-1 text-xs text-stone-500">
            {stage.completedAt ? formatDate(stage.completedAt) : stage.startedAt ? `Started ${formatDate(stage.startedAt)}` : "Not timestamped"}
          </p>
        </div>
      ))}
    </div>
  );
}

function AuditRunCard({ run }: { run: AuditRun }) {
  const reviewer = reviewerStateForAudit(run);
  const hasError = Boolean(run.error || run.validation.failures.length || run.compliance?.failures.length);
  const intakeParts = [
    auditSourceLabel(run.source),
    run.sourceRef ? `Ref ${run.sourceRef}` : null,
    run.docRef ? `Doc ${run.docRef}` : null,
  ].filter(Boolean);

  return (
    <article className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="border-b border-stone-100 bg-stone-50/80 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-stone-500">L2 executive audit</p>
            <h3 className="mt-1 line-clamp-2 text-base font-semibold text-stone-950">
              {run.prospect.businessName ?? run.docRef ?? run.id}
            </h3>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              {run.prospect.summary ?? "No intake summary emitted yet."}
            </p>
          </div>
          <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", runStatusClasses(run.status))}>
            {runStatusLabel(run.status)}
          </span>
        </div>
      </div>

      <div className="space-y-5 p-4">
        <section>
          <div className="flex flex-wrap gap-2">
            {intakeParts.map((part) => (
              <span key={part} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                {part}
              </span>
            ))}
            {run.inputHash ? (
              <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                Input hash present
              </span>
            ) : null}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-stone-950">Status timeline</p>
            <p className="text-xs text-stone-500">Updated {formatDate(run.updatedAt)}</p>
          </div>
          <AuditStageTimeline stages={run.stages} />
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-medium text-stone-500">QA status</p>
            <p className="mt-1 text-sm font-semibold text-stone-950">{validationLabel(run.validation)}</p>
            <p className="mt-1 text-xs text-stone-500">{run.validation.checkedAt ? formatDate(run.validation.checkedAt) : "No QA timestamp"}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-medium text-stone-500">Reviewer</p>
            <p className={classNames("mt-1 text-sm font-semibold", reviewer.required ? "text-amber-800" : "text-stone-950")}>{reviewer.label}</p>
            <p className="mt-1 text-xs text-stone-500">{reviewer.detail}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-medium text-stone-500">Compliance</p>
            <p className="mt-1 text-sm font-semibold text-stone-950">
              {run.compliance ? `${run.compliance.pass ? "Pass" : "Needs work"}${run.compliance.tier ? `, ${run.compliance.tier}` : ""}` : "Not emitted"}
            </p>
            <p className="mt-1 text-xs text-stone-500">
              {run.compliance?.wordCount ? `${run.compliance.wordCount} words` : "No word count"}
            </p>
          </div>
        </section>

        {hasError ? (
          <section className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-sm font-semibold text-rose-900">Blocked or error summary</p>
            {run.error ? <p className="mt-1 text-sm leading-6 text-rose-800">{run.error.message}</p> : null}
            {[...run.validation.failures, ...(run.compliance?.failures ?? [])].slice(0, 3).map((failure) => (
              <p key={failure} className="mt-1 text-sm leading-6 text-rose-800">{failure}</p>
            ))}
          </section>
        ) : null}

        <section>
          <p className="mb-2 text-sm font-semibold text-stone-950">Artifacts and previews</p>
          <AuditArtifactStrip artifacts={run.artifacts} />
        </section>
      </div>
    </article>
  );
}

function AuditReadinessPanel({ runs }: { runs: WorkspaceRunsProjection }) {
  const auditHealth = runs.sources.auditRuns;
  const agentAuditRuns = runs.records.agentRuns.filter((run) => run.workflow === "audit");
  const auditRuns = runs.records.auditRuns;
  const generatorStable = auditRuns.length > 0 && auditHealth.invalidRecordCount === 0;
  const qaHarness = auditRuns.some((run) => run.validation.status !== "unknown" || Boolean(run.compliance));
  const workerScheduler = agentAuditRuns.some((run) => run.events.length > 0 || Boolean(run.heartbeatAt));
  const typeformSeen = auditRuns.some((run) => run.source === "typeform");

  return (
    <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">L2 audit readiness</p>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            Workspace projection only. External delivery remains disabled.
          </p>
        </div>
        <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
          Workspace only
        </span>
      </div>
      <div className="mt-4 grid gap-2">
        <ReadinessSignal
          label="Typeform wiring"
          active={typeformSeen}
          detail={typeformSeen ? "Typeform-sourced audit records detected." : "Not wired in Workspace yet."}
        />
        <ReadinessSignal
          label="Generator stability"
          active={generatorStable}
          detail={sourceHealthLabel(auditHealth.present, auditHealth.validRecordCount, auditHealth.invalidRecordCount)}
        />
        <ReadinessSignal
          label="QA harness"
          active={qaHarness}
          detail={qaHarness ? "Audit validation or compliance summaries present." : "Awaiting QA summaries from the emitter."}
        />
        <ReadinessSignal
          label="Worker and scheduler"
          active={workerScheduler}
          detail={workerScheduler ? "Audit AgentRun heartbeat or events detected." : "No audit worker events detected yet."}
        />
        <ReadinessSignal
          label="Delivery policy"
          active
          detail="Workspace review only; no external Slack, DM, or client delivery controls exist here."
        />
      </div>
    </section>
  );
}

function AuditWorkspacePanel({ runs }: { runs: WorkspaceRunsProjection }) {
  const auditRuns = runs.records.auditRuns;

  if (!auditRuns.length) {
    return (
      <EmptyRunState
        title="No audit submissions yet"
        detail="When the L2 audit emitter produces validated run records, this area will show intake, timeline, QA, artifacts, reviewer state, and any blocked summaries."
      />
    );
  }

  return (
    <div className="grid gap-4">
      {auditRuns.slice(0, 4).map((run) => <AuditRunCard key={run.id} run={run} />)}
    </div>
  );
}

function ContentBatchesPanel({ batches }: { batches: ContentBatch[] }) {
  if (!batches.length) {
    return (
      <EmptyRunState
        title="No content batches yet"
        detail="Corey-facing content packs will appear once the content workflow emits validated batch records."
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {batches.slice(0, 4).map((batch) => (
        <article key={batch.id} className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-stone-500">Week of {batch.weekOf}</p>
              <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-stone-950">{batch.title}</h3>
            </div>
            <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", runStatusClasses(batch.status))}>
              {batch.status.replaceAll("_", " ")}
            </span>
          </div>
          <p className="mt-3 text-sm leading-6 text-stone-600">{batch.theme ?? "Theme not reported"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">{batch.items.length} items</span>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">{batch.frameworkRefs.length} frameworks</span>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">{validationLabel(batch.validation)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function memoryProjectionStatusClasses(status: WorkspaceMemoryMaintenanceProjection["status"]): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "error") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-stone-200 bg-stone-50 text-stone-700";
}

function MemoryMaintenancePanel({
  projection,
  runs,
}: {
  projection: WorkspaceMemoryMaintenanceProjection;
  runs: MemoryMaintenanceRun[];
}) {
  const summary = projection.summary;
  const latestReports = projection.reports.latestReports.slice(0, 5);

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-stone-950">Memory maintenance</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Read-only view of librarian reports, context packs, and review queues. Atlas does not edit notes or apply suggestions from this surface.
          </p>
        </div>
        <span className={classNames("inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs font-medium", memoryProjectionStatusClasses(projection.status))}>
          {projection.status.replaceAll("_", " ")}
        </span>
      </div>

      {projection.status === "not_ready" ? (
        <div className="mt-4">
          <EmptyRunState
            title="No librarian maintenance run emitted yet"
            detail="Prompt 65 can finish independently. When reports, context packs, or review queues appear in the librarian output folders, Workspace will show safe counts and report references here."
          />
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <QueueRow label="Graph health" value={String(summary.notesScanned)} detail={`${summary.brokenLinks} broken links, ${summary.orphanNotes} orphan notes, ${summary.weakNodes} weak nodes.`} />
        <QueueRow label="High-degree hubs" value={String(summary.highDegreeHubs)} detail="Dense or protected notes are counted only; no source bodies are shown." />
        <QueueRow label="Artifact hygiene" value={String(summary.orphanExports)} detail={`${summary.exportsMissingMetadata} exports missing metadata in the latest hygiene report.`} />
        <QueueRow label="Review queue" value={String(summary.reviewQueueItems)} detail={`${summary.riskySuggestions} risky or approval-required suggestions.`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
          <p className="text-sm font-semibold text-stone-950">Context packs</p>
          {projection.reports.contextPacks.length ? (
            <div className="mt-3 grid gap-2">
              {projection.reports.contextPacks.slice(0, 3).map((pack) => (
                <div key={`${pack.id}-${pack.kind}`} className="rounded-md border border-stone-200 bg-white p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="line-clamp-1 text-sm font-medium text-stone-950">{pack.title}</p>
                    <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600">
                      {pack.totalMembers} refs
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {pack.canonicalCount} canonical, {pack.graphConnectedCount} graph, {pack.tagMatchedCount} tag, {pack.keywordInferredCount} keyword.
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm leading-6 text-stone-600">No context packs emitted yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
          <p className="text-sm font-semibold text-stone-950">Latest report references</p>
          {latestReports.length ? (
            <div className="mt-3 space-y-2">
              {latestReports.map((report) => (
                <div key={`${report.kind}-${report.path}`} className="rounded-md border border-stone-200 bg-white p-3">
                  <p className="line-clamp-1 text-sm font-medium text-stone-950">{report.title}</p>
                  <p className="mt-1 text-xs text-stone-500">{formatDate(report.generatedAt)}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm leading-6 text-stone-600">Report references will appear after the librarian writes JSON summaries.</p>
          )}
        </div>
      </div>

      {runs.length ? (
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3">
          <p className="text-sm font-semibold text-stone-950">Contract run records</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {runs.slice(0, 2).map((run) => (
              <div key={run.id} className="rounded-md border border-stone-200 bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-medium text-stone-950">{run.scope} / {run.mode.replaceAll("_", " ")}</p>
                  <span className={classNames("rounded-full border px-2 py-0.5 text-[11px] font-medium", runStatusClasses(run.status))}>
                    {runStatusLabel(run.status)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-stone-500">{run.findings.length} findings, {run.counts.proposedChanges} proposed changes, {run.counts.appliedChanges} applied.</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RelatedRecordsPanel({ runs }: { runs: WorkspaceRunsProjection }) {
  const artifactRefs = [
    ...runs.records.agentRuns.flatMap((run) => run.artifacts),
    ...runs.records.auditRuns.flatMap((run) => run.artifacts),
    ...runs.records.contentBatches.flatMap((batch) => batch.artifacts),
    ...runs.records.memoryMaintenanceRuns.flatMap((run) => run.artifacts),
  ];
  const approvals = runs.records.approvals;

  if (!artifactRefs.length && !approvals.length) {
    return (
      <EmptyRunState
        title="No related contract records yet"
        detail="Related artifacts and review records will collect here when workflow contracts include those references."
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-stone-950">Related artifacts</p>
        <div className="mt-3 space-y-2">
          {artifactRefs.slice(0, 5).map((artifact) => (
            <div key={`${artifact.artifactId}-${artifact.role ?? artifact.kind}`} className="rounded-md bg-stone-50 p-3">
              <p className="line-clamp-1 text-sm font-medium text-stone-800">{artifact.title ?? artifact.artifactId}</p>
              <p className="mt-1 text-xs text-stone-500">{artifact.kind} {artifact.validationStatus ? `- ${artifact.validationStatus}` : ""}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-stone-950">Related reviews</p>
        <div className="mt-3 space-y-2">
          {approvals.slice(0, 5).map((approval) => (
            <div key={approval.id} className="rounded-md bg-stone-50 p-3">
              <p className="line-clamp-1 text-sm font-medium text-stone-800">{approval.subject}</p>
              <p className="mt-1 text-xs text-stone-500">{approval.workspaceStatus.replaceAll("_", " ")} - {approval.actionType.replaceAll("_", " ")}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SandboxBadge() {
  return (
    <span className="inline-flex h-7 items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-medium text-amber-800">
      Sandbox preview
    </span>
  );
}

function RoomHeader({
  room,
  project,
}: {
  room: WorkspaceRoomId;
  project: WorkspaceProjectId;
}) {
  const roomInfo = selectedRoom(room);
  const projectInfo = selectedProject(project);

  return (
    <header className="border-b border-stone-200 bg-[#f4f3ef]/95 px-4 py-5 backdrop-blur sm:px-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-500">{projectInfo.label}</p>
            <h2 className="mt-1 text-2xl font-semibold text-stone-950 sm:text-3xl">{roomInfo.label}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{roomInfo.description}</p>
          </div>
          <Link
            href="/"
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:text-stone-950"
          >
            Mission Control
          </Link>
        </div>
      </div>
    </header>
  );
}

function DataModeBanner({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const hasRunRecords = snapshot.runs.counts.totalValidRecords > 0;

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-stone-950">
            {hasRunRecords ? "Live workspace records detected" : "No live workflow records yet"}
          </p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            {hasRunRecords
              ? `${snapshot.runs.counts.totalValidRecords} validated run records are powering this Workspace view.`
              : "Rooms still render with clearly labelled sandbox previews so the team can understand the target product model without writing runtime data."}
          </p>
        </div>
        <span className={classNames(
          "inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs font-medium",
          hasRunRecords ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-stone-200 bg-stone-50 text-stone-600",
        )}>
          {hasRunRecords ? "Real data" : "Read-only demo"}
        </span>
      </div>
    </section>
  );
}

function MetricStrip({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <QueueRow
        label="Run records"
        value={String(snapshot.runs.counts.totalValidRecords)}
        detail={`${snapshot.runs.counts.sourcesPresent} emitters active, ${snapshot.runs.counts.totalInvalidRecords} invalid.`}
      />
      <QueueRow
        label="Approvals"
        value={String(snapshot.approvals.totalPending)}
        detail={`${snapshot.approvals.draftedSlack} drafts and ${snapshot.approvals.jianActive} Jian/Monday items visible.`}
      />
      <QueueRow
        label="Artifacts"
        value={String(snapshot.artifacts.total)}
        detail={`${snapshot.jobs.ready} work threads have visible result files.`}
      />
      <QueueRow
        label="Follow-ups"
        value={String(snapshot.reaper.totalPending)}
        detail={`${snapshot.reaper.stale} stale, ${snapshot.reaper.withSuggestion} with suggestions.`}
      />
    </section>
  );
}

function SandboxAuditPreview() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Typeform intake to Workspace audit run</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">Example path for the L2 room once emitters write validated records.</p>
        </div>
        <SandboxBadge />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        {[
          ["Intake", "Typeform-like payload lands as a local AuditRun source reference."],
          ["Run", "Worker produces parse, retrieve, generate, render, and validate stages."],
          ["QA", "Harness records pass/fail, compliance tier, and safe blocked summaries."],
          ["Package", "PDF, markdown, validation, and preview artifacts link back here."],
        ].map(([title, detail]) => (
          <div key={title} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-sm font-semibold text-stone-950">{title}</p>
            <p className="mt-1 text-xs leading-5 text-stone-500">{detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SandboxContentPreview() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Corey weekly batch model</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">Future batches will collect hooks, scripts, captions, assets, QA, and review references.</p>
        </div>
        <SandboxBadge />
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
        {[
          ["Week 1", "Positioning clips", "Scripts and hooks ready for review"],
          ["Week 2", "Client proof", "Asset references and captions pending"],
          ["Week 3", "Founder POV", "QA notes and filming prompts"],
        ].map(([week, theme, state]) => (
          <div key={week} className="grid gap-2 border-b border-stone-100 bg-stone-50 px-3 py-3 last:border-b-0 sm:grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)]">
            <p className="text-sm font-semibold text-stone-950">{week}</p>
            <p className="text-sm text-stone-700">{theme}</p>
            <p className="text-sm text-stone-500">{state}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SandboxApprovalPreview() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Pat approval item model</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">Approval records can show exact payload previews, destination, source workflow, and review state without exposing decision controls here.</p>
        </div>
        <SandboxBadge />
      </div>
      <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-3">
        <p className="text-sm font-semibold text-stone-950">Awaiting review</p>
        <p className="mt-1 text-sm leading-6 text-stone-600">Client task update drafted from a workflow record. Destination and payload hash are visible; execution remains disabled in Workspace.</p>
      </div>
    </section>
  );
}

function SandboxArtifactPreview() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Rhys strategic artifact model</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">Saved strategy docs and audit outputs will sit beside work history, source references, and validation status.</p>
        </div>
        <SandboxBadge />
      </div>
      <div className="mt-4 grid gap-2">
        {["Executive audit PDF", "Strategy memo markdown", "Validation report", "Artifact package index"].map((name) => (
          <div key={name} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-sm font-medium text-stone-950">{name}</p>
            <p className="mt-1 text-xs text-stone-500">Preview only until a real artifact reference is emitted.</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function artifactControlRecords(snapshot: WorkspaceSnapshot) {
  const hasRealRecords = snapshot.artifactControl.counts.totalValidRecords > 0;
  return {
    mode: hasRealRecords ? "real" : "fixture",
    projects: hasRealRecords ? snapshot.artifactControl.records.projects : workspaceArtifactControlFixtures.projects,
    collections: hasRealRecords ? snapshot.artifactControl.records.collections : workspaceArtifactControlFixtures.collections,
    artifacts: hasRealRecords ? snapshot.artifactControl.records.artifacts : workspaceArtifactControlFixtures.artifacts,
  };
}

function artifactStatusClasses(status: WorkspaceArtifact["status"]): string {
  if (status === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "ready_for_review") return "border-blue-200 bg-blue-50 text-blue-800";
  if (status === "blocked") return "border-rose-200 bg-rose-50 text-rose-800";
  if (status === "archived") return "border-stone-200 bg-stone-100 text-stone-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function trainingStatusClasses(status: TrainingGroundsSession["status"]): string {
  if (status === "approved") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "needs_review") return "border-blue-200 bg-blue-50 text-blue-800";
  if (status === "archived") return "border-stone-200 bg-stone-100 text-stone-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function trainingGroundsRecords(): TrainingGroundsSession[] {
  return workspaceTrainingGroundsFixtures.sessions.filter((session) => validateTrainingGroundsSession(session).ok);
}

function FileControlRoadmap() {
  const controls = [
    ["Move to project/collection", "Planned"],
    ["Rename", "Planned"],
    ["Archive / unarchive", "Planned"],
    ["Attach to approval", "Planned"],
    ["Share / export", "Disabled"],
  ];

  return (
    <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">File control roadmap</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            These are the eventual Rhys/team organization controls. They are labels only here and do not move, rename, archive, attach, share, export, or write files.
          </p>
        </div>
        <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">Disabled</span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {controls.map(([label, state]) => (
          <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
            <p className="text-sm font-medium text-stone-950">{label}</p>
            <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">{state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ArtifactControlLibrary({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const control = artifactControlRecords(snapshot);
  const byCollection = new Map(control.collections.map((collection) => [collection.id, collection]));
  const byProject = new Map(control.projects.map((project) => [project.id, project]));
  const projectRows = control.projects.map((project) => ({
    project,
    collections: control.collections.filter((collection) => collection.projectId === project.id),
    artifacts: control.artifacts.filter((artifact) => artifact.projectId === project.id),
  }));

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-stone-950">Artifact library control model</p>
            <p className="mt-1 text-sm leading-6 text-stone-600">
              Projects contain jobs, jobs produce artifacts, and artifacts live in predictable collections with metadata, review state, and planned organization controls.
            </p>
          </div>
          {control.mode === "real" ? (
            <span className="inline-flex h-7 items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-800">Real metadata</span>
          ) : (
            <SandboxBadge />
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <QueueRow label="Projects" value={String(control.projects.length)} detail="Saved workspaces and person-specific archives." />
          <QueueRow label="Collections" value={String(control.collections.length)} detail="Audit packages, calls, docs, content, approvals, and memory." />
          <QueueRow label="Artifacts" value={String(control.artifacts.length)} detail="Typed output records with paths and review state." />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-semibold text-stone-950">Project to collection map</p>
          <div className="mt-4 space-y-3">
            {projectRows.map(({ project, collections, artifacts }) => (
              <div key={project.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-stone-950">{project.title}</p>
                    <p className="mt-1 text-xs leading-5 text-stone-500">{project.description}</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-600">
                    {artifacts.length} artifacts
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {collections.map((collection) => (
                    <span key={collection.id} className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
                      {collection.title}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-semibold text-stone-950">Artifact records</p>
          <div className="mt-4 space-y-3">
            {control.artifacts.map((artifact) => {
              const collection = byCollection.get(artifact.collectionId);
              const project = byProject.get(artifact.projectId);
              return (
                <article key={artifact.artifactId} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase text-stone-500">{project?.title ?? artifact.projectId} / {collection?.title ?? artifact.collectionId}</p>
                      <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-stone-950">{artifact.title}</h3>
                    </div>
                    <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", artifactStatusClasses(artifact.status))}>
                      {artifact.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-stone-500 sm:grid-cols-3">
                    <p>{artifact.type}</p>
                    <p>{artifact.sensitivity.replaceAll("_", " ")}</p>
                    <p>{artifact.visibility.replaceAll("_", " ")}</p>
                  </div>
                  <p className="mt-3 line-clamp-1 text-xs text-stone-500" title={artifact.naming.suggestedFolder}>
                    {artifact.naming.suggestedFolder}/{artifact.naming.canonicalName}
                  </p>
                  {artifact.reviewNotes.length ? (
                    <p className="mt-2 text-xs leading-5 text-stone-500">{artifact.reviewNotes[0]}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function TrainingFlowPanel() {
  const steps = [
    ["Start a training session", "Rhys chooses a focus: brain dump, business problem, context challenge, correction loop, or strategy conversation."],
    ["Talk through the mess", "Atlas listens for decisions, operating principles, context gaps, and places where it should challenge more directly."],
    ["Extract learnings", "The session becomes principles, corrections, decisions, playbooks, and proposed memory updates."],
    ["Review what should be saved", "Rhys sees exactly what would become reusable context before anything is promoted."],
    ["Improve Atlas deliberately", "Approved learnings can later become memory or context improvements with clear visibility and permissions."],
  ];

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Training flow</p>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-600">
            Training Grounds is where Rhys teaches Atlas how to think. It is a structured learning room, not a live unrestricted chat surface yet.
          </p>
        </div>
        <SandboxBadge />
      </div>
      <div className="mt-5 grid gap-3 lg:grid-cols-5">
        {steps.map(([title, detail], index) => (
          <article key={title} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-stone-950 text-xs font-semibold text-white">
              {index + 1}
            </span>
            <p className="mt-3 text-sm font-semibold text-stone-950">{title}</p>
            <p className="mt-2 text-xs leading-5 text-stone-500">{detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TrainingSessionArchive({ sessions }: { sessions: TrainingGroundsSession[] }) {
  if (!sessions.length) {
    return (
      <EmptyRunState
        title="No training sessions yet"
        detail="Saved brain dumps, challenges, corrections, and strategy conversations will appear here once a safe session primitive exists."
      />
    );
  }

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Saved training sessions</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Sandbox examples show the future archive shape: title, date, topic, extracted principles, proposed memory updates, and review state.
          </p>
        </div>
        <span className="inline-flex h-7 items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 text-xs font-medium text-stone-600">
          Demo archive
        </span>
      </div>
      <div className="mt-4 space-y-3">
        {sessions.map((session) => (
          <article key={session.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase text-stone-500">
                  {formatDate(session.sessionDate)} / {session.sessionType.replaceAll("_", " ")}
                </p>
                <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-stone-950">{session.title}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">{session.topic}</p>
              </div>
              <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", trainingStatusClasses(session.status))}>
                {session.status.replaceAll("_", " ")}
              </span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-white p-3">
                <p className="text-xs font-medium text-stone-500">Principles</p>
                <p className="mt-1 text-lg font-semibold text-stone-950">{session.extractedPrinciples.length}</p>
              </div>
              <div className="rounded-md bg-white p-3">
                <p className="text-xs font-medium text-stone-500">Memory proposals</p>
                <p className="mt-1 text-lg font-semibold text-stone-950">{session.proposedMemoryUpdates.length}</p>
              </div>
              <div className="rounded-md bg-white p-3">
                <p className="text-xs font-medium text-stone-500">Visibility</p>
                <p className="mt-1 text-sm font-semibold text-stone-950">{session.visibility.replaceAll("_", " ")}</p>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {session.extractedPrinciples.slice(0, 2).map((principle) => (
                <div key={principle.id} className="rounded-md border border-stone-200 bg-white p-3">
                  <p className="text-sm font-medium text-stone-950">{principle.title}</p>
                  <p className="mt-1 text-xs leading-5 text-stone-500">{principle.summary}</p>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TrainingMemoryProposalPanel({ sessions }: { sessions: TrainingGroundsSession[] }) {
  const proposals = sessions.flatMap((session) =>
    session.proposedMemoryUpdates.map((proposal) => ({ ...proposal, sessionTitle: session.title })),
  );

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-stone-950">Proposed memory improvements</p>
      <p className="mt-1 text-sm leading-6 text-stone-600">
        Future training sessions should create reviewable proposals. This room does not change memory or knowledge files.
      </p>
      <div className="mt-4 space-y-2">
        {proposals.slice(0, 5).map((proposal) => (
          <div key={proposal.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase text-stone-500">{proposal.sessionTitle}</p>
                <p className="mt-1 text-sm leading-6 text-stone-700">{proposal.summary}</p>
              </div>
              <span className={classNames(
                "rounded-full border px-2.5 py-1 text-xs font-medium",
                proposal.risk === "high"
                  ? "border-rose-200 bg-rose-50 text-rose-800"
                  : proposal.risk === "medium"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800",
              )}>
                {proposal.risk} risk
              </span>
            </div>
            <p className="mt-2 text-xs text-stone-500">
              Scope: {proposal.targetScope} / Review required: {proposal.requiresReview ? "yes" : "no"} / State: {proposal.status.replaceAll("_", " ")}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TrainingPermissionsPanel() {
  const rows = [
    ["Rhys", "Can create broad training sessions and decide what becomes reusable context."],
    ["Pat", "Can review operational training items tied to approvals, queues, and delivery process."],
    ["Corey", "Can train content preferences in Content or Training Grounds once permissions exist."],
    ["System review", "Can inspect memory safety, context bleed, source visibility, and risky proposals."],
  ];

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-stone-950">Role and permission framing</p>
      <div className="mt-4 space-y-2">
        {rows.map(([role, detail]) => (
          <div key={role} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-sm font-semibold text-stone-950">{role}</p>
            <p className="mt-1 text-xs leading-5 text-stone-500">{detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TrainingGuardrailPanel({ sessions }: { sessions: TrainingGroundsSession[] }) {
  const sourceRefs = sessions.flatMap((session) => session.sourceContextUsed).slice(0, 5);
  const guardrails = [
    ["Automatic memory overwrite", "Disabled"],
    ["High-risk memory changes", "Review required"],
    ["Client/team visibility", "Explicit only"],
    ["Source context used", "Visible in session packet"],
    ["Live chat session primitive", "Not wired"],
  ];

  return (
    <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
      <p className="text-sm font-semibold text-stone-950">Training guardrails</p>
      <div className="mt-4 grid gap-2">
        {guardrails.map(([label, state]) => (
          <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
            <p className="text-sm font-medium text-stone-950">{label}</p>
            <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">{state}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-stone-200 bg-white p-3">
        <p className="text-sm font-semibold text-stone-950">Visible source context</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {sourceRefs.map((ref) => (
            <span key={`${ref.system}-${ref.ref}`} className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">
              {ref.label ?? ref.ref}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function SandboxBlockedRunPreview() {
  return (
    <section className="rounded-lg border border-rose-200 bg-rose-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-rose-950">Blocked run with recovery note</p>
          <p className="mt-1 text-sm leading-6 text-rose-800">
            Example blocked state: generator output failed QA. Recovery note asks the operator to inspect validation failures before another worker pass is allowed.
          </p>
        </div>
        <SandboxBadge />
      </div>
    </section>
  );
}

function GuardrailPanel() {
  const guardrails = [
    ["Typeform wiring", "Disabled"],
    ["Worker daemon", "Disabled"],
    ["Sends", "Disabled"],
    ["Approvals", "Read-only in Workspace"],
    ["Role auth", "Planned"],
  ];

  return (
    <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
      <p className="text-sm font-semibold text-stone-950">Guardrails</p>
      <div className="mt-4 grid gap-2">
        {guardrails.map(([label, state]) => (
          <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
            <p className="text-sm font-medium text-stone-950">{label}</p>
            <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">{state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceHealthPanel({ runs }: { runs: WorkspaceRunsProjection }) {
  const sources = Object.values(runs.sources);

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-stone-950">Source health</p>
      <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
        {sources.map((source) => (
          <div key={source.collection} className="grid gap-2 border-b border-stone-100 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_90px_90px_110px]">
            <p className="text-sm font-medium text-stone-950">{source.collection.replaceAll(/([A-Z])/g, " $1")}</p>
            <p className="text-sm text-stone-500">{source.present ? "Present" : "Missing"}</p>
            <p className="text-sm text-stone-500">{source.validRecordCount} valid</p>
            <p className={classNames("text-sm", source.invalidRecordCount > 0 ? "text-rose-700" : "text-stone-500")}>{source.invalidRecordCount} invalid</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ArtifactControlSourceHealthPanel({ artifactControl }: { artifactControl: WorkspaceArtifactControlProjection }) {
  const discovery = artifactControl.discovery.counts;

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-stone-950">Artifact control metadata</p>
      <p className="mt-1 text-sm leading-6 text-stone-600">
        Reads optional project, collection, artifact metadata, real sidecars, and delivery ledgers. Missing sources are safe and do not trigger file changes.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <QueueRow label="Projects" value={String(artifactControl.counts.projects)} detail={`${artifactControl.sources.projects.invalidRecordCount} invalid records.`} />
        <QueueRow label="Collections" value={String(artifactControl.counts.collections)} detail={`${artifactControl.sources.collections.invalidRecordCount} invalid records.`} />
        <QueueRow label="Artifacts" value={String(artifactControl.counts.artifacts)} detail={`${artifactControl.sources.artifacts.invalidRecordCount} invalid records.`} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {[
          ["Real sidecars", discovery.realMetadataRecordsFound],
          ["Files matched", discovery.exportFilesMatched],
          ["Missing paths", discovery.missingSidecars],
          ["Orphan exports", discovery.orphanExports],
          ["Duplicate ids", discovery.duplicateArtifactIds],
          ["Fixture fallback", discovery.fixtureFallbackCount],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-sm font-medium text-stone-950">{label}</p>
            <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">{value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function HomeRoom({
  snapshot,
}: {
  snapshot: WorkspaceSnapshot;
}) {
  return (
    <div className="space-y-5">
      <DataModeBanner snapshot={snapshot} />
      <MetricStrip snapshot={snapshot} />
      <TrialGuidePanel />
      <section className="grid gap-4 xl:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold text-stone-950">Recent work history</p>
          <JobTimeline jobs={snapshot.jobs.recent} />
        </div>
        <div className="space-y-4">
          {snapshot.artifacts.latestAudit ? <ArtifactResultCard group={snapshot.artifacts.latestAudit} /> : <SandboxArtifactPreview />}
          <SandboxBlockedRunPreview />
        </div>
      </section>
    </div>
  );
}

function AuditsRoom({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="space-y-5">
      <AuditReadinessPanel runs={snapshot.runs} />
      <AuditWorkspacePanel runs={snapshot.runs} />
      {!snapshot.runs.records.auditRuns.length ? <SandboxAuditPreview /> : null}
      <SandboxBlockedRunPreview />
    </div>
  );
}

function ContentRoom({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="space-y-5">
      <ContentBatchesPanel batches={snapshot.runs.records.contentBatches} />
      {!snapshot.runs.records.contentBatches.length ? <SandboxContentPreview /> : null}
      <RelatedRecordsPanel runs={snapshot.runs} />
    </div>
  );
}

function ApprovalsRoom({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2">
        <QueueRow
          label="Comms review"
          value={String(snapshot.approvals.slackVisible)}
          detail={`${snapshot.approvals.draftedSlack} ready drafts, ${snapshot.approvals.heldSlack} held for context.`}
        />
        <QueueRow
          label="Jian and Monday"
          value={String(snapshot.approvals.jianActive)}
          detail="Client delivery items waiting for exact review."
        />
      </section>
      <RelatedRecordsPanel runs={snapshot.runs} />
      {!snapshot.runs.records.approvals.length ? <SandboxApprovalPreview /> : null}
    </div>
  );
}

function AgentRunsRoom({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="space-y-5">
      <AgentActivityPanel runs={snapshot.runs.records.agentRuns} />
      <section>
        <p className="mb-2 text-sm font-semibold text-stone-950">Artifact-derived work history</p>
        <JobTimeline jobs={snapshot.jobs.recent} />
      </section>
      <SandboxBlockedRunPreview />
    </div>
  );
}

function KnowledgeRoom({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="space-y-5">
      <ArtifactControlLibrary snapshot={snapshot} />
      <MemoryMaintenancePanel projection={snapshot.memoryMaintenance} runs={snapshot.runs.records.memoryMaintenanceRuns} />
      <FileControlRoadmap />
      <SandboxArtifactPreview />
      <section>
        <p className="mb-2 text-sm font-semibold text-stone-950">Recent artifacts</p>
        {snapshot.artifacts.recent.length ? <ArtifactList artifacts={snapshot.artifacts.recent} /> : <EmptyRunState title="No artifacts indexed" detail="The artifact room is ready for Rhys docs, audit packages, and memory reports once files are projected." />}
      </section>
    </div>
  );
}

function TrainingGroundsRoom() {
  const sessions = trainingGroundsRecords();

  return (
    <div className="space-y-5">
      <TrainingFlowPanel />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <TrainingSessionArchive sessions={sessions} />
        <div className="space-y-5">
          <TrainingGuardrailPanel sessions={sessions} />
          <TrainingPermissionsPanel />
        </div>
      </div>
      <TrainingMemoryProposalPanel sessions={sessions} />
    </div>
  );
}

function TeamRoom({
  snapshot,
}: {
  snapshot: WorkspaceSnapshot;
}) {
  return (
    <div className="space-y-5">
      <TrialGuidePanel />
      <ContractReadinessPanel runs={snapshot.runs} />
      <ArtifactControlSourceHealthPanel artifactControl={snapshot.artifactControl} />
    </div>
  );
}

function ReadinessRoom({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <div className="space-y-5">
      <ContractReadinessPanel runs={snapshot.runs} />
      <AuditReadinessPanel runs={snapshot.runs} />
      <MemoryMaintenancePanel projection={snapshot.memoryMaintenance} runs={snapshot.runs.records.memoryMaintenanceRuns} />
      <SourceHealthPanel runs={snapshot.runs} />
      <ArtifactControlSourceHealthPanel artifactControl={snapshot.artifactControl} />
      <GuardrailPanel />
    </div>
  );
}

function WorkspaceOperationsRail({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const artifactDiscovery = snapshot.artifactControl.discovery.counts;
  const memorySummary = snapshot.memoryMaintenance.summary;
  const recentArtifacts = artifactControlRecords(snapshot).artifacts.slice(0, 3);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
        <p className="text-sm font-semibold text-stone-950">Workspace health</p>
        <dl className="mt-4 grid grid-cols-2 gap-3">
          {[
            ["Run records", snapshot.runs.counts.totalValidRecords],
            ["Artifacts", snapshot.artifactControl.counts.artifacts],
            ["Librarian", snapshot.memoryMaintenance.status],
            ["Invalid", snapshot.artifactControl.counts.totalInvalidRecords],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-white p-3">
              <dt className="text-xs font-medium text-stone-500">{label}</dt>
              <dd className="mt-1 text-xl font-semibold text-stone-950">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs leading-5 text-stone-500">Read-only projection. Controls that would change files or external systems remain disabled.</p>
      </section>

      <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
        <p className="text-sm font-semibold text-stone-950">Memory source health</p>
        <div className="mt-4 space-y-2">
          {[
            ["Notes scanned", memorySummary.notesScanned],
            ["Broken links", memorySummary.brokenLinks],
            ["Context packs", memorySummary.contextPacksGenerated],
            ["Risky suggestions", memorySummary.riskySuggestions],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
              <p className="text-sm font-medium text-stone-950">{label}</p>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
        <p className="text-sm font-semibold text-stone-950">Artifact source health</p>
        <div className="mt-4 space-y-2">
          {[
            ["Real metadata records", artifactDiscovery.realMetadataRecordsFound],
            ["Export files matched", artifactDiscovery.exportFilesMatched],
            ["Missing file paths", artifactDiscovery.missingSidecars],
            ["Orphan exports", artifactDiscovery.orphanExports],
            ["Duplicate ids", artifactDiscovery.duplicateArtifactIds],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
              <p className="text-sm font-medium text-stone-950">{label}</p>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
        <p className="text-sm font-semibold text-stone-950">Recent artifact records</p>
        <div className="mt-4 space-y-2">
          {recentArtifacts.length ? recentArtifacts.map((artifact) => (
            <div key={artifact.artifactId} className="rounded-lg border border-stone-200 bg-white p-3">
              <p className="line-clamp-2 text-sm font-medium text-stone-950">{artifact.title}</p>
              <p className="mt-1 text-xs text-stone-500">{artifact.status.replaceAll("_", " ")} / {artifact.type}</p>
            </div>
          )) : (
            <p className="text-sm leading-6 text-stone-600">No artifact metadata records found yet.</p>
          )}
        </div>
      </section>

      <section id="reaper" className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
        <p className="text-sm font-semibold text-stone-950">Follow-up triage</p>
        <dl className="mt-4 grid grid-cols-2 gap-3">
          {[
            ["Pending", snapshot.reaper.totalPending],
            ["Stale", snapshot.reaper.stale],
            ["Ancient", snapshot.reaper.ancient],
            ["Drafted", snapshot.reaper.withDraft],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-white p-3">
              <dt className="text-xs font-medium text-stone-500">{label}</dt>
              <dd className="mt-1 text-xl font-semibold text-stone-950">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs leading-5 text-stone-500">Updated {formatDate(snapshot.reaper.updatedAt)}.</p>
      </section>
    </div>
  );
}

function RoomContent({
  room,
  snapshot,
}: {
  room: WorkspaceRoomId;
  snapshot: WorkspaceSnapshot;
}) {
  if (room === "audits") return <AuditsRoom snapshot={snapshot} />;
  if (room === "content") return <ContentRoom snapshot={snapshot} />;
  if (room === "approvals") return <ApprovalsRoom snapshot={snapshot} />;
  if (room === "agent-runs") return <AgentRunsRoom snapshot={snapshot} />;
  if (room === "training") return <TrainingGroundsRoom />;
  if (room === "knowledge") return <KnowledgeRoom snapshot={snapshot} />;
  if (room === "team") return <TeamRoom snapshot={snapshot} />;
  if (room === "readiness") return <ReadinessRoom snapshot={snapshot} />;
  return <HomeRoom snapshot={snapshot} />;
}

function Composer() {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-stone-200 bg-[#f4f3ef]/95 px-4 py-3 backdrop-blur sm:px-6 lg:left-[260px] lg:right-[320px]">
      <div className="mx-auto max-w-3xl rounded-lg border border-stone-300 bg-white p-3 shadow-xl shadow-stone-900/15">
        <textarea
          aria-label="Atlas composer preview"
          className="min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-stone-600 outline-none placeholder:text-stone-400 disabled:cursor-not-allowed sm:min-h-16"
          disabled
          placeholder="Ask Atlas to build an audit, content pack, playbook, Monday plan, or follow-up..."
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 px-2 pt-2 sm:pt-3">
          <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">
            Audit
          </span>
          <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">
            Content pack
          </span>
          <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">
            Monday plan
          </span>
          <span className="hidden rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600 sm:inline-flex">
            Follow-up
          </span>
          <span className="ml-auto rounded-full bg-stone-950 px-2.5 py-1 text-xs font-medium text-white">
            Locked
          </span>
        </div>
      </div>
    </div>
  );
}

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams?: Promise<WorkspaceSearchParams>;
}) {
  const snapshot = await getWorkspaceSnapshot();
  const params = searchParams ? await searchParams : {};
  const { room, role, project } = getWorkspaceSelection(params);
  const roomMeta = {
    home: String(snapshot.runs.counts.totalValidRecords),
    audits: String(snapshot.runs.counts.auditRuns),
    content: String(snapshot.runs.counts.contentBatches),
    approvals: String(snapshot.approvals.totalPending),
    "agent-runs": String(snapshot.runs.counts.agentRuns),
    training: String(trainingGroundsRecords().length),
    knowledge: String(
      snapshot.runs.counts.memoryMaintenanceRuns +
      snapshot.artifacts.total +
      snapshot.artifactControl.counts.artifacts +
      snapshot.memoryMaintenance.summary.contextPacksGenerated,
    ),
    team: "Guide",
    readiness: `${snapshot.runs.counts.sourcesPresent + snapshot.artifactControl.counts.sourcesPresent + Object.values(snapshot.memoryMaintenance.sources).filter((source) => source.present).length}/12`,
  } satisfies Record<WorkspaceRoomId, string>;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f4f3ef] text-stone-950">
      <div className="mx-auto min-h-screen max-w-[1760px] lg:grid lg:grid-cols-[280px_minmax(0,1fr)_340px]">
        <aside className="border-b border-stone-800 bg-[#171716] px-4 py-4 text-white lg:min-h-screen lg:border-b-0 lg:px-3">
          <div className="flex items-center justify-between gap-3 lg:block">
            <div>
              <p className="text-xs font-semibold text-stone-400">Atlas</p>
              <h1 className="mt-1 text-lg font-semibold">Workspace</h1>
            </div>
            <ReadOnlyBadge />
          </div>

          <nav className="mt-5 grid gap-2 sm:grid-cols-2 md:grid-cols-4 lg:block lg:space-y-1" aria-label="Workspace rooms">
            {ROOMS.map((candidate) => (
              <RoomNavItem
                key={candidate.id}
                room={candidate}
                activeRoom={room}
                role={role}
                project={project}
                meta={roomMeta[candidate.id]}
              />
            ))}
          </nav>

          <div className="mt-6 hidden lg:block">
            <p className="px-3 text-xs font-medium text-stone-500">Saved workspaces</p>
            <div className="mt-2 space-y-1">
              {PROJECTS.map((candidate) => (
                <RailItem
                  key={candidate.id}
                  label={candidate.label}
                  href={workspaceHref({ room, role, project: candidate.id })}
                  active={candidate.id === project}
                />
              ))}
            </div>
          </div>

          <div className="mt-8 hidden rounded-lg border border-white/10 bg-white/5 p-3 lg:block">
            <p className="text-xs text-stone-400">Last refreshed</p>
            <p className="mt-1 text-sm font-medium text-stone-200">{formatDate(snapshot.generatedAt)}</p>
          </div>
        </aside>

        <section className="min-w-0 border-stone-200 lg:border-x">
          <RoomHeader room={room} project={project} />

          <div className="mx-auto max-w-5xl px-4 pb-44 pt-6 sm:px-6">
            <RoomContent room={room} snapshot={snapshot} />
          </div>

          <div id="composer">
            <Composer />
          </div>
        </section>

        <aside className="bg-[#eeece7] px-4 py-5 pb-44 sm:px-6 lg:min-h-screen lg:pb-5">
          <WorkspaceOperationsRail snapshot={snapshot} />
        </aside>
      </div>
    </main>
  );
}
