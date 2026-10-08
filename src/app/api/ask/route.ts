import { NextResponse } from "next/server";
import { execFile } from "node:child_process";

// Force this route to run on Node.js (not Edge) — needs child_process.
export const runtime = "nodejs";
// Don't cache; every call must hit the gateway.
export const dynamic = "force-dynamic";

const OPENCLAW_BIN = "/opt/homebrew/bin/openclaw";
const SESSION_ID = "mc-chat-rhys";
const TIMEOUT_MS = 180_000; // 3 minutes — accommodates Opus inference latency

interface OpenClawPayload {
  text?: string;
}

interface OpenClawResult {
  payloads?: OpenClawPayload[];
  reply?: string;
  text?: string;
}

interface OpenClawJsonReply {
  // Modern envelope (gateway agent run)
  runId?: string;
  status?: string;
  result?: OpenClawResult;
  // Legacy / flat shapes
  payloads?: OpenClawPayload[];
  reply?: string;
  message?: string;
  content?: string;
  text?: string;
  answer?: string;
}

function extractAnswer(parsed: OpenClawJsonReply): string | null {
  // Modern: result.payloads[0].text
  const resultText = parsed.result?.payloads?.[0]?.text;
  if (typeof resultText === "string" && resultText.trim()) return resultText.trim();

  // Modern: result.reply / result.text
  if (typeof parsed.result?.reply === "string" && parsed.result.reply.trim()) return parsed.result.reply.trim();
  if (typeof parsed.result?.text === "string" && parsed.result.text.trim()) return parsed.result.text.trim();

  // Flat shapes
  const flatPayload = parsed.payloads?.[0]?.text;
  if (typeof flatPayload === "string" && flatPayload.trim()) return flatPayload.trim();
  if (typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply.trim();
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  if (typeof parsed.answer === "string" && parsed.answer.trim()) return parsed.answer.trim();
  if (typeof parsed.content === "string" && parsed.content.trim()) return parsed.content.trim();
  if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();

  return null;
}

function runAgent(message: string): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      OPENCLAW_BIN,
      [
        "agent",
        "--message",
        message,
        "--session-id",
        SESSION_ID,
        "--json",
      ],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
          HOME: process.env.HOME ?? "/Users/atlasai",
          PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
          OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? "ollama-local",
        },
        cwd: "/Users/atlasai/.openclaw/workspace",
      },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          const code = (err as NodeJS.ErrnoException).code;
          if (killed || code === "ETIMEDOUT") {
            resolve({ ok: false, error: `Atlas timed out after ${TIMEOUT_MS / 1000}s. Try again or simplify the question.` });
            return;
          }
          resolve({ ok: false, error: `openclaw failed: ${err.message} | stderr: ${(stderr || "").slice(0, 500)}` });
          return;
        }

        const raw = (stdout || "").trim();
        if (!raw) {
          resolve({ ok: false, error: "Atlas returned an empty response." });
          return;
        }

        // Try JSON first.
        try {
          const parsed: OpenClawJsonReply = JSON.parse(raw);

          // Surface gateway-level errors before claiming success.
          if (parsed.status && parsed.status !== "ok") {
            resolve({ ok: false, error: `Gateway status: ${parsed.status}` });
            return;
          }

          const answer = extractAnswer(parsed);
          if (answer) {
            resolve({ ok: true, answer });
            return;
          }
          // Parsed but no recognizable text field — return the raw JSON as a fallback so
          // we can debug instead of returning a misleading "empty" response.
          resolve({ ok: true, answer: raw });
          return;
        } catch {
          // Not JSON — treat stdout as plain text.
          resolve({ ok: true, answer: raw });
        }
      }
    );
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const question: unknown = body?.question ?? body?.message;

    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const result = await runAgent(question.trim());

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    return NextResponse.json({ answer: result.answer });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
