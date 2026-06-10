import { NextResponse } from "next/server";
import { readTasksFile, computeStats, AGING } from "@/lib/rhys-tasks-store";

export async function GET() {
  const data = readTasksFile();
  const pending = data.tasks.filter((t) => t.status === "pending");
  const completed = data.tasks.filter((t) => t.status === "completed");
  const stats = computeStats(data);

  return NextResponse.json({
    pending,
    completed,
    summary: {
      pending: stats.pending,
      completed: stats.completed,
      total: data.tasks.length,
      stale: stats.stale,
      completedThisWeek: stats.completedThisWeek,
      avgTurnaroundDays: stats.avgTurnaroundDays,
    },
    thresholds: {
      staleDays: AGING.STALE_DAYS,
      ancientDays: AGING.ANCIENT_DAYS,
    },
    updatedAt: data.updatedAt,
  });
}
