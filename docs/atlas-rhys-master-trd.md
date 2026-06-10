# Atlas Rhys Master TRD

Status: canonical technical requirements for the rest of the Atlas/Rhys build.
Date: 2026-06-10.
Audience: implementation agent with repo access.

This document turns the master PRD into an implementation plan. It assumes a strong coding model will execute the work, but it still requires small commits, source/runtime verification, and no broad dirty-batch deployment.

## Current Technical State

Canonical repo:

`/Users/atlasai/atlas-mission-control`

Live runtime/state:

`/Users/atlasai/.openclaw/workspace`

Current known source facts at time of writing:

- `main...origin/main` is ahead by 81 commits.
- Latest commit is `dde4fbe fix(security): remove Host-header auth bypass from middleware`.
- Recent foundation commits include:
  - `3cefde3 feat(workspace): add core job store foundation`
  - `c462651 fix(mission-control): prevent approval double sends`
  - `01e20c8 docs(atlas): define slack baseline and workspace requirements`
  - `ee13f07 fix(openclaw): render Jess CTA asset with branded workflow`
  - `f95fec8 feat(openclaw): add Jess CTA asset workflow`
  - `56f7f13 fix(openclaw): guard Rhys approval DM routing`
  - `d3720ae feat(openclaw): complete slack asset jobs`
- Slack runtime verify reports `allMatch=true`.
- Socket owner diagnostic reports `status=ok`, active owner `slack-listener`.
- Dirty work remains and must be split before deployment:
  - dashboard/audio/UI design files
  - ask/briefing/overview APIs
  - redraft UI/API
  - Rhys task/follow-up routes
  - Pat/Reaper/meeting-prep routes
  - package/package-lock/tsconfig/middleware-related files
  - ATLAS UI Soul and design sprint docs

## Architecture Target

Atlas should converge on one lifecycle model:

request -> Core job -> workflow adapter -> artifact/version -> approval if needed -> delivery request -> delivery receipt -> delivered.

Core responsibilities:

- Slack listener creates or mirrors Core jobs.
- Workspace reads and manages Core jobs.
- Workflow adapters build or retrieve artifacts.
- Artifact store records source, validation, and versions.
- Approval lane records drafts, redrafts, decisions, and send history.
- Delivery service records external receipts.
- Supabase eventually persists the same model, but local JSON remains the fallback.

## Existing Modules To Preserve

Slack runtime:

- `openclaw-runtime/workspace/services/slack-listener/listener.mjs`
- `openclaw-runtime/workspace/lib/slack-dm-jobs.mjs`
- `openclaw-runtime/workspace/lib/slack-listener-reply.mjs`
- `openclaw-runtime/workspace/lib/slack-asset-workflows.mjs`
- `openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.mjs`
- `openclaw-runtime/workspace/lib/artifact-delivery.mjs`
- `openclaw-runtime/workspace/lib/slack-gates.mjs`

Workspace foundations:

- `src/lib/atlas-core-jobs.ts`
- `src/lib/atlas-agent-core-local-store.ts`
- `src/lib/workspace-local-jobs.ts`
- `src/lib/workspace-draft-artifacts.ts`
- `src/lib/workspace-real-artifact-workflow.ts`
- `src/lib/workspace-event-log.ts`

Approval foundations:

- `src/lib/approval-claim.ts`
- `src/lib/queue-writer.ts`
- `src/app/api/approvals/route.ts`
- `src/app/api/approvals/[id]/route.ts`

Do not replace these foundations. Extend or bridge them.

## Required Data Model

### Core Job

Use `src/lib/atlas-core-jobs.ts` as the source of truth for the local Core job envelope.

Required semantics:

- `source.type` is `slack`, `workspace`, or `operator`.
- `projectId` scopes the job.
- `workflow` is optional until selected.
- `artifactIds`, `deliveryIds`, and `approvalIds` are references, not raw UI state.
- `safeErrorSummary` is the only error field intended for user/operator display.
- `delivered` cannot be reached through a normal status transition.
- `recordAtlasCoreDeliveryReceipt()` is the only delivery completion path.

### Artifact

Artifacts must represent a versioned deliverable.

Minimum fields:

- project id
- job id
- title
- kind
- paths
- source paths
- validation status/checks
- version
- created time

Rules:

- Preview/download APIs should use artifact id, not arbitrary raw paths.
- Source paths are internal by default.
- New revisions create new versions.
- Delivery references an artifact id and version.

