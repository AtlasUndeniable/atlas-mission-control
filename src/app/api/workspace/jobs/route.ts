import { NextResponse } from "next/server";

import { getKnownLogMetadata, getWorkspaceArtifacts, groupArtifacts } from "../_lib/artifact-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JobStatus = "inferred_ready" | "inferred_unknown" | "inferred_failed";

interface WorkspaceJob {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  currentStep: string;
  createdAt: string | null;
  updatedAt: string | null;
  artifacts: string[];
  source: {
    kind: "artifact_group" | "log_metadata";
    ref: string;
  };
  confidence: "high" | "medium" | "low";
}

function jobTypeFor(workflow: string): string {
  if (workflow === "audit") return "audit";
  if (workflow === "strategist") return "strategy_document";
  if (workflow === "doc_converter") return "document_export";
  if (workflow === "export_bundle") return "data_export";
  if (workflow === "preview") return "preview_render";
  if (workflow === "brand_asset") return "asset_library";
  return "artifact_export";
}

function inferStatus(formats: Set<string>, workflow: string): JobStatus {
  if (formats.has("PDF") || formats.has("DOCX") || formats.has("ZIP")) return "inferred_ready";
  if (workflow === "preview" || workflow === "brand_asset") return "inferred_ready";
  return "inferred_unknown";
}

function currentStepFor(status: JobStatus, formats: Set<string>): string {
  if (status === "inferred_failed") return "Failed evidence found in logs";
  if (status === "inferred_ready") {
    if (formats.has("PDF") || formats.has("DOCX")) return "Artifacts present";
    if (formats.has("ZIP")) return "Export bundle present";
    return "Files present";
  }
  return "No durable job state exists";
}

function buildJobs(): Promise<WorkspaceJob[]> {
  return Promise.all([getWorkspaceArtifacts(), getKnownLogMetadata()]).then(([artifacts, logs]) => {
    const jobs: WorkspaceJob[] = groupArtifacts(artifacts).map((group) => {
      const formats = new Set(group.artifacts.map((artifact) => artifact.format));
      const status = inferStatus(formats, group.workflow);
      return {
        id: `job_${group.groupKey.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}`,
        type: jobTypeFor(group.workflow),
        title: group.title,
        status,
        currentStep: currentStepFor(status, formats),
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        artifacts: group.artifacts.map((artifact) => artifact.id),
        source: {
          kind: "artifact_group",
          ref: group.groupKey,
        },
        confidence: group.confidence,
      };
    });

    const auditErrorLog = logs.find((log) => log.name === "audit-webhook-error.log");
    if (auditErrorLog && auditErrorLog.sizeBytes > 0) {
      jobs.push({
        id: "job_audit_webhook_error_log",
        type: "audit",
        title: "Audit webhook error log",
        status: "inferred_failed",
        currentStep: "Non-empty error log present",
        createdAt: null,
        updatedAt: auditErrorLog.modifiedAt,
        artifacts: [],
        source: {
          kind: "log_metadata",
          ref: auditErrorLog.name,
        },
        confidence: "low",
      });
    }

    return jobs.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  });
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

export async function GET() {
  const [jobs, logs] = await Promise.all([buildJobs(), getKnownLogMetadata()]);

  return NextResponse.json({
    readOnly: true,
    generatedAt: new Date().toISOString(),
    jobs,
    counts: {
      total: jobs.length,
      byType: countBy(jobs.map((job) => job.type)),
      byStatus: countBy(jobs.map((job) => job.status)),
      byConfidence: countBy(jobs.map((job) => job.confidence)),
      logMetadataSources: logs.map((log) => ({
        name: log.name,
        sizeBytes: log.sizeBytes,
        modifiedAt: log.modifiedAt,
      })),
    },
  });
}
