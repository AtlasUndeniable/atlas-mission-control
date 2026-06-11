#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE_ROOT = resolve(fileURLToPath(new URL("../openclaw-runtime/workspace", import.meta.url)));
export const DEFAULT_TARGET_ROOT = "/Users/atlasai/.openclaw/workspace";

export const SLACK_RUNTIME_FILES = [
  "lib/queue-writer.mjs",
  "lib/artifact-delivery.mjs",
  "lib/slack-rhys-dm-artifact.mjs",
  "lib/error-redaction-patterns.mjs",
  "lib/slack-gates.mjs",
  "lib/slack-gate-actions.mjs",
  "lib/slack-asset-workflows.mjs",
  "lib/slack-asset-workflows.test.mjs",
  "lib/slack-listener-reply.mjs",
  "lib/slack-listener-reply.test.mjs",
  "lib/slack-dm-jobs.mjs",
  "lib/slack-dm-jobs.test.mjs",
  "lib/slack-retrieval.mjs",
  "services/slack-listener/listener.mjs",
  "services/workspace-worker/worker.mjs",
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    mode: "verify",
    sourceRoot: DEFAULT_SOURCE_ROOT,
    targetRoot: DEFAULT_TARGET_ROOT,
    backup: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") {
      options.mode = "verify";
    } else if (arg === "--dry-run") {
      options.mode = "dry-run";
    } else if (arg === "--apply") {
      options.mode = "apply";
    } else if (arg === "--no-backup") {
      options.backup = false;
    } else if (arg === "--source-root") {
      options.sourceRoot = resolve(argv[++index] || "");
    } else if (arg === "--target-root") {
      options.targetRoot = resolve(argv[++index] || "");
    } else if (arg === "--help" || arg === "-h") {
      options.mode = "help";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function assertInsideRoot(root, path) {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel === "" || rel.includes("..")) {
    throw new Error(`Refusing path outside root: ${path}`);
  }
}

async function fileSha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function optionalFileSha256(path) {
  try {
    return await fileSha256(path);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function buildRuntimePlan({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot = DEFAULT_TARGET_ROOT,
  files = SLACK_RUNTIME_FILES,
} = {}) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedTargetRoot = resolve(targetRoot);

  return Promise.all(files.map(async (relativePath) => {
    const source = resolve(resolvedSourceRoot, relativePath);
    const target = resolve(resolvedTargetRoot, relativePath);
    assertInsideRoot(resolvedSourceRoot, source);
    assertInsideRoot(resolvedTargetRoot, target);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) {
      throw new Error(`Source is not a file: ${source}`);
    }
    const sourceSha256 = await fileSha256(source);
    const targetSha256 = await optionalFileSha256(target);
    return {
      relativePath,
      source,
      target,
      sourceSha256,
      targetSha256,
      exists: targetSha256 !== null,
      matches: sourceSha256 === targetSha256,
    };
  }));
}

export async function deployRuntime({
  mode = "verify",
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot = DEFAULT_TARGET_ROOT,
  backup = true,
  now = () => new Date(),
} = {}) {
  if (!["verify", "dry-run", "apply"].includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const plan = await buildRuntimePlan({ sourceRoot, targetRoot });
  const changed = plan.filter((item) => !item.matches);
  const backups = [];

  if (mode === "apply") {
    const timestamp = now().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
    for (const item of changed) {
      await mkdir(dirname(item.target), { recursive: true });
      if (backup && existsSync(item.target)) {
        const backupPath = `${item.target}.bak-${timestamp}`;
        await rename(item.target, backupPath);
        backups.push({ relativePath: item.relativePath, backupPath });
      }
      await copyFile(item.source, item.target);
    }
  }

  const afterPlan = mode === "apply"
    ? await buildRuntimePlan({ sourceRoot, targetRoot })
    : plan;

  return {
    mode,
    changed: changed.length,
    allMatch: afterPlan.every((item) => item.matches),
    plan: afterPlan,
    backups,
  };
}

function printResult(result) {
  console.log(`mode=${result.mode}`);
  console.log(`changed=${result.changed}`);
  console.log(`allMatch=${result.allMatch}`);
  for (const item of result.plan) {
    console.log([
      item.matches ? "MATCH" : "DIFF",
      item.relativePath,
      `source=${item.sourceSha256}`,
      `target=${item.targetSha256 || "missing"}`,
    ].join(" "));
  }
  for (const backup of result.backups) {
    console.log(`BACKUP ${backup.relativePath} ${backup.backupPath}`);
  }
}

function printHelp() {
  console.log([
    "Usage: node scripts/deploy-openclaw-slack-runtime.mjs [--verify|--dry-run|--apply]",
    "",
    "Defaults:",
    `  --source-root ${DEFAULT_SOURCE_ROOT}`,
    `  --target-root ${DEFAULT_TARGET_ROOT}`,
    "",
    "Modes:",
    "  --verify   Compare tracked source to live runtime; write nothing. Default.",
    "  --dry-run  Show the same planned differences as apply; write nothing.",
    "  --apply    Copy tracked files into the target runtime, creating timestamped backups by default.",
    "",
    "Manual deploy command:",
    "  node scripts/deploy-openclaw-slack-runtime.mjs --apply",
  ].join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs();
    if (options.mode === "help") {
      printHelp();
    } else {
      const result = await deployRuntime(options);
      printResult(result);
      if (options.mode === "verify" && !result.allMatch) {
        process.exitCode = 1;
      }
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
