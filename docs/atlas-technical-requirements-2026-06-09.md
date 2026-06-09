# Atlas Technical Requirements - Slack Baseline To Workspace Lanes

Status: technical requirement baseline after the 2026-06-09 Slack recovery.

## System Boundary

Canonical repo:

`/Users/atlasai/atlas-mission-control`

Live runtime/state:

`/Users/atlasai/.openclaw/workspace`

Slack runtime deploy guard:

`scripts/deploy-openclaw-slack-runtime.mjs`

Socket owner diagnostic:

`scripts/check-openclaw-slack-socket-owner.mjs`

## Current Working Baseline

The live Slack asset path is:

1. Slack Socket Mode event received by `services/slack-listener/listener.mjs`.
2. `upsertSlackDmJob()` records the request in `/Users/atlasai/.openclaw/data/slack-dm-jobs.json`.
3. Long-running request branch sends acknowledgement text.
4. Job transitions to `queued`.
5. `findSlackAssetWorkflowForRequest()` selects a verified workflow.
6. Job transitions to `building`.
7. `executeSlackAssetWorkflow()` builds or retrieves the artifact package.
8. Files are validated through `validateSlackAssetFile()`.
9. Job transitions to `artifact_ready`.
10. Artifact ledger records the package.
11. Job transitions to `delivery_requested`.
12. `sendRhysDmArtifact()` uploads the file.
13. Slack file/message receipt is captured.
14. `recordSlackDmJobDelivered()` marks the job `delivered`.

## Current Source Modules

Slack runtime:

- `openclaw-runtime/workspace/services/slack-listener/listener.mjs`
- `openclaw-runtime/workspace/lib/slack-dm-jobs.mjs`
- `openclaw-runtime/workspace/lib/slack-listener-reply.mjs`
- `openclaw-runtime/workspace/lib/slack-asset-workflows.mjs`
- `openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.mjs`
- `openclaw-runtime/workspace/lib/artifact-delivery.mjs`
- `openclaw-runtime/workspace/lib/slack-gates.mjs`
- `openclaw-runtime/workspace/lib/slack-gate-actions.mjs`

Verified workflow examples:

- `first-10k-online-coach`
- `jess-endure-ad-cta-dm-follow-up`

## Required State Machine

Allowed Slack asset job states:

- `received`
- `queued`
- `building`
- `artifact_ready`
- `delivery_requested`
- `delivered`
- `blocked`
- `failed`

Additional compatibility states:

- `needs_workspace`
- `needs_workspace_job`
- `answered`
- `completed`
- `blocked_needs_approval`

Hard rule:

`delivered` is impossible without `deliveryResult.channelId` and either `deliveryResult.fileId` or `deliveryResult.messageTs`.

## Slack Baseline Requirements

### TR-1: Runtime Parity

Before and after any Slack runtime change:

```bash
node scripts/deploy-openclaw-slack-runtime.mjs --verify
```

Acceptance:

- before deploy, expected changed files are explicit
- after deploy, `allMatch=true`

### TR-2: Single Socket Owner

Before and after listener changes:

```bash
node scripts/check-openclaw-slack-socket-owner.mjs
```

Acceptance:

- `status=ok`
- active owner is `slack-listener`
- OpenClaw gateway Slack socket remains disabled

### TR-3: Job Ledger Integrity

Ledger path:

`/Users/atlasai/.openclaw/data/slack-dm-jobs.json`

Every long-running Slack request must include:

- id
- assetJobId
- source channel
- source timestamp
- requester
- request text
- classification
- status
- createdAt/updatedAt
- workflowKey/workflowId when selected
- artifactPath/artifactPaths when ready
- deliveryResult when delivered
- safeErrorSummary when blocked/failed

### TR-4: Verified Workflow Registry

Each workflow entry must include:

- `key`
- `workflowId`
- `adapter`
- `title`
- `message`
- `match(text)`
- `sourcePaths` or retrieval policy
- `build()` or existing artifact paths

Unknown requests must return:

- `ok=false`
- `status=blocked`
- safe user message
- no generated fake file

### TR-5: Artifact Validation

Allowed extensions:

- `.pdf`
- `.docx`
- `.pptx`
- `.xlsx`
- `.html`
- `.md`
- `.png`

Validation gates:

- artifact path is inside approved artifact root
- file exists
- file is non-empty
- PDF header starts `%PDF-`
- DOCX header starts `PK`

Generated branded document gates:

- `.md`, `.html`, and `.css` sidecars exist
- branded PDF built through HTML/CSS -> WeasyPrint
- DOCX built from clean Markdown
- DOCX zip validates
- DOCX raw tag scan counts are zero for escaped HTML tags
- render or inspect cover before delivery when workflow changes

### TR-6: Slack-Facing Copy

Slack user text must not expose:

- raw job ids
- `state=...`
- local file paths
- source paths
- stack traces
- token or provider details

Internal logs may include job ids and workflow keys.

## Workspace Lane Requirements

Workspace should become the durable manager for the same lifecycle.

### TR-7: Core Job Store

Add a local JSON-backed core job store before Supabase.

Required job envelope:

