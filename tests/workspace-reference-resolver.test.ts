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
  const callTranscriptsRoot = join(root, "fireflies");
  const callArchivesRoot = join(root, "call-archives");
  const knowledgeTopicsRoot = join(root, "knowledge-topics");
  const projectDocsRoot = join(root, "project-docs");
  const stateCurrentPath = join(root, "state-current.md");
  await mkdir(contextPacksRoot, { recursive: true });
  await mkdir(reportsRoot, { recursive: true });
  await mkdir(reviewQueueRoot, { recursive: true });
  await mkdir(callTranscriptsRoot, { recursive: true });
  await mkdir(callArchivesRoot, { recursive: true });
  await mkdir(knowledgeTopicsRoot, { recursive: true });
  await mkdir(projectDocsRoot, { recursive: true });
  return {
    root,
    options: {
      contextPacksRoot,
      reportsRoot,
      reviewQueueRoot,
      callTranscriptsRoot,
      callArchivesRoot,
      knowledgeTopicsRoot,
      projectDocsRoot,
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
    assert.match(packet.internalSummary, /path_summaries=/);
    assert.doesNotMatch(packet.internalSummary, /\/Users\/atlasai|\.openclaw/);

    const inspectorPacket = createWorkspaceReferenceInspectorPacket(packet);
    assert.equal(inspectorPacket.coverage, "matched");
    assert.ok(inspectorPacket.rootsRead.some((root) => root.key === "librarian-reports"));
    assert.equal(JSON.stringify(inspectorPacket).includes("/Users/atlasai"), false);
    assert.ok(inspectorPacket.references.some((reference) => reference.handle.includes("ricky-calder-source-match")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent calls prompt prioritizes call transcript handles when available", async () => {
  const { root, options } = await fixtureRoots();
  try {
    await writeFile(join(options.callTranscriptsRoot!, "2026-06-03-Corey-Batson-x-Rhys.md"), [
      "# Corey Batson x Rhys",
      "**Date:** 03/06/2026",
      "## KEY FRAMEWORKS",
      "Delivery model tradeoff, Loom-heavy fulfilment, pricing restructure, and hiring another coach.",
      "## ACTION ITEMS",
      "Choose between restructuring delivery, hiring another coach, or maintaining the current model.",
    ].join("\n"));
    await writeFile(join(options.reportsRoot!, "memory-maintenance-2026-06-03.md"), [
      "# Atlas Memory Maintenance Report",
      "Notes scanned: 5842.",
      "new notes sample includes memory/PARA/Resources/fireflies/2026-06-03-Corey-Batson-x-Rhys",
      "This is graph maintenance, not transcript content.",
    ].join("\n"));

    const packet = await resolveWorkspaceReferences({
      prompt: "with available knowledge what are some topics from today's calls or recent memory",
      workspaceId: "workspace_undeniable_demo",
      project: "Undeniable",
      room: "workspace-demo",
    }, options);

    assert.notEqual(packet.coverage, "none");
    assert.equal(packet.references[0]?.sourceType, "call-transcript");
    assert.match(packet.references[0]?.excerpt ?? "", /Delivery model tradeoff|pricing restructure/i);
    assert.ok(packet.references.some((reference) => reference.sourceType === "system-memory-maintenance"));
    assert.match(packet.guidance.join(" "), /Found, Missing, Best next search/);
    assert.doesNotMatch(packet.guidance.join(" "), /No matching Workspace references/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory maintenance reports do not masquerade as call content", async () => {
  const { root, options } = await fixtureRoots();
  try {
    await writeFile(join(options.reportsRoot!, "memory-maintenance-2026-06-03.md"), [
      "# Atlas Memory Maintenance Report",
      "new notes sample includes memory/PARA/Resources/fireflies/2026-06-03-Corey-Batson-x-Rhys",
      "Broken links and orphan counts changed after recent call transcript ingestion.",
      "No transcript excerpts are included in this report.",
    ].join("\n"));

    const packet = await resolveWorkspaceReferences({
      prompt: "What topics came up in today's calls?",
      workspaceId: "workspace_undeniable_demo",
      project: "Undeniable",
      room: "workspace-demo",
    }, options);

    assert.equal(packet.coverage, "thin");
    assert.equal(packet.references.some((reference) => reference.sourceType === "call-transcript"), false);
    assert.ok(packet.references.some((reference) => reference.sourceType === "system-memory-maintenance"));
    assert.match(packet.guidance.join(" "), /not as call transcript content/i);
    assert.match(packet.userFacingSummary, /Missing: call transcript or call-summary content/i);
    assert.doesNotMatch(JSON.stringify(createWorkspaceReferenceInspectorPacket(packet)), /\/Users\/atlasai|\.openclaw/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thin call coverage summary exposes missing source types without paths", async () => {
  const { root, options } = await fixtureRoots();
  try {
    await writeFile(join(options.knowledgeTopicsRoot!, "call-transcripts.md"), [
      "# Transcript - Call Transcripts",
      "Sub-hub - 2443 call transcripts featuring Fireflies.",
      "- [[memory/PARA/Resources/fireflies/2026-06-03-Corey-Batson-x-Rhys.md|Corey Batson x Rhys]]",
    ].join("\n"));

    const packet = await resolveWorkspaceReferences({
      prompt: "Summarize today's calls from available memory.",
      workspaceId: "workspace_undeniable_demo",
      project: "Undeniable",
      room: "workspace-demo",
    }, options);

    assert.equal(packet.coverage, "thin");
    assert.ok(packet.references.some((reference) => reference.sourceType === "knowledge-index"));
    assert.match(packet.userFacingSummary, /Found:/);
    assert.match(packet.userFacingSummary, /Missing: call transcript or call-summary content/);
    assert.match(packet.userFacingSummary, /Best next search: call-transcripts and call-archives/);
    assert.doesNotMatch(packet.userFacingSummary, /\/Users\/atlasai|\.openclaw/);
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
