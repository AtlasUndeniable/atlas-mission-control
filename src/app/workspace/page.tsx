import Link from "next/link";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ReactNode } from "react";

import { groupArtifacts, getWorkspaceArtifacts } from "@/app/api/workspace/_lib/artifact-projection";
import type { ArtifactGroup, WorkspaceArtifact } from "@/app/api/workspace/_lib/artifact-projection";
import { buildReaperData } from "@/lib/reaper";
import {
  validateAgentRun,
  validateApproval,
  validateAuditRun,
  validateContentBatch,
  validateMemoryMaintenanceRun,
} from "@/lib/workspace-contracts";
import type {
  AgentRun,
  AgentRunStatus,
  Approval,
  ArtifactReference,
  AuditRun,
  ContentBatch,
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
    recent: WorkspaceArtifact[];
    latestAudit: ArtifactGroup | null;
  };
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
  const [slackQueue, jianApprovals, artifacts, runs] = await Promise.all([
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
    "flex min-h-10 items-center gap-3 rounded-md px-3 text-sm transition",
    active ? "bg-white text-stone-950" : "text-stone-300 hover:bg-white/8 hover:text-white",
    disabled && "cursor-not-allowed text-stone-500 hover:bg-transparent hover:text-stone-500",
  );

  if (href && !disabled) {
    return <a className={classes} href={href}>{body}</a>;
  }
  return <div aria-disabled={disabled ? "true" : undefined} className={classes}>{body}</div>;
}

