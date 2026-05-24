import { NextResponse } from "next/server";

import { EXPORTS_ROOT, getWorkspaceArtifacts } from "../_lib/artifact-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

export async function GET() {
  const artifacts = await getWorkspaceArtifacts();

  return NextResponse.json({
    readOnly: true,
    generatedAt: new Date().toISOString(),
    root: EXPORTS_ROOT,
    artifacts,
    counts: {
      total: artifacts.length,
      byWorkflow: countBy(artifacts.map((artifact) => artifact.inferredWorkflow)),
      byKind: countBy(artifacts.map((artifact) => artifact.kind)),
      byFormat: countBy(artifacts.map((artifact) => artifact.format)),
      withPreview: artifacts.filter((artifact) => artifact.previewPath).length,
      validation: countBy(artifacts.map((artifact) => artifact.validationStatus)),
    },
  });
}
