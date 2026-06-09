import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
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
