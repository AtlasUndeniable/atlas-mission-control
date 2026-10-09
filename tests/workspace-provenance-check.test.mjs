import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  collectWorkspaceProvenance,
  formatWorkspaceProvenance,
} from "../scripts/check-workspace-provenance.mjs";
import { SLACK_RUNTIME_FILES } from "../scripts/deploy-openclaw-slack-runtime.mjs";

// The collector always walks the deploy script's own manifest, so the
// synthetic tree has to carry every file on it. Seeding a hand-written subset
// made this test fail the moment the manifest grew a file the subset lacked.
const RUNTIME_FILES = Object.fromEntries(
  SLACK_RUNTIME_FILES.map((relativePath) => [relativePath, `${relativePath}\n`]),
);

test("workspace provenance check reports roots, processes, git head, and matching runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-provenance-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  try {
    await seedRuntimeTree(sourceRoot, RUNTIME_FILES);
    await seedRuntimeTree(targetRoot, RUNTIME_FILES);

    const report = await collectWorkspaceProvenance({
      repoRoot: "/repo",
      sourceRoot,
      targetRoot,
      commandRunner: async (command, args) => mockCommand(command, args),
    });
    const text = formatWorkspaceProvenance(report);

    assert.equal(report.git.head, "abc123");
    assert.equal(report.git.branch, "main");
    assert.equal(report.git.dirty, true);
    assert.equal(report.processes.workspace[0]?.pid, 100);
    assert.equal(report.processes.workspace[0]?.cwd, "/Users/atlasai/atlas-mission-control");
    assert.equal(report.processes.openclaw[0]?.pid, 200);
    assert.equal(report.processes.openclaw[0]?.cwd, "/Users/atlasai/.openclaw/workspace/services/slack-listener");
    assert.equal(report.processes.openclaw.some((process) => process.pid === 300), false);
    assert.equal(report.slackRuntime.allMatch, true);
    assert.match(text, /MATCH lib\/slack-listener-reply\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace provenance check flags live runtime drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-provenance-drift-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  try {
    await seedRuntimeTree(sourceRoot, RUNTIME_FILES);
    await seedRuntimeTree(targetRoot, {
      ...RUNTIME_FILES,
      "services/slack-listener/listener.mjs": "different listener\n",
    });

    const report = await collectWorkspaceProvenance({
      repoRoot: "/repo",
      sourceRoot,
      targetRoot,
      commandRunner: async (command, args) => mockCommand(command, args),
    });
    const listener = report.slackRuntime.files.find((file) => file.relativePath === "services/slack-listener/listener.mjs");

    assert.equal(report.slackRuntime.allMatch, false);
    assert.equal(listener?.matches, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function seedRuntimeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function mockCommand(command, args) {
  const key = `${command} ${args.join(" ")}`;
  if (key === "git -C /repo rev-parse HEAD") return "abc123\n";
  if (key === "git -C /repo branch --show-current") return "main\n";
  if (key === "git -C /repo status --short --branch") return "## main...origin/main\n M src/app/workspace/page.tsx\n";
  if (key === "ps -axo pid,ppid,command") {
    return [
      "  PID  PPID COMMAND",
      "  100     1 node /Users/atlasai/atlas-mission-control/node_modules/.bin/next dev -H 127.0.0.1 -p 3031",
      "  200     1 /opt/homebrew/bin/node /Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs",
      "  300     1 /bin/zsh -lc find /Users/atlasai/.openclaw/workspace/services -type f",
      "",
    ].join("\n");
  }
  if (key === "lsof -a -p 100 -d cwd -Fn") return "p100\nfcwd\nn/Users/atlasai/atlas-mission-control\n";
  if (key === "lsof -a -p 200 -d cwd -Fn") return "p200\nfcwd\nn/Users/atlasai/.openclaw/workspace/services/slack-listener\n";
  if (key === "lsof -a -p 300 -d cwd -Fn") return "p300\nfcwd\nn/Users/atlasai/atlas-mission-control\n";
  return "";
}
