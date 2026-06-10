# Atlas Rhys Master PRD

Status: canonical product requirements for the rest of the Atlas/Rhys build.
Date: 2026-06-10.
Audience: implementation agent, Dante/operator, and future Atlas product reviewers.

This document supersedes the narrower Slack-baseline PRD as the product north star. The Slack-baseline docs remain source material for the proven intake/status/delivery spine.

## Canon Map

This document is the canonical implementation requirements on the Mac. Engagement-level architecture and execution sequencing live in the Vader atlas-client namespace (manus-emulation blueprint plus build orchestration plan). On conflict:

- Design: the design pass (docs/design/atlas-workspace-design-pass.md) wins.
- Runtime architecture: the agent architecture doc wins.
- Execution order: the orchestration plan wins.

## Executive Summary

Atlas must become the operating workspace Rhys and his team can actually use every day. Slack should feel reliable again, but Slack is not the product centre. Slack is the intake, status, and delivery edge. Workspace is the Manus-grade workbench where jobs, artifacts, approvals, source context, team lanes, and access controls live.

The next build must resolve the complaints that keep damaging trust:

- Atlas acknowledged asset work in Slack, then did not automatically return the artifact.
- A fast delivered PDF is still a failure if it is generic, unbranded, or detached from the real Atlas/Undeniable workflow.
- Rhys should not see internal job ids, `state=...`, file paths, stack traces, or implementation bloat in Slack.
- Rhys-client approval drafts must not leak to Dante DMs or any wrong comms surface.
- Workspace must feel like a serious client operating system, not a dashboard toy or a pile of disconnected panels.
- Access control, client separation, source provenance, approval gates, and delivery receipts are product requirements, not implementation nice-to-haves.

The product target is: Rhys can ask Atlas for real work, see where it is, inspect or approve the result, get the artifact or draft delivered, and trust that Atlas will be honest when a workflow is not ready.

## Product Positioning

Atlas for Rhys is an Undeniable operating layer:

- Slack: fast, low-friction requests and status.
- Workspace: durable project work, artifacts, source packets, reviews, approvals, revisions, team lanes, and operator visibility.
- Mission Control: the command-centre shell and operational dashboard around live systems.
- Verified workflow adapters: narrow, real workflows backed by source context and brand rules.

The system should feel closer to Manus than a chatbot:

- It plans work and shows progress.
- It produces durable artifacts, not throwaway chat text.
- It exposes source context and validation.
- It remembers project state across sessions.
- It supports revision, approval, delivery, and audit history.
- It is tailored to Rhys and Undeniable, not a generic AI dashboard.

## Users And Jobs To Be Done

### Rhys

Rhys needs to:

- ask for client-ready assets from Slack without chasing follow-ups
- know quickly whether Atlas is working, blocked, or done
- inspect artifacts and drafts in a workspace without reading logs
- approve or request changes before anything client-facing is sent
- trust that Atlas uses Undeniable voice, source memory, and real workflows
- avoid technical noise while still getting reliable results

### Dante / Operator

Dante needs to:

- know whether Atlas is live, safe, and source/runtime aligned
- see every job, artifact, delivery, approval, and failure reason
- split and deploy work safely without mixing unrelated dirty batches
- prevent client comms leaks and wrong-surface sends
- continue building toward the $42.5K Atlas promise without re-breaking Slack

### Rhys Team

The team needs lane-specific workflows:

- Pat: client-safe Slack response drafts, follow-ups, and approval queue
- Corey: content ideation, repurposing, and review packages
- Coaches/operators: call follow-up tasks, client memory, source packets
- Leadership: work status, artifacts, approvals, risks, and delivery history

## Current Proven Baseline

The following can be treated as real substrate:

- Slack Socket Mode ownership is single-owner: `slack-listener`.
- Slack runtime source/live parity verifies with `allMatch=true`.
- Slack asset lifecycle exists for supported workflows:
  request -> acknowledgement -> durable job -> workflow -> validation -> Slack upload -> receipt -> delivered.
- First $10K and Jess Endure CTA workflows prove real artifact retrieval/generation paths.
- Rhys-facing Slack copy has been cleaned to hide internal asset ids and raw states.
- Wrong-route Rhys approval drafts to Dante DM are guarded.
- Approval queue double-send prevention is committed.
- Core job store foundation is committed with jobs, artifacts, deliveries, approvals, and project filtering.
- Core delivered state requires a real receipt with `channelId` plus `fileId` or `messageTs`.
- Mission Control has an active design sprint plan and UI Soul direction, but much of that work remains dirty/unreviewed.

## Product Requirements

### PRD-1: Slack Is Intake, Status, And Delivery Only

Slack must not be the primary builder. Slack receives requests, creates or attaches to a job, returns short status, and delivers supported outputs.

Acceptance:

- Every long-running Slack request has a durable job.
- The initial acknowledgement never implies completion.
- Status follow-ups answer from job state immediately.
- Delivered means Slack returned a file or message receipt.
- Unknown workflow requests block honestly.
- Rhys never sees raw job ids, internal states, local paths, tokens, or stack traces.

### PRD-2: Workspace Is The Primary Operating Surface

Workspace must become the place where durable work lives.

Acceptance:

- Project lanes show active jobs, artifacts, approvals, and delivery history.
- Job detail shows request, source, status, plan, events, blockers, artifacts, approvals, and receipts.
- Artifact detail shows preview/download, source packet, validation, versions, and delivery history.
- Approval lane supports approve, deny, redraft, feedback, and send history.
- Internal diagnostics are available to operators but hidden from Rhys-facing views.

