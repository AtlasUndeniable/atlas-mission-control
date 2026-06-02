/**
 * P7a local draft artifact tests.
 * Uses temp roots only; no external sends or existing artifact archive mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectWorkspaceDraftArtifactIntent,
  isSafeWorkspaceDraftArtifactId,
  maybeWriteWorkspaceDraftArtifact,
  readWorkspaceDraftArtifactPreview,
  shouldCreateWorkspaceDraftArtifact,
  summarizeWorkspaceDraftArtifactForChat,
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
  assert.equal(pdfIntent.exportLimitation, undefined);
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
    const chatSummary = summarizeWorkspaceDraftArtifactForChat(result);
    assert.match(chatSummary, /Markdown draft saved/);
    assert.match(chatSummary, /Open the artifact card to preview the full draft/);
    assert.doesNotMatch(chatSummary, /## Ricky pay model/);
    const processSummary = summarizeWorkspaceDraftArtifactForChat({
      ...result,
      artifact: {
        ...result.artifact,
        preview: "I'll update the Ricky pay model. Update",
      },
    });
    assert.match(processSummary, /Ricky pay model/);
    assert.doesNotMatch(processSummary, /I'll update/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft artifact preview reads only safe markdown artifact ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-preview-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Can you create the Ricky pay structure handover doc?",
      content: "## Ricky pay model\n\nUse clearer bands.",
      taskTitle: "Ricky pay structure handover",
      runtimeProvider: "mastra",
      runId: "run_preview_test",
      taskId: "task_preview_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });
    assert.ok(result);

    const preview = await readWorkspaceDraftArtifactPreview(result.metadata.id, { root });
    assert.ok(preview);
    assert.equal(preview.id, result.metadata.id);
    assert.equal(preview.type, "markdown");
    assert.match(preview.title, /Ricky pay structure handover draft/);
    assert.match(preview.markdown, /## Draft/);
    assert.doesNotMatch(JSON.stringify(preview), /localPath|metadataPath|\/Users\/atlasai|workspace-demo-artifacts/);

    assert.equal(await readWorkspaceDraftArtifactPreview("artifact_demo_missing", { root }), null);
    assert.equal(isSafeWorkspaceDraftArtifactId(result.metadata.id), true);
    assert.equal(isSafeWorkspaceDraftArtifactId("../secrets"), false);
    await assert.rejects(
      () => readWorkspaceDraftArtifactPreview("../secrets", { root }),
      /Unsafe artifact id/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pdf request saves real local PDF artifact with markdown source kept internal", async () => {
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
    assert.equal(result.artifact.type, "pdf");
    assert.match(result.artifact.title, /Readiness summary PDF draft/);
    assert.match(result.artifact.subtitle, /PDF draft/);
    assert.equal(result.metadata.requestedFormat, "pdf");
    assert.equal(result.metadata.type, "pdf");
    assert.equal(result.metadata.exportLimitation, undefined);
    assert.ok(result.metadata.sourceMarkdownPath);
    assert.ok(result.metadata.pdfPath);
    assert.equal(result.metadata.localPath, result.metadata.pdfPath);
    const markdown = await readFile(result.metadata.sourceMarkdownPath, "utf8");
    assert.match(markdown, /Delivery: local draft only; no external send performed/);
    const pdf = await readFile(result.metadata.pdfPath, "utf8");
    assert.match(pdf.slice(0, 8), /%PDF-1\.4/);
    assert.ok((await stat(result.metadata.pdfPath)).size > 500);
    assert.doesNotMatch(result.artifact.subtitle, /not wired/i);

    const preview = await readWorkspaceDraftArtifactPreview(result.metadata.id, { root });
    assert.ok(preview);
    assert.equal(preview.type, "pdf");
    assert.ok(preview.pdf);
    assert.match(preview.pdf.filename, /readiness_summary_pdf_draft\.pdf/);
    assert.doesNotMatch(JSON.stringify(preview), /localPath|metadataPath|pdfPath|sourceMarkdownPath|\/Users\/atlasai|workspace-demo-artifacts/);

    const chatSummary = summarizeWorkspaceDraftArtifactForChat(result);
    assert.match(chatSummary, /PDF draft saved/);
    assert.match(chatSummary, /download the PDF/);
    assert.doesNotMatch(chatSummary, /PDF export is not wired|Markdown draft saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
