import { NextResponse } from "next/server";

// ===== TYPES =====
interface MondayColumnValue {
  id: string;
  text?: string;
  value?: string;
}

interface MondayRawItem {
  id: string;
  name: string;
  state: string;
  column_values?: MondayColumnValue[];
  group?: { title: string };
}

interface MondayBoard {
  id: string;
  name: string;
  state: string;
  board_kind: string;
  columns?: Array<{ id: string; title: string; type: string }>;
  groups?: Array<{ id: string; title: string }>;
}

// ===== RESPONSE TYPES =====
export interface TaskItem {
  id: string;
  name: string;
  status: string;
  priority: string;
  group: string;
  boardName: string;
  boardId: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  totalItems: number;
  groups: string[];
}

export interface MondayData {
  boards: BoardSummary[];
  tasks: TaskItem[];
  summary: {
    activeClients: number;
    highPriority: number;
    critical: number;
    inProgress: number;
    stuck: number;
    notStarted: number;
    done: number;
    totalTasks: number;
  };
  fetchedAt: number;
}

// ===== CACHE =====
let cachedData: { data: MondayData; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchJSON(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normaliseStatus(text: string): string {
  const t = text.toLowerCase().trim();
  if (!t || t === "none") return "Not Started";
  if (t.includes("done") || t.includes("complete")) return "Done";
  if (t.includes("working") || t.includes("progress") || t === "in progress" || t === "working on it") return "In Progress";
  if (t.includes("stuck")) return "Stuck";
  if (t.includes("not started") || t.includes("not yet")) return "Not Started";
  if (t.includes("waiting") || t.includes("review") || t.includes("pending")) return "Waiting";
  // Return original with title case if unrecognised
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalisePriority(text: string): string {
  const t = text.toLowerCase().trim();
  if (!t || t === "none" || t === "") return "None";
  if (t.includes("critical")) return "Critical";
  if (t.includes("high")) return "High";
  if (t.includes("medium") || t.includes("med")) return "Medium";
  if (t.includes("low")) return "Low";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function gatherMondayData(): Promise<MondayData | null> {
  const boardsRaw = await fetchJSON("http://127.0.0.1:4004/boards") as { data?: { boards?: MondayBoard[] } } | null;
  if (!boardsRaw) return null;

  const boards: MondayBoard[] = boardsRaw?.data?.boards || [];
  const clientBoards = boards.filter(
    (b) => !b.name.toLowerCase().startsWith("subitems of")
  );

  // Fetch items for each board in parallel
  const itemResults = await Promise.all(
    clientBoards.map(async (b) => {
      const result = await fetchJSON(`http://127.0.0.1:4004/items?board=${b.id}`) as {
        data?: { boards?: Array<{ items_page?: { items?: MondayRawItem[] } }> };
      } | null;
      const items: MondayRawItem[] = result?.data?.boards?.[0]?.items_page?.items || [];
      return { board: b, items };
    })
  );

  const allTasks: TaskItem[] = [];
  const boardSummaries: BoardSummary[] = [];

  for (const { board, items } of itemResults) {
    boardSummaries.push({
      id: board.id,
      name: board.name,
      totalItems: items.length,
      groups: board.groups?.map((g) => g.title) || [],
    });

    for (const item of items) {
      const cols = item.column_values || [];
      let statusRaw = "";
      let priorityRaw = "";

      for (const col of cols) {
        const val = col.text || "";
        if (col.id === "status") statusRaw = val;
        if (col.id === "priority__1") priorityRaw = val;
      }

      allTasks.push({
        id: item.id,
        name: item.name,
        status: normaliseStatus(statusRaw),
        priority: normalisePriority(priorityRaw),
        group: item.group?.title || "Ungrouped",
        boardName: board.name,
        boardId: board.id,
      });
    }
  }

  // Compute summary
  let highPriority = 0;
  let critical = 0;
  let inProgress = 0;
  let stuck = 0;
  let notStarted = 0;
  let done = 0;

  for (const task of allTasks) {
    if (task.priority === "High") highPriority++;
    if (task.priority === "Critical") critical++;
    if (task.status === "In Progress") inProgress++;
    if (task.status === "Stuck") stuck++;
    if (task.status === "Not Started") notStarted++;
    if (task.status === "Done") done++;
  }

  return {
    boards: boardSummaries,
    tasks: allTasks,
    summary: {
      activeClients: clientBoards.length,
      highPriority,
      critical,
      inProgress,
      stuck,
      notStarted,
      done,
      totalTasks: allTasks.length,
    },
    fetchedAt: Date.now(),
  };
}

export async function GET() {
  const now = Date.now();

  if (cachedData && now - cachedData.ts < CACHE_TTL) {
    return NextResponse.json(cachedData.data);
  }

  const data = await gatherMondayData();

  if (!data) {
    // Bridge unreachable — return null signal (not an error)
    return NextResponse.json(null);
  }

  cachedData = { data, ts: now };
  return NextResponse.json(data);
}
