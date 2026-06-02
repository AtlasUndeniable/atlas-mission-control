"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  demoRhysReadyStarterPrompt,
  demoRhysReadyTaskTitle,
  demoStarterPrompts,
  demoUserPrompt,
  demoWorkspace,
  type AgentEvent,
  type Artifact,
  type Message,
  type Task,
  type TaskStep,
} from "@/lib/workspace-demo-events";
import { LocalWorkspaceEventSource } from "@/lib/workspace-local-event-source";
import styles from "./workspace-demo.module.css";

type RunState = "idle" | "running" | "complete";
type ReferenceCoverage = "matched" | "thin" | "none";

interface ArtifactPreview {
  id: string;
  title: string;
  type: "markdown" | "pdf";
  createdAt: string;
  taskTitle: string;
  runtimeProvider: string;
  requestedFormat: string;
  markdown?: string;
  pdf?: {
    url: string;
    downloadUrl: string;
    filename: string;
    byteLength: number;
  };
}

type ArtifactPreviewState =
  | { status: "closed" }
  | { status: "loading"; artifact: Artifact }
  | { status: "ready"; artifact: Artifact; preview: ArtifactPreview }
  | { status: "missing"; artifact: Artifact }
  | { status: "error"; artifact: Artifact; message: string };

interface ReferenceInspectorPacket {
  resolvedAt: string;
  coverage: ReferenceCoverage;
  rootsRead: Array<{
    key: string;
    present: boolean;
    pathSummary: string;
  }>;
  references: Array<{
    handle: string;
    title: string;
    sourceType: string;
    pathSummary: string;
    freshness?: string;
    confidence: string;
    matchedTerms: string[];
  }>;
  userFacingSummary: string;
}

interface ThreadState {
  messages: Message[];
  artifacts: Artifact[];
  steps: TaskStep[];
  task: Task | null;
  tasks: Task[];
  internalEvents: AgentEvent[];
}

const initialThreadState: ThreadState = {
  messages: [],
  artifacts: [],
  steps: [],
  task: null,
  tasks: [],
  internalEvents: [],
};

interface StoredWorkspaceThread {
  threadState: ThreadState;
  runState: Exclude<RunState, "running">;
  activeTaskTitle: string;
}

const THREAD_STORAGE_KEY = "atlas.workspace.activeThread.v1";

function titleForPrompt(prompt: string): string {
  return prompt === demoRhysReadyStarterPrompt ? demoRhysReadyTaskTitle : "Atlas workspace session";
}

function reduceEvent(state: ThreadState, event: AgentEvent): ThreadState {
  if (event.visibility === "internal") {
    return { ...state, internalEvents: [...state.internalEvents, event] };
  }

  if (event.kind === "message.complete") {
    const existing = state.messages.find((message) => message.id === event.messageId);
    const nextMessage: Message = { id: event.messageId, role: event.role, content: event.content, complete: true };
    return {
      ...state,
      messages: existing
        ? state.messages.map((message) => (message.id === event.messageId ? nextMessage : message))
        : [...state.messages, nextMessage],
    };
  }

  if (event.kind === "message.delta") {
    const existing = state.messages.find((message) => message.id === event.messageId);
    if (!existing) {
      return {
        ...state,
        messages: [...state.messages, { id: event.messageId, role: event.role, content: event.delta, complete: false }],
      };
    }
    if (existing.complete) return state;
    return {
      ...state,
      messages: state.messages.map((message) =>
        message.id === event.messageId ? { ...message, content: message.content + event.delta } : message,
      ),
    };
  }

  if (event.kind === "artifact.created") {
    if (state.artifacts.some((artifact) => artifact.id === event.artifact.id)) return state;
    return { ...state, artifacts: [...state.artifacts, event.artifact] };
  }

  if (event.kind === "task.step") {
    return {
      ...state,
      steps: state.steps.some((step) => step.id === event.step.id)
        ? state.steps.map((step) => (step.id === event.step.id ? event.step : step))
        : [...state.steps, event.step],
    };
  }

  if (event.kind === "task.complete") {
    const taskSnapshot: Task = { ...event.task, id: `${event.runId}:${event.task.id}` };
    return {
      ...state,
      task: event.task,
      tasks: state.tasks.some((task) => task.id === taskSnapshot.id)
        ? state.tasks.map((task) => (task.id === taskSnapshot.id ? taskSnapshot : task))
        : [...state.tasks, taskSnapshot],
      steps: event.task.steps,
    };
  }

  return state;
}

