// One-shot QA: full-page screenshots of the executive board (/exec) at a large
// desktop width, for the 30d and YTD ranges. Drives Chrome headless over CDP —
// no npm deps. Authenticates with the Rhys credential, which is the only one
// middleware.ts accepts on /exec.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "/Users/atlasai/atlas-mission-control";
const BASE = process.env.QA_BASE || "http://127.0.0.1:3000";
const OUTDIR = process.env.QA_OUTDIR || `${process.env.HOME}/exec-dashboard-review`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Build the Basic Auth header from .env.local without ever printing it.
const env = readFileSync(`${ROOT}/.env.local`, "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
const authB64 = Buffer.from(`${pick("MISSION_CONTROL_RHYS_USER")}:${pick("MISSION_CONTROL_RHYS_PASSWORD")}`).toString("base64");

mkdirSync(OUTDIR, { recursive: true });

const userDataDir = `/tmp/qa-chrome-exec-${process.pid}`;
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${userDataDir}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--disable-gpu", "about:blank",
], { stdio: "ignore" });

let nextId = 1;
const pending = new Map();
function send(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

try {
  let wsUrl;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9334/json/version");
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {}
    await sleep(100);
  }
  if (!wsUrl) throw new Error("CDP endpoint never came up");

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };

  const { targetId } = await send(ws, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send(ws, "Target.attachToTarget", { targetId, flatten: true });

  const flatPending = new Map();
  let flatId = 100000;
  const sendS = (method, params = {}) => {
    const id = flatId++;
    ws.send(JSON.stringify({ id, sessionId, method, params }));
    return new Promise((res, rej) => flatPending.set(id, { res, rej }));
  };
  const baseOnMessage = ws.onmessage;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && flatPending.has(msg.id)) {
      const { res, rej } = flatPending.get(msg.id);
      flatPending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
    baseOnMessage(ev);
  };

  await sendS("Page.enable");
  await sendS("Runtime.enable");
  await sendS("Network.enable");
  await sendS("Network.setExtraHTTPHeaders", { headers: { Authorization: `Basic ${authB64}` } });

  // Large-screen viewport: this board is read on a desk monitor, not a laptop.
  await sendS("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1200, deviceScaleFactor: 2, mobile: false });

  for (const [range, file] of [["30d", "exec-30d.png"], ["ytd", "exec-ytd.png"]]) {
    await sendS("Page.navigate", { url: `${BASE}/exec?range=${range}` });
    await sleep(6000); // load + hydrate + live GHL fetch

    // Confirm the figures actually rendered before capturing.
    const probe = `(${(() => {
      const tiles = [...document.querySelectorAll(".glass-card")];
      const h1 = document.querySelector("h1");
      return JSON.stringify({
        title: h1 ? h1.textContent : null,
        titleFontSize: h1 ? getComputedStyle(h1).fontSize : null,
        tiles: tiles.length,
        live: document.body.innerText.includes("LIVE"),
        stale: document.body.innerText.includes("STALE") || document.body.innerText.includes("NO FEED"),
        docHeight: document.documentElement.scrollHeight,
      });
    }).toString()})()`;
    const { result } = await sendS("Runtime.evaluate", { expression: probe, returnByValue: true });
    console.log(range, result.value);

    const shot = await sendS("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(`${OUTDIR}/${file}`, Buffer.from(shot.data, "base64"));
    console.log("SAVED", `${OUTDIR}/${file}`);
  }

  ws.close();
} finally {
  chrome.kill();
}
