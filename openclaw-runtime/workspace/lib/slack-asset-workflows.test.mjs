import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildJessEndureAdCtaPlaybook,
  executeSlackAssetWorkflow,
  findSlackAssetWorkflowForRequest,
  validateSlackAssetFile,
} from "./slack-asset-workflows.mjs";

function tempArtifacts() {
  const dir = mkdtempSync(join(tmpdir(), "slack-asset-workflow-test-"));
  const pdf = join(dir, "first-10k.pdf");
  const docx = join(dir, "first-10k.docx");
  writeFileSync(pdf, Buffer.from("%PDF-1.7\nfixture pdf\n"));
  writeFileSync(docx, Buffer.from("PK\x03\x04fixture docx\n"));
  return {
    dir,
    pdf,
    docx,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("Jess Endure CTA playbook prompt selects the verified generated workflow", () => {
  const prompt = [
    "Atlas, create a branded Undeniable Ad CTA + DM Follow-Up Playbook for Jess Endure Mentoring.",
    "Use recent Jessica De Bortoli / Jess Endure Mentoring Slack or call memory if available.",
    "Return it here as a branded PDF.",
  ].join(" ");

  const selected = findSlackAssetWorkflowForRequest(prompt);
  assert.equal(selected.key, "jess-endure-ad-cta-dm-follow-up");
  assert.equal(selected.adapter, "generated-source-package");
  assert.equal(selected.workflowId, "atlas-undeniable-doc-converter");
});

test("known workflow adapter retrieves and validates an existing artifact package", async () => {
  const t = tempArtifacts();
  try {
    const workflow = {
      key: "fixture-first-10k",
      workflowId: "atlas-undeniable-doc-converter",
      adapter: "existing-export-package",
      title: "Fixture First 10K",
      message: "Done. I attached the verified file here.",
      artifactPath: t.pdf,
      artifactPaths: [t.pdf, t.docx],
      sourcePaths: [join(t.dir, "source.md")],
      match: (text) => /first 10k/i.test(text),
    };

    const selected = findSlackAssetWorkflowForRequest("please make the first 10k pdf", [workflow]);
    assert.equal(selected.key, "fixture-first-10k");

    const result = await executeSlackAssetWorkflow({
      text: "please make the first 10k pdf",
      workflows: [workflow],
      allowedRoots: [t.dir],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "artifact_ready");
    assert.equal(result.workflowId, "atlas-undeniable-doc-converter");
    assert.equal(result.adapter, "existing-export-package");
    assert.equal(result.artifactPath, t.pdf);
    assert.deepEqual(result.artifactPaths, [t.pdf, t.docx]);
    assert.equal(result.reusedExistingArtifact, true);
  } finally {
    t.cleanup();
  }
});

test("generated workflow adapter builds and validates an artifact package before delivery", async () => {
  const t = tempArtifacts();
  try {
    const html = join(t.dir, "jess-playbook.html");
    const source = join(t.dir, "jess-playbook.md");
    const workflow = {
      key: "fixture-generated-jess-playbook",
      workflowId: "atlas-undeniable-doc-converter",
      adapter: "generated-source-package",
      title: "Fixture Jess CTA Playbook",
      message: "Done. I attached the verified generated file here.",
      match: (text) => /jess/i.test(text),
      async build() {
        writeFileSync(source, "# Fixture Jess playbook\n", "utf8");
        writeFileSync(t.pdf, Buffer.from("%PDF-1.7\nfixture pdf\n"));
        writeFileSync(t.docx, Buffer.from("PK\x03\x04fixture docx\n"));
        writeFileSync(html, "<html><body>fixture</body></html>", "utf8");
        return {
          artifactPath: t.pdf,
          artifactPaths: [t.pdf, t.docx, html],
          sourcePaths: [source],
        };
      },
    };

    const result = await executeSlackAssetWorkflow({
      text: "make Jess Endure a CTA playbook PDF",
      workflows: [workflow],
      allowedRoots: [t.dir],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "artifact_ready");
    assert.equal(result.workflowKey, "fixture-generated-jess-playbook");
    assert.equal(result.adapter, "generated-source-package");
    assert.equal(result.artifactPath, t.pdf);
    assert.deepEqual(result.artifactPaths, [t.pdf, t.docx, html]);
    assert.deepEqual(result.sourcePaths, [source]);
    assert.equal(result.reusedExistingArtifact, false);
  } finally {
    t.cleanup();
  }
});

test("Jess Endure builder writes source markdown and invokes the Atlas converter package", async () => {
  const t = tempArtifacts();
  try {
    const calls = [];
    const result = await buildJessEndureAdCtaPlaybook({
      workflow: { title: "Fixture Jess CTA Playbook" },
      exportsRoot: t.dir,
      converterScript: "/tmp/fake-convert.sh",
      runConverter: async ({ sourcePath, outputFilename, title }) => {
        calls.push({ sourcePath, outputFilename, title });
        const out = join(t.dir, outputFilename);
        if (outputFilename.endsWith(".pdf")) writeFileSync(out, Buffer.from("%PDF-1.7\nfixture pdf\n"));
        if (outputFilename.endsWith(".docx")) writeFileSync(out, Buffer.from("PK\x03\x04fixture docx\n"));
        if (outputFilename.endsWith(".html")) writeFileSync(out, "<html><body>fixture</body></html>", "utf8");
      },
    });

    assert.equal(result.artifactPath, join(t.dir, "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.pdf"));
    assert.deepEqual(result.artifactPaths, [
      join(t.dir, "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.pdf"),
      join(t.dir, "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.docx"),
      join(t.dir, "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.html"),
    ]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.outputFilename), [
      "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.pdf",
      "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.docx",
      "2026-06-09-jess-endure-ad-cta-dm-follow-up-playbook-branded.html",
    ]);
    assert.equal(calls[0].title, "Fixture Jess CTA Playbook");
    assert.match(result.sourcePaths[0], /jess-endure-ad-cta-dm-follow-up-playbook-branded\.md$/);
  } finally {
    t.cleanup();
  }
});

test("unknown workflow blocks honestly instead of creating a fake asset", async () => {
  const result = await executeSlackAssetWorkflow({
    text: "make a branded PDF for a completely unknown offer",
    workflows: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.match(result.safeErrorSummary, /No verified Slack asset workflow/);
  assert.match(result.userMessage, /will not invent a generic PDF/);
});

test("workflow validation rejects invalid files before delivery", async () => {
  const t = tempArtifacts();
  try {
    const badPdf = join(t.dir, "bad.pdf");
    writeFileSync(badPdf, Buffer.from("not a pdf"));
    assert.throws(() => validateSlackAssetFile(badPdf, { allowedRoots: [t.dir] }), /PDF artifact failed header validation/);

    const result = await executeSlackAssetWorkflow({
      text: "first 10k",
      workflows: [{
        key: "bad-package",
        workflowId: "atlas-undeniable-doc-converter",
        adapter: "existing-export-package",
        artifactPath: badPdf,
        artifactPaths: [badPdf],
        match: () => true,
      }],
      allowedRoots: [t.dir],
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.match(result.safeErrorSummary, /failed validation/);
  } finally {
    t.cleanup();
  }
});