### Delivery

Delivery is an external receipt.

Rules:

- Slack delivery requires `channelId` plus `fileId` or `messageTs`.
- Workspace review delivery can be recorded as a review destination, but it must not be called external Slack delivery.
- A job may not be marked delivered from an acknowledgement, queued state, local file existence, or artifact validation alone.

### Approval

Approvals must represent the human review loop.

Rules:

- Approve and deny must be race-safe.
- Redraft feedback must be stored.
- Send history must be recorded.
- Wrong destination sends must be blocked.
- `send_failed` is visible and not automatically resendable.

## Implementation Order

### Phase 1: Mirror Slack Jobs Into Core Jobs

Goal:

Every Slack asset job should have a Core job counterpart so Workspace can show the same lifecycle.

Implementation:

- Add a bridge module that maps Slack DM ledger records to Core jobs.
- Prefer idempotent upsert semantics keyed by Slack `assetJobId` or source channel/timestamp.
- On Slack job creation, create a Core job with `source.type="slack"`.
- On Slack status transitions, append Core job status events.
- On artifact ready, record Core artifact metadata.
- On Slack delivery receipt, record Core delivery receipt.
- On blocked/failed, record `safeErrorSummary`.

Acceptance:

- Existing Slack tests continue to pass.
- New tests prove a Slack job mirrors to Core job states.
- Re-running the mirror does not duplicate jobs/artifacts/deliveries.
- Delivered remains impossible without receipt.

### Phase 2: Workspace Core Job APIs

Goal:

Workspace can list and inspect Core jobs.

Implementation:

- Add API routes for Core job projection:
  - list jobs by project/status/source
  - read job detail by id
  - include referenced artifacts, approvals, deliveries, and events
- Keep raw paths and internal payloads out of default Rhys-facing response.
- Add operator detail mode only if already authenticated/authorised.

Acceptance:

- API returns empty projection when no Core events exist.
- API returns Slack-created jobs after mirror.
- API filters by project.
- API response includes delivery receipt for delivered jobs.

### Phase 3: Workspace UI Job Lane

Goal:

Workspace shows durable work instead of only chat/session fragments.

Implementation:

- Add project lane job list using Core job APIs.
- Add job detail panel with status, request, source, workflow, artifacts, approvals, deliveries, and blockers.
- Add status chips that use human copy, not internal state names.
- Add source chips and receipt chips.
- Add empty/loading/error states that are honest and polished.

Acceptance:

- Operator can find a Slack-created Jess CTA or First $10K job in Workspace.
- Blocked jobs show safe reason.
- Delivered jobs show receipt.
- Rhys-facing view does not expose local paths or raw event payloads.

### Phase 4: Artifact Version Store And Preview

Goal:

Artifacts become durable, versioned workspace objects.

Implementation:

- Add artifact projection over Core artifacts and existing workspace artifact records.
- Add preview/download by artifact id.
- Record validation checks in UI.
- Support version history and current version selection.
- Do not expose source paths in Rhys-facing UI by default.

Acceptance:

- PDF/DOCX artifacts validate before display as delivered outputs.
- Version history is visible.
- Artifact download cannot escape approved roots.
- Generic/unsupported artifact requests block instead of generating fake docs.

### Phase 5: Approval And Redraft Lane

Goal:

Mission Control and Workspace share an approval model.

Implementation:

- Project approval queue records into Core approvals.
- Preserve `approval-claim` race safety.
- Add redraft feedback storage.
- Add send result/failed result storage.
- Connect wrong-destination guards to approval send actions.

Acceptance:

- Concurrent approval attempts produce exactly one send.
- Failed sends become visible `send_failed`.
- Redraft feedback persists.
- Approval history appears on related job/artifact.

### Phase 6: Verified Workflow Adapter Registry

Goal:

Add new capabilities without reintroducing fake outputs.

Implementation:

- Define adapter contract with:
  - matcher
  - workflow key/id
  - source retrieval policy
  - builder/retriever
  - validator
  - delivery policy
  - test coverage
- Migrate First $10K and Jess CTA as canonical examples.
- Add adapters in this order:
  1. Pat Slack response drafts
  2. call follow-up task drafts
  3. Corey content workflow
  4. branded client asset packs
  5. client source packet summaries

Acceptance:

