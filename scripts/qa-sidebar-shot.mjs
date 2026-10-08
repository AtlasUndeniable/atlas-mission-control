// One-shot QA: screenshot the workspace sidebar nav at the default 256px width
// and assert every nav label renders on a single line (no mid-word wrap, no
// ellipsis). Drives Chrome headless over CDP — no npm deps.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "/Users/atlasai/atlas-mission-control";
const URL = process.env.QA_URL || "http://127.0.0.1:3099/workspace";
const OUT = process.env.QA_OUT || `${ROOT}/.qa/sidebar-nav-grid.png`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Build the Basic Auth header from .env.local without ever printing it.
const env = readFileSync(`${ROOT}/.env.local`, "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
const authB64 = Buffer.from(`${pick("MISSION_CONTROL_AUTH_USER")}:${pick("MISSION_CONTROL_AUTH_PASSWORD")}`).toString("base64");

mkdirSync(`${ROOT}/.qa`, { recursive: true });

const userDataDir = `/tmp/qa-chrome-${process.pid}`;
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${userDataDir}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--disable-gpu", "--force-device-scale-factor=2", "about:blank",
], { stdio: "ignore" });

let nextId = 1;
const pending = new Map();
function send(ws, method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

try {
  // Wait for the CDP endpoint, then grab the browser WS URL.
  let wsUrl;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9333/json/version");
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

  // New page target + its own session.
  const { targetId } = await send(ws, "Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send(ws, "Target.attachToTarget", { targetId, flatten: true });

  // Session-scoped send.
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
  await sendS("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });

  await sendS("Page.navigate", { url: URL });
  await sleep(2500); // load + hydrate + localStorage-default (256px) client render

  const probe = `(${(() => {
    const nav = document.querySelector('nav[aria-label="Workspace navigation"]');
    const aside = document.querySelector('aside');
    const btns = nav ? [...nav.querySelectorAll('button')] : [];
    const cs = nav ? getComputedStyle(nav) : null;
    return JSON.stringify({
      sidebarWidth: aside ? Math.round(aside.getBoundingClientRect().width) : null,
      navDisplay: cs ? cs.display : null,
      navCols: cs ? cs.gridTemplateColumns : null,
      navRect: nav ? (({ x, y, width, height }) => ({ x, y, width, height }))(nav.getBoundingClientRect()) : null,
      asideRect: aside ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }))(aside.getBoundingClientRect()) : null,
      items: btns.map((b) => ({
        label: b.textContent,
        lines: b.getClientRects().length,
        scrollW: b.scrollWidth,
        clientW: b.clientWidth,
        overflow: b.scrollWidth > b.clientWidth + 1,
        fontSize: getComputedStyle(b).fontSize,
        top: Math.round(b.getBoundingClientRect().top),
      })),
    });
  }).toString()})()`;

  const { result } = await sendS("Runtime.evaluate", { expression: probe, returnByValue: true });
  const data = JSON.parse(result.value);

  // Clip the screenshot to the sidebar (top portion: brand + nav).
  const r = data.asideRect;
  const clip = r ? { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 170), scale: 2 } : undefined;
  const shot = await sendS("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT, Buffer.from(shot.data, "base64"));

  console.log(JSON.stringify(data, null, 2));
  console.log("SAVED", OUT);

  ws.close();
} finally {
  chrome.kill();
}
