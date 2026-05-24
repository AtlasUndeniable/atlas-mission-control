import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SLACK_QUEUE_FILE = "/Users/atlasai/.openclaw/data/slack-queue.json";
const JIAN_APPROVALS_FILE = "/Users/atlasai/.openclaw/data/pending-approvals.json";
const RHYS_TASKS_FILE = "/Users/atlasai/.openclaw/data/rhys-tasks.json";

type SourceSystem = "mission_control_comms" | "jian_monday" | "rhys_reaper";
type WorkspaceStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "held"
  | "drafted"
  | "needs_draft"
  | "failed"
  | "unknown";

interface SourceRead<T> {
  sourceSystem: SourceSystem;
  path: string;
  ok: boolean;
  items: T[];
  rootUpdatedAt?: string | null;
  error?: string;
}

interface SlackQueueItem {
  id?: string;
  status?: string;
  channel?: string;
  channelId?: string;
  channelName?: string;
  sender?: string;
  senderName?: string;
  originalMessage?: string;
  draftReply?: string | null;
  intendedText?: string | null;
  timestamp?: number;
  messageTs?: string;
  approvalStartedAt?: string;
  sentAt?: string;
  sendFailedAt?: string;
  deniedAt?: string;
  heldAt?: string;
  lastSendError?: string;
  gate?: string;
  gateReason?: string;
  callerService?: string;
}

interface JianApprovalItem {
  id?: string;
  status?: string;
  callTitle?: string;
  clientName?: string;
  callDate?: string | null;
  board?: { id?: string; name?: string } | null;
  slackChannel?: { id?: string; name?: string } | null;
  tasks?: unknown[];
  decisions?: unknown[];
  actions?: unknown[];
  draftMessage?: string | null;
  clientNotice?: string | null;
  jianMessageTs?: string | null;
  approvalChunkTs?: string[];
  jianChannelId?: string | null;
  createdAt?: string | null;
  resolvedAt?: string | null;
  executionResults?: {
    mondayCreated?: number;
    mondayUpdated?: number;
    mondayErrors?: unknown[];
    clientNoticePosted?: boolean;
    clientNoticeHeld?: boolean;
    channelError?: string | null;
  };
}

interface RhysTasksFile {
  tasks?: RhysTask[];
  updatedAt?: string | null;
}

interface RhysTask {
  id?: string;
  status?: string;
  sourceDate?: number | null;
  extractedAt?: string;
  completedAt?: string | null;
  draftedFollowups?: Array<{
    draftedAt?: string;
    sentToRhysAt?: string | null;
    sources?: unknown[];
  }>;
}

interface WorkspaceApproval {
  id: string;
  sourceSystem: SourceSystem;
  sourceRef: string;
  status: string;
  workspaceStatus: WorkspaceStatus;
  subject: string;
  personOrClient: string | null;
  exactText: string | null;
  summary: string;
  target: {
    kind: "slack_channel" | "jian_thread" | "rhys_followup" | "unknown";
    label: string | null;
    id: string | null;
  };
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
  legacyPointer: {
    file: string;
    id: string;
  };
  metadata: Record<string, string | number | boolean | null>;
}

interface SourceMeta {
  sourceSystem: SourceSystem;
  path: string;
  ok: boolean;
  count: number;
  error?: string;
}

function safeId(prefix: string, id: string | undefined, index: number): string {
  return id?.trim() || `${prefix}-${index}`;
}

function isoFromMs(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeDraft(value: unknown): string | null {
  const text = safeString(value);
  if (!text || text === "None") return null;
  return text;
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function mapWorkspaceStatus(sourceStatus: string | undefined, opts: { hasDraft?: boolean; sentToRhys?: boolean } = {}): WorkspaceStatus {
  const status = (sourceStatus || "").toLowerCase();
  if (status === "pending") return opts.hasDraft || opts.sentToRhys ? "drafted" : "pending";
  if (status === "needs_draft") return "needs_draft";
  if (status === "drafted") return "drafted";
  if (status === "approving" || status === "redirected") return "pending";
  if (status === "approved" || status === "completed") return "approved";
  if (status === "denied" || status === "rejected") return "rejected";
  if (status === "held" || status === "escalated") return "held";
  if (status === "send_failed" || status === "failed") return "failed";
  return "unknown";
}

async function readArraySource<T>(sourceSystem: SourceSystem, path: string): Promise<SourceRead<T>> {
  if (!existsSync(path)) {
    return { sourceSystem, path, ok: false, items: [], error: "source file missing" };
  }

  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed)) {
      return { sourceSystem, path, ok: false, items: [], error: "source root is not an array" };
    }
    return { sourceSystem, path, ok: true, items: parsed as T[] };
  } catch (err) {
    return {
      sourceSystem,
      path,
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : "invalid source json",
    };
  }
}

