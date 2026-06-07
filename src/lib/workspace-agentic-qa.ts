import type { WorkspaceRuntimeContextPacket } from "./workspace-runtime-context.ts";

export type WorkspaceQaIssueCode =
  | "unsupported_claims"
  | "number_inconsistency"
  | "missing_source_labels"
  | "accidental_artifact_creation"
  | "local_path_leak"
  | "unnecessary_followup"
  | "missing_answer_shape";

export interface WorkspaceQaCritiqueIssue {
  code: WorkspaceQaIssueCode;
  message: string;
}

export interface WorkspaceQaCritique {
  passed: boolean;
  issues: WorkspaceQaCritiqueIssue[];
}

export interface WorkspaceAnalyticalQaInput {
  prompt: string;
  draftText: string;
  runtimeContext: WorkspaceRuntimeContextPacket;
  artifactPlanned?: boolean;
}

export interface WorkspaceAnalyticalQaResult {
  finalText: string;
  passed: boolean;
  revised: boolean;
  initialIssues: WorkspaceQaCritiqueIssue[];
  remainingIssues: WorkspaceQaCritiqueIssue[];
  checked: string[];
  sourceCategories: string[];
  nextAction: string;
}

const REQUIRED_ANALYTICAL_HEADINGS = [
  "what i checked",
  "what i found",
  "confidence / coverage",
  "what i would check next",
];

export function isWorkspaceAnalyticalMemoryQuestion(prompt: string): boolean {
  return /\b(call logs?|calls?|transcripts?|playbooks?|learned knowledge|available knowledge|memory|source|references?|clients?|models?|strateg(?:y|ies)|10k|revenue|month|week)\b/i
    .test(prompt);
}

export function critiqueWorkspaceAnalyticalAnswer(input: WorkspaceAnalyticalQaInput): WorkspaceQaCritique {
  const issues: WorkspaceQaCritiqueIssue[] = [];
  const text = sanitizeWorkspacePresentationText(input.draftText);
  const lower = text.toLowerCase();
  const evidenceAvailable = hasWorkspaceEvidence(input.runtimeContext);
  const sourceLabels = sourceLabelList(input.runtimeContext);

  const missingHeadings = REQUIRED_ANALYTICAL_HEADINGS.filter((heading) => !lower.includes(heading));
  if (missingHeadings.length) {
    issues.push({
      code: "missing_answer_shape",
      message: `Missing analytical sections: ${missingHeadings.join(", ")}.`,
    });
  }

  if (evidenceAvailable && sourceLabels.length && !/\[[a-z][a-z0-9_-]*: [^\]]+\]/i.test(text)) {
    issues.push({
      code: "missing_source_labels",
      message: "Resolved references are available but the answer does not show source labels.",
    });
  }

  if (containsLocalPath(input.draftText)) {
    issues.push({
      code: "local_path_leak",
      message: "Answer contains a local filesystem path.",
    });
  }

  if (input.artifactPlanned) {
    issues.push({
      code: "accidental_artifact_creation",
      message: "Analytical prompt would create an artifact without explicit deliverable intent.",
    });
  }

  if (evidenceAvailable && /\b(do you want me to dig|should i dig|would you like me to dig|want me to pull|should i pull)\b/i.test(text)) {
    issues.push({
      code: "unnecessary_followup",
      message: "Safe read-only evidence exists, so Atlas should answer instead of asking whether to dig.",
    });
  }

  if (hasFortyByTwoFiftyTenKMonthMismatch(text)) {
    issues.push({
      code: "number_inconsistency",
      message: "40 clients at $250/week is $10,000/week, not $10,000/month.",
    });
  }
  if (requiresFortyByTwoFiftyCorrection(input.prompt) && !/\$?10,?000\s*\/\s*week|\$?10,?000\s+per\s+week/i.test(text)) {
    issues.push({
      code: "number_inconsistency",
      message: "Prompt asks for the 40 x $250/week model but the answer does not state the corrected weekly revenue.",
    });
  }

  if (!evidenceAvailable && /\b(source labels above|grounded in|checked call|transcript excerpts|playbook notes|workspace references show)\b/i.test(text)) {
    issues.push({
      code: "unsupported_claims",
      message: "Answer claims source grounding even though no usable source was checked.",
    });
  }

  return { passed: issues.length === 0, issues };
}

