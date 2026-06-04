/**
 * P7a local draft artifact tests.
 * Uses temp roots only; no external sends or existing artifact archive mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectWorkspaceDraftArtifactIntent,
  isSafeWorkspaceDraftArtifactId,
  maybeWriteWorkspaceDraftArtifact,
  readWorkspaceDraftArtifactPdf,
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
    prompt: "With available knowledge, what are some topics from today's calls or recent memory?",
    taskTitle: "Ricky Calder pay structure handover",
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

test("Ricky handover document without PDF intent remains markdown draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-ricky-md-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Please update the Ricky Calder pay structure handover doc.",
      content: "Updated Ricky pay structure handover.",
      taskTitle: "Ricky Calder pay structure handover",
      runtimeProvider: "mastra",
      runId: "run_ricky_markdown_test",
      taskId: "task_ricky_markdown_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });

    assert.ok(result);
    assert.equal(result.artifact.type, "markdown");
    assert.equal(result.metadata.type, "markdown");
    assert.equal(result.metadata.requestedFormat, "handover");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit Ricky handover PDF request creates primary PDF artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-ricky-pdf-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Please update the Ricky Calder pay structure handover doc and return it as a PDF.",
      content: "Updated Ricky pay structure handover.",
      taskTitle: "Ricky Calder pay structure handover",
      runtimeProvider: "mastra",
      runId: "run_ricky_pdf_test",
      taskId: "task_ricky_pdf_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });

    assert.ok(result);
    assert.equal(result.artifact.type, "pdf");
    assert.equal(result.metadata.type, "pdf");
    assert.equal(result.metadata.requestedFormat, "pdf");
    assert.ok(result.metadata.sourceMarkdownPath);
    assert.ok(result.metadata.pdfPath);
    assert.equal(result.metadata.localPath, result.metadata.pdfPath);
    assert.equal(result.metadata.sourceWorkflow, "atlas-rhys-ricky-handover-archive");
    assert.equal(result.artifact.title, "Ricky Calder Coach Hire Pay Model Handover");
    assert.equal(
      result.artifact.preview,
      "Existing Atlas/Rhys Ricky handover package copied into Workspace. Review the PDF before any external use.",
    );
    assert.equal(result.metadata.userFacingName, "Ricky Calder Coach Hire Pay Model Handover");
    const pdf = await readFile(result.metadata.pdfPath);
    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    assert.ok(pdf.byteLength > 200_000);
    assert.match(summarizeWorkspaceDraftArtifactForChat(result), /PDF draft saved/);
    assert.match(summarizeWorkspaceDraftArtifactForChat(result), /existing Atlas\/Rhys Ricky handover package/);
    assert.doesNotMatch(summarizeWorkspaceDraftArtifactForChat(result), /Markdown draft saved|PDF export is not wired/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic workspace PDF request is blocked to an internal markdown draft without fake branding", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-pdf-blocked-"));
  try {
    const result = await maybeWriteWorkspaceDraftArtifact({
      prompt: "Make this a PDF.",
      content: "Draft body.",
      taskTitle: "Atlas workspace session",
      runtimeProvider: "mastra",
      runId: "run_pdf_branding_test",
      taskId: "task_pdf_branding_test",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      root,
    });

    assert.ok(result);
    assert.equal(result.artifact.type, "markdown");
    assert.equal(result.metadata.type, "markdown");
    assert.equal(result.metadata.requestedFormat, "pdf");
    assert.equal(result.metadata.pdfPath, undefined);
    assert.equal(result.metadata.sourceWorkflow, undefined);
    assert.match(result.metadata.exportLimitation ?? "", /real Atlas\/Rhys document workflow/);
    assert.match(result.artifact.subtitle, /PDF rendering is blocked/);
    assert.match(summarizeWorkspaceDraftArtifactForChat(result), /Internal markdown draft saved; PDF rendering is blocked/);
    assert.doesNotMatch(summarizeWorkspaceDraftArtifactForChat(result), /PDF draft saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("send back as pdf phrase creates PDF artifact", () => {
  const intent = detectWorkspaceDraftArtifactIntent({
    prompt: "Tidy this up and send this back as a pdf.",
    taskTitle: "Workspace handover document",
  });

  assert.equal(intent.shouldCreate, true);
  assert.equal(intent.requestedFormat, "pdf");
});

test("PDF intent beats generic document and handover intent", () => {
  const phrases = [
    "Please create the handover document as a PDF.",
    "Please create the document and export to PDF.",
    "Please create the handover doc as a downloadable PDF.",
    "Please update the handover doc and send back as a PDF.",
  ];

  for (const prompt of phrases) {
    const intent = detectWorkspaceDraftArtifactIntent({
      prompt,
      taskTitle: "Ricky Calder handover document",
    });
    assert.equal(intent.shouldCreate, true, prompt);
    assert.equal(intent.requestedFormat, "pdf", prompt);
    assert.equal(intent.exportLimitation, undefined, prompt);
  }
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

test("unsupported pdf request preserves only markdown source and reports blocker", async () => {
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
    assert.match(result.artifact.subtitle, /PDF rendering is blocked/);
    assert.equal(result.metadata.requestedFormat, "pdf");
    assert.equal(result.metadata.type, "markdown");
    assert.match(result.metadata.exportLimitation ?? "", /real Atlas\/Rhys document workflow/);
    assert.equal(result.metadata.sourceMarkdownPath, undefined);
    assert.equal(result.metadata.pdfPath, undefined);
    assert.equal(result.metadata.localPath.endsWith(".md"), true);
    const markdown = await readFile(result.metadata.localPath, "utf8");
    assert.match(markdown, /Delivery: local draft only; no external send performed/);
    assert.ok((await stat(result.metadata.localPath)).size > 100);

    const preview = await readWorkspaceDraftArtifactPreview(result.metadata.id, { root });
    assert.ok(preview);
    assert.equal(preview.type, "markdown");
    assert.equal(preview.pdf, undefined);
    assert.equal(await readWorkspaceDraftArtifactPdf(result.metadata.id, { root }), null);
    assert.doesNotMatch(JSON.stringify(preview), /localPath|metadataPath|pdfPath|sourceMarkdownPath|\/Users\/atlasai|workspace-demo-artifacts/);

    const chatSummary = summarizeWorkspaceDraftArtifactForChat(result);
    assert.match(chatSummary, /Internal markdown draft saved; PDF rendering is blocked/);
    assert.match(chatSummary, /preview the full draft/);
    assert.doesNotMatch(chatSummary, /PDF draft saved|download the PDF/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy placeholder PDF metadata previews as markdown and cannot download PDF", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-draft-artifacts-legacy-pdf-"));
  try {
    const id = "artifact_demo_legacy_placeholder_pdf";
    await writeLegacyArtifactFiles(root, id);

    const preview = await readWorkspaceDraftArtifactPreview(id, { root });
    assert.ok(preview);
    assert.equal(preview.type, "markdown");
    assert.equal(preview.requestedFormat, "pdf");
    assert.equal(preview.pdf, undefined);
    assert.match(preview.markdown ?? "", /Legacy placeholder source/);
    assert.equal(await readWorkspaceDraftArtifactPdf(id, { root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeLegacyArtifactFiles(root: string, id: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${id}.md`), "# Legacy placeholder source\n", "utf8");
  await writeFile(join(root, `${id}.pdf`), Buffer.from("%PDF-1.4\nlegacy fake\n"));
  await writeFile(join(root, `${id}.metadata.json`), `${JSON.stringify({
    id,
    title: "Legacy placeholder PDF",
    type: "pdf",
    createdAt: "2026-06-02T00:00:00.000Z",
    taskTitle: "Legacy placeholder PDF",
    runtimeProvider: "mastra",
    requestedFormat: "pdf",
    intentReason: "PDF export requested.",
    localPath: join(root, `${id}.pdf`),
    sourceMarkdownPath: join(root, `${id}.md`),
    pdfPath: join(root, `${id}.pdf`),
    metadataPath: join(root, `${id}.metadata.json`),
    userFacingName: "Legacy placeholder PDF",
  }, null, 2)}\n`, "utf8");
}
