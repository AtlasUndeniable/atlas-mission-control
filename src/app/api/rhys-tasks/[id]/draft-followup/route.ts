import { NextRequest, NextResponse } from "next/server";
import {
  readTasksFile,
  appendDraftedFollowup,
  type DraftedFollowup,
} from "@/lib/rhys-tasks-store";
import { extractClientName } from "@/lib/client-match";
import { gatherFollowupContext } from "@/lib/followup-context";
import { callClaude } from "@/lib/anthropic";

function formatSourceDate(ts: number | null): string {
  if (!ts) return "unknown date";
  const d = new Date(ts);
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const data = readTasksFile();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const clientName = extractClientName(task.sourceCall);
  const daysOld = task.sourceDate
    ? Math.floor((Date.now() - task.sourceDate) / (24 * 60 * 60 * 1000))
    : null;

  // Gather context in parallel — never fatal, only populates what's available.
  const context = await gatherFollowupContext(clientName, task.text);

  const retrievalBlock = context.retrievalChunks.length
    ? context.retrievalChunks
        .map(
          (c, i) =>
            `[KB ${i + 1} · ${c.source}]\n${c.content.slice(0, 400)}`
        )
        .join("\n\n")
    : "(no relevant knowledge-base chunks found)";

  const slackBlock = context.slackMessages.length
    ? `Recent #${context.slackChannel?.name} activity:\n` +
      context.slackMessages
        .map((m) => `  ${m.user}: ${m.text.slice(0, 200)}`)
        .join("\n")
    : context.slackChannel
      ? `(no recent messages in #${context.slackChannel.name})`
      : "(no client channel matched)";

  const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
    {
      type: "text",
      text:
        "You are drafting a short, natural follow-up message for Rhys Livingstone, a high-performance coach, " +
        "to send to a client. The message is about an action item Rhys committed to during a past coaching call. " +
        "Rhys will send this himself — do not pretend to be anyone else, and never sign off as Atlas or an assistant. " +
        "Write in first person as Rhys. 2–4 sentences. Warm, direct, no jargon, no corporate voice, no em dashes. " +
        "Reference the specific thing owed without over-explaining why it's late. If the action is genuinely blocked, " +
        "be honest; otherwise just deliver or give a clear next step.",
    },
  ];

  if (context.voiceProfile) {
    systemBlocks.push({
      type: "text",
      text: `# Rhys's voice profile (for tone matching)\n\n${context.voiceProfile}`,
      cache_control: { type: "ephemeral" },
    });
  }

  const userMessage = [
    `Client: ${clientName ?? "(could not identify — use neutral pronoun)"}`,
    `Source call: "${task.sourceCall}" on ${formatSourceDate(task.sourceDate)}`,
    daysOld !== null ? `Days elapsed since the call: ${daysOld}` : "",
    "",
    `Action item Rhys committed to:`,
    `  "${task.text}"`,
    "",
    "## Knowledge-base context",
    retrievalBlock,
    "",
    "## Recent Slack context",
    slackBlock,
    "",
    "Draft the follow-up message now. Output only the message body — no preamble, no greeting line unless it feels natural, no signature.",
  ]
    .filter(Boolean)
    .join("\n");

  let draftText = "";
  try {
    const result = await callClaude({
      system: systemBlocks,
      userMessage,
      maxTokens: 400,
      temperature: 0.6,
    });
    draftText = result.text.trim();
  } catch (e) {
    return NextResponse.json(
      {
        error: "draft generation failed",
        detail: e instanceof Error ? e.message : "unknown",
        clientName,
        context: {
          retrievalChunks: context.retrievalChunks.length,
          slackMessages: context.slackMessages.length,
          errors: context.errors,
        },
      },
      { status: 502 }
    );
  }

  const sources: DraftedFollowup["sources"] = [];
  if (context.voiceProfile) {
    sources.push({ kind: "voice-profile", summary: "rhys-voice-profile-v2.md" });
  }
  for (const c of context.retrievalChunks) {
    sources.push({ kind: "retrieval", summary: c.source });
  }
  if (context.slackChannel && context.slackMessages.length) {
    sources.push({
      kind: "slack",
      summary: `#${context.slackChannel.name} (${context.slackMessages.length} recent msgs)`,
    });
  }

  const drafted: DraftedFollowup = {
    draft: draftText,
    draftedAt: new Date().toISOString(),
    sentToRhysAt: null,
    sources,
  };

  appendDraftedFollowup(id, drafted);

  return NextResponse.json({
    ok: true,
    draft: draftText,
    clientName,
    sources,
    context: {
      retrievalChunks: context.retrievalChunks.length,
      slackMessages: context.slackMessages.length,
      slackChannel: context.slackChannel?.name ?? null,
      errors: context.errors,
    },
  });
}