function safeStoredThread(value: string | null): StoredWorkspaceThread | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredWorkspaceThread>;
    if (!parsed.threadState || typeof parsed.threadState !== "object") return null;
    const thread = parsed.threadState as Partial<ThreadState>;
    if (!Array.isArray(thread.messages) || !Array.isArray(thread.artifacts) || !Array.isArray(thread.internalEvents)) return null;
    return {
      threadState: {
        messages: thread.messages,
        artifacts: thread.artifacts,
        steps: Array.isArray(thread.steps) ? thread.steps : [],
        task: thread.task ?? null,
        tasks: Array.isArray(thread.tasks) ? thread.tasks : thread.task ? [thread.task] : [],
        internalEvents: thread.internalEvents,
      },
      runState: parsed.runState === "complete" ? "complete" : "idle",
      activeTaskTitle: typeof parsed.activeTaskTitle === "string" && parsed.activeTaskTitle.trim()
        ? parsed.activeTaskTitle
        : "New session",
    };
  } catch {
    return null;
  }
}

function readStoredWorkspaceThread(): StoredWorkspaceThread | null {
  if (typeof window === "undefined") return null;
  return safeStoredThread(window.sessionStorage.getItem(THREAD_STORAGE_KEY));
}

function readLatestReferencePacket(events: AgentEvent[]): ReferenceInspectorPacket | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind !== "tool.result" || event.toolName !== "workspace.references") continue;
    try {
      const parsed = JSON.parse(event.resultSummary) as Partial<ReferenceInspectorPacket>;
      if (
        parsed &&
        (parsed.coverage === "matched" || parsed.coverage === "thin" || parsed.coverage === "none") &&
        Array.isArray(parsed.rootsRead) &&
        Array.isArray(parsed.references)
      ) {
        return {
          resolvedAt: typeof parsed.resolvedAt === "string" ? parsed.resolvedAt : "",
          coverage: parsed.coverage,
          rootsRead: parsed.rootsRead.map((root) => ({
            key: typeof root.key === "string" ? root.key : "unknown",
            present: Boolean(root.present),
            pathSummary: typeof root.pathSummary === "string" ? root.pathSummary : "unknown",
          })),
          references: parsed.references.map((reference) => ({
            handle: typeof reference.handle === "string" ? reference.handle : "unknown",
            title: typeof reference.title === "string" ? reference.title : "Untitled reference",
            sourceType: typeof reference.sourceType === "string" ? reference.sourceType : "unknown",
            pathSummary: typeof reference.pathSummary === "string" ? reference.pathSummary : "unknown",
            ...(typeof reference.freshness === "string" ? { freshness: reference.freshness } : {}),
            confidence: typeof reference.confidence === "string" ? reference.confidence : "unknown",
            matchedTerms: Array.isArray(reference.matchedTerms)
              ? reference.matchedTerms.filter((term): term is string => typeof term === "string")
              : [],
          })),
          userFacingSummary: typeof parsed.userFacingSummary === "string" ? parsed.userFacingSummary : "",
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function IconDocument() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg className={styles.spinnerArc} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeDasharray="3 3.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="5" r="0.8" />
      <circle cx="12" cy="12" r="0.8" />
      <circle cx="12" cy="19" r="0.8" />
    </svg>
  );
}

function IconShare() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M16 6 12 2 8 6" />
      <path d="M12 2v13" />
    </svg>
  );
}

function IconChevronDown({ expanded = false, size = 14 }: { expanded?: boolean; size?: number }) {
  return (
    <svg className={expanded ? styles.chevronOpen : undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Composer({
  prompt,
  runState,
  onPromptChange,
  onStart,
}: {
  prompt: string;
  runState: RunState;
  onPromptChange: (prompt: string) => void;
  onStart: (nextPrompt?: string) => void;
}) {
  const isRunning = runState === "running";
  const enterSubmitRef = useRef(false);
  const handleSubmit = () => {
    if (!isRunning) onStart(prompt);
  };
  const handleEnterSubmit = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isEnter = event.key === "Enter" || event.code === "Enter" || event.keyCode === 13;
    if (!isEnter || event.shiftKey) return false;
    event.preventDefault();
    handleSubmit();
    return true;
  };
  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        <button className={styles.composerIcon} type="button" aria-label="Attach file"><IconPlus /></button>
        <textarea
          className={styles.composerInput}
          value={prompt}
          placeholder="Message Atlas"
          readOnly={isRunning}
          aria-label="Message Atlas"
          rows={1}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            enterSubmitRef.current = handleEnterSubmit(event);
          }}
          onKeyUp={(event) => {
            if (enterSubmitRef.current) {
              enterSubmitRef.current = false;
              return;
            }
            handleEnterSubmit(event);
          }}
        />
        <button className={styles.composerIcon} type="button" aria-label="Voice input">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v4" /></svg>
        </button>
        <button className={styles.composerSend} type="button" onClick={handleSubmit} disabled={isRunning} aria-label="Send message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
        </button>
      </div>
      <div className={styles.composerFoot}>Atlas can make mistakes. Verify decisions before acting.</div>
    </div>
  );
}

