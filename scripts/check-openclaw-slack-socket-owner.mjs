#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFAULT_LIVE_ROOT = "/Users/atlasai/.openclaw/workspace";
const DEFAULT_CONFIG_PATH = "/Users/atlasai/.openclaw/openclaw.json";
const DEFAULT_INTENDED_OWNER = "slack-listener";
const DEFAULT_LAUNCH_AGENT_DIRS = [
  "/Users/atlasai/Library/LaunchAgents",
  "/Library/LaunchAgents",
  "/Library/LaunchDaemons",
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    liveRoot: DEFAULT_LIVE_ROOT,
    configPath: DEFAULT_CONFIG_PATH,
    intendedOwner: process.env.OPENCLAW_SLACK_SOCKET_OWNER || DEFAULT_INTENDED_OWNER,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--live-root") options.liveRoot = argv[++index] || "";
    else if (arg === "--config") options.configPath = argv[++index] || "";
    else if (arg === "--intended-owner") options.intendedOwner = argv[++index] || "";
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args = []) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) resolve("");
      else resolve(String(stdout || ""));
    });
  });
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readLaunchAgent(path, commandRunner) {
  const output = await commandRunner("plutil", ["-convert", "json", "-o", "-", path]);
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

async function collectLaunchAgents({ launchAgentDirs = DEFAULT_LAUNCH_AGENT_DIRS, commandRunner = run } = {}) {
  const agents = [];
  for (const dir of launchAgentDirs) {
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/atlas|openclaw|slack|gateway/i.test(file)) continue;
      const path = join(dir, file);
      const plist = await readLaunchAgent(path, commandRunner);
      if (!plist) continue;
      const env = plist.EnvironmentVariables || {};
      agents.push({
        label: plist.Label || basename(path),
        path,
        programArguments: plist.ProgramArguments || [],
        workingDirectory: plist.WorkingDirectory || null,
        envKeys: Object.keys(env).sort(),
      });
    }
  }
  return agents;
}

function parseProcesses(psOutput = "") {
  return String(psOutput || "")
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() };
    })
    .filter(Boolean);
}

function findProcess(processes, pattern) {
  return processes.find((process) => pattern.test(process.command)) || null;
}

function findGatewayProcess(processes) {
  const candidates = processes.filter((process) => /(?:^|\s)openclaw(?:\s|$)|\/openclaw\s+gateway/.test(process.command));
  return candidates.find((process) => /\/openclaw\s+gateway/.test(process.command))
    || candidates.find((process) => process.ppid === 1)
    || candidates[0]
    || null;
}

function findLaunchAgent(agents, pattern) {
  return agents.find((agent) => pattern.test(`${agent.label} ${agent.programArguments.join(" ")}`)) || null;
}