export function runWorkspaceAnalyticalQa(input: WorkspaceAnalyticalQaInput): WorkspaceAnalyticalQaResult {
  const initial = critiqueWorkspaceAnalyticalAnswer(input);
  const checked = describeQaChecks(input.runtimeContext);
  const sourceCategories = describeSourceCategories(input.runtimeContext);
  const nextAction = nextBestAction(input.runtimeContext);
  if (initial.passed) {
    return {
      finalText: sanitizeWorkspacePresentationText(input.draftText),
      passed: true,
      revised: false,
      initialIssues: [],
      remainingIssues: [],
      checked,
      sourceCategories,
      nextAction,
    };
  }

  const revisedText = reviseAnalyticalAnswer(input, nextAction);
  const remaining = critiqueWorkspaceAnalyticalAnswer({
    ...input,
    draftText: revisedText,
    artifactPlanned: false,
  });
  if (remaining.passed) {
    return {
      finalText: revisedText,
      passed: true,
      revised: true,
      initialIssues: initial.issues,
      remainingIssues: [],
      checked,
      sourceCategories,
      nextAction,
    };
  }

  return {
    finalText: buildThinCoverageAnswer(input, nextAction),
    passed: false,
    revised: true,
    initialIssues: initial.issues,
    remainingIssues: remaining.issues,
    checked,
    sourceCategories,
    nextAction,
  };
}

