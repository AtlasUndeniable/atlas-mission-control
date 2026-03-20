import { NextResponse } from "next/server";

let cachedData: { data: unknown; ts: number } | null = null;
const CACHE_TTL = 30_000;

async function fetchJSON(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function gatherOverview() {
  const [mondayRaw, firefliesRaw, ghlRaw, slackRaw, callHealth] =
    await Promise.all([
      fetchJSON("http://127.0.0.1:4004/boards"),
      fetchJSON("http://127.0.0.1:4005/transcripts?limit=10"),
      fetchJSON("http://127.0.0.1:4003/pipelines"),
      fetchJSON("http://127.0.0.1:4006/channels"),
      fetchJSON("http://127.0.0.1:4007/health"),
    ]);

  // Monday: boards data
  const boards = mondayRaw?.data?.boards || mondayRaw?.boards || [];
  const clientBoards = boards.filter(
    (b: { name: string }) => !b.name.toLowerCase().startsWith("subitems of")
  );

  // Count items by status
  let highPriority = 0;
  let tasksDone = 0;
  let tasksWorking = 0;
  let tasksStuck = 0;

  for (const board of boards) {
    const items = board.items_page?.items || board.items || [];
    for (const item of items) {
      const cols = item.column_values || [];
      for (const col of cols) {
        const val = (col.text || col.value || "").toLowerCase();
        if (col.id === "priority__1" || col.title?.toLowerCase() === "priority") {
          if (val.includes("high") || val.includes("critical")) highPriority++;
        }
        if (col.id === "status" || col.title?.toLowerCase() === "status") {
          if (val.includes("done") || val.includes("complete")) tasksDone++;
          else if (val.includes("working") || val.includes("progress")) tasksWorking++;
          else if (val.includes("stuck")) tasksStuck++;
        }
      }
    }
  }

  // Fireflies: transcripts
  const transcripts = firefliesRaw?.data?.transcripts || firefliesRaw?.transcripts || [];
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const callsThisWeek = transcripts.filter(
    (t: { date: number }) => t.date && t.date > weekAgo
  ).length;

  const recentCalls = transcripts.slice(0, 3).map((t: { title: string; date: number }) => ({
    title: t.title,
    date: t.date,
  }));

  // GHL: pipelines (note: endpoint is /pipelines not /pipeline)
  const pipelines = ghlRaw?.pipelines || null;

  // Slack
  const slackTotal = slackRaw?.total || slackRaw?.channels?.length || 0;

  // Call processor
  const callsProcessed = callHealth?.processed || 0;

  return {
    monday: {
      activeClients: clientBoards.length,
      highPriority,
      tasksDone,
      tasksWorking,
      tasksStuck,
    },
    fireflies: {
      callsThisWeek,
      callsProcessed,
      recentCalls,
    },
    pipeline: { pipelines },
    slack: {
      totalChannels: slackTotal,
    },
  };
}

export async function GET() {
  const now = Date.now();

  if (cachedData && now - cachedData.ts < CACHE_TTL) {
    return NextResponse.json(cachedData.data);
  }

  const data = await gatherOverview();
  cachedData = { data, ts: now };

  return NextResponse.json(data);
}
