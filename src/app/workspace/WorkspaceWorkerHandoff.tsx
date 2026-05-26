"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";

import type {
  WorkspaceLocalJob,
  WorkspaceLocalJobControlEvent,
  WorkspaceLocalWorkerPackage,
  WorkspaceLocalWorkerResult,
} from "@/lib/workspace-local-jobs";

type WorkspaceWorkerHandoffProps = {
  job: WorkspaceLocalJob;
  workerPackage: WorkspaceLocalWorkerPackage;
  packageText: string;
  events: WorkspaceLocalJobControlEvent[];
  results: WorkspaceLocalWorkerResult[];
};

function classNames(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatEventAction(action: string): string {
  return action.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function WorkspaceWorkerHandoff({
  job,
  workerPackage,
  packageText,
  events,
  results,
}: WorkspaceWorkerHandoffProps) {
  const router = useRouter();
  const [handoffState, setHandoffState] = useState<"idle" | "ready" | "packaging" | "importing" | "copied" | "error">("idle");
  const [message, setMessage] = useState("Manual local handoff only. No worker, model, Slack, Supabase, or external send is wired.");
  const [resultTitle, setResultTitle] = useState("");
  const [resultBody, setResultBody] = useState("");
  const canImport = resultBody.trim().length > 0 && handoffState !== "importing";
  const hasReadyEvent = useMemo(
    () => events.some((event) => event.action === "ready_for_worker" || event.action === "worker_package_created"),
    [events],
  );
  const hasPackageEvent = useMemo(
    () => events.some((event) => event.action === "worker_package_created"),
    [events],
  );
  const latestRequestFiles = useMemo(
    () => [...events].reverse().find((event) => event.requestFiles)?.requestFiles ?? null,
    [events],
  );
  const latestResultPath = useMemo(
    () => [...events].reverse().find((event) => event.resultPath)?.resultPath ?? null,
    [events],
  );
  const latestLibrarianReferences = useMemo(
    () => [...events].reverse().find((event) => event.librarianReferences?.length)?.librarianReferences ?? [],
    [events],
  );
  const localAdapterState = useMemo(() => {
    if (job.status === "completed_local") return "completed local";
    if (job.status === "worker_failed") return "failed locally";
    if (job.status === "worker_result_written") return "result written";
    if (job.status === "worker_staged") return "staged locally";
    if (job.status === "worker_claimed") return "claimed locally";
    if (job.status === "ready_for_worker") return "ready for worker";
    return job.status.replaceAll("_", " ");
  }, [job.status]);

  async function postControl(body: Record<string, unknown>) {
    const response = await fetch("/api/workspace/local-jobs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, ...body }),
    });
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(payload?.error ?? "Unable to save local worker handoff event.");
  }

  async function markReady() {
    setHandoffState("ready");
    setMessage("Marking ready in local control JSONL...");
    try {
      await postControl({ action: "ready_for_worker" });
      setMessage("Ready for manual handoff. Still not executing.");
      router.refresh();
    } catch (error) {
      setHandoffState("error");
      setMessage(error instanceof Error ? error.message : "Unable to mark ready locally.");
    }
  }

  async function recordPackage() {
    setHandoffState("packaging");
    setMessage("Recording package-created event locally...");
    try {
      await postControl({ action: "worker_package_created", workerPackage });
      setMessage("Worker package recorded locally. No worker was invoked.");
      router.refresh();
    } catch (error) {
      setHandoffState("error");
      setMessage(error instanceof Error ? error.message : "Unable to record worker package locally.");
    }
  }

  async function copyPackage() {
    try {
      await navigator.clipboard.writeText(packageText);
      setHandoffState("copied");
      setMessage("Package text copied. Copying does not send or execute anything.");
    } catch {
      setHandoffState("error");
      setMessage("Clipboard copy was unavailable. The package remains visible below.");
    }
  }

  async function importResult(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canImport) return;

    setHandoffState("importing");
    setMessage("Importing manual result locally...");
    try {
      await postControl({
        action: "result_imported",
        resultTitle: resultTitle.trim() || undefined,
        resultBody: resultBody.trim(),
      });
      setResultTitle("");
      setResultBody("");
      setMessage("Manual result imported locally. It is not delivered or sent.");
      router.refresh();
    } catch (error) {
      setHandoffState("error");
      setMessage(error instanceof Error ? error.message : "Unable to import manual result.");
    }
  }

  return (
    <section className="rounded-lg border border-emerald-300/15 bg-emerald-400/[0.045] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-emerald-300">Manual worker handoff</p>
          <p className="mt-1 text-sm leading-6 text-stone-300">
            Create a local package, or use the Codex adapter CLI to stage files on disk. Codex, Claude, Hermes, sends, and external writes are not invoked here.
          </p>
        </div>
        <span className="rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
          {localAdapterState}
        </span>
      </div>

      {latestRequestFiles ? (
        <div className="mt-4 rounded-md border border-white/10 bg-black/15 p-3">
          <p className="text-[11px] font-semibold uppercase text-stone-500">Local Codex adapter files</p>
          <div className="mt-2 grid gap-1 text-xs leading-5 text-stone-400">
            <p className="break-all">Request JSON: {latestRequestFiles.requestJsonPath}</p>
            <p className="break-all">Request MD: {latestRequestFiles.requestMarkdownPath}</p>
            <p className="break-all">Result JSON: {latestRequestFiles.resultJsonPath}</p>
            <p className="break-all">Result MD: {latestRequestFiles.resultMarkdownPath}</p>
            {latestResultPath ? <p className="break-all text-emerald-300">Imported result path: {latestResultPath}</p> : null}
          </div>
        </div>
      ) : null}

      {latestLibrarianReferences.length ? (
        <div className="mt-4 rounded-md border border-white/10 bg-black/15 p-3">
          <p className="text-[11px] font-semibold uppercase text-stone-500">Existing Librarian outputs</p>
          <div className="mt-2 grid gap-2">
            {latestLibrarianReferences.map((reference) => (
              <div key={`${reference.type}-${reference.sourcePath}`} className="border-b border-white/10 pb-2 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-stone-200">{reference.title}</p>
                  <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-stone-400">
                    {reference.type}
                  </span>
                </div>
                <p className="mt-1 break-all text-xs leading-5 text-stone-500">{reference.sourcePath}</p>
                {reference.summary ? <p className="mt-1 text-xs leading-5 text-stone-400">{reference.summary}</p> : null}
                <p className="mt-1 text-xs leading-5 text-emerald-300">{reference.relevanceReason}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          onClick={markReady}
          disabled={handoffState === "ready" || hasReadyEvent}
          className="rounded-md bg-stone-100 px-2.5 py-1.5 text-xs font-semibold text-stone-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-stone-500 sm:px-3"
        >
          {hasReadyEvent ? "Ready locally" : "Mark ready"}
        </button>
        <button
          type="button"
          onClick={recordPackage}
          disabled={handoffState === "packaging"}
          className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-semibold text-stone-300 disabled:cursor-not-allowed disabled:text-stone-600 sm:px-3"
        >
          {hasPackageEvent ? "Record package again" : "Record package"}
        </button>
        <button
          type="button"
          onClick={copyPackage}
          className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-semibold text-stone-300 sm:px-3"
        >
          Copy package
        </button>
        <button
          type="button"
          disabled
          className="rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-xs font-semibold text-stone-600 sm:px-3"
        >
          Run unavailable
        </button>
        <button
          type="button"
          disabled
          className="rounded-md border border-white/10 bg-white/[0.025] px-2.5 py-1.5 text-xs font-semibold text-stone-600 sm:px-3"
        >
          Send unavailable
        </button>
      </div>

      <p className={classNames(
        "mt-3 text-xs leading-5",
        handoffState === "error" ? "text-rose-300" : ["copied", "ready"].includes(handoffState) ? "text-emerald-300" : "text-stone-500",
      )}>
        {message}
      </p>

      <div className="mt-4 grid gap-4">
        <label className="grid gap-1">
          <span className="text-[11px] font-medium uppercase text-stone-500">Read-only worker package</span>
          <textarea
            readOnly
            className="min-h-64 w-full resize-y rounded-md border border-white/10 bg-black/25 px-3 py-2 font-mono text-xs leading-5 text-stone-300 outline-none"
            value={packageText}
          />
        </label>

        <form onSubmit={importResult} className="grid gap-3 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase text-stone-500">Manual result import</p>
            <span className="text-xs text-stone-500">Stored locally, not delivered</span>
          </div>
          <input
            className="min-h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-stone-100 outline-none focus:border-white/30"
            placeholder="Optional result title"
            value={resultTitle}
            onChange={(event) => setResultTitle(event.target.value)}
          />
          <textarea
            aria-label="Manual worker result"
            className="min-h-32 resize-y rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm leading-6 text-stone-100 outline-none placeholder:text-stone-600 focus:border-white/30"
            placeholder="Paste a local worker result here. This records the result only; it does not send, approve, publish, or write to external systems."
            value={resultBody}
            onChange={(event) => setResultBody(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!canImport}
              className="rounded-md bg-stone-100 px-3 py-1.5 text-xs font-semibold text-stone-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-stone-500"
            >
              {handoffState === "importing" ? "Importing..." : "Import result locally"}
            </button>
            <button
              type="button"
              disabled
              className="rounded-md border border-white/10 bg-white/[0.025] px-3 py-1.5 text-xs font-semibold text-stone-600"
            >
              Deliver unavailable
            </button>
          </div>
        </form>

        <div className="grid gap-3 border-t border-white/10 pt-4">
          <p className="text-[11px] font-semibold uppercase text-stone-500">Selected task thread</p>
          <div className="grid gap-2">
            {events.length ? events.map((event) => (
              <div key={event.id} className="rounded-md border border-white/10 bg-black/15 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-stone-200">{formatEventAction(event.action)}</p>
                  <span className="text-xs text-stone-500">{formatDate(event.createdAt)}</span>
                </div>
                {event.workerPackage ? (
                  <p className="mt-1 break-all text-xs text-stone-500">{event.workerPackage.packageId}</p>
                ) : null}
                {event.requestFiles ? (
                  <div className="mt-2 grid gap-1 text-xs leading-5 text-stone-500">
                    <p className="break-all">Request: {event.requestFiles.requestMarkdownPath}</p>
                    <p className="break-all">Result target: {event.requestFiles.resultMarkdownPath}</p>
                  </div>
                ) : null}
                {event.librarianReferences?.length ? (
                  <p className="mt-1 text-xs text-stone-500">
                    {event.librarianReferences.length} existing Librarian reference{event.librarianReferences.length === 1 ? "" : "s"} included.
                  </p>
                ) : null}
                {event.resultPath ? (
                  <p className="mt-1 break-all text-xs text-emerald-300">{event.resultPath}</p>
                ) : null}
                {event.result ? (
                  <p className="mt-1 text-xs text-emerald-300">{event.result.title}</p>
                ) : null}
                {event.errorMessage ? (
                  <p className="mt-1 break-words text-xs text-rose-300">{event.errorMessage}</p>
                ) : null}
              </div>
            )) : (
              <p className="rounded-md border border-white/10 bg-black/15 p-3 text-sm text-stone-500">
                No handoff events yet. Mark ready or record the package to start the local thread.
              </p>
            )}
          </div>

          {results.length ? (
            <div className="grid gap-2">
              {results.map((result) => (
                <article key={result.id} className="rounded-md border border-emerald-300/15 bg-black/20 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-stone-100">{result.title}</p>
                    <span className="rounded-md border border-emerald-300/20 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                      {result.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-stone-300">{result.body}</p>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