```ts
type AtlasJob = {
  id: string;
  projectId: string;
  source: {
    type: "slack" | "workspace" | "operator";
    channelId?: string;
    messageTs?: string;
    userId?: string;
  };
  request: {
    text: string;
    classification: string;
    createdAt: string;
  };
  status: string;
  workflow?: {
    key: string;
    id: string;
    adapter: string;
  };
  artifactIds: string[];
  deliveryIds: string[];
  approvalIds: string[];
  safeErrorSummary?: string;
};
```

Acceptance:

- Slack jobs can be mirrored or imported into Workspace.
- Workspace-created jobs can use the same workflow registry.
- Status projection is consistent between Slack and Workspace.

### TR-8: Artifact Store

Required artifact envelope:

```ts
type AtlasArtifact = {
  id: string;
  projectId: string;
  jobId: string;
  title: string;
  kind: "pdf" | "docx" | "html" | "md" | "deck" | "sheet";
  paths: string[];
  sourcePaths: string[];
  validation: {
    status: "passed" | "failed";
    checks: Record<string, boolean | string | number>;
  };
  version: number;
  createdAt: string;
};
```

Acceptance:

- preview/download are based on artifact id, not raw path in UI
- source paths remain internal
- revisions create new versions
- delivery references artifact version

### TR-9: Project Lane

Required project lane model:

```ts
type AtlasProjectLane = {
  id: string;
  name: string;
  client: string;
  allowedUsers: string[];
  slackChannels: string[];
  defaultDelivery: "slack_dm" | "workspace_review";
  activeWorkflowKeys: string[];
};
```

Acceptance:

- project scopes jobs and artifacts
- access controls are explicit
- Slack channel/user mapping is configured, not inferred from text alone

### TR-10: Approval Lane

Approval envelope:

```ts
type AtlasApproval = {
  id: string;
  projectId: string;
  jobId?: string;
  artifactId?: string;
  channel: "slack" | "email" | "workspace";
  destination: string;
  draft: string | null;
  status: "pending" | "approved" | "denied" | "redraft_requested" | "sent" | "failed";
  feedback?: string;
  deliveryResult?: unknown;
};
```

Acceptance:

- redraft feedback is stored
- approval routing guard blocks wrong destination
- send result is recorded
- no direct client send without explicit approval unless the source/request has approved Slack DM delivery semantics

## Verified Adapter Requirements

Each adapter must ship with:

1. matcher tests
2. known happy path test
3. unknown workflow blocked test
4. failed validation test
5. status follow-up test when used from Slack
6. delivery receipt test when delivering externally

Required adapter interface:

```ts
type VerifiedArtifactWorkflow = {
  key: string;
  workflowId: string;
  adapter: string;
  title: string;
  message: string;
  sourcePaths?: string[];
  match(text: string): boolean;
  build?(input: WorkflowBuildInput): Promise<WorkflowBuildResult>;
  artifactPath?: string;
  artifactPaths?: string[];
};
```

## Observability Requirements

Minimum diagnostics:

- runtime parity command
- socket owner command
- job ledger report
- stuck Slack item report
- artifact validation report
- listener logs

Future Workspace UI diagnostics:

- job timeline
- current state
- workflow selected
- artifact validations
- delivery receipt
- blocked reason
- source packet labels

## Deployment Requirements

Slack runtime deployment:

```bash
node scripts/deploy-openclaw-slack-runtime.mjs --apply
launchctl kickstart -k gui/$(id -u atlasai)/com.atlas.slack-listener
node scripts/deploy-openclaw-slack-runtime.mjs --verify
node scripts/check-openclaw-slack-socket-owner.mjs
```

Mission Control app deployment:

- out of scope until dirty Workspace batch is reconciled
- do not deploy broad UI/API changes from dirty tree without review

## Test Matrix

Slack/OpenClaw targeted:

```bash
node --test \
  openclaw-runtime/workspace/lib/slack-asset-workflows.test.mjs \
  openclaw-runtime/workspace/lib/slack-dm-jobs.test.mjs \
  openclaw-runtime/workspace/lib/slack-listener-reply.test.mjs \
  openclaw-runtime/workspace/lib/slack-rhys-dm-artifact.test.mjs \
  openclaw-runtime/workspace/lib/slack-gates.test.mjs
```

Repo checks:

```bash
npx eslint <scoped files>
npx tsc --noEmit --pretty false
npm run build
```

Known build warnings:

- Next middleware convention deprecation
- Turbopack NFT trace warning from `next.config.ts` import path

## Open Technical Debt

- `main` is ahead of origin by 77 commits.
- dirty Workspace/UI/API batch needs review and split.
- stale Slack monitor queue items include `source_missing_or_deleted`; not blocking the Rhys DM asset baseline, but should be archived or surfaced cleanly.
- Slack adapters and Workspace stores are not unified yet.
- Supabase persistence is available locally but not wired as production Workspace persistence.

## Next Implementation Order

1. Commit this requirements baseline without touching dirty implementation files.
2. Review dirty Workspace/UI/API batch and split/park it.
3. Create local Core job store.
4. Mirror Slack jobs into Workspace project lanes.
5. Add Artifact store/version model.
6. Add approval/redraft lane.
7. Add first new verified adapters in order of real Rhys/team demand.
