import { test } from "node:test";
import assert from "node:assert/strict";

import {
  critiqueWorkspaceAnalyticalAnswer,
  isWorkspaceAnalyticalMemoryQuestion,
  runWorkspaceAnalyticalQa,
} from "../src/lib/workspace-agentic-qa.ts";
import { buildWorkspaceRuntimeContext } from "../src/lib/workspace-runtime-context.ts";
import type { WorkspaceReferencePacket } from "../src/lib/workspace-reference-resolver.ts";

function matchedRuntimeContext() {
  const referencePacket: WorkspaceReferencePacket = {
    resolvedAt: "2026-06-07T00:00:00.000Z",
    coverage: "matched",
    rootsRead: [],
    references: [{
      handle: "saad-rhys",
      title: "Saad x Rhys",
      sourceType: "call-transcript",
      sourcePath: "/Users/atlasai/.openclaw/workspace/calls/saad-rhys.md",
      pathSummary: "calls/saad-rhys.md",
      excerpt: "Client acquisition model discussion.",
      confidence: "high",
      score: 24,
      matchedTerms: ["clients", "model"],
    }],
    guidance: ["Use labels for source-backed claims."],
    userFacingSummary: "1 Workspace reference resolved.",
    internalSummary: "references=1; coverage=matched",
  };
  return buildWorkspaceRuntimeContext({
    prompt: "40 clients x $250/week is not $10k/month. With available knowledge, what is the real model?",
    title: "Real model analysis",
  }, {
    provider: "mock",
    referencePacket,
    agentTools: [],
  });
}

test("analytical memory prompt is eligible for agentic QA", () => {
  assert.equal(isWorkspaceAnalyticalMemoryQuestion("With available knowledge, what is the real model?"), true);
  assert.equal(isWorkspaceAnalyticalMemoryQuestion("Create a short heading."), false);
});

test("critic catches missing answer shape and source labels", () => {
  const critique = critiqueWorkspaceAnalyticalAnswer({
    prompt: "With available knowledge, what is the real model?",
    draftText: "The model is obvious from the calls.",
    runtimeContext: matchedRuntimeContext(),
  });

  assert.equal(critique.passed, false);
  assert.ok(critique.issues.some((issue) => issue.code === "missing_answer_shape"));
  assert.ok(critique.issues.some((issue) => issue.code === "missing_source_labels"));
});

test("critic prevents local path leaks and unnecessary follow-up", () => {
  const critique = critiqueWorkspaceAnalyticalAnswer({
    prompt: "Use call logs and playbooks to explain the model.",
    draftText: [
      "## What I checked",
      "I checked /Users/atlasai/.openclaw/workspace/calls/private.md.",
      "## What I found",
      "Do you want me to dig into the transcripts?",
      "## Confidence / coverage",
      "Medium.",
      "## What I would check next",
      "Pull excerpts.",
    ].join("\n"),
    runtimeContext: matchedRuntimeContext(),
  });

  assert.ok(critique.issues.some((issue) => issue.code === "local_path_leak"));
  assert.ok(critique.issues.some((issue) => issue.code === "unnecessary_followup"));
});

test("critic revises math inconsistency into a sourced final answer", () => {
  const result = runWorkspaceAnalyticalQa({
    prompt: "40 clients x $250/week is not $10k/month. With available knowledge, what is the real model?",
    draftText: [
      "40 clients x $250/week is $10k/month.",
      "Do you want me to dig into calls?",
      "/Users/atlasai/private.md",
    ].join("\n"),
    runtimeContext: matchedRuntimeContext(),
  });

  assert.equal(result.passed, true);
  assert.equal(result.revised, true);
  assert.ok(result.initialIssues.some((issue) => issue.code === "number_inconsistency"));
  assert.match(result.finalText, /40 clients x \$250\/week = \$10,000\/week/);
  assert.match(result.finalText, /\[call-transcript: Saad x Rhys\]/);
  assert.doesNotMatch(result.finalText, /\/Users\/atlasai|do you want me to dig/i);
});

test("critic requires corrected weekly math for 40 client model prompts", () => {
  const result = runWorkspaceAnalyticalQa({
    prompt: "40 clients x $250/week is not $10k/month. With available knowledge, what is the real model?",
    draftText: [
      "## What I checked",
      "Sources: [call-transcript: Saad x Rhys]",
      "## What I found",
      "The available calls discuss advertising budget, but not the real model.",
      "## Confidence / coverage",
      "Medium.",
      "## What I would check next",
      "Check pricing calls.",
    ].join("\n"),
    runtimeContext: matchedRuntimeContext(),
  });

  assert.equal(result.revised, true);
  assert.ok(result.initialIssues.some((issue) => issue.code === "number_inconsistency"));
  assert.match(result.finalText, /\$10,000\/week/);
});