async function readRhysTasksSource(): Promise<SourceRead<RhysTask>> {
  if (!existsSync(RHYS_TASKS_FILE)) {
    return {
      sourceSystem: "rhys_reaper",
      path: RHYS_TASKS_FILE,
      ok: false,
      items: [],
      error: "source file missing",
    };
  }

  try {
    const parsed = JSON.parse(await readFile(RHYS_TASKS_FILE, "utf8")) as RhysTasksFile;
    if (!parsed || !Array.isArray(parsed.tasks)) {
      return {
        sourceSystem: "rhys_reaper",
        path: RHYS_TASKS_FILE,
        ok: false,
        items: [],
        error: "source root does not contain tasks array",
      };
    }
    return {
      sourceSystem: "rhys_reaper",
      path: RHYS_TASKS_FILE,
      ok: true,
      items: parsed.tasks,
      rootUpdatedAt: parsed.updatedAt ?? null,
    };
  } catch (err) {
    return {
      sourceSystem: "rhys_reaper",
      path: RHYS_TASKS_FILE,
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : "invalid source json",
    };
  }
}

function normalizeSlack(items: SlackQueueItem[], path: string): WorkspaceApproval[] {
  return items.map((item, index) => {
    const id = safeId("slack", item.id, index);
    const exactText = safeDraft(item.draftReply);
    const heldText = safeDraft(item.intendedText);
    const status = item.status || "unknown";
    const workspaceStatus = mapWorkspaceStatus(status, { hasDraft: !!exactText });
    const createdAt = isoFromMs(item.timestamp) ?? item.heldAt ?? null;
    const updatedAt = item.sendFailedAt ?? item.sentAt ?? item.deniedAt ?? item.approvalStartedAt ?? item.heldAt ?? createdAt;

    return {
      id: `slack:${id}`,
      sourceSystem: "mission_control_comms",
      sourceRef: `slack-queue.json#${id}`,
      status,
      workspaceStatus,
      subject: item.channelName ? `Slack response in #${item.channelName}` : "Slack response",
      personOrClient: item.senderName ?? null,
      exactText,
      summary: exactText
        ? "Draft reply available for exact-text review."
        : heldText
          ? "Held outbound text is present but withheld from this projection; review source gate context in the comms flow."
          : "No draft text available yet.",
      target: {
        kind: "slack_channel",
        label: item.channelName ?? null,
        id: item.channel ?? item.channelId ?? null,
      },
      createdAt,
      updatedAt,
      resolvedAt: item.sentAt ?? item.deniedAt ?? null,
      legacyPointer: { file: path, id },
      metadata: {
        hasOriginalMessage: Boolean(item.originalMessage),
        hasDraft: Boolean(exactText),
        hasHeldText: Boolean(heldText),
        messageTsPresent: Boolean(item.messageTs),
        gate: item.gate ?? null,
        gateReasonPresent: Boolean(item.gateReason),
        callerService: item.callerService ?? null,
        lastSendErrorPresent: Boolean(item.lastSendError),
      },
    };
  });
}

function normalizeJian(items: JianApprovalItem[], path: string): WorkspaceApproval[] {
  return items.map((item, index) => {
    const id = safeId("jian", item.id, index);
    const status = item.status || "unknown";
    const workspaceStatus = mapWorkspaceStatus(status);
    const taskCount = countOf(item.tasks);
    const decisionCount = countOf(item.decisions);
    const actionCount = countOf(item.actions);
    const updatedAt = item.resolvedAt ?? item.createdAt ?? null;

    return {
      id: `jian:${id}`,
      sourceSystem: "jian_monday",
      sourceRef: `pending-approvals.json#${id}`,
      status,
      workspaceStatus,
      subject: item.callTitle ? `Call approval: ${item.callTitle}` : "Call approval",
      personOrClient: item.clientName ?? null,
      exactText: null,
      summary: `Jian/Monday approval with ${taskCount || actionCount} task${(taskCount || actionCount) === 1 ? "" : "s"} and ${decisionCount} decision${decisionCount === 1 ? "" : "s"}. Content body withheld from this projection.`,
      target: {
        kind: "jian_thread",
        label: item.slackChannel?.name ?? item.board?.name ?? null,
        id: item.jianMessageTs ?? item.jianChannelId ?? null,
      },
      createdAt: item.createdAt ?? null,
      updatedAt,
      resolvedAt: item.resolvedAt ?? null,
      legacyPointer: { file: path, id },
      metadata: {
        taskCount,
        decisionCount,
        actionCount,
        hasDraftMessage: Boolean(item.draftMessage),
        hasClientNotice: Boolean(item.clientNotice),
        approvalChunkCount: countOf(item.approvalChunkTs),
        boardId: item.board?.id ?? null,
        boardName: item.board?.name ?? null,
        clientChannelId: item.slackChannel?.id ?? null,
        clientChannelName: item.slackChannel?.name ?? null,
        mondayCreated: item.executionResults?.mondayCreated ?? null,
        mondayUpdated: item.executionResults?.mondayUpdated ?? null,
        mondayErrorCount: countOf(item.executionResults?.mondayErrors),
        clientNoticePosted: item.executionResults?.clientNoticePosted ?? false,
        clientNoticeHeld: item.executionResults?.clientNoticeHeld ?? false,
      },
    };
  });
}

