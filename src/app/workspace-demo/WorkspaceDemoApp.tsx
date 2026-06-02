"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
  internalEvents: AgentEvent[];
}

const initialThreadState: ThreadState = {
  messages: [],
  artifacts: [],
  steps: [],
  task: null,
  internalEvents: [],
};

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
    return { ...state, task: event.task, steps: event.task.steps };
  }

  return state;
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
        <div className={styles.composerTools} aria-label="Available tools">
          <button className={styles.toolIcon} type="button" title="Gmail" aria-label="Gmail">G</button>
          <button className={styles.toolIcon} type="button" title="Drive" aria-label="Drive">D</button>
          <button className={styles.toolIcon} type="button" title="Slack" aria-label="Slack">S</button>
          <button className={styles.toolIcon} type="button" title="Monday" aria-label="Monday">M</button>
        </div>
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

function MarkdownLite({ content, streaming }: { content: string; streaming: boolean }) {
  const blocks = content.split(/\n\n+/).filter(Boolean);
  return (
    <>
      {blocks.map((block, index) => {
        const parts = block.split(/(\*\*[^*]+\*\*)/g);
        return (
          <p key={`${block.slice(0, 20)}-${index}`}>
            {parts.map((part, partIndex) => {
              if (part.startsWith("**") && part.endsWith("**")) {
                return <strong key={partIndex}>{part.slice(2, -2)}</strong>;
              }
              return <span key={partIndex}>{part}</span>;
            })}
          </p>
        );
      })}
      {streaming ? <span className={styles.streamingCaret} aria-hidden="true" /> : null}
    </>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  return (
    <div className={styles.artifactCard}>
      <span className={styles.artifactIcon}><IconDocument /></span>
      <span className={styles.artifactBody}>
        <span className={styles.artifactTitle}>{artifact.title}</span>
        <span className={styles.artifactMeta}>{artifact.subtitle}</span>
      </span>
      <span className={styles.artifactState}>
        <span>Markdown draft saved</span>
        <small>Preview coming next</small>
      </span>
    </div>
  );
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
}: {
  state: ThreadState;
  runState: RunState;
  referencePacket: ReferenceInspectorPacket | null;
}) {
  const chatRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  const handleScroll = () => {
    const chat = chatRef.current;
    if (!chat) return;
    autoScrollRef.current = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 96;
  };

  useEffect(() => {
    if (runState === "running" && state.messages.length === 0) {
      autoScrollRef.current = true;
    }
  }, [runState, state.messages.length]);

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
              {state.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
              <TaskChip task={state.task} steps={state.steps} />
            </div>
          )
        ))}
      </div>
    </section>
  );
}

function Sidebar({ runState }: { runState: RunState }) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span className={styles.brandMark} /><span className={styles.brandName}>Atlas</span><span className={styles.brandSub}>for Undeniable</span></div>
      <button className={styles.newTask} type="button"><span className={styles.newTaskPlus}>+</span> New task</button>
      <nav className={styles.navMini} aria-label="Workspace sections">
        <a className={styles.navMiniActive}>Tasks</a><a>Library</a><a>Plugins</a><a>Scheduled</a>
      </nav>
      <div className={styles.sectionHeader}><span>Projects</span><IconPlus /></div>
      <ul className={styles.sidebarList}>
        <li><IconFolder /><span className={styles.sidebarTitle}>Ricky coach hire</span><span className={styles.sidebarCount}>4</span></li>
        <li><IconFolder /><span className={styles.sidebarTitle}>L2 audit review</span><span className={styles.sidebarCount}>6</span></li>
        <li><IconFolder /><span className={styles.sidebarTitle}>Content planning</span><span className={styles.sidebarCount}>9</span></li>
      </ul>
      <div className={styles.sectionHeader}><span>All tasks</span></div>
      <ul className={styles.sidebarList}>
        <li className={styles.sidebarActive}>{runState === "running" ? <IconSpinner /> : <IconDocument />}<span className={styles.sidebarTitle}>Ricky coach hire pay model</span></li>
        <li><IconDocument /><span className={styles.sidebarTitle}>L2 audit review</span></li>
        <li><IconDocument /><span className={styles.sidebarTitle}>Content plan</span></li>
        <li><IconDocument /><span className={styles.sidebarTitle}>Monday board draft</span></li>
        <li><IconSpinner /><span className={styles.sidebarTitle}>Training notes</span></li>
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
  const [threadState, setThreadState] = useState<ThreadState>(initialThreadState);
  const [runState, setRunState] = useState<RunState>("idle");
  const [prompt, setPrompt] = useState(demoUserPrompt);
  const [activeTaskTitle, setActiveTaskTitle] = useState("New session");
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
    setThreadState(initialThreadState);
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

  const taskTitle = runState === "idle" ? "New session" : activeTaskTitle;

  return (
    <main className={styles.app}>
      <Sidebar runState={runState} />
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
          : <><ChatThread state={threadState} runState={runState} referencePacket={referencePacket} /><Composer prompt={prompt} runState={runState} onPromptChange={setPrompt} onStart={startReplay} /></>}
      </section>
    </main>
  );
}