- Known workflow happy path passes.
- Unknown workflow blocks honestly.
- Validation failure blocks delivery.
- Delivery receipt is required for external delivered state.

### Phase 7: Supabase Persistence Adapter

Goal:

Move from local JSON to shared persistence only after local behavior is stable.

Implementation:

- Keep local JSON as fallback.
- Map Core job events to Supabase tables or event log.
- Preserve event/projection semantics.
- Add migration tests and RLS/access tests before team rollout.

Acceptance:

- Supabase outage does not destroy local operator workflow.
- Local and Supabase projections agree for mirrored test data.
- Access controls are explicit and tested.

## UI And Design Requirements

Workspace design follows docs/design/atlas-workspace-design-pass.md (approved): chat-first Manus-style. Conversation as the main canvas, composer as front door, sidebar = projects/tasks, collapsible task chips, inline artifact cards, status as iconography not pills, restrained dark palette. The design sprint plan and ATLAS UI Soul are visual source material ONLY for the Mission Control dashboard, never the Workspace. Do not let visual work on either surface bypass product safety.

Required UI principles:

- Workspace: chat-first canvas per the design pass; no status pills, no dashboard cards.
- Mission Control dashboard: command-centre feel with dense useful information.
- No fake dashboard numbers.
- "Connecting" states for missing integrations.
- Visible job/run progress.
- Polished empty/error/loading states.
- Responsive layouts with no overlap or clipped text.
- Rhys-facing surfaces hide internals.
- Operator surfaces can expose diagnostics deliberately.

Dirty design sprint files must be split by feature:

1. Pure visual system and component polish.
2. Boot/audio changes.
3. Dashboard data/API changes.
4. Approval/redraft UI.
5. New Pat/Reaper/meeting-prep/Rhys task lanes.

Do not commit these as one broad batch.

## Safety And Deployment Gates

Before any Slack runtime change:

```bash
node scripts/deploy-openclaw-slack-runtime.mjs --verify
node scripts/check-openclaw-slack-socket-owner.mjs
```

Before any deploy/restart:

- Confirm intended files changed.
- Run scoped tests.
- Run `npx tsc --noEmit --pretty false`.
- Run `npm run build` for Mission Control changes.
- Confirm no unrelated dirty files are staged.
- Do not push without Dante approval.

For Slack runtime deploys:

- Use deploy script with verify.
- Restart only the required LaunchAgent.
- Re-run parity and socket owner checks.

For docs-only commits:

- Run `git diff --check`.
- Stage only docs.
- Do not deploy/restart.

## Test Matrix

Required tests by subsystem:

- Core job store:
  - empty projection
  - create Slack-sourced job
  - lifecycle to artifact ready
  - delivered requires delivery receipt
  - blocked preserves safe reason
  - approvals link to jobs
- Slack mirror:
  - initial asset request mirrors to Core
  - artifact-ready mirrors once
  - delivery receipt mirrors once
  - blocked/failed mirrors safe reason
  - idempotent re-run
- Artifact lane:
  - PDF/DOCX validation
  - path root guard
  - version history
  - preview/download by id
- Approval lane:
  - exactly one send under concurrent approve
  - deny does not race in-flight approve
  - redraft feedback persists
  - wrong destination blocked
- UI:
  - no internal ids/paths in Rhys-facing Slack copy
  - job lane renders queued/building/blocked/delivered
  - artifact card renders validation/version/receipt
  - mobile and desktop screenshots show no overlap

## Dirty Batch Policy

The Mac repo is intentionally ahead and dirty. Do not clean it by reverting user work. Do not commit the whole dirty tree.

Each future commit must be one coherent slice:

- one subsystem
- known intent
- tests or explicit verification
- no unrelated style churn
- no broad deploy unless requested

Security-sensitive changes such as middleware/auth, host binding, and package/package-lock updates require dedicated review and tests.

## Definition Of Done

The rest-of-build implementation is done when:

- Slack creates or attaches to Core jobs for long-running work.
- Workspace shows the same job lifecycle with project context.
- Artifacts are versioned, validated, previewable, and deliverable by id.
- Approvals/redrafts are durable and race-safe.
- Verified adapters cover the first team lanes.
- Unsupported requests block honestly.
- Source/live parity and socket ownership remain green.
- Rhys can use Atlas without technical bloat or manual recovery.
- Dante can audit every job, artifact, approval, and delivery receipt.
