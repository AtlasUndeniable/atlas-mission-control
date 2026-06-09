/**
 * Slack gate side effects — hold to queue + Telegram alert to Dante.
 *
 * Kept separate from `slack-gates.mjs` so the gate functions stay pure and
 * unit-testable without filesystem or network mocks.
 *
 * Telegram bot/chat constants mirror watchdog.mjs (the existing alert path):
 *   bot 8098243076  →  chat 7069167270 ("Dante only")
 */

import https from "node:https";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { mutateQueue } from "./queue-writer.mjs";

const DATA_DIR = "/Users/atlasai/.openclaw/data";
const LOG_DIR = "/Users/atlasai/.openclaw/logs";
const LOG_FILE = `${LOG_DIR}/slack-gates.log`;

// Reuse watchdog's Telegram bot — same channel Dante already watches.
const TG_BOT_URL = "https://api.telegram.org/bot8098243076:AAGrv9TBGE8G85bc2BXxmvoUS_wqxHCq2yM/sendMessage";
const TG_CHAT_ID = "7069167270";

function ts() {
  return new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" });
}

function log(emoji, msg) {
  const line = `[${ts()}] ${emoji} ${msg}`;
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function ensureDataDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// ─── Hold to slack-queue.json ───────────────────────────────────────────────
// Adds a held-status entry alongside COMMS drafts. Reuses the existing review
// surface (MC ApprovalQueue reads /api/approvals which reads this file).
//
// Entry shape:
//   {
//     id: "hld-...",
//     status: "held",
//     gate: 1,
//     gateReason: "...",
//     channelId, channelName, asRhys, intendedText,
//     heldAt: ISO timestamp,
//     callerService: "call-processor" | "meeting-prep" | "slack-bridge" | ...,
//   }
export async function holdMessage({
  text,
  channelId,
  channelName,
  asRhys,
  gateResult,
  callerService = "unknown",
}) {
  ensureDataDir();
  const id = `hld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    status: "held",
    gate: gateResult.gate,
    gateReason: gateResult.reason,
    gatePattern: gateResult.pattern || null,
    gateSample: gateResult.sample || null,
    channelId: channelId || null,
    channelName: channelName || null,
    asRhys: asRhys === true,
    intendedText: text,
    callerService,
    heldAt: new Date().toISOString(),
  };
  try {
    await mutateQueue((queue) => { queue.push(entry); return queue; });
    log("⛔", `held ${id} gate=${gateResult.gate} caller=${callerService} channel=${channelName || channelId || "?"} reason="${gateResult.reason}"`);
  } catch (err) {
    log("⚠️", `failed to write slack-queue.json: ${err.message}`);
  }
  return id;
}

// ─── Telegram alert ─────────────────────────────────────────────────────────
export function alertDante(text) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({ chat_id: TG_CHAT_ID, text });
      const url = new URL(TG_BOT_URL);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d.slice(0, 200) }));
      });
      req.on("error", (err) => {
        log("⚠️", `Telegram alert error: ${err.message}`);
        resolve({ status: 0, error: err.message });
      });
      req.write(payload);
      req.end();
    } catch (err) {
      log("⚠️", `Telegram alert threw: ${err.message}`);
      resolve({ status: 0, error: err.message });
    }
  });
}

// ─── Convenience: hold + alert in one call ──────────────────────────────────
export async function holdAndAlert({
  text,
  channelId,
  channelName,
  asRhys,
  gateResult,
  callerService,
}) {
  const heldId = await holdMessage({ text, channelId, channelName, asRhys, gateResult, callerService });
  const alertText = [
    "🚫 ATLAS Slack outbound HELD",
    `Gate: ${gateResult.gate} — ${gateResult.reason}`,
    `Channel: ${channelName || channelId || "?"}${asRhys ? " (as Rhys)" : ""}`,
    `Caller: ${callerService}`,
    `Hold ID: ${heldId} (slack-queue.json, status=held)`,
    "",
    `First 200 chars: ${(text || "").slice(0, 200)}`,
  ].join("\n");
  const alertResp = await alertDante(alertText);
  log("📨", `Telegram alert for ${heldId}: status=${alertResp.status}`);
  return { heldId, alertStatus: alertResp.status };
}