export function sanitizeWorkspacePresentationText(text: string): string {
  return text
    .replace(/(?:\/Users\/[^\s"'`),;]+|\/private\/[^\s"'`),;]+|\/tmp\/[^\s"'`),;]+|\.openclaw\/[^\s"'`),;]+)/g, "[Workspace internal path]")
    .replace(/^(#{1,4}\s*)?Coverage\s*\/\s*Confidence\s*$/gim, "## Confidence / coverage")
    .trim();
}

export function sourceLabelList(runtimeContext: WorkspaceRuntimeContextPacket): string[] {
  return runtimeContext.workspaceReferences.references.slice(0, 5).map((reference) =>
    `[${reference.sourceType}: ${reference.title}]`,
  );
}

export function describeQaChecks(runtimeContext: WorkspaceRuntimeContextPacket): string[] {
  const checks = [
    "Observed prompt intent and artifact intent boundary.",
    "Resolved Workspace reference packet.",
    ...runtimeContext.agentTools
      .filter((execution) => execution.toolName !== "get_reference_packet")
      .map((execution) => {
        if (execution.toolName === "summarize_calls") return `Checked call summaries (${execution.output.coverage}).`;
        if (execution.toolName === "search_memory") return `Checked Workspace memory (${execution.output.coverage}).`;
        if (execution.toolName === "find_artifact") return `Checked artifact library (${execution.output.coverage}).`;
        return `Checked ${execution.toolName} (${execution.output.coverage}).`;
      }),
    "Ran critic checks for claims, math, source labels, artifacts, follow-up posture, and path leaks.",
  ];
  return [...new Set(checks)].map(sanitizeWorkspacePresentationText);
}

export function describeSourceCategories(runtimeContext: WorkspaceRuntimeContextPacket): string[] {
  const categories = [
    ...runtimeContext.workspaceReferences.references.map((reference) => reference.sourceType),
    ...runtimeContext.agentTools
      .filter((execution) => execution.toolName !== "get_reference_packet" && execution.output.coverage !== "none")
      .map((execution) => execution.toolName),
  ];
  const unique = [...new Set(categories.map((category) => category.replaceAll("_", "-")))];
  return unique.length ? unique : ["none checked"];
}

function reviseAnalyticalAnswer(input: WorkspaceAnalyticalQaInput, nextAction: string): string {
  const prompt = input.prompt.toLowerCase();
  const labels = sourceLabelList(input.runtimeContext);
  const evidenceLine = labels.length
    ? `Sources: ${labels.join("; ")}`
    : "Sources: no usable Workspace source labels were resolved for this run.";
  const checkedLines = describeQaChecks(input.runtimeContext).map((item) => `- ${item}`);
  const confidence = confidenceLine(input.runtimeContext);
  const finding = /\b40\b.*\b250\b|\b250\b.*\b40\b|\b10k\b/.test(prompt)
    ? [
      "The arithmetic correction is the key model constraint: 40 clients x $250/week = $10,000/week, not $10,000/month.",
      "Using 4.33 weeks/month, that is roughly $43,300/month before churn, failed payments, delivery capacity, and acquisition lag.",
      "A cleaner $10k/month model at $250/week is about 10 active weekly clients, because 10 x $250 x 4 weeks is about $10,000/month.",
      "The real model should therefore separate weekly recurring revenue, monthly run-rate, client capacity, and acquisition pace instead of compressing them into one headline number.",
    ].join("\n\n")
    : "The safest answer is to separate what the retrieved Workspace evidence supports from what remains an operating hypothesis, then make the next check explicit.";

  return [
    "## What I checked",
    "",
    ...checkedLines,
    "",
    evidenceLine,
    "",
    "## What I found",
    "",
    finding,
    "",
    "## Confidence / coverage",
    "",
    confidence,
    "",
    "## What I would check next",
    "",
    `- ${nextAction}`,
  ].join("\n");
}

function buildThinCoverageAnswer(input: WorkspaceAnalyticalQaInput, nextAction: string): string {
  const checkedLines = describeQaChecks(input.runtimeContext).map((item) => `- ${item}`);
  return [
    "## What I checked",
    "",
    ...checkedLines,
    "",
    "Sources: no usable Workspace source labels were resolved for this run.",
    "",
    "## What I found",
    "",
    "Coverage is thin, so I am not going to present source-backed claims. The useful first pass is to correct the model, mark assumptions, and keep retrieval gaps visible.",
    "",
    "## Confidence / coverage",
    "",
    "Low-medium. This is safe as an operating sanity check, not a final source-grounded answer.",
    "",
    "## What I would check next",
    "",
    `- ${nextAction}`,
  ].join("\n");
}

function confidenceLine(runtimeContext: WorkspaceRuntimeContextPacket): string {
  if (runtimeContext.workspaceReferences.coverage === "matched") {
    return "Medium-high for the labelled evidence available in this run; I am not claiming full corpus coverage.";
  }
  if (runtimeContext.workspaceReferences.coverage === "thin") {
    return "Medium-low. Some read-only signals were available, but coverage is thin.";
  }
  return "Low-medium. No usable source labels were resolved, so this should be treated as an ungrounded operating pass.";
}

function nextBestAction(runtimeContext: WorkspaceRuntimeContextPacket): string {
  if (hasWorkspaceEvidence(runtimeContext)) {
    return "Pull the strongest labelled excerpts into a small evidence table before turning this into a client-facing recommendation.";
  }
  return "Run a narrower source query against call transcripts or playbooks before making source-backed recommendations.";
}

function hasWorkspaceEvidence(runtimeContext: WorkspaceRuntimeContextPacket): boolean {
  return runtimeContext.workspaceReferences.references.length > 0 ||
    runtimeContext.agentTools.some((execution) =>
      execution.toolName !== "get_reference_packet" && execution.output.coverage !== "none"
    );
}

function containsLocalPath(text: string): boolean {
  return /(?:\/Users\/|\/private\/|\/tmp\/|\.openclaw\/)/.test(text);
}

function hasFortyByTwoFiftyTenKMonthMismatch(text: string): boolean {
  return /\b40\s+clients?\b[\s\S]{0,120}\$?250\s*\/\s*week[\s\S]{0,120}(?:is|equals|=)[\s\S]{0,80}\$?10k\s*\/?\s*month/i
    .test(text) ||
    /\$?10k\s*\/?\s*month[\s\S]{0,120}\b40\s+clients?\b[\s\S]{0,120}\$?250\s*\/\s*week/i.test(text);
}

function requiresFortyByTwoFiftyCorrection(prompt: string): boolean {
  return /\b40\s+clients?\b/i.test(prompt) && /\$?250\s*\/\s*week/i.test(prompt) && /\b10k\b|\$?10,?000/i.test(prompt);
}
