// One-shot QA: full-page screenshots of the action board (/board) at a large
// desktop width, in the Everything and Engineering lane filters. Drives Chrome
// headless over CDP — no npm deps. Authenticates with the Rhys credential,
// which is the only one middleware.ts accepts on /board.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "/Users/atlasai/atlas-mission-control";
const BASE = process.env.QA_BASE || "http://127.0.0.1:3000";
const OUTDIR = process.env.QA_OUTDIR || `${ROOT}/.qa`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Build the Basic Auth header from .env.local without ever printing it.
const env = readFileSync(`${ROOT}/.env.local`, "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
const authB64 = Buffer.from(`${pick("MISSION_CONTROL_RHYS_USER")}:${pick("MISSION_CONTROL_RHYS_PASSWORD")}`).toString("base64");

mkdirSync(OUTDIR, { recursive: true });

const userDataDir = `/tmp/qa-chrome-board-${process.pid}`;
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=9335", `--user-data-dir=${userDataDir}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--disable-gpu", "about:blank",
], { stdio: "ignore" });

let nextId = 1;
const pending = new Map();

try {
  let wsUrl;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9335/json/version");
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
  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

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
  await sendS("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 2, mobile: false });

  await sendS("Page.navigate", { url: `${BASE}/board` });
  await sleep(5000); // load + hydrate + the hosted task_board read

  // Confirm the live rows actually rendered before capturing.
  const probe = `(${(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      title: document.querySelector("h1")?.textContent ?? null,
      cards: document.querySelectorAll("article").length,
      // Column label -> the card titles actually under it. B3.1 puts `approved`
      // in the In build column, and a label-only probe could not tell whether
      // the card landed there or quietly stayed in the strip below.
      columns: [...document.querySelectorAll("section")].map((s) => ({
        label: s.innerText.split("\n")[0],
        cards: [...s.querySelectorAll("article")].map((a) => ({
          title: a.querySelector("p")?.textContent ?? null,
          stateLine: [...a.querySelectorAll("p")].pop()?.textContent ?? null,
        })),
      })),
      offBoard: [...document.querySelectorAll("article")].length
        - [...document.querySelectorAll("section article")].length,
      synced: (text.match(/SYNCED [^\n]*/) || [null])[0],
      slackNote: text.includes("Approvals happen in Slack for now."),
      buttons: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()),
      docHeight: document.documentElement.scrollHeight,
    });
  }).toString()})()`;
  const { result } = await sendS("Runtime.evaluate", { expression: probe, returnByValue: true });
  console.log("everything:", result.value);

  let shot = await sendS("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${OUTDIR}/board-everything.png`, Buffer.from(shot.data, "base64"));
  console.log("SAVED", `${OUTDIR}/board-everything.png`);

  // Engineering filter — proves the lane split and the un-dimming rule.
  await sendS("Runtime.evaluate", {
    // innerText is the RENDERED text and the buttons are uppercased by CSS,
    // so this must match case-insensitively or it silently clicks nothing.
    expression: `[...document.querySelectorAll("button")].find((b) => /^engineering/i.test(b.innerText.trim())).click()`,
  });
  await sleep(800);
  const after = await sendS("Runtime.evaluate", {
    expression: `JSON.stringify({cards: document.querySelectorAll("article").length, active: [...document.querySelectorAll("button")].filter((b) => b.style.background.includes("136")).map((b) => b.innerText.trim())})`,
    returnByValue: true,
  });
  console.log("engineering:", after.result.value);
  shot = await sendS("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`${OUTDIR}/board-engineering.png`, Buffer.from(shot.data, "base64"));
  console.log("SAVED", `${OUTDIR}/board-engineering.png`);

  ws.close();
} finally {
  chrome.kill();
}
