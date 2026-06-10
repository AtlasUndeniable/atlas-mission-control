/**
 * Follow-up context gatherer — pulls the pieces used to draft a follow-up
 * message for a Rhys task.
 *
 * Sources (each best-effort, never fatal):
 *   - /retrieve on the retrieval bridge :4012 (knowledge graph + RAG)
 *   - /channels + /channels/:id/history on the slack bridge :4006
 *
 * Returns a structured bundle + per-source errors so the drafting step can
 * degrade gracefully.
 */

import { readFileSync, existsSync } from "node:fs";
import { firstNameSlug } from "./client-match";

const RETRIEVAL_URL = "http://127.0.0.1:4012";
const SLACK_BRIDGE = "http://127.0.0.1:4006";
const VOICE_PROFILE_PATH =
  "/Users/atlasai/.openclaw/workspace/memory/PARA/Resources/rhys-voice-profile-v2.md";

export interface RetrievalChunk {
  source: string;
  content: string;
  relevance: number;
}

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  channel: string;
}

export interface FollowupContext {
  clientName: string | null;
  voiceProfile: string | null;
  retrievalChunks: RetrievalChunk[];
  slackMessages: SlackMessage[];
  slackChannel: { id: string; name: string } | null;
  errors: Record<string, string>;
}

function loadVoiceProfile(): string | null {
  try {
    if (existsSync(VOICE_PROFILE_PATH)) {
      // Cap at ~6KB — the full profile is ~13KB but the top half has the
      // rules and cadence which is what we need for short drafts.
      const raw = readFileSync(VOICE_PROFILE_PATH, "utf-8");
      return raw.slice(0, 6000);
    }
  } catch {}
  return null;
}

async function tryRetrieval(query: string, errors: Record<string, string>): Promise<RetrievalChunk[]> {
  try {
    // Retrieval bridge baseline is ~25s (Gemini embedding + Kuzu graph +
    // LanceDB search + re-rank). Give it 28s so most calls complete; the
    // whole draft call is still <40s including Claude.
    const r = await fetch(`${RETRIEVAL_URL}/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, top_k: 4 }),
      signal: AbortSignal.timeout(28_000),
    });
    if (!r.ok) {
      errors.retrieval = `HTTP ${r.status}`;
      return [];
    }
    const data = await r.json();
    return (data.chunks ?? []).map(
      (c: { source?: string; content?: string; relevance?: number }) => ({
        source: c.source ?? "(unknown)",
        content: (c.content ?? "").slice(0, 800),
        relevance: c.relevance ?? 0,
      })
    );
  } catch (e) {
    errors.retrieval = e instanceof Error ? e.message : "unknown";
    return [];
  }
}

async function findClientChannel(
  clientName: string | null,
  errors: Record<string, string>
): Promise<{ id: string; name: string } | null> {
  const first = firstNameSlug(clientName);
  if (!first) return null;
  try {
    const r = await fetch(`${SLACK_BRIDGE}/channels`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      errors.slackChannels = `HTTP ${r.status}`;
      return null;
    }
    const data = await r.json();
    const list: Array<{ id: string; name: string }> = data.channels ?? [];

    // Pass 1: first name + coaching/mentoring suffix
    const mentoring = list.find(
      (c) => c.name.toLowerCase().includes(first) &&
        (c.name.toLowerCase().includes("mentoring") ||
          c.name.toLowerCase().includes("coaching"))
    );
    if (mentoring) return mentoring;

    // Pass 2: single first-name hit
    const hits = list.filter((c) => c.name.toLowerCase().includes(first));
    if (hits.length === 1) return hits[0];
  } catch (e) {
    errors.slackChannels = e instanceof Error ? e.message : "unknown";
  }
  return null;
}

async function fetchChannelHistory(
  channelId: string,
  errors: Record<string, string>
): Promise<SlackMessage[]> {
  try {
    const r = await fetch(`${SLACK_BRIDGE}/channels/${channelId}/history?limit=5`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      errors.slackHistory = `HTTP ${r.status}`;
      return [];
    }
    const data = await r.json();
    const msgs = data.messages ?? data.history ?? [];
    return msgs.slice(0, 5).map((m: { user?: string; text?: string; ts?: string; username?: string }) => ({
      user: m.user ?? m.username ?? "(unknown)",
      text: (m.text ?? "").slice(0, 400),
      ts: m.ts ?? "",
      channel: channelId,
    }));
  } catch (e) {
    errors.slackHistory = e instanceof Error ? e.message : "unknown";
    return [];
  }
}

export async function gatherFollowupContext(
  clientName: string | null,
  taskText: string
): Promise<FollowupContext> {
  const errors: Record<string, string> = {};
  const query = clientName
    ? `${clientName} context — ${taskText.slice(0, 120)}`
    : taskText.slice(0, 160);

  const [retrievalChunks, slackChannel] = await Promise.all([
    tryRetrieval(query, errors),
    findClientChannel(clientName, errors),
  ]);

  const slackMessages = slackChannel
    ? await fetchChannelHistory(slackChannel.id, errors)
    : [];

  return {
    clientName,
    voiceProfile: loadVoiceProfile(),
    retrievalChunks,
    slackMessages,
    slackChannel,
    errors,
  };
}