function EmptyState({
  prompt,
  onPromptChange,
  onStart,
}: {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onStart: (nextPrompt?: string) => void;
}) {
  return (
    <section className={styles.emptyState}>
      <p className={styles.emptyKicker}>What do you want to do?</p>
      <Composer prompt={prompt} runState="idle" onPromptChange={onPromptChange} onStart={onStart} />
      <div className={styles.starterChips}>
        {demoStarterPrompts.map((prompt) => (
          <button
            key={prompt}
            className={styles.starterChip}
            type="button"
            onClick={() => {
              onPromptChange(prompt);
              onStart(prompt);
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part.split("\n").map((line, lineIndex) => (
      <Fragment key={`${index}-${lineIndex}`}>
        {lineIndex > 0 ? <br /> : null}
        {line}
      </Fragment>
    ));
  }).flat();
}

type MarkdownSection =
  | { type: "heading"; depth: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    sections.push({ type: "paragraph", text: paragraph.join("\n").trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    sections.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      sections.push({ type: "heading", depth: heading[1].length, text: heading[2] });
      continue;
    }

    const listItem = line.trim().match(/^([-*]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listItem[2]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return sections;
}

function MarkdownLite({ content, streaming }: { content: string; streaming: boolean }) {
  const sections = parseMarkdownSections(content);
  return (
    <>
      {sections.map((section, index) => {
        const key = `${section.type}-${index}`;
        if (section.type === "heading") {
          const HeadingTag = section.depth <= 2 ? "h3" : "h4";
          return <HeadingTag key={key}>{renderInlineMarkdown(section.text)}</HeadingTag>;
        }

        if (section.type === "list") {
          const ListTag = section.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className={styles.markdownList}>
              {section.items.map((item, lineIndex) => {
                const checklist = item.match(/^\[([ xX])\]\s+(.+)$/);
                if (checklist) {
                  return (
                    <li key={lineIndex} className={styles.checkItem}>
                      <span className={checklist[1].trim() ? styles.checkBoxDone : styles.checkBox} />
                      <span>{renderInlineMarkdown(checklist[2])}</span>
                    </li>
                  );
                }
                return <li key={lineIndex}>{renderInlineMarkdown(item)}</li>;
              })}
            </ListTag>
          );
        }

        return <p key={key}>{renderInlineMarkdown(section.text)}</p>;
      })}
      {streaming ? <span className={styles.streamingCaret} aria-hidden="true" /> : null}
    </>
  );
}

function ThinkingIndicator() {
  return (
    <div className={`${styles.msgAgent} ${styles.thinkingMessage}`} aria-live="polite">
      <span>Atlas is thinking</span>
      <span className={styles.thinkingDots} aria-hidden="true"><span /><span /><span /></span>
    </div>
  );
}

function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: (artifact: Artifact) => void }) {
  const isPdf = artifact.type === "pdf";
  return (
    <button className={styles.artifactCard} type="button" onClick={() => onOpen(artifact)} aria-label={`Open ${artifact.title}`}>
      <span className={styles.artifactIcon}><IconDocument /></span>
      <span className={styles.artifactBody}>
        <span className={styles.artifactTitle}>{artifact.title}</span>
        <span className={styles.artifactMeta}>{artifact.subtitle}</span>
      </span>
      <span className={styles.artifactState}>
        <span>{isPdf ? "PDF draft saved" : "Markdown draft saved"}</span>
        <small>{isPdf ? "Open / Download PDF" : "Open preview"}</small>
      </span>
    </button>
  );
}

function ArtifactPreviewPanel({
  state,
  onClose,
}: {
  state: ArtifactPreviewState;
  onClose: () => void;
}) {
  if (state.status === "closed") return null;

  const title = state.status === "ready" ? state.preview.title : state.artifact.title;
  const type = state.status === "ready" ? state.preview.type : state.artifact.type;
  const createdAt = state.status === "ready" ? formatArtifactCreatedAt(state.preview.createdAt) : null;
  const isPdf = state.status === "ready" && state.preview.type === "pdf";
  const previewMarkdown = state.status === "ready" && state.preview.markdown ? artifactPreviewDisplayMarkdown(state.preview.markdown) : "";
  const canUseMarkdown = previewMarkdown.trim().length > 0;

  const downloadMarkdown = () => {
    if (state.status !== "ready") return;
    const blob = new Blob([previewMarkdown], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `${slugifyFilename(state.preview.title)}.md`;
    link.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className={styles.previewBackdrop} role="presentation" onClick={onClose}>
      <section className={styles.previewPanel} role="dialog" aria-modal="true" aria-label={`${title} preview`} onClick={(event) => event.stopPropagation()}>
        <header className={styles.previewHeader}>
          <span className={styles.previewKicker}>Artifact preview</span>
          <button className={styles.previewClose} type="button" onClick={onClose} aria-label="Close artifact preview">Close</button>
          <h2>{title}</h2>
          <div className={styles.previewMeta}>
            <span>{type}</span>
            {createdAt ? <span>{createdAt}</span> : null}
          </div>
        </header>
        <div className={styles.previewActions}>
          {isPdf && state.preview.pdf ? (
            <>
              <a href={state.preview.pdf.url} target="_blank" rel="noreferrer">Open PDF</a>
              <a href={state.preview.pdf.downloadUrl}>Download PDF</a>
            </>
          ) : null}
          <button type="button" onClick={downloadMarkdown} disabled={!canUseMarkdown}>Download markdown</button>
        </div>
        <div className={styles.previewBody}>
          {state.status === "loading" ? (
            <p className={styles.previewEmpty}>Loading artifact preview...</p>
          ) : state.status === "missing" ? (
            <p className={styles.previewEmpty}>This draft is no longer available locally.</p>
          ) : state.status === "error" ? (
            <p className={styles.previewEmpty}>{state.message}</p>
          ) : isPdf && state.preview.pdf ? (
            <div className={styles.previewPdf}>
              <iframe title={`${state.preview.title} PDF`} src={state.preview.pdf.url} />
              <p>
                PDF ready locally. Use Open PDF or Download PDF if the inline viewer is unavailable.
              </p>
            </div>
          ) : (
            <div className={styles.previewMarkdown}>
              <MarkdownLite content={previewMarkdown} streaming={false} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function formatArtifactCreatedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function slugifyFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workspace-draft";
}

function artifactPreviewDisplayMarkdown(markdown: string): string {
  const draftMarker = "\n## Draft\n";
  const markerIndex = markdown.indexOf(draftMarker);
  const draft = markerIndex >= 0 ? markdown.slice(markerIndex + draftMarker.length) : markdown;
  return draft
    .replace(/```(?:markdown|md)?\s*/gi, "")
    .replace(/```/g, "")
    .replace(/^Runtime provider:.*$/gmi, "")
    .replace(/^I(?:'ll| will)\s+(?:update|create|draft|build|generate|prepare|revise|refine)\s+.+?(?:\n\n|\n)/i, "")
    .replace(/^I'm\s+(?:going to\s+)?(?:update|creating|drafting|building|generating|preparing|revising|refining)\s+.+?(?:\n\n|\n)/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function TaskChip({ task, steps }: { task: Task | null; steps: TaskStep[] }) {
  const [expanded, setExpanded] = useState(false);
  const completed = task?.completedSteps ?? steps.filter((step) => step.status === "complete").length;
  const total = task?.totalSteps ?? 5;
  const title = task?.title ?? "Atlas workspace session";

  if (steps.length === 0 && !task) return null;

  return (
    <div className={styles.taskChipWrap}>
      <button className={styles.taskChip} type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className={styles.taskChipCheck}><IconCheck /></span>
        <span className={styles.taskChipTitle}>{title}</span>
        <span className={styles.taskChipSteps}>{completed}/{total}</span>
        <span className={styles.taskChipChevron}><IconChevronDown expanded={expanded} /></span>
      </button>
      {expanded ? (
        <div className={styles.stepPanel}>
          {steps.map((step, index) => (
            <div className={styles.stepRow} key={step.id}>
              <span className={styles.stepNumber}>{index + 1}</span>
              <span className={styles.stepBody}>
                <span className={styles.stepTitle}>{step.title}</span>
                {step.summary ? <span className={styles.stepSummary}>{step.summary}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReferenceCoverageLine({ packet }: { packet: ReferenceInspectorPacket | null }) {
  if (packet?.coverage === "matched") {
    return <div className={styles.referenceCoverageLine}>Using Workspace references</div>;
  }
  if (packet?.coverage === "thin") {
    return <div className={styles.referenceCoverageLine}>Limited references available</div>;
  }
  return null;
}

function ChatThread({
  state,
  runState,
  referencePacket,
  onOpenArtifact,
}: {
  state: ThreadState;
  runState: RunState;
  referencePacket: ReferenceInspectorPacket | null;
  onOpenArtifact: (artifact: Artifact) => void;
}) {
  const chatRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const hasAssistantMessage = state.messages.some((message) => message.role === "assistant");
  const taskCards = state.tasks.length > 0 ? state.tasks : state.steps.length ? [state.task].filter((task): task is Task => Boolean(task)) : [];
  const showActiveSteps = state.steps.length > 0 && (runState === "running" || taskCards.length === 0);

  const handleScroll = () => {
    const chat = chatRef.current;
    if (!chat) return;
    autoScrollRef.current = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 96;
  };

  useEffect(() => {
    if (runState === "running") {
      autoScrollRef.current = true;
    }
  }, [runState]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const chat = chatRef.current;
    if (!chat) return;
    requestAnimationFrame(() => {
      chat.scrollTop = chat.scrollHeight;
    });
  }, [state.messages, state.artifacts, state.steps]);

  return (
    <section className={styles.chat} ref={chatRef} onScroll={handleScroll}>
      <div className={styles.thread}>
        {state.messages.map((message) => (
          message.role === "user" ? (
            <div key={message.id} className={styles.msgUser}>{message.content}</div>
          ) : (
            <div key={message.id} className={styles.msgAgent}>
              <ReferenceCoverageLine packet={referencePacket} />
              <MarkdownLite content={message.content} streaming={!message.complete && runState === "running"} />
            </div>
          )
        ))}
        {state.artifacts.length ? (
          <div className={styles.threadArtifacts}>
            {state.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onOpen={onOpenArtifact} />)}
          </div>
        ) : null}
        {showActiveSteps ? <TaskChip task={state.task} steps={state.steps} /> : null}
        {taskCards.map((task) => (
          <TaskChip key={task.id} task={task} steps={task.steps} />
        ))}
        {runState === "running" && !hasAssistantMessage ? <ThinkingIndicator /> : null}
      </div>
    </section>
  );
}

function Sidebar({ runState, onNewTask }: { runState: RunState; onNewTask: () => void }) {
  const navTabs = ["Tasks", "Library", "Plugins", "Scheduled"] as const;
  const projects = ["Ricky coach hire", "L2 audit review", "Content planning", "Training / Knowledge"] as const;
  const tasks = [
    { title: "Ricky coach hire pay model", icon: runState === "running" ? <IconSpinner /> : <IconDocument /> },
    { title: "L2 audit review", icon: <IconDocument /> },
    { title: "Content plan", icon: <IconDocument /> },
    { title: "Monday board draft", icon: <IconList /> },
    { title: "Training notes", icon: <IconFolder /> },
  ] as const;

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span className={styles.brandMark} /><span className={styles.brandName}>Atlas</span><span className={styles.brandSub}>for Undeniable</span></div>
      <button className={styles.newTask} type="button" onClick={onNewTask}><span className={styles.newTaskPlus}>+</span> New task</button>
      <nav className={styles.navMini} aria-label="Workspace navigation">
        {navTabs.map((tab) => (
          <button
            aria-label={tab === "Tasks" ? "Tasks" : `${tab} coming next`}
            className={tab === "Tasks" ? styles.navMiniActive : undefined}
            disabled={tab !== "Tasks"}
            key={tab}
            title={tab === "Tasks" ? "Tasks" : `${tab} coming next`}
            type="button"
          >
            {tab}
          </button>
        ))}
      </nav>
      <div className={styles.sectionHeader}><span>Projects</span></div>
      <ul className={styles.sidebarList}>
        {projects.map((project, index) => (
          <li className={index === 0 ? styles.sidebarActive : undefined} key={project}>
            <IconFolder />
            <span className={styles.sidebarTitle}>{project}</span>
          </li>
        ))}
      </ul>
      <div className={styles.sectionHeader}><span>All Tasks</span></div>
      <ul className={styles.sidebarList}>
        {tasks.map((task, index) => (
          <li className={index === 0 ? styles.sidebarActive : undefined} key={task.title}>
            {task.icon}
            <span className={styles.sidebarTitle}>{task.title}</span>
          </li>
        ))}
      </ul>
      <div className={styles.sidebarSpacer} />
      <div className={styles.userRow}><span className={styles.avatar}>R</span><span className={styles.userMeta}><span className={styles.userName}>Rhys</span><span className={styles.userSub}>Undeniable</span></span><span className={styles.userChevron}><IconChevronDown size={13} /></span></div>
    </aside>
  );
}

function ReferenceInspectorPanel({ packet }: { packet: ReferenceInspectorPacket | null }) {
  if (!packet) {
    return <div className={styles.referencePanelEmpty}>No reference packet for this run yet.</div>;
  }

  return (
    <section className={styles.referencePanel} aria-label="Workspace reference coverage">
      <div className={styles.referencePanelHeader}>
        <span>References</span>
        <span className={`${styles.referenceCoveragePill} ${styles[`referenceCoverage_${packet.coverage}`]}`}>
          {packet.coverage}
        </span>
      </div>
      <div className={styles.referenceRoots}>
        {packet.rootsRead.map((root) => (
          <span className={styles.referenceRoot} key={root.key}>
            <span className={root.present ? styles.rootPresent : styles.rootMissing} />
            {root.key}
          </span>
        ))}
      </div>
      {packet.references.length ? (
        <div className={styles.referenceList}>
          {packet.references.map((reference) => (
            <div className={styles.referenceItem} key={reference.handle}>
              <div className={styles.referenceItemTop}>
                <span className={styles.referenceTitle}>{reference.title}</span>
                <span className={styles.referenceConfidence}>{reference.confidence}</span>
              </div>
              <div className={styles.referenceHandle}>{reference.handle}</div>
              <div className={styles.referenceMeta}>
                <span>{reference.sourceType}</span>
                {reference.freshness ? <span>{reference.freshness}</span> : null}
              </div>
              {reference.matchedTerms.length ? (
                <div className={styles.referenceTerms}>
                  {reference.matchedTerms.map((term) => <span key={term}>{term}</span>)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.referencePanelEmpty}>{packet.userFacingSummary}</div>
      )}
    </section>
  );
}

function Inspector({
  events,
  referencePacket,
}: {
  events: AgentEvent[];
  referencePacket: ReferenceInspectorPacket | null;
}) {
  const [open, setOpen] = useState(false);
  const eventDetail = (event: AgentEvent) => {
    if (event.kind === "tool.result" && event.toolName === "workspace.references") return "Safe reference packet captured.";
    if (event.kind === "tool.call") return event.inputSummary;
    if (event.kind === "tool.result") return event.resultSummary;
    if (event.kind === "error") return event.message;
    return event.id;
  };
  return (
    <div className={styles.inspector}>
      <button className={styles.inspectorButton} type="button" onClick={() => setOpen((value) => !value)}>
        Inspector {events.length ? `(${events.length})` : ""}
      </button>
      {open ? (
        <div className={styles.inspectorPanel}>
          <ReferenceInspectorPanel packet={referencePacket} />
          {events.length === 0 ? <p>No internal events yet.</p> : events.map((event) => (
            <div className={styles.inspectorEvent} key={event.id}>
              <span>
                <strong>{event.kind}</strong>
                {"toolName" in event ? <em>{event.toolName}</em> : null}
              </span>
              <small>{eventDetail(event)}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function WorkspaceDemoApp() {
  const [storedThread] = useState<StoredWorkspaceThread | null>(() => readStoredWorkspaceThread());
  const [threadState, setThreadState] = useState<ThreadState>(() => storedThread?.threadState ?? initialThreadState);
  const [runState, setRunState] = useState<RunState>(() => storedThread?.runState ?? "idle");
  const [prompt, setPrompt] = useState(demoUserPrompt);
  const [activeTaskTitle, setActiveTaskTitle] = useState(() => storedThread?.activeTaskTitle ?? "New session");
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewState>({ status: "closed" });
  const sourceRef = useRef<LocalWorkspaceEventSource | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const referencePacket = useMemo(
    () => readLatestReferencePacket(threadState.internalEvents),
    [threadState.internalEvents],
  );

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      sourceRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (runState === "running") return;
    const hasThread = threadState.messages.length > 0 || threadState.artifacts.length > 0 || threadState.tasks.length > 0;
    if (!hasThread) return;
    sessionStorage.setItem(THREAD_STORAGE_KEY, JSON.stringify({
      threadState,
      runState: "complete",
      activeTaskTitle,
    } satisfies StoredWorkspaceThread));
  }, [activeTaskTitle, runState, threadState]);

  const subscribeToSource = (source: LocalWorkspaceEventSource) => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = source.subscribe((event) => {
      setThreadState((state) => reduceEvent(state, event));
      if (event.kind === "task.complete" || event.kind === "error") setRunState(event.kind === "error" ? "complete" : "complete");
    });
  };

  const startReplay = (nextPrompt?: string) => {
    if (runState === "running") return;
    const activePrompt = nextPrompt?.trim() || prompt.trim() || demoUserPrompt;
    const activeTitle = titleForPrompt(activePrompt);
    setActiveTaskTitle(activeTitle);
    setPrompt("");
    sourceRef.current?.reset();
    setThreadState((state) => ({ ...state, steps: [], task: null }));
    setRunState("running");
    const source = new LocalWorkspaceEventSource({
      endpoint: "/api/workspace-demo/local-run",
      input: {
        prompt: activePrompt,
        title: activeTitle,
      },
    });
    sourceRef.current = source;
    subscribeToSource(source);
    source.start();
  };

  const startNewTask = () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    sourceRef.current?.reset();
    sourceRef.current = null;
    sessionStorage.removeItem(THREAD_STORAGE_KEY);
    setThreadState(initialThreadState);
    setRunState("idle");
    setPrompt(demoUserPrompt);
    setActiveTaskTitle("New session");
    setArtifactPreview({ status: "closed" });
  };

  const openArtifactPreview = async (artifact: Artifact) => {
    setArtifactPreview({ status: "loading", artifact });
    try {
      const response = await fetch(`/api/workspace-demo/artifacts/${encodeURIComponent(artifact.id)}`, {
        cache: "no-store",
      });
      if (response.status === 404) {
        setArtifactPreview({ status: "missing", artifact });
        return;
      }
      const body = await response.json() as { ok?: boolean; artifact?: ArtifactPreview; error?: string };
      if (!response.ok || !body.ok || !body.artifact) {
        setArtifactPreview({ status: "error", artifact, message: body.error || "Artifact preview failed." });
        return;
      }
      setArtifactPreview({ status: "ready", artifact, preview: body.artifact });
    } catch {
      setArtifactPreview({ status: "error", artifact, message: "Artifact preview failed." });
    }
  };

  const taskTitle = runState === "idle" ? "New session" : activeTaskTitle;

  return (
    <main className={styles.app}>
      <Sidebar runState={runState} onNewTask={startNewTask} />
      <section className={styles.canvas}>
        <header className={styles.topbar}>
          <div className={styles.taskTitle}>{taskTitle}</div>
          <button className={styles.modelChip} type="button">{demoWorkspace.title} <IconChevronDown size={12} /></button>
          <div className={styles.topSpacer} />
          <button className={styles.iconButton} type="button" aria-label="Share"><IconShare /></button>
          <button className={styles.iconButton} type="button" aria-label="More"><IconMore /></button>
          <Inspector events={threadState.internalEvents} referencePacket={referencePacket} />
        </header>
        {runState === "idle"
          ? <EmptyState prompt={prompt} onPromptChange={setPrompt} onStart={startReplay} />
          : (
            <>
              <ChatThread
                state={threadState}
                runState={runState}
                referencePacket={referencePacket}
                onOpenArtifact={openArtifactPreview}
              />
              <Composer prompt={prompt} runState={runState} onPromptChange={setPrompt} onStart={startReplay} />
            </>
          )}
      </section>
      <ArtifactPreviewPanel state={artifactPreview} onClose={() => setArtifactPreview({ status: "closed" })} />
    </main>
  );
}
