/**
 * P7a local draft artifact tests.
 * Uses temp roots only; no external sends or existing artifact archive mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectWorkspaceDraftArtifactIntent,
  maybeWriteWorkspaceDraftArtifact,
  shouldCreateWorkspaceDraftArtifact,
} from "../src/lib/workspace-draft-artifacts.ts";

test("draft artifact intent is explicit deliverable only", () => {
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Can you create the Ricky pay structure handover doc?",
    taskTitle: "Ricky handover",
  }), true);
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "What are the top 5 trends from recent calls?",
    taskTitle: "Recent call trends",
  }), false);
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Give me 10 ideas for next week.",
    taskTitle: "Ideas",
  }), false);
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Give me 10 content ideas for next week.",
    taskTitle: "Content ideas",
  }), false);
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Give me 10 content ideas for next week and save this.",
    taskTitle: "Content ideas",
  }), true);
  assert.equal(shouldCreateWorkspaceDraftArtifact({
    prompt: "Export these content ideas as a file.",
    taskTitle: "Content ideas",
  }), true);
});

test("draft artifact intent tracks requested format and export limitation", () => {
  const pdfIntent = detectWorkspaceDraftArtifactIntent({
    prompt: "Make this a PDF for Rhys.",
    taskTitle: "Workspace note",
  });
  const docxIntent = detectWorkspaceDraftArtifactIntent({
    prompt: "Turn this into a DOCX.",
    taskTitle: "Workspace note",
  });

  assert.equal(pdfIntent.shouldCreate, true);
  assert.equal(pdfIntent.requestedFormat, "pdf");
  assert.match(pdfIntent.exportLimitation ?? "", /PDF export is not wired yet/);
  assert.equal(docxIntent.shouldCreate, true);
  assert.equal(docxIntent.requestedFormat, "docx");
  assert.match(docxIntent.exportLimitation ?? "", /DOCX export is not wired yet/);
});

test("draft artifact writer saves markdown and metadata under caller root", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Can you create the Ricky pay structure handover doc?",
      content: "## Ricky pay model\n\nUse clearer bands.",
      taskTitle: "Ricky pay structure handover",
      runtimeProvider: "mastra",
      runId: "run_test",
      taskId: "task_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });

    assert.ok(result);
    assert.equal(result.artifact.type, "markdown");
    assert.match(result.artifact.title, /Ricky pay structure handover draft/);
    assert.equal(result.metadata.type, "markdown");
    assert.equal(result.metadata.requestedFormat, "handover");
    assert.equal(result.metadata.runtimeProvider, "mastra");
    assert.match(result.metadata.localPath, new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.metadata.metadataPath, /\.metadata\.json$/);
    assert.doesNotMatch(result.artifact.title, /\/Users\/atlasai|\.openclaw/);

    const markdown = await readFile(result.metadata.localPath, "utf8");
    const metadataJson = JSON.parse(await readFile(result.metadata.metadataPath, "utf8")) as {
      localPath?: string;
      userFacingName?: string;
    };
    assert.match(markdown, /# Ricky pay structure handover/);
    assert.match(markdown, /Delivery: local draft only; no external send performed/);
    assert.match(markdown, /Use clearer bands/);
    assert.equal(metadataJson.localPath, result.metadata.localPath);
    assert.equal(metadataJson.userFacingName, "Ricky pay structure handover draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pdf request saves markdown draft with honest export limitation", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Make this a PDF for Rhys.",
      content: "Draft body.",
      taskTitle: "Readiness summary",
      runtimeProvider: "mastra",
      runId: "run_pdf_test",
      taskId: "task_pdf_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });

    assert.ok(result);
    assert.equal(result.artifact.type, "markdown");
    assert.match(result.artifact.title, /Readiness summary PDF draft/);
    assert.match(result.artifact.subtitle, /Draft saved; PDF export is not wired yet/);
    assert.equal(result.metadata.requestedFormat, "pdf");
    assert.match(result.metadata.exportLimitation ?? "", /PDF export is not wired yet/);
    const markdown = await readFile(result.metadata.localPath, "utf8");
    assert.match(markdown, /Delivery: local draft only; no external send performed/);
    assert.doesNotMatch(result.artifact.subtitle, /generated|created PDF/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
