/**
 * Atlas Agent Core V0 interface tests.
 * These tests assert safety/shape only; they do not execute tools, send Slack,
 * mutate external systems, or wire production persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_AGENT_CORE_V0_LOOP,
  isAtlasAgentCoreLoopPhase,
  validateAtlasAgentToolDispatchRequest,
  type AtlasAgentToolDispatchRequest,
} from "../src/lib/atlas-agent-core.ts";

const readOnlyDispatch: AtlasAgentToolDispatchRequest = {
  runId: "run_123",
  toolName: "search_memory",
  input: { query: "Ricky Calder" },
  safety: "read_only",
  dryRun: false,
};

test("Agent Core loop phases match the target architecture", () => {
  assert.deepEqual(ATLAS_AGENT_CORE_V0_LOOP, [
    "observe",
    "plan",
    "decide",
    "act",
    "reflect",
    "compress",
    "emit",
    "persist",
  ]);
  assert.equal(isAtlasAgentCoreLoopPhase("observe"), true);
  assert.equal(isAtlasAgentCoreLoopPhase("send_slack"), false);
});

test("read-only dispatch is valid for V0", () => {
  assert.deepEqual(validateAtlasAgentToolDispatchRequest(readOnlyDispatch), { ok: true, issues: [] });
});

test("non-read dispatch must be dry-run or explicitly approval-scoped", () => {
  const result = validateAtlasAgentToolDispatchRequest({
    ...readOnlyDispatch,
    safety: "approval_required",
    dryRun: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /approvalId/);
  assert.match(result.issues.join(" "), /read_only or dry_run/);
});

test("blocked dispatch cannot run", () => {
  const result = validateAtlasAgentToolDispatchRequest({
    ...readOnlyDispatch,
    safety: "blocked",
    dryRun: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /blocked tools/);
});
