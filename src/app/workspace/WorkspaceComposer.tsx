"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type { WorkspaceLocalJobWorkflow } from "@/lib/workspace-local-jobs";

type WorkspaceComposerProps = {
  room: string;
  role: string;
  project: string;
  title?: string;
  helperText?: string;
  placeholder?: string;
  defaultWorkflow?: WorkspaceLocalJobWorkflow;
  visibleWorkflows?: WorkspaceLocalJobWorkflow[];
};

const INTENTS: Array<{ label: string; workflow: WorkspaceLocalJobWorkflow; prompt: string }> = [
  { label: "Ask Atlas", workflow: "ask_atlas", prompt: "" },
  { label: "Audit draft", workflow: "audit", prompt: "Draft a local L2 audit intake note: " },
  { label: "Content draft", workflow: "content_batch", prompt: "Draft a local content batch note: " },
  { label: "Call archive draft", workflow: "call_archive", prompt: "Draft a local call archive note: " },
  { label: "Training draft", workflow: "training_session", prompt: "Draft a local training session note about: " },
];

function classNames(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function WorkspaceComposer({
  room,
  role,
  project,
  title = "Local intake",
  helperText = "Local JSONL draft only",
  placeholder = "Ask Atlas to start a local draft job. It will appear in the work stream, but no model or worker will run.",
  defaultWorkflow = "ask_atlas",
  visibleWorkflows,
}: WorkspaceComposerProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [workflow, setWorkflow] = useState<WorkspaceLocalJobWorkflow>(defaultWorkflow);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("Local draft only. Nothing executes yet.");
  const canSubmit = prompt.trim().length > 0 && state !== "saving";
  const availableIntents = useMemo(
    () => visibleWorkflows?.length
      ? INTENTS.filter((intent) => visibleWorkflows.includes(intent.workflow))
      : INTENTS,
    [visibleWorkflows],
  );

  const selectedLabel = useMemo(
    () => availableIntents.find((intent) => intent.workflow === workflow)?.label
      ?? INTENTS.find((intent) => intent.workflow === workflow)?.label
      ?? "Ask Atlas",
    [availableIntents, workflow],
  );

  useEffect(() => {
    setWorkflow(defaultWorkflow);
    setState("idle");
    setMessage("Local draft only. Nothing executes yet.");
  }, [defaultWorkflow]);

  async function submitLocalJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setState("saving");
    setMessage("Saving local draft...");

    try {
      const response = await fetch("/api/workspace/local-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          project,
          room,
          requesterRole: role,
          intendedWorkflow: workflow,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Unable to save local draft.");

      setPrompt("");
      setState("saved");
      setMessage("Local draft queued. It is not executing.");
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Unable to save local draft.");
    }
  }

  function chooseIntent(intent: typeof INTENTS[number]) {
    setWorkflow(intent.workflow);
    setState("idle");
    setMessage(`${intent.label} selected. This will create a local draft only.`);
    if (!prompt.trim() && intent.prompt) setPrompt(intent.prompt);
  }

  return (
    <div className="w-full max-w-full">
      <form onSubmit={submitLocalJob} className="w-full overflow-hidden rounded-lg border border-white/10 bg-[#1f1f1f] p-3 shadow-sm shadow-black/20">
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
          <div>
            <p className="text-[11px] font-semibold uppercase text-stone-500">{title}</p>
            <p className="mt-1 text-xs text-stone-400">{selectedLabel} / {helperText}</p>
          </div>
          <span className="rounded-md border border-blue-300/20 bg-blue-400/10 px-2 py-0.5 text-[11px] font-medium text-blue-200">
            Not executing
          </span>
        </div>
        <textarea
          aria-label="Atlas local job composer"
          className="min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-stone-100 outline-none placeholder:text-stone-600 sm:min-h-16"
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            if (state !== "saving") setState("idle");
          }}
          placeholder={placeholder}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-2 pt-2 sm:pt-3">
          {availableIntents.map((intent, index) => (
            <button
              key={intent.label}
              type="button"
              onClick={() => chooseIntent(intent)}
              className={classNames(
                "rounded-md border px-2 py-1 text-xs font-medium transition",
                workflow === intent.workflow
                  ? "border-stone-100 bg-stone-100 text-stone-950"
                  : "border-white/10 bg-white/[0.03] text-stone-400 hover:border-white/20 hover:text-stone-200",
                index > 2 && "hidden sm:inline-flex",
              )}
            >
              {intent.label}
            </button>
          ))}
          <p className={classNames(
            "min-w-0 basis-full text-xs sm:flex-1 sm:basis-auto",
            state === "error" ? "text-rose-300" : state === "saved" ? "text-emerald-300" : "text-stone-500",
          )}>
            {message}
          </p>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-stone-100 px-3 py-1.5 text-xs font-semibold text-stone-950 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-stone-500"
          >
            {state === "saving" ? "Saving..." : "Queue draft"}
          </button>
        </div>
      </form>
    </div>
  );
}
