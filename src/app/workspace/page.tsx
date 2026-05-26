/* eslint-disable @typescript-eslint/no-unused-vars */
import Link from "next/link";
import type { Viewport } from "next";
import type { ReactNode } from "react";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import WorkspaceComposer from "./WorkspaceComposer";
import WorkspaceLocalJobControls from "./WorkspaceLocalJobControls";
import WorkspaceWorkerHandoff from "./WorkspaceWorkerHandoff";
import { groupArtifacts, getWorkspaceArtifacts } from "@/app/api/workspace/_lib/artifact-projection";
import type { ArtifactGroup, WorkspaceArtifact as ScannedWorkspaceArtifact } from "@/app/api/workspace/_lib/artifact-projection";
import { buildReaperData } from "@/lib/reaper";
import { getWorkspaceArtifactControlProjection } from "@/lib/workspace-artifact-control-projection";
import type { WorkspaceArtifactControlProjection } from "@/lib/workspace-artifact-control-projection";
import {
  buildWorkspaceLocalWorkerPackage,
  formatWorkspaceLocalWorkerPackage,
  getWorkspaceLocalJobs,
  WORKSPACE_LOCAL_JOB_PROJECTS as LOCAL_JOB_PROJECT_IDS,
  WORKSPACE_LOCAL_JOB_ROOMS as LOCAL_JOB_ROOM_IDS,
} from "@/lib/workspace-local-jobs";
import type { WorkspaceLocalJob, WorkspaceLocalJobsProjection, WorkspaceLocalWorkerPackageContextSummary } from "@/lib/workspace-local-jobs";
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
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const SLACK_QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";
const JIAN_APPROVALS_FILE = "/Users/atlasai/.openclaw/data/pending-approvals.json";

const VISIBLE_SLACK_STATUSES = new Set(["pending", "needs_draft", "drafted", "send_failed", "held"]);
const ACTIVE_JIAN_STATUSES = new Set(["pending", "redirected"]);

type JobStatus = "ready" | "collecting" | "needs_review";
type JobLoopStageState = "complete" | "current" | "locked";

type WorkStreamItem = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
  updatedAt: string | null;
  source: "real" | "sandbox";
  href?: string;
  localJob?: WorkspaceLocalJob;
};

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
  localJobs: WorkspaceLocalJobsProjection;
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
  | "delivery-ops"
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
  { id: "content", label: "Content", description: "Weekly batches, scripts, frameworks, and assets." },
  { id: "approvals", label: "Approvals", description: "Review queues and read-only approval visibility." },
  { id: "agent-runs", label: "Agent Runs", description: "Agent work history, blocked runs, events, and recovery notes." },
  { id: "training", label: "Training Grounds", description: "Structured brain dumps, challenges, and reviewable learning packets." },
  { id: "knowledge", label: "Knowledge", description: "Memory maintenance, strategy docs, and artifact archives." },
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
  { id: "delivery-ops", label: "Delivery Ops", detail: "Task delivery visibility and review state." },
  { id: "memory-knowledge", label: "Memory/Knowledge", detail: "Librarian runs, saved docs, and knowledge health." },
];