function socketMarkersFromSource(source = "") {
  return {
    callsAppsConnectionsOpen: /apps\.connections\.open/.test(source),
    opensWebSocket: /new\s+WebSocket|from\s+["']ws["']/.test(source),
  };
}

function hasSlackEnv(agent) {
  const keys = new Set(agent?.envKeys || []);
  return {
    appToken: keys.has("SLACK_APP_TOKEN"),
    botToken: keys.has("SLACK_BOT_TOKEN"),
    userToken: keys.has("SLACK_USER_TOKEN"),
  };
}

function publicCommand(command = "") {
  return String(command || "")
    .replace(/(xox[baprs]-)[A-Za-z0-9-]+/g, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
}

export async function collectSlackSocketOwnerReport({
  liveRoot = DEFAULT_LIVE_ROOT,
  configPath = DEFAULT_CONFIG_PATH,
  intendedOwner = process.env.OPENCLAW_SLACK_SOCKET_OWNER || DEFAULT_INTENDED_OWNER,
  launchAgentDirs = DEFAULT_LAUNCH_AGENT_DIRS,
  commandRunner = run,
  processes = null,
} = {}) {
  const psOutput = processes ? "" : await commandRunner("ps", ["-axo", "pid,ppid,command"]);
  const processList = processes || parseProcesses(psOutput);
  const launchAgents = await collectLaunchAgents({ launchAgentDirs, commandRunner });
  const config = await readJson(configPath);
  const listenerSource = await readText(join(liveRoot, "services/slack-listener/listener.mjs"));
  const slackBridgeSource = await readText(join(liveRoot, "services/slack-bridge/slack-bridge.mjs"));

  const listenerProcess = findProcess(processList, /services\/slack-listener\/listener\.mjs/);
  const gatewayProcess = findGatewayProcess(processList);
  const slackBridgeProcess = findProcess(processList, /services\/slack-bridge\/slack-bridge\.mjs/);
  const listenerAgent = findLaunchAgent(launchAgents, /com\.atlas\.slack-listener|services\/slack-listener\/listener\.mjs/);
  const gatewayAgent = findLaunchAgent(launchAgents, /com\.atlas\.gateway|openclaw.*gateway/);
  const slackBridgeAgent = findLaunchAgent(launchAgents, /com\.atlas\.slack-bridge|services\/slack-bridge\/slack-bridge\.mjs/);

  const listenerMarkers = socketMarkersFromSource(listenerSource);
  const bridgeMarkers = socketMarkersFromSource(slackBridgeSource);
  const gatewaySlack = {
    enabled: config?.channels?.slack?.enabled === true,
    mode: config?.channels?.slack?.mode || "unknown",
  };

  const candidates = [
    {
      id: "slack-listener",
      label: "Tracked Slack listener",
      active: Boolean(listenerProcess),
      pid: listenerProcess?.pid || null,
      command: publicCommand(listenerProcess?.command || ""),
      launchAgent: listenerAgent?.label || null,
      slackEnv: hasSlackEnv(listenerAgent),
      socketCapable: listenerMarkers.callsAppsConnectionsOpen && listenerMarkers.opensWebSocket,
      socketEvidence: listenerMarkers.callsAppsConnectionsOpen && listenerMarkers.opensWebSocket
        ? "source calls apps.connections.open and opens WebSocket"
        : "no source Socket Mode markers found",
    },
    {
      id: "openclaw-gateway",
      label: "OpenClaw gateway native Slack channel",
      active: Boolean(gatewayProcess),
      pid: gatewayProcess?.pid || null,
      command: publicCommand(gatewayProcess?.command || ""),
      launchAgent: gatewayAgent?.label || null,
      slackEnv: hasSlackEnv(gatewayAgent),
      socketCapable: gatewaySlack.enabled && gatewaySlack.mode === "socket",
      socketEvidence: gatewaySlack.enabled && gatewaySlack.mode === "socket"
        ? "openclaw.json channels.slack.enabled=true mode=socket"
        : `openclaw.json channels.slack.enabled=${gatewaySlack.enabled} mode=${gatewaySlack.mode}`,
    },
    {
      id: "slack-bridge",
      label: "Slack Web API bridge",
      active: Boolean(slackBridgeProcess),
      pid: slackBridgeProcess?.pid || null,
      command: publicCommand(slackBridgeProcess?.command || ""),
      launchAgent: slackBridgeAgent?.label || null,
      slackEnv: hasSlackEnv(slackBridgeAgent),
      socketCapable: bridgeMarkers.callsAppsConnectionsOpen && bridgeMarkers.opensWebSocket,
      socketEvidence: bridgeMarkers.callsAppsConnectionsOpen && bridgeMarkers.opensWebSocket
        ? "source has Socket Mode markers"
        : "Web API/MCP bridge only; no Socket Mode markers",
    },
  ];

  const activeSocketOwners = candidates.filter((candidate) => candidate.active && candidate.socketCapable);
  const activeOwnerIds = activeSocketOwners.map((candidate) => candidate.id);
  const intendedActive = activeOwnerIds.includes(intendedOwner);
  const status = activeSocketOwners.length > 1
    ? "conflict"
    : activeSocketOwners.length === 0
      ? "no_active_socket_owner"
      : intendedActive
        ? "ok"
        : "wrong_owner";

  return {
    generatedAt: new Date().toISOString(),
    intendedOwner,
    status,
    activeSocketOwners: activeOwnerIds,
    candidates,
  };
}

export function formatSlackSocketOwnerReport(report) {
  const lines = [
    "# OpenClaw Slack Socket Owner",
    "",
    `generated_at=${report.generatedAt}`,
    `intended_owner=${report.intendedOwner}`,
    `status=${report.status}`,
    `active_socket_owners=${report.activeSocketOwners.join(",") || "none"}`,
    "",
    "## Candidates",
  ];
  for (const candidate of report.candidates) {
    lines.push([
      candidate.active && candidate.socketCapable ? "OWNER" : candidate.active ? "ACTIVE" : "INACTIVE",
      candidate.id,
      `pid=${candidate.pid || "none"}`,
      `socket_capable=${candidate.socketCapable}`,
      `launch_agent=${candidate.launchAgent || "none"}`,
      `slack_env=${Object.entries(candidate.slackEnv).filter(([, value]) => value).map(([key]) => key).join(",") || "none"}`,
      `evidence="${candidate.socketEvidence}"`,
    ].join(" "));
  }
  if (report.status === "conflict") {
    lines.push("", "WARNING multiple active Slack Socket Mode owners detected; leave processes running but fix ownership before live restart.");
  }
  return lines.join("\n");
}

function printHelp() {
  console.log([
    "Usage: node scripts/check-openclaw-slack-socket-owner.mjs [--json]",
    "",
    "Read-only diagnostic. Does not call Slack, restart services, or read secret values.",
    "",
    "Options:",
    "  --intended-owner slack-listener|openclaw-gateway",
    `  --live-root ${DEFAULT_LIVE_ROOT}`,
    `  --config ${DEFAULT_CONFIG_PATH}`,
  ].join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
    } else {
      const report = await collectSlackSocketOwnerReport(options);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatSlackSocketOwnerReport(report));
      if (report.status === "conflict" || report.status === "wrong_owner") process.exitCode = 1;
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
