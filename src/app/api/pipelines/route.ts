import { NextResponse } from "next/server";

// ===== TYPES =====
interface GHLStage {
  id: string;
  name: string;
  position: number;
}

interface GHLPipeline {
  id: string;
  name: string;
  stages: GHLStage[];
}

interface GHLOpportunity {
  id: string;
  name: string;
  monetaryValue: number;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
}

// ===== RESPONSE TYPES =====
export interface PipelineStageData {
  id: string;
  name: string;
  count: number;
  value: number;
}

export interface PipelineData {
  id: string;
  name: string;
  stages: PipelineStageData[];
  totalOpportunities: number;
  totalValue: number;
}

export interface PipelinesResponse {
  pipelines: PipelineData[];
  summary: {
    totalPipelines: number;
    totalOpportunities: number;
    totalValue: number;
    totalStages: number;
  };
  fetchedAt: number;
}

// ===== CACHE =====
let cachedData: { data: PipelinesResponse; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function gatherPipelineData(): Promise<PipelinesResponse | null> {
  // Fetch pipelines and opportunities in parallel
  const [pipelinesRaw, oppsRaw] = await Promise.all([
    fetchJSON<{ pipelines: GHLPipeline[] }>("http://127.0.0.1:4003/pipelines"),
    fetchJSON<{ opportunities: GHLOpportunity[]; total: number }>("http://127.0.0.1:4003/opportunities"),
  ]);

  if (!pipelinesRaw) return null;

  const ghlPipelines = pipelinesRaw.pipelines || [];
  const opportunities = oppsRaw?.opportunities || [];

  // Build stage count + value maps from opportunities
  const stageCountMap = new Map<string, number>();
  const stageValueMap = new Map<string, number>();

  for (const opp of opportunities) {
    if (opp.status !== "open") continue;
    const key = opp.pipelineStageId;
    stageCountMap.set(key, (stageCountMap.get(key) || 0) + 1);
    stageValueMap.set(key, (stageValueMap.get(key) || 0) + (opp.monetaryValue || 0));
  }

  let totalOpportunities = 0;
  let totalValue = 0;
  let totalStages = 0;

  const pipelines: PipelineData[] = ghlPipelines.map((p) => {
    const stages: PipelineStageData[] = p.stages
      .sort((a, b) => a.position - b.position)
      .map((s) => {
        const count = stageCountMap.get(s.id) || 0;
        const value = stageValueMap.get(s.id) || 0;
        totalOpportunities += count;
        totalValue += value;
        totalStages++;
        return { id: s.id, name: s.name, count, value };
      });

    const pipelineTotal = stages.reduce((sum, s) => sum + s.count, 0);
    const pipelineValue = stages.reduce((sum, s) => sum + s.value, 0);

    return {
      id: p.id,
      name: p.name,
      stages,
      totalOpportunities: pipelineTotal,
      totalValue: pipelineValue,
    };
  });

  return {
    pipelines,
    summary: {
      totalPipelines: pipelines.length,
      totalOpportunities,
      totalValue,
      totalStages,
    },
    fetchedAt: Date.now(),
  };
}

export async function GET() {
  const now = Date.now();

  if (cachedData && now - cachedData.ts < CACHE_TTL) {
    return NextResponse.json(cachedData.data);
  }

  const data = await gatherPipelineData();

  if (!data) {
    // Bridge unreachable — return null so client uses fallback
    return NextResponse.json(null);
  }

  cachedData = { data, ts: now };
  return NextResponse.json(data);
}
