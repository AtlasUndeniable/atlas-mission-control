/**
 * P6a read-only Workspace reference resolver tests.
 * Uses temp fixtures only; no live Slack/OpenClaw/Monday/Typeform/Supabase mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createWorkspaceReferenceInspectorPacket,
  resolveWorkspaceReferences,
  type WorkspaceReferenceResolverOptions,
} from "../src/lib/workspace-reference-resolver.ts";

async function fixtureRoots(): Promise<{
  root: string;
  options: WorkspaceReferenceResolverOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "atlas-workspace-references-"));
  const contextPacksRoot = join(root, "librarian-context-packs");
  const reportsRoot = join(root, "librarian-reports");
  const reviewQueueRoot = join(root, "librarian-review-queue");
  const stateCurrentPath = join(root, "state-current.md");
  await mkdir(contextPacksRoot, { recursive: true });
  await mkdir(reportsRoot, { recursive: true });
  await mkdir(reviewQueueRoot, { recursive: true });
  return {
    root,
    options: {
      contextPacksRoot,
      reportsRoot,
      reviewQueueRoot,
      stateCurrentPath,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
    },
  };
}

test("Ricky Calder prompt resolves compact matching reference handles", async () => {
  const { root, options } = await fixtureRoots();
  try {
    await writeFile(join(options.reportsRoot!, "ricky-calder-source-match-dry-run-2026-05-25.md"), [
      "# Ricky Calder Source Match Dry Run",
      "Generated: 2026-05-25",
      "Matched document candidates: 7 calls.",
      "Ricky Calder coach hire call archive includes pay model handover notes.",
      "Source path: /Users/atlasai/.openclaw/workspace/memory/PARA/Resources/fireflies/call-ricky.md",
    ].join("\n"));
    await writeFile(join(options.reportsRoot!, "artifact-hygiene-2026-06-01.json"), JSON.stringify({
      generatedAt: "2026-06-01T17:30:11.176Z",
      records: [{
        artifactId: "ricky-calder-call-archive-strategic-overview",
        title: "Ricky Calder Call Archive Strategic Overview",
        summary: "Metadata record for Ricky Calder coach hire source material.",
      }],
    }));

    const packet = await resolveWorkspaceReferences({
      prompt: "Update the Ricky Calder coach hire pay model handover with clearer bands.",
      workspaceId: "workspace_undeniable_demo",
      project: "Undeniable",
      room: "workspace-demo",
    }, options);

    assert.equal(packet.coverage, "matched");
    assert.ok(packet.references.some((reference) => reference.handle.includes("ricky-calder-source-match")));
    assert.ok(packet.references.some((reference) => reference.sourceType === "artifact-metadata"));
    assert.equal(packet.references.every((reference) => reference.excerpt.length <= 420), true);
    assert.equal(packet.references.every((reference) => !reference.excerpt.includes("/Users/atlasai")), true);
    assert.match(packet.internalSummary, /paths=/);

    const inspectorPacket = createWorkspaceReferenceInspectorPacket(packet);
    assert.equal(inspectorPacket.coverage, "matched");
    assert.ok(inspectorPacket.rootsRead.some((root) => root.key === "librarian-reports"));
    assert.equal(JSON.stringify(inspectorPacket).includes("/Users/atlasai"), false);
    assert.ok(inspectorPacket.references.some((reference) => reference.handle.includes("ricky-calder-source-match")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent calls prompt uses matching reports when available", async () => {
  const { root, options } = await fixtureRoots();
  try {
    await writeFile(join(options.reportsRoot!, "daily-delta-2026-06-01.md"), [
      "# Daily Delta 2026-06-01",
      "Recent calls trend toward clearer handovers, coach pricing bands, and retention playbooks.",
      "Call notes remain summaries only; full transcript search was not run.",
    ].join("\n"));

    const packet = await resolveWorkspaceReferences({
      prompt: "What are the top trends from recent calls?",
      workspaceId: "workspace_undeniable_demo",
      project: "Undeniable",
      room: "workspace-demo",
    }, options);

    assert.notEqual(packet.coverage, "none");
    assert.ok(packet.references.some((reference) => reference.handle.includes("daily-delta")));
    assert.match(packet.references.map((reference) => reference.excerpt).join(" "), /Recent calls trend/);
    assert.doesNotMatch(packet.guidance.join(" "), /No matching Workspace references/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic content idea prompt does not invent memory references", async () => {
  const { root, options } = await fixtureRoots();
  try {
    await writeFile(join(options.reportsRoot!, "artifact-hygiene-2026-06-01.json"), JSON.stringify({
      generatedAt: "2026-06-01T17:30:11.176Z",
      records: [{ title: "Audit artifact metadata", summary: "Audit export inventory." }],
    }));

    const packet = await resolveWorkspaceReferences({
      prompt: "Give me three content ideas for next week.",
      workspaceId: "workspace_undeniable_demo",
      project: "Undeniable",
      room: "workspace-demo",
    }, options);

    assert.equal(packet.coverage, "none");
    assert.deepEqual(packet.references, []);
    assert.match(packet.guidance.join(" "), /Do not claim to have searched calls/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
