/**
 * Read-only projection over the durable L2 audit run records written by the
 * audit pipeline at `state/audit-runs/<runId>.json`.
 *
 * READ-ONLY by construction: this module only ever reads + maps record files to
 * safe metadata. It never writes, deletes, sends, or posts anything. It mirrors
 * the pattern of `artifact-projection.ts` (filesystem → projection) but reads
 * the DURABLE run contract instead of inferring jobs from artifacts on disk.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const AUDIT_RUNS_DIR = "/Users/atlasai/.openclaw/workspace/state/audit-runs";

const ATTENTION_STATUSES = new Set(["blocked", "failed"]);

export interface AuditRunProjection {
  runId: string;
  status: string;
  sourceType: string;
  sourceId: string | null;
  business: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  reviewerRequired: boolean;
  reviewChannel: { name: string | null; wired: boolean };
  deliveryPolicy: {
    reviewTarget: string | null;
    clientDelivery: boolean;
    deliverAsRhys: boolean;
    dmRhys: boolean;
  };
  qa: { pass: boolean | null; blockingFailures: string[] } | null;
  artifacts: { markdownPath: string | null; pdfPath: string | null };
  errorSummary: string | null;
}

export interface AuditRunsSummary {
  total: number;
  byStatus: Record<string, number>;
  readyForReview: number;
  needsAttention: number;
}

export async function getAuditRuns(dir: string = AUDIT_RUNS_DIR): Promise<AuditRunProjection[]> {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const runs: AuditRunProjection[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const r = JSON.parse(raw);
      runs.push({
        runId: r.runId,
        status: r.status,
        sourceType: r.sourceType ?? "unknown",
        sourceId: r.sourceId ?? null,
        business: r.inputSummary?.businessName ?? null,
        createdAt: r.createdAt ?? null,
        updatedAt: r.updatedAt ?? null,
        reviewerRequired: r.reviewerRequired ?? true,
        reviewChannel: {
          name: r.reviewChannel?.name ?? null,
          wired: Boolean(r.reviewChannel?.wired),
        },
        deliveryPolicy: {
          reviewTarget: r.deliveryPolicy?.reviewTarget ?? null,
          clientDelivery: Boolean(r.deliveryPolicy?.clientDelivery),
          deliverAsRhys: Boolean(r.deliveryPolicy?.deliverAsRhys),
          dmRhys: Boolean(r.deliveryPolicy?.dmRhys),
        },
        qa: r.qa ? { pass: r.qa.pass ?? null, blockingFailures: r.qa.blockingFailures ?? [] } : null,
        artifacts: {
          markdownPath: r.artifacts?.markdownPath ?? null,
          pdfPath: r.artifacts?.pdfPath ?? null,
        },
        errorSummary: r.errorSummary ?? null,
      });
    } catch {
      // skip partial / unreadable records — projection must never throw
    }
  }
  return runs.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
}

export function summariseAuditRuns(runs: AuditRunProjection[]): AuditRunsSummary {
  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    total: runs.length,
    byStatus,
    readyForReview: runs.filter((r) => r.status === "ready_for_review").length,
    needsAttention: runs.filter((r) => ATTENTION_STATUSES.has(r.status)).length,
  };
}
