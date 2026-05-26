import { NextResponse } from "next/server";

import {
  applyWorkspaceLocalJobControl,
  createWorkspaceLocalJob,
  getWorkspaceLocalJobs,
  validateWorkspaceLocalJobControlInput,
  validateWorkspaceLocalJobInput,
} from "@/lib/workspace-local-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeError(message: string, status = 400) {
  return NextResponse.json(
    {
      ok: false,
      localOnly: true,
      error: message,
    },
    { status },
  );
}

export async function GET() {
  const projection = await getWorkspaceLocalJobs();
  return NextResponse.json({
    ok: true,
    readOnly: true,
    localOnly: true,
    source: "workspace-local-jsonl",
    ...projection,
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError("Request body must be JSON.");
  }

  const checked = validateWorkspaceLocalJobInput(body);
  if (!checked.ok) return safeError(checked.errors.join(" "));

  try {
    const job = await createWorkspaceLocalJob(checked.value);
    return NextResponse.json(
      {
        ok: true,
        localOnly: true,
        job,
      },
      { status: 201 },
    );
  } catch (error) {
    return safeError(error instanceof Error ? error.message : "Unable to create local job.", 500);
  }
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return safeError("Request body must be JSON.");
  }

  const checked = validateWorkspaceLocalJobControlInput(body);
  if (!checked.ok) return safeError(checked.errors.join(" "));

  try {
    const projection = await getWorkspaceLocalJobs();
    const jobExists = [...projection.records, ...projection.archivedRecords].some((job) => job.id === checked.value.jobId);
    if (!jobExists) return safeError("Local job was not found.", 404);

    const control = await applyWorkspaceLocalJobControl(checked.value);
    return NextResponse.json({
      ok: true,
      localOnly: true,
      nonExecuting: true,
      control,
    });
  } catch (error) {
    return safeError(error instanceof Error ? error.message : "Unable to update local job.", 500);
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return safeError("jobId is required.");

  try {
    const projection = await getWorkspaceLocalJobs();
    const jobExists = [...projection.records, ...projection.archivedRecords].some((job) => job.id === jobId);
    if (!jobExists) return safeError("Local job was not found.", 404);

    const control = await applyWorkspaceLocalJobControl({ jobId, action: "delete" });
    return NextResponse.json({
      ok: true,
      localOnly: true,
      nonExecuting: true,
      control,
    });
  } catch (error) {
    return safeError(error instanceof Error ? error.message : "Unable to delete local job.", 500);
  }
}