### PRD-3: Artifact Quality And Provenance Are Non-Negotiable

Atlas must not ship generic fake documents.

Acceptance:

- PDF/DOCX outputs use verified Atlas/Undeniable workflows or block.
- Every artifact has validation results.
- Every artifact has source context or an explicit note that source context was unavailable.
- Generated branded docs save source sidecars where applicable.
- Artifact revisions create new versions, not overwritten silent changes.
- Delivery references a specific artifact version.

### PRD-4: Project And Access Controls Are Product Features

The system must separate clients, team lanes, operators, and delivery surfaces.

Acceptance:

- Each job belongs to a project lane.
- Slack users/channels map to project permissions.
- Rhys-client comms cannot be routed to Dante DM except approved internal status.
- Direct client-channel send requires an explicit approved workflow.
- Operator-only details remain operator-only.
- Broad team rollout is blocked until these controls are visible and test-covered.

### PRD-5: Verified Workflow Adapters Expand Carefully

Adapters must be added for real recurring use cases, not broad generic promises.

Initial adapter priorities:

1. Mirror existing Slack asset jobs into Core jobs.
2. Pat Slack response drafts and approval queue.
3. Call follow-up tasks from transcripts and memory.
4. Corey content workflow.
5. Client-ready branded asset packs.
6. Source packet summaries for client calls/resources.

Acceptance:

- Each adapter has matcher, source policy, builder/retriever, validator, delivery policy, and tests.
- Unknown requests block with a safe reason and setup requirement.
- No adapter can mark delivered without a delivery receipt.

### PRD-6: Manus-Grade Workspace Experience

Workspace must feel alive, durable, and productive.

Acceptance:

- Session and artifact state survive refresh, project switching, and navigation.
- Run timeline shows meaningful progress without leaking internals.
- Plan cards, source chips, artifact cards, revision actions, and approval actions are visible.
- Empty/loading/error states are polished and honest.
- Workspace design follows docs/design/atlas-workspace-design-pass.md (approved): chat-first Manus-style. Conversation as the main canvas, composer as front door, sidebar = projects/tasks, collapsible task chips, inline artifact cards, status as iconography not pills, restrained dark palette. ATLAS UI Soul / design-sprint command-centre styling applies ONLY to the Mission Control dashboard (see PRD-7), never the Workspace.
- Mobile/responsive layouts do not overlap or clip text.

### PRD-7: Mission Control Dashboard Supports The Workspace, Not The Reverse

The dashboard should show live operational context, but not become theater.

Acceptance:

- Live bridge data is used where available.
- Missing integrations show honest "connecting" or "not connected" states.
- No fake numbers are introduced.
- Agent activity, approvals, system performance, and project workload reflect real state.
- Visual polish does not override safety, correctness, or client separation.

## Release Milestones

### Milestone 1: Baseline Trust

Already mostly complete.

- Slack asset lifecycle works for supported workflows.
- Runtime parity and socket owner diagnostics are green.
- Approval double-send guard exists.
- Core job store foundation exists.

Exit criteria:

- Three controlled human Rhys Slack prompts complete or block honestly.
- No false delivered states.
- No internal Slack bloat.

### Milestone 2: Workspace Job Spine

- Mirror Slack jobs into Core jobs.
- Add Workspace Core job list/detail APIs.
- Add project lane projection.
- Show job state in Workspace.

Exit criteria:

- Operator can find a Slack-created job in Workspace.
- Workspace status matches Slack ledger.
- Delivered jobs show receipt.

### Milestone 3: Artifact And Approval Lanes

- Add artifact version projection and preview/download links.
- Add approval/redraft lane projection.
- Connect approval send history to Core approvals.

Exit criteria:

- Operator can inspect artifact source, validation, version, and delivery history.
- Approval flow cannot double-send.
- Redraft feedback is stored.

### Milestone 4: Team Workflow Adapters

- Pat draft workflow.
- Call follow-up workflow.
- Corey content workflow.
- Branded asset packs beyond First $10K and Jess CTA.

Exit criteria:

- Each adapter has happy path, blocked path, validation failure, and delivery receipt tests.
- Rhys/team users can use supported lanes without operator log-diving.

### Milestone 5: Persistence And Rollout

- Keep local JSON as default fallback.
- Add Supabase adapter after the local model is stable.
- Introduce access-controlled team beta.

Exit criteria:

- Production/shared persistence does not regress local fallback.
- Access controls are explicit.
- Team beta has a written safe-use scope.

## Quality Bar

The build is not done when it compiles. It is done when:

- Rhys can use it without feeling like a tester.
- Dante can explain what Atlas can and cannot safely do.
- Jobs do not disappear.
- Artifacts are real and branded.
- Delivery is receipted.
- Unsupported work blocks honestly.
- Operators can trace source, workflow, validation, and delivery.
- The UI feels like a tailored operating system for Undeniable, not a generic AI wrapper.

## Non-Goals

- Do not promise universal autonomous client delivery.
- Do not push or deploy broad dirty batches as part of this requirements work.
- Do not rebuild known-good artifact workflows unless inspection proves they are missing or broken.
- Do not turn Slack into a full workspace.
- Do not expose implementation details to Rhys to prove progress.
- Do not use fake dashboard data where live integration is missing.
