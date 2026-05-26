"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";

import type { WorkspaceLocalJob, WorkspaceLocalJobWorkflow } from "@/lib/workspace-local-jobs";

type Option = {
  id: string;
  label: string;
};

type WorkspaceLocalJobControlsProps = {
  job: WorkspaceLocalJob;
  role: string;
  rooms: Option[];
  projects: Option[];
};

const WORKFLOWS: Array<{ id: WorkspaceLocalJobWorkflow; label: string }> = [
  { id: "ask_atlas", label: "Ask Atlas" },
  { id: "audit", label: "Audit" },
  { id: "content_batch", label: "Content batch" },
  { id: "call_archive", label: "Call archive" },
  { id: "training_session", label: "Training session" },
  { id: "general", label: "General" },
];

function workspaceHref(room: string, project: string, role: string, job?: string): string {
  const params = new URLSearchParams({ room, project, role });
  if (job) params.set("job", job);
  return `/workspace?${params.toString()}`;
}

function classNames(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function WorkspaceLocalJobControls({
  job,
  role,
  rooms,
  projects,
}: WorkspaceLocalJobControlsProps) {
  const router = useRouter();
  const [title, setTitle] = useState(job.title);
  const [prompt, setPrompt] = useState(job.prompt);
  const [room, setRoom] = useState(job.room);
  const [project, setProject] = useState(job.project);
  const [intendedWorkflow, setIntendedWorkflow] = useState<WorkspaceLocalJobWorkflow>(job.intendedWorkflow);
  const [state, setState] = useState<"idle" | "saving" | "archiving" | "deleting" | "saved" | "error">("idle");
  const [message, setMessage] = useState("Local controls write only to Workspace control JSONL. Nothing executes.");

  const hasChanges = useMemo(
    () =>
      title.trim() !== job.title ||
      prompt.trim() !== job.prompt ||
      room !== job.room ||
      project !== job.project ||
      intendedWorkflow !== job.intendedWorkflow,
    [intendedWorkflow, job, project, prompt, room, title],
  );
  const canSave = hasChanges && title.trim().length > 0 && prompt.trim().length > 0 && state !== "saving";

  async function saveLocalChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;

    setState("saving");
    setMessage("Saving local control event...");
    try {
      const response = await fetch("/api/workspace/local-jobs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          action: "update",
          title: title.trim(),
          prompt: prompt.trim(),
          room,
          project,
          intendedWorkflow,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Unable to save local changes.");

      setState("saved");
      setMessage("Local changes saved. Still not executing.");
      router.push(workspaceHref(room, project, role, job.id));
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Unable to save local changes.");
    }
  }

  async function archiveLocalJob() {
    setState("archiving");
    setMessage("Archiving locally...");
    try {
      const response = await fetch("/api/workspace/local-jobs", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.id, action: "archive" }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Unable to archive local job.");

      router.push(workspaceHref(room, project, role));
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Unable to archive local job.");
    }
  }

  async function deleteLocalJob() {
    setState("deleting");
    setMessage("Deleting locally...");
    try {
      const response = await fetch(`/api/workspace/local-jobs?jobId=${encodeURIComponent(job.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Unable to delete local job.");

      router.push(workspaceHref(room, project, role));
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Unable to delete local job.");
    }
  }

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.045] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase text-stone-500">Local control layer</p>
          <p className="mt-1 text-sm leading-6 text-stone-400">
            Edit, move, archive, or delete this draft locally. These controls do not start workers, models, file operations, or sends.
          </p>
        </div>
        <span className="rounded-md border border-amber-300/20 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
          JSONL control only
        </span>
      </div>

      <form onSubmit={saveLocalChanges} className="mt-4 grid gap-3">
        <label className="grid gap-1">
          <span className="text-[11px] font-medium uppercase text-stone-500">Name</span>
          <input
            className="min-h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-stone-100 outline-none focus:border-white/30"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-[11px] font-medium uppercase text-stone-500">Draft prompt</span>
          <textarea
            className="min-h-28 resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm leading-6 text-stone-100 outline-none focus:border-white/30"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1">
            <span className="text-[11px] font-medium uppercase text-stone-500">Room</span>
            <select
              className="h-10 rounded-md border border-white/10 bg-[#171717] px-3 text-sm text-stone-100 outline-none focus:border-white/30"
              value={room}
              onChange={(event) => setRoom(event.target.value)}
            >
              {rooms.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="text-[11px] font-medium uppercase text-stone-500">Project</span>
            <select
              className="h-10 rounded-md border border-white/10 bg-[#171717] px-3 text-sm text-stone-100 outline-none focus:border-white/30"
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              {projects.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="grid gap-1">
            <span className="text-[11px] font-medium uppercase text-stone-500">Workflow</span>
            <select
              className="h-10 rounded-md border border-white/10 bg-[#171717] px-3 text-sm text-stone-100 outline-none focus:border-white/30"
              value={intendedWorkflow}
              onChange={(event) => setIntendedWorkflow(event.target.value as WorkspaceLocalJobWorkflow)}
            >
              {WORKFLOWS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-md bg-stone-100 px-3 py-1.5 text-xs font-semibold text-stone-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-stone-500"
          >
            {state === "saving" ? "Saving..." : "Save local changes"}
          </button>
          <button
            type="button"
            onClick={archiveLocalJob}
            disabled={state === "archiving" || state === "deleting"}
            className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-stone-300 disabled:cursor-not-allowed disabled:text-stone-600"
          >
            {state === "archiving" ? "Archiving..." : "Archive locally"}
          </button>
          <button
            type="button"
            onClick={deleteLocalJob}
            disabled={state === "deleting" || state === "archiving"}
            className="rounded-md border border-rose-300/20 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 disabled:cursor-not-allowed disabled:text-rose-400/50"
          >
            {state === "deleting" ? "Deleting..." : "Delete locally"}
          </button>
          <p className={classNames(
            "min-w-0 basis-full text-xs sm:flex-1 sm:basis-auto",
            state === "error" ? "text-rose-300" : state === "saved" ? "text-emerald-300" : "text-stone-500",
          )}>
            {message}
          </p>
        </div>
      </form>
    </section>
  );
}
