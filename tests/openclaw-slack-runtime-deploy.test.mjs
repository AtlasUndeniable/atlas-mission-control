import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildRuntimePlan,
  deployRuntime,
  SLACK_RUNTIME_FILES,
} from "../scripts/deploy-openclaw-slack-runtime.mjs";

async function withTempRoots(fn) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-slack-runtime-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  try {
    await seedRuntimeTree(sourceRoot, {
      "lib/queue-writer.mjs": "source queue writer\n",
      "lib/artifact-delivery.mjs": "source artifact delivery\n",
      "lib/slack-rhys-dm-artifact.mjs": "source rhys dm artifact\n",
      "lib/error-redaction-patterns.mjs": "source error redaction patterns\n",
      "lib/slack-gates.mjs": "source slack gates\n",
      "lib/slack-gate-actions.mjs": "source slack gate actions\n",
      "lib/slack-asset-workflows.mjs": "source asset workflows\n",
      "lib/slack-asset-workflows.test.mjs": "source asset workflows test\n",
      "lib/slack-listener-reply.mjs": "source reply\n",
      "lib/slack-listener-reply.test.mjs": "source reply test\n",
      "lib/slack-dm-jobs.mjs": "source dm jobs\n",
      "lib/slack-dm-jobs.test.mjs": "source dm jobs test\n",
      "services/slack-listener/listener.mjs": "source listener\n",
      "services/workspace-worker/worker.mjs": "source workspace worker\n",
    });
    await seedRuntimeTree(targetRoot, {
      "lib/queue-writer.mjs": "source queue writer\n",
      "lib/artifact-delivery.mjs": "source artifact delivery\n",
      "lib/slack-rhys-dm-artifact.mjs": "source rhys dm artifact\n",
      "lib/error-redaction-patterns.mjs": "source error redaction patterns\n",
      "lib/slack-gates.mjs": "source slack gates\n",
      "lib/slack-gate-actions.mjs": "source slack gate actions\n",
      "lib/slack-asset-workflows.mjs": "source asset workflows\n",
      "lib/slack-asset-workflows.test.mjs": "source asset workflows test\n",
      "lib/slack-listener-reply.mjs": "old reply\n",
      "lib/slack-listener-reply.test.mjs": "source reply test\n",
      "lib/slack-dm-jobs.mjs": "source dm jobs\n",
      "lib/slack-dm-jobs.test.mjs": "source dm jobs test\n",
      "services/slack-listener/listener.mjs": "old listener\n",
      "services/workspace-worker/worker.mjs": "source workspace worker\n",
    });
    await fn({ sourceRoot, targetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedRuntimeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("buildRuntimePlan owns exactly the Slack listener runtime files", async () => {
  await withTempRoots(async ({ sourceRoot, targetRoot }) => {
    const plan = await buildRuntimePlan({ sourceRoot, targetRoot });

    assert.deepEqual(plan.map((item) => item.relativePath), SLACK_RUNTIME_FILES);
    assert.deepEqual(SLACK_RUNTIME_FILES, [
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
      "services/slack-listener/listener.mjs",
      "services/workspace-worker/worker.mjs",
    ]);
    const replyPlan = plan.find((item) => item.relativePath === "lib/slack-listener-reply.mjs");
    assert.equal(replyPlan.sourceSha256, sha256("source reply\n"));
    assert.equal(replyPlan.targetSha256, sha256("old reply\n"));
  });
});

test("verify mode reports mismatches without modifying target files", async () => {
  await withTempRoots(async ({ sourceRoot, targetRoot }) => {
    const result = await deployRuntime({ mode: "verify", sourceRoot, targetRoot });

    assert.equal(result.allMatch, false);
    assert.equal(result.changed, 2);
    assert.equal(await readFile(join(targetRoot, "lib/slack-listener-reply.mjs"), "utf8"), "old reply\n");
    assert.equal(await readFile(join(targetRoot, "services/slack-listener/listener.mjs"), "utf8"), "old listener\n");
  });
});

test("apply mode backs up changed live files and copies tracked source", async () => {
  await withTempRoots(async ({ sourceRoot, targetRoot }) => {
    const result = await deployRuntime({
      mode: "apply",
      sourceRoot,
      targetRoot,
      now: () => new Date("2026-06-06T10:11:12.000Z"),
    });

    assert.equal(result.allMatch, true);
    assert.equal(result.changed, 2);
    assert.deepEqual(result.backups.map((item) => item.relativePath), [
      "lib/slack-listener-reply.mjs",
      "services/slack-listener/listener.mjs",
    ]);
    assert.equal(await readFile(join(targetRoot, "lib/slack-listener-reply.mjs"), "utf8"), "source reply\n");
    assert.equal(await readFile(join(targetRoot, "services/slack-listener/listener.mjs"), "utf8"), "source listener\n");
    assert.equal(
      await readFile(join(targetRoot, "lib/slack-listener-reply.mjs.bak-20260606T101112Z"), "utf8"),
      "old reply\n",
    );
  });
});
