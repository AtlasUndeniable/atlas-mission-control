import { NextRequest, NextResponse } from "next/server";
import { readTasksFile, markLatestDraftSent } from "@/lib/rhys-tasks-store";
import { extractClientName } from "@/lib/client-match";

const SLACK_BRIDGE = "http://127.0.0.1:4006";
const RHYS_DM_CHANNEL = "D0AM2R3H6SE";

interface SendBody {
  /** Optional override — if omitted, sends the latest drafted follow-up on the task */
  draft?: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  let body: SendBody = {};
  try {
    body = (await req.json()) as SendBody;
  } catch {
    /* empty body is fine */
  }

  const data = readTasksFile();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const latest = task.draftedFollowups?.[task.draftedFollowups.length - 1];
  const draft = body.draft ?? latest?.draft;
  if (!draft) {
    return NextResponse.json(
      { error: "No draft available. Call /draft-followup first, or pass a draft in the body." },
      { status: 400 }
    );
  }

  const clientName = extractClientName(task.sourceCall) ?? task.sourceCall;
  const taskPreview =
    task.text.length <= 120 ? task.text : task.text.slice(0, 117) + "…";

  const slackText =
    `*Draft follow-up for ${clientName}*\n` +
    `_Re: ${taskPreview}_\n\n` +
    `${draft}\n\n` +
    `_Edit + send yourself, or let me know to rewrite._`;

  let slackResp: unknown = null;
  try {
    const r = await fetch(`${SLACK_BRIDGE}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: RHYS_DM_CHANNEL, text: slackText }),
      signal: AbortSignal.timeout(6000),
    });
    const data = await r.json().catch(() => ({}));
    slackResp = data;
    if (!r.ok || data?.ok === false) {
      return NextResponse.json(
        { error: "Slack send failed", status: r.status, slack: data },
        { status: 502 }
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: "Slack bridge unreachable", detail: e instanceof Error ? e.message : "unknown" },
      { status: 502 }
    );
  }

  const updated = markLatestDraftSent(id);

  return NextResponse.json({
    ok: true,
    sentAt: updated?.draftedFollowups?.slice(-1)[0]?.sentToRhysAt ?? null,
    slack: slackResp,
  });
}
