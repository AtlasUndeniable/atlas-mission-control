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
  const [mondayRaw, firefliesRaw, ghlPipelines, ghlOpps, slackRaw, callHealth] =
    await Promise.all([
      fetchJSON("http://127.0.0.1:4004/boards"),
      fetchJSON("http://127.0.0.1:4005/transcripts?limit=10"),
      fetchJSON("http://127.0.0.1:4003/pipelines"),
      fetchJSON("http://127.0.0.1:4003/opportunities"),
      fetchJSON("http://127.0.0.1:4006/channels"),
      fetchJSON("http://127.0.0.1:4007/health"),
    ]);

  // Monday: boards data
  const boards = mondayRaw?.data?.boards || mondayRaw?.boards || [];
  const clientBoards = boards.filter(
    (b: { name: string }) => !b.name.toLowerCase().startsWith("subitems of")
  );

  // Fetch items for each client board in parallel
  const itemResults = await Promise.all(
    clientBoards.map((b: { id: string }) =>
      fetchJSON(`http://127.0.0.1:4004/items?board=${b.id}`)
    )
  );

  // Count items by status/priority across all boards
  let highPriority = 0;
  let tasksDone = 0;
  let tasksWorking = 0;
  let tasksStuck = 0;

  interface MondayColumnValue {
    id: string;
    text?: string;
    value?: string;
    title?: string;
  }
  interface MondayItem {
    id: string;
    name: string;
    column_values?: MondayColumnValue[];
  }

  for (const result of itemResults) {
    const items: MondayItem[] =
      result?.items ||
      result?.data?.boards?.[0]?.items_page?.items ||
      [];
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

  // GHL: pipeline data with opportunity counts per stage
  interface GHLStage { id: string; name: string; position?: number }
  interface GHLPipeline { id: string; name: string; stages: GHLStage[] }
  interface GHLOpportunity { pipelineId: string; pipelineStageId: string; status: string }

  const pipelines: GHLPipeline[] = ghlPipelines?.pipelines || [];
  const opportunities: GHLOpportunity[] = ghlOpps?.opportunities || [];

  // Build stage count map: stageId → count of open opportunities
  const stageCounts: Record<string, number> = {};
  for (const opp of opportunities) {
    if (opp.status === "open" || opp.status === "won") {
      stageCounts[opp.pipelineStageId] = (stageCounts[opp.pipelineStageId] || 0) + 1;
    }
  }

  // Enrich pipelines with counts
  const enrichedPipelines = pipelines.map((p) => ({
    ...p,
    stages: p.stages.map((s) => ({
      ...s,
      count: stageCounts[s.id] || 0,
    })),
  }));

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
    pipeline: { pipelines: enrichedPipelines },
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