const ROOM_IDS = new Set(ROOMS.map((room) => room.id));
const ROLE_IDS = new Set<WorkspaceRoleId>(["rhys", "pat", "corey", "jian", "dante"]);
const PROJECT_IDS = new Set(PROJECTS.map((project) => project.id));
const SHELL_ROOM_IDS: WorkspaceRoomId[] = ["home", "audits", "content", "approvals", "agent-runs", "training", "knowledge"];
const UTILITY_ROOM_IDS: WorkspaceRoomId[] = ["readiness"];
const LOCKED_LOCAL_ACTIONS = [
  "Worker run unavailable",
  "File attach unavailable",
  "Assignment unavailable",
  "External send unavailable",
];

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
  if (status === "ready") return `Existing artifact metadata includes ${formats.slice(0, 3).join(", ") || "artifact"} output`;
  if (status === "needs_review") return "Needs review before it is promoted into the workspace history";
  return "Metadata is incomplete; no worker is collecting files from this surface";
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
  const [slackQueue, jianApprovals, artifacts, runs, artifactControl, memoryMaintenance, localJobs] = await Promise.all([
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
    getWorkspaceLocalJobs(),
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
    localJobs,
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

function buildWorkerPackageContextSummary(snapshot: WorkspaceSnapshot): WorkspaceLocalWorkerPackageContextSummary {
  return {
    generatedAt: snapshot.generatedAt,
    localJobs: {
      active: snapshot.localJobs.records.length,
      archived: snapshot.localJobs.archivedRecords.length,
      controls: snapshot.localJobs.health.controlRecordCount,
    },
    artifacts: {
      total: snapshot.artifacts.total,
      recentTitles: snapshot.artifacts.recent.slice(0, 5).map((artifact) => artifact.title),
      latestAuditTitle: snapshot.artifacts.latestAudit?.title ?? null,
    },
    memory: {
      status: snapshot.memoryMaintenance.status,
      contextPacks: snapshot.memoryMaintenance.summary.contextPacksGenerated,
      reviewItems: snapshot.memoryMaintenance.summary.reviewQueueItems,
    },
    runs: {
      validRecords: snapshot.runs.counts.totalValidRecords,
      sourcesPresent: snapshot.runs.counts.sourcesPresent,
    },
    approvals: {
      pending: snapshot.approvals.totalPending,
      slackVisible: snapshot.approvals.slackVisible,
      taskReviews: snapshot.approvals.jianActive,
    },
    readiness: {
      localJobSource: snapshot.localJobs.file,
      artifactRecords: snapshot.artifactControl.counts.artifacts,
      externalSystems: "not_connected",
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
  job,
}: {
  room: WorkspaceRoomId;
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
  job?: string;
}): string {
  const params = new URLSearchParams({ room, role, project });
  if (job) params.set("job", job);
  return `/workspace?${params.toString()}`;
}

function selectedProject(projectId: WorkspaceProjectId) {
  return PROJECTS.find((project) => project.id === projectId) ?? PROJECTS[0];
}

function selectedRoom(roomId: WorkspaceRoomId) {
  return ROOMS.find((room) => room.id === roomId) ?? ROOMS[0];
}

function displayProjectLabel(projectId: string): string {
  return PROJECTS.find((project) => project.id === projectId)?.label ?? projectId;
}

function displayRoomLabel(roomId: string): string {
  return ROOMS.find((room) => room.id === roomId)?.label ?? roomId;
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
  if (status === "ready") return "Metadata ready";
  if (status === "collecting") return "Metadata partial";
  return "Review";
}

function workStreamStatusClasses(status: string): string {
  if (/ready|delivered|complete|approved|archived/i.test(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (/review|blocked|held|warning|failed/i.test(status)) return "border-amber-200 bg-amber-50 text-amber-800";
  if (/running|working|collecting|draft/i.test(status)) return "border-blue-200 bg-blue-50 text-blue-800";
  return "border-stone-200 bg-stone-50 text-stone-700";
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
    <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-white/10 bg-white/5 px-2.5 text-[11px] font-medium text-stone-300">
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
    "flex min-h-8 min-w-[132px] items-center gap-2 rounded-md px-2.5 text-sm transition lg:min-w-0",
    active ? "bg-white/10 text-white" : "text-stone-400 hover:bg-white/[0.06] hover:text-stone-100",
    disabled && "cursor-not-allowed text-stone-600 hover:bg-transparent hover:text-stone-600",
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
        "flex min-h-8 min-w-[132px] items-center gap-2 rounded-md px-2.5 text-sm transition lg:min-w-0",
        active ? "bg-white/10 text-white" : "text-stone-400 hover:bg-white/[0.06] hover:text-stone-100",
      )}
    >
      <span className="min-w-0 truncate">{room.label}</span>
      {meta ? (
        <span className={classNames(
          "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px]",
          active ? "bg-white/10 text-stone-200" : "bg-white/[0.06] text-stone-500",
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
    <div className="mt-4 overflow-hidden rounded-lg border border-white/10 bg-white/[0.035]">
      <div className="border-b border-white/10 bg-white/[0.025] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={classNames("h-2 w-2 rounded-full", workflowAccent(group.workflow))} />
          <p className="text-xs font-semibold uppercase text-stone-500">{workspaceFor(group.workflow)}</p>
          <span className="ml-auto rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
            Latest deliverable
          </span>
        </div>
      </div>
      <div className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-base font-semibold text-stone-100" title={group.title}>{group.title}</h3>
          <p className="mt-2 text-sm leading-6 text-stone-400">
            Packaged result with the core files grouped together for review.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          {jobTypeFor(group.workflow)}
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="flex min-w-0 flex-wrap gap-2">
          {formats.map((format) => (
            <span key={format} className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-medium text-stone-400">
              {format}
            </span>
          ))}
          <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs font-medium text-stone-400">
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

function WorkbenchStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
      <p className="text-sm font-semibold text-stone-950">{label}</p>
      <p className="mt-2 break-words text-xl font-semibold leading-tight text-stone-950">{value}</p>
      <p className="mt-2 text-sm leading-6 text-stone-600">{detail}</p>
    </div>
  );
}

function EmptyRunState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.025] p-4 text-sm leading-6 text-stone-500">
      <p className="font-medium text-stone-200">{title}</p>
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
          label="Typeform source visibility"
          active={typeformSeen}
          detail={typeformSeen ? "Typeform-sourced audit records are visible." : "No Typeform source records visible in Workspace yet."}
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
          label="Worker record visibility"
          active={workerScheduler}
          detail={workerScheduler ? "Audit AgentRun heartbeat or events detected." : "No audit worker records visible yet."}
        />
        <ReadinessSignal
          label="Delivery policy"
          active
          detail="Workspace review only; external notification and client delivery controls are not part of this surface."
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
        detail="Content packs will appear once the content workflow emits validated batch records."
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

function DataModeBanner({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const hasRunRecords = snapshot.runs.counts.totalValidRecords > 0;

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-stone-950">
            {hasRunRecords ? "Validated workspace records detected" : "No workflow records yet"}
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
          {hasRunRecords ? "Read-only records" : "Read-only demo"}
        </span>
      </div>
    </section>
  );
}

function latestArtifactControlItems(snapshot: WorkspaceSnapshot): WorkspaceArtifact[] {
  return artifactControlRecords(snapshot).artifacts
    .filter((artifact) => artifact.status !== "archived")
    .slice(0, 3);
}

function buildWorkStreamItems(snapshot: WorkspaceSnapshot): WorkStreamItem[] {
  const localItems = snapshot.localJobs.records.slice(0, 5).map((job) => ({
    id: job.id,
    kind: job.intendedWorkflow.replaceAll("_", " "),
    title: job.title,
    detail: job.prompt,
    status: `${job.status.replaceAll("_", " ")} / ${job.execution.state.replaceAll("_", " ")}`,
    updatedAt: job.updatedAt,
    source: "real" as const,
    href: workspaceHref({
      room: ROOM_IDS.has(job.room as WorkspaceRoomId) ? job.room as WorkspaceRoomId : "home",
      role: "rhys",
      project: PROJECT_IDS.has(job.project as WorkspaceProjectId) ? job.project as WorkspaceProjectId : "undeniable-os",
      job: job.id,
    }),
    localJob: job,
  }));
  const agentItems = snapshot.runs.records.agentRuns.slice(0, 3).map((run) => ({
    id: run.id,
    kind: run.workflow.replaceAll("_", " "),
    title: run.title,
    detail: run.currentStep ?? `${run.events.length} timeline events and ${run.artifacts.length} artifact links.`,
    status: runStatusLabel(run.status),
    updatedAt: run.updatedAt,
    source: "real" as const,
    href: workspaceHref({ room: "agent-runs", role: "rhys", project: "undeniable-os" }),
  }));
  const jobItems = snapshot.jobs.recent.slice(0, 4).map((job) => ({
    id: job.id,
    kind: job.type,
    title: job.title,
    detail: job.currentStep,
    status: statusLabel(job.status),
    updatedAt: job.updatedAt,
    source: "real" as const,
    href: workspaceHref({ room: "agent-runs", role: "rhys", project: "undeniable-os" }),
  }));
  const artifactItems = latestArtifactControlItems(snapshot).map((artifact) => ({
    id: artifact.artifactId,
    kind: artifact.type.replaceAll("_", " "),
    title: artifact.title,
    detail: artifact.reviewNotes[0] ?? `${artifact.naming.suggestedFolder}/${artifact.naming.canonicalName}`,
    status: artifact.status.replaceAll("_", " "),
    updatedAt: artifact.updatedAt,
    source: "real" as const,
    href: workspaceHref({ room: "knowledge", role: "rhys", project: "memory-knowledge" }),
  }));
  const realItems = [...localItems, ...agentItems, ...jobItems, ...artifactItems]
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));

  if (realItems.length) return realItems.slice(0, 6);

  return [
    {
      id: "sandbox-audit-loop",
      kind: "Audit",
      title: "L2 audit package",
      detail: "Intake, generation, QA, and artifact package will appear as one traceable work thread.",
      status: "Sandbox review",
      updatedAt: snapshot.generatedAt,
      source: "sandbox",
      href: workspaceHref({ room: "audits", role: "rhys", project: "l2-audits" }),
    },
    {
      id: "sandbox-training-loop",
      kind: "Training",
      title: "End-of-day training session",
      detail: "Brain dump becomes principles, decisions, corrections, and reviewable memory proposals.",
      status: "Locked preview",
      updatedAt: snapshot.generatedAt,
      source: "sandbox",
      href: workspaceHref({ room: "training", role: "rhys", project: "undeniable-os" }),
    },
  ];
}

function WorkbenchIntro({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const hasRealRecords =
    snapshot.localJobs.health.validRecordCount > 0 ||
    snapshot.runs.counts.totalValidRecords > 0 ||
    snapshot.artifactControl.counts.artifacts > 0 ||
    snapshot.jobs.total > 0;

  return (
    <section className="w-full max-w-full overflow-hidden rounded-lg border border-stone-300 bg-white p-4 shadow-sm sm:p-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600">
              Atlas workbench
            </span>
            <span className={classNames(
              "rounded-full border px-2.5 py-1 text-xs font-medium",
              hasRealRecords ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800",
            )}>
              {hasRealRecords ? "Reading live records" : "Sandbox examples visible"}
            </span>
          </div>
          <h3 className="mt-4 max-w-2xl break-words text-2xl font-semibold tracking-normal text-stone-950 sm:text-3xl">
            Draft locally, inspect records, keep execution locked.
          </h3>
          <p className="mt-3 max-w-3xl break-words text-sm leading-6 text-stone-600">
            Workspace is becoming the place where Atlas receives work, shows its plan, surfaces existing artifacts, and asks for review. Execution, delivery, and file operations are locked until the backend safety loop is ready.
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <WorkbenchStat label="Local drafts" value={String(snapshot.localJobs.health.validRecordCount)} detail="Queued here only. No execution." />
            <WorkbenchStat label="Artifacts" value={String(snapshot.artifactControl.counts.artifacts)} detail={`${snapshot.artifactControl.discovery.counts.realMetadataRecordsFound} real metadata sidecars.`} />
            <WorkbenchStat label="Memory health" value={snapshot.memoryMaintenance.status} detail={`${snapshot.memoryMaintenance.summary.contextPacksGenerated} context packs indexed.`} />
          </div>
        </div>

        <div className="rounded-lg border border-stone-200 bg-[#f8f7f4] p-4">
          <p className="text-sm font-semibold text-stone-950">Local draft intents</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">The composer saves a Workspace draft record only. Running, assignment, file attachment, and delivery stay locked.</p>
          <div className="mt-4 grid gap-2">
            {["Ask Atlas", "Audit draft", "Content draft", "Call archive draft", "Training draft"].map((intent) => (
              <div key={intent} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2.5">
                <p className="text-sm font-medium text-stone-950">{intent}</p>
                <span className="rounded-full bg-stone-950 px-2.5 py-1 text-xs font-medium text-white">Draft only</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function WorkStreamPanel({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const items = buildWorkStreamItems(snapshot);

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Work stream</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">Recent jobs, run records, and artifacts collected into one operational feed.</p>
        </div>
        {items.some((item) => item.source === "sandbox") ? <SandboxBadge /> : (
          <span className="inline-flex h-7 items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-800">Real records</span>
        )}
      </div>
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <article key={item.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase text-stone-500">{item.kind} / {item.source === "real" ? "read-only record" : "sandbox"}</p>
                <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-stone-950">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">{item.detail}</p>
              </div>
              <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", workStreamStatusClasses(item.status))}>
                {item.status}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
                Updated {formatDate(item.updatedAt)}
              </span>
              {item.localJob ? (
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800">
                  Workspace local intake
                </span>
              ) : null}
              {item.href ? (
                <Link href={item.href} className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600 hover:border-stone-300">
                  Open room
                </Link>
              ) : null}
            </div>
            {item.localJob ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-200 pt-3">
                {LOCKED_LOCAL_ACTIONS.map((action) => (
                  <LockedActionButton key={action} label={action} tone="light" />
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function stageClasses(state: JobLoopStageState): string {
  if (state === "complete") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (state === "current") return "border-blue-200 bg-blue-50 text-blue-800";
  return "border-stone-200 bg-stone-50 text-stone-600";
}

function jobLoopStages(snapshot: WorkspaceSnapshot): Array<{ label: string; detail: string; state: JobLoopStageState }> {
  const hasArtifacts = snapshot.artifactControl.counts.artifacts > 0 || snapshot.artifacts.total > 0;
  const needsReview = snapshot.approvals.totalPending > 0 || latestArtifactControlItems(snapshot).some((artifact) => artifact.status === "ready_for_review");
  const hasArchived = latestArtifactControlItems(snapshot).some((artifact) => ["approved", "archived"].includes(artifact.status));

  return [
    { label: "Received", detail: "Request captured as a workspace work item.", state: "complete" },
    { label: "Planning", detail: "Atlas builds a local plan and required context list.", state: hasArtifacts ? "complete" : "current" },
    { label: "Execution locked", detail: "No worker execution is wired to Workspace.", state: "locked" },
    { label: "Artifact metadata", detail: hasArtifacts ? "Existing artifact metadata is visible in the library." : "Output cards will appear here only when existing emitters write metadata.", state: hasArtifacts ? "complete" : "locked" },
    { label: "Review needed", detail: needsReview ? "Review records or ready artifacts are visible." : "Human review is planned before external use.", state: needsReview ? "current" : "locked" },
    { label: "Approved / archived", detail: hasArchived ? "Final state is represented in metadata." : "Finalization controls are not live.", state: hasArchived ? "complete" : "locked" },
  ];
}

function LockedJobLoopPreview({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  return (
    <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Internal job loop</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">The product loop Atlas is moving toward. Execution is represented, not wired.</p>
        </div>
        <span className="inline-flex h-7 items-center rounded-full bg-stone-950 px-2.5 text-xs font-medium text-white">Locked preview</span>
      </div>
      <div className="mt-4 grid gap-2">
        {jobLoopStages(snapshot).map((stage, index) => (
          <div key={stage.label} className="grid gap-3 rounded-lg border border-stone-200 bg-white p-3 sm:grid-cols-[32px_minmax(0,1fr)_92px] sm:items-start">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-950 text-xs font-semibold text-white">{index + 1}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-stone-950">{stage.label}</p>
              <p className="mt-1 text-xs leading-5 text-stone-500">{stage.detail}</p>
            </div>
            <span className={classNames("w-fit rounded-full border px-2.5 py-1 text-xs font-medium sm:justify-self-end", stageClasses(stage.state))}>
              {stage.state}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SandboxAuditPreview() {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Audit intake preview model</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">Example path for the L2 room once existing local emitters write validated records. Typeform wiring is not active here.</p>
        </div>
        <SandboxBadge />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        {[
          ["Intake", "Local source reference appears as an AuditRun record."],
          ["Execution", "Worker stages are a schema preview only; Workspace cannot start them."],
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
          <p className="text-sm font-semibold text-stone-950">Weekly content batch model</p>
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
          <p className="text-sm font-semibold text-stone-950">Approval item model</p>
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
          <p className="text-sm font-semibold text-stone-950">Strategic artifact model</p>
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
            These are the eventual organization controls. They are labels only here and do not move, rename, archive, attach, share, export, or write files.
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
          <QueueRow label="Projects" value={String(control.projects.length)} detail="Saved workspaces and archive scopes." />
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
    ["Draft a training session", "Choose a focus: brain dump, business problem, context challenge, correction loop, or strategy conversation."],
    ["Talk through the mess", "Atlas listens for decisions, operating principles, context gaps, and places where it should challenge more directly."],
    ["Extract learnings", "The session becomes principles, corrections, decisions, playbooks, and proposed memory updates."],
    ["Review what should be saved", "The reviewer sees exactly what would become reusable context before anything is promoted."],
    ["Improve Atlas deliberately", "Approved learnings can later become memory or context improvements with clear visibility and permissions."],
  ];

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">Training flow</p>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-600">
            Training Grounds is where Atlas learns operating preferences through structured review. It is not a live unrestricted chat surface yet.
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

function TrainingAccessGuardrailPanel() {
  const rows = [
    ["Session creation", "Locked until Atlas has a safe local session primitive."],
    ["Memory promotion", "Requires explicit review before any learning can become reusable context."],
    ["Visibility", "Client, team, and project scope must be explicit before anything is saved."],
    ["Safety review", "Context bleed, source sensitivity, and high-risk proposals stay visible before promotion."],
  ];

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-stone-950">Access guardrails</p>
      <div className="mt-4 space-y-2">
        {rows.map(([label, detail]) => (
          <div key={label} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <p className="text-sm font-semibold text-stone-950">{label}</p>
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

function CapabilityStatusPill({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-8 items-center whitespace-nowrap rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-xs font-medium text-stone-500"
    >
      {label} preview
    </span>
  );
}

function LockedActionButton({ label, tone = "dark" }: { label: string; tone?: "dark" | "light" }) {
  return (
    <button
      type="button"
      disabled
      aria-label={`${label}; locked in Workspace`}
      className={classNames(
        "rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed",
        tone === "light"
          ? "border-stone-200 bg-white text-stone-500"
          : "border-white/10 bg-white/[0.03] text-stone-500",
      )}
    >
      {label}
    </button>
  );
}

function WorkspaceTopBar({
  room,
  project,
  activeSession,
}: {
  room: WorkspaceRoomId;
  project: WorkspaceProjectId;
  activeSession: boolean;
}) {
  const roomInfo = selectedRoom(room);
  const projectInfo = selectedProject(project);

  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-[#151515]/92 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium text-stone-500">{projectInfo.label}</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-xl font-semibold text-stone-100">{roomInfo.label}</h2>
            <span className={classNames(
              "rounded-md border px-2 py-0.5 text-[11px] font-medium",
              activeSession ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" : "border-white/10 bg-white/[0.04] text-stone-400",
            )}>
              {activeSession ? "Local/read-only lane" : "Workspace overview"}
            </span>
          </div>
        </div>
        <div className="flex max-w-full gap-2 overflow-x-auto pb-1 xl:pb-0">
          {["Agents", "Tools", "Routines", "Library", "Mode"].map((label) => (
            <CapabilityStatusPill key={label} label={label} />
          ))}
        </div>
      </div>
    </header>
  );
}

function localJobHref({
  job,
  role,
}: {
  job: WorkspaceLocalJob;
  role: WorkspaceRoleId;
}) {
  const room = ROOM_IDS.has(job.room as WorkspaceRoomId) ? job.room as WorkspaceRoomId : "home";
  const project = PROJECT_IDS.has(job.project as WorkspaceProjectId) ? job.project as WorkspaceProjectId : "undeniable-os";
  return workspaceHref({ room, role, project, job: job.id });
}

function LocalJobThreadCard({
  job,
  selected,
  role,
}: {
  job: WorkspaceLocalJob;
  selected: boolean;
  role: WorkspaceRoleId;
}) {
  return (
    <Link
      href={localJobHref({ job, role })}
      className={classNames(
        "block rounded-lg border px-4 py-3 transition",
        selected ? "border-emerald-400/30 bg-white/[0.075] shadow-[0_0_0_1px_rgba(52,211,153,0.08)]" : "border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-stone-500">Local task / {job.intendedWorkflow.replaceAll("_", " ")}</p>
          <h3 className="mt-1 line-clamp-2 text-base font-semibold text-stone-100">{job.title}</h3>
          <p className="mt-2 line-clamp-3 text-sm leading-6 text-stone-400">{job.prompt}</p>
        </div>
        <span className="rounded-md border border-blue-300/20 bg-blue-400/10 px-2 py-0.5 text-[11px] font-medium text-blue-200">
          {job.execution.state.replaceAll("_", " ")}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          {job.status.replaceAll("_", " ")}
        </span>
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          Created {formatDate(job.createdAt)}
        </span>
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          {displayProjectLabel(job.project)}
        </span>
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          {displayRoomLabel(job.room)}
        </span>
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-300">
          Inspect
        </span>
      </div>
    </Link>
  );
}

function LocalJobDetailPanel({
  job,
  snapshot,
}: {
  job: WorkspaceLocalJob;
  snapshot: WorkspaceSnapshot;
}) {
  const timeline = [
    ["Created", formatDate(job.createdAt)],
    ["Queued locally", job.status.replaceAll("_", " ")],
    ["Execution locked", job.execution.reason],
  ];

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-stone-500">Selected local task</p>
          <h3 className="mt-1 text-lg font-semibold text-stone-100">{job.title}</h3>
        </div>
        <span className="rounded-md border border-blue-300/20 bg-blue-400/10 px-2 py-0.5 text-[11px] font-medium text-blue-200">
          {job.execution.state.replaceAll("_", " ")}
        </span>
      </div>

      <div className="mt-4 border-l border-white/10 pl-3">
        <p className="text-[11px] font-semibold uppercase text-stone-500">Prompt</p>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-stone-300">{job.prompt}</p>
      </div>

      <dl className="mt-4 grid gap-x-5 gap-y-3 border-t border-white/10 pt-4 sm:grid-cols-3">
        {[
          ["Status", job.status.replaceAll("_", " ")],
          ["Workflow", job.intendedWorkflow.replaceAll("_", " ")],
          ["Project", displayProjectLabel(job.project)],
          ["Room", displayRoomLabel(job.room)],
          ["Created", formatDate(job.createdAt)],
          ["Updated", formatDate(job.updatedAt)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] font-medium uppercase text-stone-500">{label}</dt>
            <dd className="mt-1 break-words text-sm font-medium text-stone-200">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 border-t border-white/10 pt-4">
        <p className="text-[11px] font-semibold uppercase text-stone-500">Timeline</p>
        <div className="mt-3 space-y-2">
          {timeline.map(([label, detail], index) => (
            <div key={label} className="grid gap-3 rounded-md border border-white/10 bg-black/10 p-3 sm:grid-cols-[24px_minmax(0,1fr)]">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/10 text-[11px] font-semibold text-stone-200">{index + 1}</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-stone-200">{label}</p>
                <p className="mt-1 break-words text-xs leading-5 text-stone-500">{detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-white/10 pt-4">
        <p className="text-[11px] font-semibold uppercase text-stone-500">Local source health</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {[
            ["Valid", snapshot.localJobs.health.validRecordCount],
            ["Invalid", snapshot.localJobs.health.invalidRecordCount],
            ["Records", snapshot.localJobs.health.recordCount],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-xs text-stone-500">{label}</p>
              <p className="mt-1 text-lg font-semibold text-stone-200">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 break-all text-xs leading-5 text-stone-500">{snapshot.localJobs.file}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {LOCKED_LOCAL_ACTIONS.map((action) => (
          <LockedActionButton key={action} label={action} />
        ))}
      </div>
    </section>
  );
}

function SelectedLocalJobSurface({
  job,
  role,
  snapshot,
}: {
  job: WorkspaceLocalJob;
  role: WorkspaceRoleId;
  snapshot: WorkspaceSnapshot;
}) {
  const workerPackage = buildWorkspaceLocalWorkerPackage({
    job,
    contextSummary: buildWorkerPackageContextSummary(snapshot),
    now: new Date(snapshot.generatedAt),
    idFactory: () => `${job.id}_${job.updatedAt}`,
  });
  const packageText = formatWorkspaceLocalWorkerPackage(workerPackage);
  const events = snapshot.localJobs.eventsByJob[job.id] ?? [];
  const results = snapshot.localJobs.resultsByJob[job.id] ?? [];

  return (
    <section className="space-y-3 border-b border-white/10 pb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-emerald-300">Selected task</p>
          <h3 className="mt-1 break-words text-lg font-semibold text-stone-100">{job.title}</h3>
        </div>
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          Local controls only
        </span>
      </div>

      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
        <WorkspaceLocalJobControls
          job={job}
          role={role}
          rooms={ROOMS
            .filter((candidate) => (LOCAL_JOB_ROOM_IDS as readonly string[]).includes(candidate.id))
            .map((candidate) => ({ id: candidate.id, label: candidate.label }))}
          projects={PROJECTS
            .filter((candidate) => (LOCAL_JOB_PROJECT_IDS as readonly string[]).includes(candidate.id))
            .map((candidate) => ({ id: candidate.id, label: candidate.label }))}
        />
        <LocalJobDetailPanel job={job} snapshot={snapshot} />
      </div>

      <WorkspaceWorkerHandoff
        job={job}
        workerPackage={workerPackage}
        packageText={packageText}
        events={events}
        results={results}
      />
    </section>
  );
}

function InlineArtifactCard({ artifact }: { artifact: ScannedWorkspaceArtifact }) {
  return (
    <article className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-stone-500">Artifact / {workspaceFor(artifact.inferredWorkflow)}</p>
          <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-stone-100">{artifact.title}</h3>
        </div>
        <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
          {artifact.format}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-stone-500">
        <span>{formatBytes(artifact.sizeBytes)}</span>
        <span>{formatDate(artifact.modifiedAt)}</span>
        <span>{artifact.validationStatus.replaceAll("_", " ")}</span>
      </div>
    </article>
  );
}

function StartTaskCard({
  role,
  project,
  room,
}: {
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
  room: WorkspaceRoomId;
}) {
  const copy: Record<string, { title: string; detail: string; primary: string; href: string; secondary: string; secondaryHref: string }> = {
    approvals: {
      title: "Review room is read-only",
      detail: "Approval state is visible here, but review decisions and sends stay outside this Workspace shell.",
      primary: "Open Home",
      href: workspaceHref({ room: "home", role, project }),
      secondary: "Open Library",
      secondaryHref: workspaceHref({ room: "knowledge", role, project: "memory-knowledge" }),
    },
    "agent-runs": {
      title: "Run timeline is read-only",
      detail: "Local jobs and projected runs appear here, but no worker can be started from Workspace.",
      primary: "Open Home",
      href: workspaceHref({ room: "home", role, project }),
      secondary: "Open Audits",
      secondaryHref: workspaceHref({ room: "audits", role, project: "l2-audits" }),
    },
    knowledge: {
      title: "Knowledge is browse-only",
      detail: "Use this room for artifact cards, context packs, and source health. File controls remain locked.",
      primary: "Open Home",
      href: workspaceHref({ room: "home", role, project }),
      secondary: "Training",
      secondaryHref: workspaceHref({ room: "training", role, project: "memory-knowledge" }),
    },
    readiness: {
      title: "Readiness is inspect-only",
      detail: "Source health and integration guardrails are visible here. Nothing restarts, writes, or connects.",
      primary: "Open Home",
      href: workspaceHref({ room: "home", role, project }),
      secondary: "Knowledge",
      secondaryHref: workspaceHref({ room: "knowledge", role, project: "memory-knowledge" }),
    },
  };
  const state = copy[room] ?? {
    title: "Local draft composer lives in active rooms",
    detail: "Pick Home, Audits, Content, or Training to save a local JSONL draft. Nothing executes from this Workspace shell.",
    primary: "Open audit intake",
    href: workspaceHref({ room: "audits", role, project }),
    secondary: "Open library",
    secondaryHref: workspaceHref({ room: "knowledge", role, project: "memory-knowledge" }),
  };

  return (
    <section className="rounded-lg border border-dashed border-white/15 bg-white/[0.035] p-5 text-center">
      <p className="text-sm font-semibold text-stone-100">{state.title}</p>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-400">
        {state.detail}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Link
          href={state.href}
          className="inline-flex h-9 items-center rounded-md bg-stone-100 px-3 text-sm font-semibold text-stone-950"
        >
          {state.primary}
        </Link>
        <Link
          href={state.secondaryHref}
          className="inline-flex h-9 items-center rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm font-medium text-stone-300"
        >
          {state.secondary}
        </Link>
      </div>
    </section>
  );
}

type RoomComposerConfig = {
  title: string;
  helperText: string;
  placeholder: string;
  defaultWorkflow: WorkspaceLocalJob["intendedWorkflow"];
  visibleWorkflows: WorkspaceLocalJob["intendedWorkflow"][];
};

function roomComposerConfig(room: WorkspaceRoomId): RoomComposerConfig | null {
  if (room === "home") {
    return {
      title: "Local draft",
      helperText: "local JSONL draft only",
      placeholder: "Ask Atlas to save a local task note. It will be saved here, but no model or worker will run.",
      defaultWorkflow: "ask_atlas",
      visibleWorkflows: ["ask_atlas", "audit", "content_batch", "call_archive", "training_session"],
    };
  }
  if (room === "audits") {
    return {
      title: "Audit intake",
      helperText: "local JSONL draft only",
      placeholder: "Describe the L2 audit package to stage locally. No Typeform, worker, or delivery path will run.",
      defaultWorkflow: "audit",
      visibleWorkflows: ["audit", "ask_atlas"],
    };
  }
  if (room === "content") {
    return {
      title: "Content batch intake",
      helperText: "local JSONL draft only",
      placeholder: "Describe the content batch, scripts, or assets to stage locally. Nothing publishes or sends.",
      defaultWorkflow: "content_batch",
      visibleWorkflows: ["content_batch", "ask_atlas"],
    };
  }
  if (room === "training") {
    return {
      title: "Training session intake",
      helperText: "local JSONL draft only",
      placeholder: "Describe the training session or principle to capture locally. No memory write happens.",
      defaultWorkflow: "training_session",
      visibleWorkflows: ["training_session", "ask_atlas"],
    };
  }
  return null;
}

function localJobsForRoom(room: WorkspaceRoomId, jobs: WorkspaceLocalJob[], selectedJob: WorkspaceLocalJob | null) {
  const workflowByRoom: Partial<Record<WorkspaceRoomId, WorkspaceLocalJob["intendedWorkflow"][]>> = {
    audits: ["audit"],
    content: ["content_batch"],
    training: ["training_session"],
    "agent-runs": ["ask_atlas", "audit", "content_batch", "call_archive", "training_session", "general"],
  };
  const workflows = workflowByRoom[room];
  const filtered = room === "home"
    ? jobs
    : jobs.filter((job) => job.room === room || workflows?.includes(job.intendedWorkflow) || job.id === selectedJob?.id);
  return (filtered.length ? filtered : []).slice(0, 5);
}

function LaneStep({
  label,
  detail,
  state = "locked",
}: {
  label: string;
  detail: string;
  state?: "ready" | "current" | "locked";
}) {
  const stateClass = state === "ready"
    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
    : state === "current"
      ? "border-blue-300/20 bg-blue-400/10 text-blue-200"
      : "border-white/10 bg-white/[0.03] text-stone-500";

  return (
    <div className="grid gap-3 border-b border-white/10 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_80px]">
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-200">{label}</p>
        <p className="mt-1 text-xs leading-5 text-stone-500">{detail}</p>
      </div>
      <span className={classNames("h-fit w-fit rounded-md border px-2 py-0.5 text-[11px] font-medium sm:justify-self-end", stateClass)}>
        {state}
      </span>
    </div>
  );
}

function RoomLane({
  eyebrow,
  title,
  detail,
  steps,
  children,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  steps: Array<{ label: string; detail: string; state?: "ready" | "current" | "locked" }>;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-4 border-b border-white/10 pb-5">
      <div>
        <p className="text-[11px] font-semibold uppercase text-stone-500">{eyebrow}</p>
        <h3 className="mt-1 text-lg font-semibold text-stone-100">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-stone-400">{detail}</p>
      </div>
      <div className="rounded-lg border border-white/10 bg-white/[0.025] px-4">
        {steps.map((step) => <LaneStep key={step.label} {...step} />)}
      </div>
      {children}
    </section>
  );
}

function MiniStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase text-stone-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-stone-200">{value}</p>
      <p className="mt-1 text-xs leading-5 text-stone-500">{detail}</p>
    </div>
  );
}

function RoomSpecificContent({
  room,
  role,
  snapshot,
}: {
  room: WorkspaceRoomId;
  role: WorkspaceRoleId;
  snapshot: WorkspaceSnapshot;
}) {
  if (room === "audits") {
    const auditRuns = snapshot.runs.records.auditRuns;
    return (
      <RoomLane
        eyebrow="L2 audit lane"
        title="Intake, review, package"
        detail="Audit work is staged as local drafts and read-only run/package projections until the safe execution path exists."
        steps={[
          { label: "Intake", detail: "Capture an audit request as a local Workspace draft.", state: "current" },
          { label: "Review", detail: `${auditRuns.length} validated audit run record${auditRuns.length === 1 ? "" : "s"} visible.`, state: auditRuns.length ? "ready" : "locked" },
          { label: "Package", detail: "Audit artifacts appear here when projected from existing metadata.", state: snapshot.artifacts.latestAudit ? "ready" : "locked" },
        ]}
      >
        {snapshot.artifacts.latestAudit ? <ArtifactResultCard group={snapshot.artifacts.latestAudit} /> : <EmptyRunState title="No audit package selected" detail="Local audit drafts can be staged here; package generation remains locked." />}
      </RoomLane>
    );
  }

  if (room === "content") {
    const batches = snapshot.runs.records.contentBatches;
    return (
      <RoomLane
        eyebrow="Content lane"
        title="Batch, scripts, assets"
        detail="Content work is organized around batch intent, script status, and asset references without publishing or sending."
        steps={[
          { label: "Batch brief", detail: "Save a local content batch draft from the composer.", state: "current" },
          { label: "Scripts", detail: `${batches.length} validated content batch record${batches.length === 1 ? "" : "s"} visible.`, state: batches.length ? "ready" : "locked" },
          { label: "Assets", detail: "Asset cards appear when artifact metadata exists.", state: snapshot.artifacts.recent.some((artifact) => artifact.inferredWorkflow === "brand_asset") ? "ready" : "locked" },
        ]}
      >
        <div className="grid gap-3">
          {snapshot.artifacts.recent.filter((artifact) => ["brand_asset", "strategist", "unknown"].includes(artifact.inferredWorkflow)).slice(0, 3).map((artifact) => (
            <InlineArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      </RoomLane>
    );
  }

  if (room === "approvals") {
    return (
      <RoomLane
        eyebrow="Review lane"
        title="Approval state and exact-review queues"
        detail="This room reads existing approval/review state. It does not approve, reject, send, or mutate tasks."
        steps={[
          { label: "Comms review", detail: `${snapshot.approvals.slackVisible} visible comms review item${snapshot.approvals.slackVisible === 1 ? "" : "s"}.`, state: snapshot.approvals.slackVisible ? "current" : "locked" },
          { label: "Task workflow", detail: `${snapshot.approvals.jianActive} active task workflow review item${snapshot.approvals.jianActive === 1 ? "" : "s"}.`, state: snapshot.approvals.jianActive ? "current" : "locked" },
          { label: "Decision controls", detail: "Approval actions stay outside this Workspace shell.", state: "locked" },
        ]}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <MiniStat label="Visible reviews" value={snapshot.approvals.totalPending} detail="Read-only projection only." />
          <MiniStat label="Drafted" value={snapshot.approvals.draftedSlack} detail="No send action is exposed here." />
        </div>
      </RoomLane>
    );
  }

  if (room === "agent-runs") {
    const jobs = snapshot.localJobs.records.slice(0, 5);
    return (
      <RoomLane
        eyebrow="Run timeline lane"
        title="Local drafts and projected run history"
        detail="This room shows run-like state without starting workers. Local jobs remain queued and not executing."
        steps={[
          { label: "Local intake", detail: `${snapshot.localJobs.health.validRecordCount} local draft record${snapshot.localJobs.health.validRecordCount === 1 ? "" : "s"}.`, state: snapshot.localJobs.health.validRecordCount ? "ready" : "locked" },
          { label: "Run records", detail: `${snapshot.runs.counts.totalValidRecords} validated run contract record${snapshot.runs.counts.totalValidRecords === 1 ? "" : "s"}.`, state: snapshot.runs.counts.totalValidRecords ? "ready" : "locked" },
          { label: "Workers", detail: "No worker execution is available from Workspace.", state: "locked" },
        ]}
      >
        <div className="space-y-2">
          {jobs.length ? jobs.map((job) => <LocalJobThreadCard key={job.id} job={job} role={role} selected={false} />) : <EmptyRunState title="No local jobs yet" detail="Draft jobs created in active rooms will appear here as non-executing run candidates." />}
        </div>
      </RoomLane>
    );
  }

  if (room === "training") {
    const sessions = trainingGroundsRecords();
    return (
      <RoomLane
        eyebrow="Training lane"
        title="Session, principles, memory proposals"
        detail="Training captures can be drafted locally. Memory writes and promotion remain locked."
        steps={[
          { label: "Session draft", detail: "Capture a training focus with local intake.", state: "current" },
          { label: "Principles", detail: `${sessions.length} fixture training session${sessions.length === 1 ? "" : "s"} available for shape preview.`, state: sessions.length ? "ready" : "locked" },
          { label: "Memory proposal", detail: "No memory write happens from this room.", state: "locked" },
        ]}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <MiniStat label="Context packs" value={snapshot.memoryMaintenance.summary.contextPacksGenerated} detail="Read-only Librarian output." />
          <MiniStat label="Review queue" value={snapshot.memoryMaintenance.summary.reviewQueueItems} detail="Proposals are not applied here." />
        </div>
      </RoomLane>
    );
  }

  if (room === "knowledge") {
    return (
      <RoomLane
        eyebrow="Knowledge lane"
        title="Artifacts, context packs, source health"
        detail="Knowledge is browse-and-inspect only: artifact cards, context counts, and source health without moving or writing files."
        steps={[
          { label: "Artifact library", detail: `${snapshot.artifactControl.counts.artifacts} artifact metadata record${snapshot.artifactControl.counts.artifacts === 1 ? "" : "s"}.`, state: snapshot.artifactControl.counts.artifacts ? "ready" : "locked" },
          { label: "Context packs", detail: `${snapshot.memoryMaintenance.summary.contextPacksGenerated} context pack${snapshot.memoryMaintenance.summary.contextPacksGenerated === 1 ? "" : "s"} indexed.`, state: snapshot.memoryMaintenance.summary.contextPacksGenerated ? "ready" : "locked" },
          { label: "File controls", detail: "Move, rename, archive, attach, share, and export are not active.", state: "locked" },
        ]}
      >
        <div className="grid gap-3">
          {snapshot.artifacts.recent.slice(0, 4).map((artifact) => <InlineArtifactCard key={artifact.id} artifact={artifact} />)}
        </div>
      </RoomLane>
    );
  }

  if (room === "readiness") {
    return (
      <RoomLane
        eyebrow="Readiness lane"
        title="Source health and integration guardrails"
        detail="This room shows whether local sources are present and which integration paths remain locked."
        steps={[
          { label: "Local jobs", detail: `${snapshot.localJobs.health.validRecordCount} valid, ${snapshot.localJobs.health.invalidRecordCount} invalid.`, state: snapshot.localJobs.health.invalidRecordCount ? "current" : "ready" },
          { label: "Artifact metadata", detail: `${snapshot.artifactControl.counts.totalValidRecords} valid records, ${snapshot.artifactControl.counts.totalInvalidRecords} invalid.`, state: snapshot.artifactControl.counts.totalInvalidRecords ? "current" : "ready" },
          { label: "External systems", detail: "Slack, Monday, Typeform, workers, and Supabase remain disconnected from this shell.", state: "locked" },
        ]}
      />
    );
  }

  return (
    <RoomLane
      eyebrow="Workspace home"
      title="Overview and recent local jobs"
      detail="Home collects the current local Workspace state: draft jobs, recent artifacts, and memory/readiness summaries."
      steps={[
        { label: "Ask Atlas", detail: "Save a local-only draft from the composer.", state: "current" },
        { label: "Inspect", detail: "Select a local job to inspect prompt, status, timeline, and locked actions.", state: snapshot.localJobs.health.validRecordCount ? "ready" : "locked" },
        { label: "Results", detail: "Read artifact and memory projections without moving or sending anything.", state: snapshot.artifactControl.counts.artifacts ? "ready" : "locked" },
      ]}
    />
  );
}

function SessionThread({
  room,
  role,
  project,
  snapshot,
  selectedJob,
}: {
  room: WorkspaceRoomId;
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
  snapshot: WorkspaceSnapshot;
  selectedJob: WorkspaceLocalJob | null;
}) {
  const composerConfig = roomComposerConfig(room);
  const activeSession = Boolean(selectedJob) || Boolean(composerConfig) || !["home", "readiness"].includes(room);
  const roomInfo = selectedRoom(room);
  const visibleJobs = localJobsForRoom(room, snapshot.localJobs.records, selectedJob)
    .filter((job) => job.id !== selectedJob?.id);
  const artifacts = snapshot.artifacts.recent.slice(0, 3);
  const showLocalTaskStrip = ["home", "audits", "content", "training"].includes(room);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-65px)] w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
      <section className="border-b border-white/10 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase text-stone-500">Atlas</p>
            <h3 className="mt-1 text-lg font-semibold text-stone-100">{activeSession ? `${roomInfo.label} session` : "Workspace home"}</h3>
            <p className="mt-2 text-sm leading-6 text-stone-400">{roomInfo.description}</p>
          </div>
          <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
            Local only
          </span>
        </div>
      </section>

      {selectedJob ? (
        <SelectedLocalJobSurface job={selectedJob} role={role} snapshot={snapshot} />
      ) : null}

      <RoomSpecificContent room={room} role={role} snapshot={snapshot} />

      {showLocalTaskStrip ? (
        <section className="space-y-3 border-b border-white/10 pb-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-stone-200">
              {selectedJob ? "Other local tasks" : room === "home" ? "Recent local tasks" : "Local drafts in this lane"}
            </p>
            <span className="text-xs text-stone-500">{visibleJobs.length} shown</span>
          </div>
          {visibleJobs.length ? (
            visibleJobs.map((job) => (
              <LocalJobThreadCard
                key={job.id}
                job={job}
                role={role}
                selected={job.id === selectedJob?.id}
              />
            ))
          ) : (
            <EmptyRunState
              title={selectedJob ? "No other local tasks shown" : "No local tasks in this room yet"}
              detail={selectedJob ? "The selected task is pinned above with its local controls." : "Save a local draft here and it will appear as a Workspace record before any execution path exists."}
            />
          )}
        </section>
      ) : null}

      {room === "home" && artifacts.length ? (
        <section className="space-y-3 border-t border-white/10 pt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-stone-200">Recent artifacts</p>
            <Link href={workspaceHref({ room: "knowledge", role, project: "memory-knowledge" })} className="text-xs font-medium text-stone-500 hover:text-stone-200">
              Library
            </Link>
          </div>
          <div className="grid gap-3">
            {artifacts.map((artifact) => <InlineArtifactCard key={artifact.id} artifact={artifact} />)}
          </div>
        </section>
      ) : null}

      <section className="grid gap-4 border-t border-white/10 pt-5 text-sm md:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase text-stone-500">Memory</p>
          <p className="mt-1 font-semibold text-stone-200">{snapshot.memoryMaintenance.status}</p>
          <p className="mt-1 text-xs leading-5 text-stone-500">{snapshot.memoryMaintenance.summary.contextPacksGenerated} context packs, {snapshot.memoryMaintenance.summary.reviewQueueItems} review items.</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase text-stone-500">Readiness</p>
          <p className="mt-1 font-semibold text-stone-200">{snapshot.localJobs.health.validRecordCount} local</p>
          <p className="mt-1 text-xs leading-5 text-stone-500">{snapshot.localJobs.health.invalidRecordCount} invalid local job records. External execution remains locked.</p>
        </div>
      </section>

      <div className="mt-auto">
        {composerConfig ? (
          <WorkspaceComposer
            room={room}
            role={role}
            project={project}
            title={composerConfig.title}
            helperText={composerConfig.helperText}
            placeholder={composerConfig.placeholder}
            defaultWorkflow={composerConfig.defaultWorkflow}
            visibleWorkflows={composerConfig.visibleWorkflows}
          />
        ) : (
          <StartTaskCard role={role} project={project} room={room} />
        )}
      </div>
    </div>
  );
}

function WorkspaceRail({
  room,
  role,
  project,
  snapshot,
}: {
  room: WorkspaceRoomId;
  role: WorkspaceRoleId;
  project: WorkspaceProjectId;
  snapshot: WorkspaceSnapshot;
}) {
  const recentTasks = snapshot.localJobs.records.slice(0, 4);
  const projectCounts = new Map<string, number>();
  snapshot.localJobs.records.forEach((job) => {
    projectCounts.set(job.project, (projectCounts.get(job.project) ?? 0) + 1);
  });

  return (
    <aside className="max-w-full overflow-x-hidden border-b border-white/10 bg-[#161616] px-4 py-4 text-white lg:min-h-screen lg:border-b-0 lg:px-3">
      <div className="flex items-center justify-between gap-3 lg:block">
        <div>
          <p className="text-xs font-semibold text-stone-400">Atlas</p>
          <h1 className="mt-1 text-lg font-semibold">Workspace</h1>
        </div>
        <ReadOnlyBadge />
      </div>

      <div className="mt-5">
        <Link
          href={workspaceHref({ room: "audits", role, project })}
          className="flex min-h-9 items-center justify-center rounded-md border border-white/10 bg-white/[0.08] px-3 text-sm font-semibold text-stone-100 transition hover:bg-white/[0.12]"
        >
          Local draft
        </Link>
      </div>

      <nav className="mt-5 flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-3 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0" aria-label="Workspace rooms">
        {SHELL_ROOM_IDS.map((roomId) => {
          const candidate = selectedRoom(roomId);
          return (
            <RoomNavItem
              key={candidate.id}
              room={candidate}
              activeRoom={room}
              role={role}
              project={project}
              meta={roomId === "home" ? String(snapshot.localJobs.health.validRecordCount) : undefined}
            />
          );
        })}
      </nav>

      <div className="mt-6 hidden lg:block">
        <p className="px-2.5 text-[11px] font-medium uppercase text-stone-600">Projects</p>
        <div className="mt-2 space-y-1">
          {PROJECTS.map((candidate) => (
            <RailItem
              key={candidate.id}
              label={candidate.label}
              meta={projectCounts.get(candidate.id) ? String(projectCounts.get(candidate.id)) : undefined}
              href={workspaceHref({ room, role, project: candidate.id })}
              active={candidate.id === project}
            />
          ))}
        </div>
      </div>

      <div className="mt-6 hidden lg:block">
        <p className="px-2.5 text-[11px] font-medium uppercase text-stone-600">Recent tasks</p>
        <div className="mt-2 space-y-1">
          {recentTasks.length ? recentTasks.map((job) => (
            <RailItem
              key={job.id}
              label={job.title}
              meta={job.intendedWorkflow.replaceAll("_", " ")}
              href={localJobHref({ job, role })}
              active={job.room === room}
            />
          )) : (
            <RailItem label="No local tasks yet" disabled />
          )}
        </div>
      </div>

      <div className="mt-6 hidden lg:block">
        <p className="px-2.5 text-[11px] font-medium uppercase text-stone-600">Library</p>
        <div className="mt-2 space-y-1">
          <RailItem label="Artifact library" href={workspaceHref({ room: "knowledge", role, project: "memory-knowledge" })} active={room === "knowledge"} />
          <RailItem label="Training" href={workspaceHref({ room: "training", role, project })} active={room === "training"} />
          {UTILITY_ROOM_IDS.map((roomId) => (
            <RailItem
              key={roomId}
              label={selectedRoom(roomId).label}
              href={workspaceHref({ room: roomId, role, project })}
              active={room === roomId}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function ContextInspector({
  snapshot,
  selectedJob,
}: {
  snapshot: WorkspaceSnapshot;
  selectedJob: WorkspaceLocalJob | null;
}) {
  const artifactDiscovery = snapshot.artifactControl.discovery.counts;

  return (
    <aside className="space-y-5 border-t border-white/10 bg-[#181818] px-4 py-5 sm:px-6 lg:min-h-screen lg:border-t-0">
      {selectedJob ? (
        <section className="border-b border-white/10 pb-5">
          <p className="text-sm font-semibold text-stone-100">Task context</p>
          <p className="mt-2 text-sm leading-6 text-stone-400">{selectedJob.execution.reason}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {LOCKED_LOCAL_ACTIONS.map((action) => (
              <LockedActionButton key={action} label={action} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="border-b border-white/10 pb-5">
        <p className="text-sm font-semibold text-stone-100">Workspace pulse</p>
        <dl className="mt-4 grid grid-cols-2 gap-4">
          {[
            ["Local", snapshot.localJobs.health.validRecordCount],
            ["Archived", snapshot.localJobs.health.archivedRecordCount],
            ["Artifacts", snapshot.artifactControl.counts.artifacts],
            ["Controls", snapshot.localJobs.health.controlRecordCount],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-stone-500">{label}</dt>
              <dd className="mt-1 text-lg font-semibold text-stone-200">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <p className="text-sm font-semibold text-stone-100">Source health</p>
        <div className="mt-4 space-y-3">
          {[
            ["Local job records", snapshot.localJobs.health.recordCount],
            ["Artifact sidecars", artifactDiscovery.realMetadataRecordsFound],
            ["Exports matched", artifactDiscovery.exportFilesMatched],
            ["Memory review items", snapshot.memoryMaintenance.summary.reviewQueueItems],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 border-b border-white/10 pb-3 last:border-b-0">
              <p className="text-sm font-medium text-stone-300">{label}</p>
              <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">{value}</span>
            </div>
          ))}
        </div>
      </section>
    </aside>
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
  const selectedJobId = firstParam(params.job);
  const selectedJob = snapshot.localJobs.records.find((job) => job.id === selectedJobId) ?? null;
  const activeSession = Boolean(selectedJob) || !["home", "readiness"].includes(room);

  return (
    <main className="min-h-screen w-full max-w-full overflow-x-hidden bg-[#111111] text-stone-100">
      <div className="mx-auto min-h-screen w-full max-w-[1760px] overflow-x-hidden lg:grid lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        <WorkspaceRail room={room} role={role} project={project} snapshot={snapshot} />

        <section className="min-w-0 max-w-full overflow-x-hidden bg-[#131313] lg:border-x lg:border-white/10">
          <WorkspaceTopBar room={room} project={project} activeSession={activeSession} />
          <SessionThread
            room={room}
            role={role}
            project={project}
            snapshot={snapshot}
            selectedJob={selectedJob}
          />
        </section>

        <ContextInspector snapshot={snapshot} selectedJob={selectedJob} />
      </div>
    </main>
  );
}
