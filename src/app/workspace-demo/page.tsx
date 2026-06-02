import { redirect } from "next/navigation";

type WorkspaceDemoSearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function workspaceRedirectHref(params: WorkspaceDemoSearchParams): string {
  const query = new URLSearchParams();
  for (const key of ["room", "project", "task", "job"] as const) {
    const value = firstParam(params[key]);
    if (value) query.set(key, value);
  }
  const serialized = query.toString();
  return serialized ? `/workspace?${serialized}` : "/workspace";
}

export default async function WorkspaceDemoPage({
  searchParams,
}: {
  searchParams?: Promise<WorkspaceDemoSearchParams>;
}) {
  redirect(workspaceRedirectHref(searchParams ? await searchParams : {}));
}