function normalizeRhysTasks(items: RhysTask[], path: string, rootUpdatedAt: string | null | undefined): WorkspaceApproval[] {
  return items.map((item, index) => {
    const id = safeId("rhys-task", item.id, index);
    const drafts = Array.isArray(item.draftedFollowups) ? item.draftedFollowups : [];
    const sentDrafts = drafts.filter((draft) => !!draft.sentToRhysAt);
    const status = item.status || "unknown";
    const workspaceStatus = mapWorkspaceStatus(status, {
      hasDraft: drafts.length > 0,
      sentToRhys: sentDrafts.length > 0,
    });
    const latestDraft = drafts
      .map((draft) => draft.sentToRhysAt ?? draft.draftedAt ?? null)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
    const createdAt = item.extractedAt ?? isoFromMs(item.sourceDate ?? undefined);

    return {
      id: `rhys-task:${id}`,
      sourceSystem: "rhys_reaper",
      sourceRef: `rhys-tasks.json#${id}`,
      status,
      workspaceStatus,
      subject: "Reaper follow-up item",
      personOrClient: null,
      exactText: null,
      summary: `Extracted follow-up item with ${drafts.length} draft${drafts.length === 1 ? "" : "s"} and ${sentDrafts.length} sent-to-Rhys marker${sentDrafts.length === 1 ? "" : "s"}. Task text withheld from this projection.`,
      target: {
        kind: "rhys_followup",
        label: "Rhys task queue",
        id,
      },
      createdAt,
      updatedAt: item.completedAt ?? latestDraft ?? rootUpdatedAt ?? createdAt ?? null,
      resolvedAt: item.completedAt ?? null,
      legacyPointer: { file: path, id },
      metadata: {
        draftCount: drafts.length,
        sentToRhysCount: sentDrafts.length,
        sourceDatePresent: Boolean(item.sourceDate),
        sourceCount: drafts.reduce((sum, draft) => sum + countOf(draft.sources), 0),
        completed: status === "completed",
      },
    };
  });
}

function addCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function buildCounts(records: WorkspaceApproval[], sources: SourceMeta[]) {
  const bySource: Record<string, { total: number; status: Record<string, number>; workspaceStatus: Record<string, number> }> = {};
  const byStatus: Record<string, number> = {};
  const byWorkspaceStatus: Record<string, number> = {};

  for (const source of sources) {
    bySource[source.sourceSystem] = { total: 0, status: {}, workspaceStatus: {} };
  }

  for (const record of records) {
    const sourceCounts = bySource[record.sourceSystem] ?? { total: 0, status: {}, workspaceStatus: {} };
    sourceCounts.total += 1;
    addCount(sourceCounts.status, record.status);
    addCount(sourceCounts.workspaceStatus, record.workspaceStatus);
    bySource[record.sourceSystem] = sourceCounts;
    addCount(byStatus, record.status);
    addCount(byWorkspaceStatus, record.workspaceStatus);
  }

  return {
    total: records.length,
    bySource,
    byStatus,
    byWorkspaceStatus,
  };
}

export async function GET() {
  const [slack, jian, rhys] = await Promise.all([
    readArraySource<SlackQueueItem>("mission_control_comms", SLACK_QUEUE_FILE),
    readArraySource<JianApprovalItem>("jian_monday", JIAN_APPROVALS_FILE),
    readRhysTasksSource(),
  ]);

  const records = [
    ...normalizeSlack(slack.items, slack.path),
    ...normalizeJian(jian.items, jian.path),
    ...normalizeRhysTasks(rhys.items, rhys.path, rhys.rootUpdatedAt),
  ].sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""));

  const sources: SourceMeta[] = [slack, jian, rhys].map((source) => ({
    sourceSystem: source.sourceSystem,
    path: source.path,
    ok: source.ok,
    count: source.items.length,
    ...(source.error ? { error: source.error } : {}),
  }));

  return NextResponse.json({
    readOnly: true,
    generatedAt: new Date().toISOString(),
    records,
    counts: buildCounts(records, sources),
    sources,
  });
}
