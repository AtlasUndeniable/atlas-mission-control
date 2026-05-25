/**
 * Read-only contract validation tests for Atlas Workspace workflow records.
 * No fs, network, Slack, Monday, Typeform, Supabase, or Next runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAgentRun,
  validateArtifactCollection,
  validateApproval,
  validateAuditRun,
  validateContentBatch,
  validateMemoryMaintenanceRun,
  validateTrainingGroundsSession,
  validateWorkspaceArtifact,
  validateWorkspaceProject,
} from "../src/lib/workspace-contracts.ts";
import {
  workspaceArtifactControlFixtures,
  workspaceContractFixtures,
  workspaceTrainingGroundsFixtures,
} from "../src/lib/workspace-contract-fixtures.ts";

test("workspace contract fixtures validate", () => {
  for (const project of workspaceArtifactControlFixtures.projects) {
    const result = validateWorkspaceProject(project);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const collection of workspaceArtifactControlFixtures.collections) {
    const result = validateArtifactCollection(collection);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const artifact of workspaceArtifactControlFixtures.artifacts) {
    const result = validateWorkspaceArtifact(artifact);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const session of workspaceTrainingGroundsFixtures.sessions) {
    const result = validateTrainingGroundsSession(session);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const run of workspaceContractFixtures.agentRuns) {
    const result = validateAgentRun(run);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const run of workspaceContractFixtures.auditRuns) {
    const result = validateAuditRun(run);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const batch of workspaceContractFixtures.contentBatches) {
    const result = validateContentBatch(batch);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const approval of workspaceContractFixtures.approvals) {
    const result = validateApproval(approval);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }

  for (const run of workspaceContractFixtures.memoryMaintenanceRuns) {
    const result = validateMemoryMaintenanceRun(run);
    assert.equal(result.ok, true, result.ok ? undefined : result.issues.join("\n"));
  }
});

test("workspace artifact model rejects unsafe file-control shapes", () => {
  const invalid = {
    ...workspaceArtifactControlFixtures.artifacts[0],
    artifactId: "",
    status: "moved",
    filePaths: [123],
    sensitivity: "internet_public",
    naming: { canonicalName: "" },
  };

  const result = validateWorkspaceArtifact(invalid);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /WorkspaceArtifact\.artifactId/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /WorkspaceArtifact\.status/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /WorkspaceArtifact\.filePaths\.0/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /WorkspaceArtifact\.sensitivity/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /WorkspaceArtifact\.naming\.canonicalName/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /WorkspaceArtifact\.naming\.suggestedFolder/);
});

test("training grounds validation blocks automatic memory changes", () => {
  const invalid = {
    ...workspaceTrainingGroundsFixtures.sessions[0],
    status: "auto_saved",
    guardrails: {
      ...workspaceTrainingGroundsFixtures.sessions[0].guardrails,
      automaticMemoryWrite: true,
      sourceContextVisible: false,
    },
    proposedMemoryUpdates: [
      {
        ...workspaceTrainingGroundsFixtures.sessions[0].proposedMemoryUpdates[1],
        requiresReview: false,
      },
    ],
  };

  const result = validateTrainingGroundsSession(invalid);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /TrainingGroundsSession\.status/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /automaticMemoryWrite/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /sourceContextVisible/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /proposedMemoryUpdates\.0\.requiresReview/);
});

test("agent run validation rejects unstable workflow records", () => {
  const invalid = {
    ...workspaceContractFixtures.agentRuns[0],
    id: "",
    workflow: "untracked_worker",
    status: "done",
    sourceRefs: [{ system: "manual" }],
    createdAt: "not-a-date",
  };

  const result = validateAgentRun(invalid);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /AgentRun\.id/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /AgentRun\.workflow/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /AgentRun\.status/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /AgentRun\.sourceRefs\.0\.ref/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /AgentRun\.createdAt/);
});

test("approval validation keeps approval records as exact read-model gates", () => {
  const invalid = {
    ...workspaceContractFixtures.approvals[0],
    actionType: "auto_send",
    workspaceStatus: "approved_by_model",
    relatedArtifactIds: [123],
  };

  const result = validateApproval(invalid);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /Approval\.actionType/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /Approval\.workspaceStatus/);
  assert.match(result.ok ? "" : result.issues.join("\n"), /Approval\.relatedArtifactIds\.0/);
});

test("content batch validation requires publishing to remain blocked", () => {
  const invalid = {
    ...workspaceContractFixtures.contentBatches[0],
    publishingBlocked: false,
  };

  const result = validateContentBatch(invalid);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /ContentBatch\.publishingBlocked/);
});

test("memory maintenance validation rejects unsafe count shapes", () => {
  const invalid = {
    ...workspaceContractFixtures.memoryMaintenanceRuns[0],
    counts: {
      ...workspaceContractFixtures.memoryMaintenanceRuns[0].counts,
      appliedChanges: "five",
    },
  };

  const result = validateMemoryMaintenanceRun(invalid);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join("\n"), /MemoryMaintenanceRun\.counts\.appliedChanges/);
});
