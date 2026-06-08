import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  collectSlackSocketOwnerReport,
  formatSlackSocketOwnerReport,
} from "../scripts/check-openclaw-slack-socket-owner.mjs";

async function withSocketFixture(options = {}, fn = null) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  const { gatewaySlack = true } = options;
  const root = await mkdtemp(join(tmpdir(), "openclaw-slack-socket-owner-"));
  const liveRoot = join(root, "workspace");
  const launchDir = join(root, "LaunchAgents");
  const configPath = join(root, "openclaw.json");
  try {
    await writeFixtureFile(
      join(liveRoot, "services/slack-listener/listener.mjs"),
      'import { WebSocket } from "ws";\nhttps.request({ path: "/api/apps.connections.open" });\nnew WebSocket(url);\n',
    );
    await writeFixtureFile(
      join(liveRoot, "services/slack-bridge/slack-bridge.mjs"),
      "https.request({ path: '/api/conversations.history' });\n",
    );
    await writeFile(configPath, JSON.stringify({
      channels: {
        slack: {
          enabled: gatewaySlack,
          mode: gatewaySlack ? "socket" : "off",
        },
      },
    }), "utf8");
    await mkdir(launchDir, { recursive: true });
    await writeFile(join(launchDir, "com.atlas.slack-listener.plist"), "", "utf8");
    await writeFile(join(launchDir, "com.atlas.gateway.plist"), "", "utf8");
    await writeFile(join(launchDir, "com.atlas.slack-bridge.plist"), "", "utf8");
    await fn({ liveRoot, launchDir, configPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function mockCommandRunner(command, args) {
  const key = `${command} ${args.join(" ")}`;
  if (key === "ps -axo pid,ppid,command") {
    return [
      "  PID  PPID COMMAND",
      "  100     1 /opt/homebrew/bin/node /tmp/workspace/services/slack-listener/listener.mjs",
      "  200     1 openclaw",
      "  300     1 /opt/homebrew/bin/node /tmp/workspace/services/slack-bridge/slack-bridge.mjs",
      "",
    ].join("\n");
  }
  if (command === "plutil") {
    const file = args.at(-1) || "";
    if (/slack-listener/.test(file)) {
      return JSON.stringify({
        Label: "com.atlas.slack-listener",
        ProgramArguments: ["/opt/homebrew/bin/node", "/tmp/workspace/services/slack-listener/listener.mjs"],
        EnvironmentVariables: { SLACK_APP_TOKEN: "redacted", SLACK_BOT_TOKEN: "redacted" },
      });
    }
    if (/gateway/.test(file)) {
      return JSON.stringify({
        Label: "com.atlas.gateway",
        ProgramArguments: ["/opt/homebrew/bin/node", "/opt/homebrew/bin/openclaw", "gateway"],
        EnvironmentVariables: { SLACK_APP_TOKEN: "redacted", SLACK_BOT_TOKEN: "redacted" },
      });
    }
    if (/slack-bridge/.test(file)) {
      return JSON.stringify({
        Label: "com.atlas.slack-bridge",
        ProgramArguments: ["/opt/homebrew/bin/node", "/tmp/workspace/services/slack-bridge/slack-bridge.mjs"],
        EnvironmentVariables: { SLACK_APP_TOKEN: "redacted", SLACK_BOT_TOKEN: "redacted", SLACK_USER_TOKEN: "redacted" },
      });
    }
  }
  return "";
}

test("socket owner diagnostic reports listener and gateway conflict", async () => {
  await withSocketFixture(async ({ liveRoot, launchDir, configPath }) => {
    const report = await collectSlackSocketOwnerReport({
      liveRoot,
      configPath,
      launchAgentDirs: [launchDir],
      commandRunner: mockCommandRunner,
      intendedOwner: "slack-listener",
    });

    assert.equal(report.status, "conflict");
    assert.deepEqual(report.activeSocketOwners, ["slack-listener", "openclaw-gateway"]);
    assert.equal(report.candidates.find((candidate) => candidate.id === "slack-bridge")?.socketCapable, false);
    assert.doesNotMatch(JSON.stringify(report), /xox|redacted-token-value|SLACK_APP_TOKEN=/);
    assert.match(formatSlackSocketOwnerReport(report), /WARNING multiple active Slack Socket Mode owners/);
  });
});

test("socket owner diagnostic reports ok when gateway Slack socket is disabled", async () => {
  await withSocketFixture({ gatewaySlack: false }, async ({ liveRoot, launchDir, configPath }) => {
    const report = await collectSlackSocketOwnerReport({
      liveRoot,
      configPath,
      launchAgentDirs: [launchDir],
      commandRunner: mockCommandRunner,
      intendedOwner: "slack-listener",
    });

    assert.equal(report.status, "ok");
    assert.deepEqual(report.activeSocketOwners, ["slack-listener"]);
  });
});
