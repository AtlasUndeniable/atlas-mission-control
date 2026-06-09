# Atlas Product Requirements - Slack Baseline To Workspace Lanes

Status: product requirement baseline after the 2026-06-09 Slack recovery.

## Purpose

Atlas must feel reliable again to Rhys before the Workspace expansion resumes.

The product direction is:

1. Slack becomes the narrow intake, status, and delivery adapter.
2. Workspace becomes the durable builder: jobs, artifacts, project lanes, access controls, source packets, revisions, and team workflows.
3. Verified workflow adapters are added only when they map to real Rhys/team use cases and existing source/brand workflows.

## Problem

Atlas had become hard to trust because it could acknowledge work in Slack without completing the loop. Rhys could ask for an asset, Atlas could say it was working, then the user had to follow up before the file appeared.

The First $10K PDF quality was not the core failure. The failure was orchestration:

request -> acknowledgement -> durable job -> worker -> file validation -> Slack delivery -> receipt.

The Jess CTA smoke exposed a second issue: the lifecycle could be fast and correct while the artifact quality path was wrong. The workflow used generic converter output instead of the branded Undeniable document workflow.

## Product Principles

- Do not claim done until a real result exists.
- Do not invent generic branded PDFs when no verified workflow exists.
- Do not expose internal job IDs, states, paths, stack traces, or tokens to Rhys.
- Keep Slack messages short, calm, and operational.
- Preserve existing Atlas/Undeniable brand and voice workflows.
- Use Workspace for durable work and review. Use Slack for clear intake/status/delivery.
- Make every completed artifact traceable to source context, workflow, file path, and delivery receipt.

## Personas

### Rhys

Needs Atlas to:

- accept a request in Slack
- answer quickly
- return real files without chasing
- know when it is blocked
- stay client-safe
- avoid sounding like a debug console

### Dante / Operator

Needs Atlas to:

- be auditable
- be deployable without drift
- keep live runtime parity visible
- keep source/workflow provenance clear
- avoid breaking client comms

### Rhys Team

Future users need Atlas to:

- support specific lanes without broad chaos
- draft client-safe responses
- create client-ready artifacts
- keep approvals and access controls clear

## Current Proven Baseline

The controlled Slack DM baseline now works for verified asset workflows:

- inbound Rhys DM is received by `slack-listener`
- job is recorded in the Slack DM ledger
- Rhys sees a plain-language acknowledgement
- asset workflow is selected from the verified registry
- artifact is built or retrieved
- file validation gates run
- delivery is requested
- Slack upload returns a receipt
- ledger is marked `delivered`

Proof points:

- First $10K verified PDF delivered by Slack file receipt.
- Jess Endure CTA PDF delivered by Slack file receipt after branded workflow fix.
- Socket owner diagnostic is `status=ok`.
- Runtime parity is `allMatch=true`.
- Targeted Slack/OpenClaw tests pass.

## Scope

### Phase 1: Slack Baseline Definition

Product outcomes:

- Define what Atlas can confidently do from Slack today.
- Define what Slack should refuse or park.
- Define user-facing copy for queued/building/blocked/delivered states.
- Define the support language Dante can use with Rhys.

Required Slack baseline behavior:

- Acknowledge asset requests without technical bloat.
- Create or attach to a durable job.
- Use only verified workflows for artifact delivery.
- Block honestly when no verified workflow exists.
- Answer status follow-ups from the ledger.
- Deliver only after Slack file/message receipt.
- Never route Rhys-client approval drafts to Dante DMs.

Out of scope:

- Broad free-form PDF generation.
- Direct client-channel posting.
- Monday, Typeform, Meta, or email mutations.
- Full Workspace production persistence.

### Phase 2: Workspace Job / Artifact / Project Lanes

Product outcomes:

- Workspace becomes the primary place to view and manage durable work.
- Every Slack job can be represented in Workspace.
- Artifacts have project context, source context, status, revisions, and delivery state.
- Operators can inspect, approve, revise, and re-deliver without touching raw files.

Required lanes:

- Project lane: client/team/project context, permissions, active jobs, artifacts.
- Job lane: request, status, plan, worker events, blockers, receipts.
- Artifact lane: preview, source packet, versions, validation, delivery history.
- Approval lane: drafts, redrafts, approvals, send history.

### Phase 3: Verified Workflow Adapter Expansion

Product outcomes:

- Add adapters only for real, repeated Rhys/team workflows.
- Every adapter has a matcher, source retrieval policy, builder, validator, delivery behavior, and tests.

Initial adapters:

- Pat Slack response drafts
- Corey content workflow
- call follow-ups
- branded client asset packs
- client call/source packet summaries

Adapter rule:

No source package or real workflow means no delivery. The system should block, explain, and ask for operator setup.

## Product Requirements

### PR-1: Slack Baseline Page

Create a plain-language baseline document that says:

- what Atlas can do from Slack
- what Atlas cannot do yet
- how to phrase requests
- what blocked means
- what delivered means
- how to escalate

Acceptance:

- Dante can send or paraphrase it to Rhys.
- It is not technical.
- It does not overpromise.

### PR-2: Durable Job Visibility

Every Slack long-running request must have a job visible to operators.

Acceptance:

- job has requester, source channel, request text, status, timestamps, workflow, artifact paths, and delivery receipt
- status follow-up can answer immediately
- blocked/failed jobs preserve a safe reason

### PR-3: Artifact Trust

Every delivered artifact must be validated.

Acceptance:

- file exists
- extension is allowed
- PDF/DOCX headers validate
- branded docs use branded workflow paths
- source sidecars exist for generated branded docs
- delivery happens only after receipt

### PR-4: Workspace Project Lanes

Workspace must organize work by project/client lane.

Acceptance:

- job list scoped by project
- artifact library scoped by project
- access controls are explicit
- internal events stay out of client-facing UI

### PR-5: Approval And Redraft Loop

Client-facing drafts and assets need a review loop.

Acceptance:

- approve, deny, redraft
- feedback captured
- send history recorded
- unsafe destination blocked

### PR-6: Adapter Registry

Verified workflows need a registry.

Acceptance:

- matcher
- workflow id
- source paths or retrieval policy
- build/retrieve adapter
- validation gates
- delivery message
- tests for known, unknown, and failed packages

## Success Metrics

Slack baseline:

- 3 controlled Rhys Slack requests complete without manual recovery.
- 0 false "done" claims.
- 0 client/source/path leaks.
- 0 unreceipted deliveries marked delivered.

Workspace:

- operator can find the job, artifact, source packet, and delivery receipt from one project lane.
- artifact preview/revision/download works.
- status shown in Workspace matches Slack ledger.

Adapter expansion:

- each adapter has an end-to-end smoke and blocked-path test.
- unknown requests block honestly.

## Messaging To Rhys

Recommended external wording:

Atlas is back to baseline in Slack for controlled work. It can take a Slack request, acknowledge it, build through a verified workflow, return the file in Slack, and record delivery. We are now moving from repair mode into Workspace/team workflow buildout.

## Non-Goals

- Do not promise full autonomous client delivery yet.
- Do not promise every artifact request is supported.
- Do not turn Slack into the primary builder.
- Do not push broad repo changes until the dirty Workspace batch is reconciled.