function StreamBlock({
  author,
  time,
  children,
}: {
  author: string;
  time: string;
  children: ReactNode;
}) {
  return (
    <article className="flex gap-3 sm:gap-4">
      <div className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stone-950 text-xs font-semibold text-white shadow-sm">
        {author.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold text-stone-950">{author}</h2>
          <p className="text-xs text-stone-500">{time}</p>
        </div>
        <div className="mt-2 text-[15px] leading-7 text-stone-700">{children}</div>
      </div>
    </article>
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

function ArtifactList({ artifacts }: { artifacts: WorkspaceArtifact[] }) {
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

function MemoryMaintenancePanel({ runs }: { runs: MemoryMaintenanceRun[] }) {
  if (!runs.length) {
    return (
      <EmptyRunState
        title="No memory maintenance reports yet"
        detail="Librarian scans will appear with findings, counts, QA, and proposed review references."
      />
    );
  }

  return (
    <div className="grid gap-3">
      {runs.slice(0, 3).map((run) => (
        <article key={run.id} className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-stone-500">{run.mode.replaceAll("_", " ")}</p>
              <h3 className="mt-1 text-sm font-semibold text-stone-950">{run.scope} memory scan</h3>
            </div>
            <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-medium", runStatusClasses(run.status))}>
              {runStatusLabel(run.status)}
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[
              ["Scanned", run.counts.scanned],
              ["Findings", run.findings.length],
              ["Changes", run.counts.proposedChanges],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md bg-stone-50 p-2">
                <dt className="text-[11px] font-medium text-stone-500">{label}</dt>
                <dd className="mt-1 text-lg font-semibold text-stone-950">{value}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
    </div>
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

export default async function WorkspacePage() {
  const snapshot = await getWorkspaceSnapshot();

  return (
    <main className="min-h-screen bg-[#f4f3ef] text-stone-950">
      <div className="mx-auto min-h-screen max-w-[1600px] lg:grid lg:grid-cols-[260px_minmax(0,1fr)_320px]">
        <aside className="border-b border-stone-800 bg-[#171716] px-4 py-4 text-white lg:min-h-screen lg:border-b-0 lg:px-3">
          <div className="flex items-center justify-between gap-3 lg:block">
            <div>
              <p className="text-xs font-semibold text-stone-400">Atlas</p>
              <h1 className="mt-1 text-lg font-semibold">Workspace</h1>
            </div>
            <ReadOnlyBadge />
          </div>

          <nav className="mt-5 flex flex-wrap gap-2 lg:block lg:space-y-1" aria-label="Workspace navigation">
            <RailItem label="New task" meta="Soon" disabled />
            <RailItem label="Agent" href="#agent-activity" />
            <RailItem label="Library" href="#artifacts" />
            <RailItem label="Scheduled" meta="Soon" disabled />
          </nav>

          <div className="mt-6 hidden lg:block">
            <p className="px-3 text-xs font-medium text-stone-500">Projects</p>
            <div className="mt-2 space-y-1">
              <RailItem label="Undeniable OS" href="#stream" active />
              <RailItem label="L2 audits" href="#audit-runs" meta={String(snapshot.runs.counts.auditRuns)} />
              <RailItem label="Content studio" href="#content-batches" meta={String(snapshot.runs.counts.contentBatches)} />
              <RailItem label="Memory" href="#memory-maintenance" meta={String(snapshot.runs.counts.memoryMaintenanceRuns)} />
            </div>
          </div>

          <div className="mt-6 hidden lg:block">
            <p className="px-3 text-xs font-medium text-stone-500">All tasks</p>
            <div className="mt-2 space-y-1">
              <RailItem label="Approval queue" href="#approvals" meta={String(snapshot.approvals.totalPending)} />
              <RailItem label="Artifacts" href="#artifacts" meta={String(snapshot.artifacts.total)} />
              <RailItem label="Follow-up triage" href="#reaper" meta={String(snapshot.reaper.totalPending)} />
            </div>
          </div>

          <div className="mt-8 hidden rounded-lg border border-white/10 bg-white/5 p-3 lg:block">
            <p className="text-xs text-stone-400">Last refreshed</p>
            <p className="mt-1 text-sm font-medium text-stone-200">{formatDate(snapshot.generatedAt)}</p>
          </div>
        </aside>

        <section className="min-w-0 border-stone-200 lg:border-x">
          <header className="border-b border-stone-200 bg-[#f4f3ef]/95 px-4 py-5 backdrop-blur sm:px-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-500">Project</p>
                <h2 className="mt-1 text-2xl font-semibold text-stone-950 sm:text-3xl">Undeniable OS</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
                  One workspace for client audits, content packs, Monday plans, follow-ups, and the finished work Atlas creates.
                </p>
              </div>
              <Link
                href="/"
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:text-stone-950"
              >
                Mission Control
              </Link>
            </div>
          </header>

          <div id="stream" className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-44 pt-6 sm:px-6">
            <StreamBlock author="Atlas" time={formatDate(snapshot.generatedAt)}>
              <p>
                Ready when the composer opens up: start with a client outcome, then keep the brief, work history, review queue, and deliverables together.
              </p>
              {snapshot.artifacts.latestAudit ? <ArtifactResultCard group={snapshot.artifacts.latestAudit} /> : null}
            </StreamBlock>

            <StreamBlock author="Work history" time="Latest activity">
              <p>
                Recent Atlas work appears as a task history, with delivered files and review points attached to each run.
              </p>
              <div id="jobs" className="mt-4">
                <JobTimeline jobs={snapshot.jobs.recent} />
              </div>
            </StreamBlock>

            <StreamBlock author="Agent activity" time={`${snapshot.runs.counts.agentRuns} contract records`}>
              <p>
                Workflow emitters can now surface durable AgentRun records here: current step, event history, artifact links, QA, and review references.
              </p>
              <div id="agent-activity" className="mt-4">
                <AgentActivityPanel runs={snapshot.runs.records.agentRuns} />
              </div>
            </StreamBlock>

            <StreamBlock author="L2 audit runs" time={`${snapshot.runs.counts.auditRuns} records`}>
              <p>
                Executive audit submissions live here as read-only workspace records: source intake, run stages, QA, review state, and artifacts.
              </p>
              <div id="audit-runs" className="mt-4">
                <AuditWorkspacePanel runs={snapshot.runs} />
              </div>
            </StreamBlock>

            <StreamBlock author="Content batches" time={`${snapshot.runs.counts.contentBatches} records`}>
              <p>
                Corey content packs will land here for review as structured batches with frameworks, items, QA, and artifacts.
              </p>
              <div id="content-batches" className="mt-4">
                <ContentBatchesPanel batches={snapshot.runs.records.contentBatches} />
              </div>
            </StreamBlock>

            <StreamBlock author="Memory maintenance" time={`${snapshot.runs.counts.memoryMaintenanceRuns} records`}>
              <p>
                Librarian runs appear as scan reports with findings, proposed review points, and validation summaries.
              </p>
              <div id="memory-maintenance" className="mt-4">
                <MemoryMaintenancePanel runs={snapshot.runs.records.memoryMaintenanceRuns} />
              </div>
            </StreamBlock>

            <StreamBlock author="Related records" time="Approvals and artifacts">
              <p>
                Contract-linked review records and artifact references collect here without creating operational actions.
              </p>
              <div className="mt-4">
                <RelatedRecordsPanel runs={snapshot.runs} />
              </div>
            </StreamBlock>

            <StreamBlock author="Review queue" time="Waiting room">
              <div id="approvals" className="grid gap-3 sm:grid-cols-2">
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
              </div>
            </StreamBlock>

            <StreamBlock author="Library" time="Recent artifacts">
              <div id="artifacts">
                {snapshot.artifacts.recent.length ? (
                  <ArtifactList artifacts={snapshot.artifacts.recent} />
                ) : (
                  <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-600 shadow-sm">
                    No artifacts appeared in the latest metadata scan.
                  </div>
                )}
              </div>
            </StreamBlock>
          </div>

          <div id="composer">
            <Composer />
          </div>
        </section>

        <aside className="bg-[#eeece7] px-4 py-5 pb-44 sm:px-6 lg:min-h-screen lg:pb-5">
          <div className="space-y-6">
            <section>
              <p className="text-sm font-semibold text-stone-950">Today</p>
              <div className="mt-3 space-y-3">
                <QueueRow
                  label="Agent records"
                  value={String(snapshot.runs.counts.totalValidRecords)}
                  detail={`${snapshot.runs.counts.sourcesPresent} emitters active, ${snapshot.runs.counts.totalInvalidRecords} invalid records.`}
                />
                <QueueRow
                  label="Approvals"
                  value={String(snapshot.approvals.totalPending)}
                  detail="Drafts and delivery notes waiting for a human pass."
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
              </div>
            </section>

            <ContractReadinessPanel runs={snapshot.runs} />

            <AuditReadinessPanel runs={snapshot.runs} />

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

            <section className="rounded-lg border border-stone-300 bg-[#f8f7f4] p-4">
              <p className="text-sm font-semibold text-stone-950">Next actions</p>
              <div className="mt-4 space-y-3 text-sm leading-6 text-stone-600">
                <p>Pick a project from the rail.</p>
                <p>Review the newest deliverables and work history.</p>
                <p>Use the composer when task creation is enabled.</p>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </main>
  );
}
