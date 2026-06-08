#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import {
  buildRuntimePlan,
  DEFAULT_SOURCE_ROOT as SLACK_RUNTIME_SOURCE_ROOT,
  DEFAULT_TARGET_ROOT as SLACK_RUNTIME_TARGET_ROOT,
} from "./deploy-openclaw-slack-runtime.mjs";

const execFile = promisify(execFileCallback);

export const ROOTS = [
  "/Users/atlasai/atlas-mission-control",
  "/Users/atlasai/.openclaw/workspace",
  "/Users/atlasai/workspace",
  "/Users/atlasai/atlas-workspace",
];

const WORKSPACE_PROCESS_RE = /\b(next dev|next-server)\b|atlas-mission-control\/node_modules\/\.bin\/next/;
const OPENCLAW_NODE_PROCESS_RE = /^\S*node(?:\s|$).*\/Users\/atlasai\/\.openclaw\/workspace\//;

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes("--json"),
  };
}

async function runCommand(command, args, options = {}) {
  if (options.commandRunner) return options.commandRunner(command, args);
  const result = await execFile(command, args, { maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}

async function safeRunCommand(command, args, options = {}) {
  try {
    return await runCommand(command, args, options);
  } catch {
    return "";
  }
}

async function gitInfo(repoRoot, options = {}) {
  const [head, branch, statusShort] = await Promise.all([
    safeRunCommand("git", ["-C", repoRoot, "rev-parse", "HEAD"], options),
    safeRunCommand("git", ["-C", repoRoot, "branch", "--show-current"], options),
    safeRunCommand("git", ["-C", repoRoot, "status", "--short", "--branch"], options),
  ]);

  return {
    repoRoot,
    head: head.trim() || null,
    branch: branch.trim() || null,
    dirty: statusShort.split("\n").some((line) => line.trim() && !line.startsWith("##")),
    statusShort: statusShort.trim().split("\n").filter(Boolean),
  };
}

function parsePsOutput(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^PID\s+PPID\s+COMMAND\b/.test(line))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    })
    .filter(Boolean);
}

function parseLsofCwd(text) {
  const line = text.split("\n").find((item) => item.startsWith("n/"));
  return line ? line.slice(1) : null;
}

async function annotateProcesses(processes, options = {}) {
  return Promise.all(processes.map(async (process) => {
    const cwdText = await safeRunCommand("lsof", ["-a", "-p", String(process.pid), "-d", "cwd", "-Fn"], options);
    return {
      ...process,
      cwd: parseLsofCwd(cwdText),
    };
  }));
}

export async function collectWorkspaceProvenance(options = {}) {
  const psText = await safeRunCommand("ps", ["-axo", "pid,ppid,command"], options);
  const processes = parsePsOutput(psText);
  const workspaceProcesses = await annotateProcesses(
    processes.filter((process) => WORKSPACE_PROCESS_RE.test(process.command)),
    options,
  );
  const openclawProcesses = await annotateProcesses(processes.filter(isOpenClawRuntimeProcess), options);
  const runtimePlan = await buildRuntimePlan({
    sourceRoot: options.sourceRoot ?? SLACK_RUNTIME_SOURCE_ROOT,
    targetRoot: options.targetRoot ?? SLACK_RUNTIME_TARGET_ROOT,
  });

  return {
    generatedAt: new Date().toISOString(),
    roots: ROOTS.map((root) => ({
      path: root,
      exists: existsSync(root),
    })),
    git: await gitInfo(options.repoRoot ?? ROOTS[0], options),
    processes: {
      workspace: workspaceProcesses,
      openclaw: openclawProcesses,
    },
    slackRuntime: {
      sourceRoot: options.sourceRoot ?? SLACK_RUNTIME_SOURCE_ROOT,
      targetRoot: options.targetRoot ?? SLACK_RUNTIME_TARGET_ROOT,
      allMatch: runtimePlan.every((item) => item.matches),
      files: runtimePlan.map((item) => ({
        relativePath: item.relativePath,
        source: item.source,
        target: item.target,
        sourceSha256: item.sourceSha256,
        targetSha256: item.targetSha256,
        matches: item.matches,
      })),
    },
  };
}

export function formatWorkspaceProvenance(report) {
  const lines = [
    "# Atlas Workspace Provenance",
    "",
    `generated_at=${report.generatedAt}`,
    `repo=${report.git.repoRoot}`,
    `branch=${report.git.branch ?? "unknown"}`,
    `head=${report.git.head ?? "unknown"}`,
    `dirty=${String(report.git.dirty)}`,
    "",
    "## Roots",
    ...report.roots.map((root) => `${root.exists ? "EXISTS" : "MISSING"} ${root.path}`),
    "",
    "## Workspace Processes",
    ...formatProcessLines(report.processes.workspace),
    "",
    "## OpenClaw / Slack Processes",
    ...formatProcessLines(report.processes.openclaw),
    "",
    "## Slack Runtime Files",
    `all_match=${String(report.slackRuntime.allMatch)}`,
    ...report.slackRuntime.files.map((file) => [
      file.matches ? "MATCH" : "DIFF",
      file.relativePath,
      `source=${file.sourceSha256}`,
      `target=${file.targetSha256 ?? "missing"}`,
    ].join(" ")),
  ];
  return `${lines.join("\n")}\n`;
}

function formatProcessLines(processes) {
  if (!processes.length) return ["none"];
  return processes.map((process) => [
    `pid=${process.pid}`,
    `ppid=${process.ppid}`,
    `cwd=${process.cwd ?? "unknown"}`,
    `command=${process.command}`,
  ].join(" "));
}

function isOpenClawRuntimeProcess(process) {
  return OPENCLAW_NODE_PROCESS_RE.test(process.command) || process.command === "openclaw" || process.command.startsWith("openclaw ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs();
    const report = await collectWorkspaceProvenance();
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatWorkspaceProvenance(report));
    }
    if (!report.slackRuntime.allMatch) process.exitCode = 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
