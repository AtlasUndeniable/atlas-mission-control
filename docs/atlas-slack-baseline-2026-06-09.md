# Atlas Slack Baseline - 2026-06-09

Status: operator-facing baseline for what can be confidently said after the Slack recovery.

## Plain-English Claim

Atlas is back to baseline in Slack for controlled work.

That means Rhys can send a supported request in Slack, Atlas can acknowledge it, run the request through a verified workflow, return the file in Slack, and record the delivery result. Atlas should not call work done until the file or message has actually been returned.

## What Is Proven

- Rhys DM intake is handled by the single `slack-listener` socket owner.
- Short Slack replies work after the socket ownership fix.
- Asset requests now use a durable job lifecycle instead of stopping after the acknowledgement.
- The First $10K PDF path can retrieve and return a verified existing branded artifact.
- The Jess Endure CTA/DM playbook path can generate and return a branded PDF/DOCX package.
- Delivery is not marked complete until Slack returns a file or message receipt.
- Status follow-ups read from the local job ledger.
- Internal job ids, states, paths, and stack traces are not meant to be shown to Rhys.

## What To Tell Rhys

Recommended wording:

Atlas is back to baseline in Slack for controlled asset work. You can ask it for supported Undeniable/Atlas assets, and it should now acknowledge the request, build or retrieve the file through a verified workflow, return the file in Slack, and track the delivery. We are keeping Slack narrow for intake, status, and delivery while the Workspace becomes the fuller Manus-style workbench for projects, revisions, approvals, and team workflows.

## What Still Needs Care

- Atlas is not ready to promise every possible asset request.
- Unsupported workflows should block honestly instead of producing generic documents.
- Broad team rollout should wait until Workspace job, artifact, project, and approval lanes are visible.
- Direct client-channel sending and approval routing must stay gated.
- Mission Control / Workspace dirty code still needs a dedicated review and commit split before broader app deployment.

## Suggested Smoke Prompts

Use these only after runtime parity and socket owner diagnostics are green.

1. Ask for a verified known asset:

   Atlas, send me the current branded First $10K PDF.

2. Ask for the Jess workflow:

   Atlas, create a branded Undeniable Ad CTA + DM Follow-Up Playbook for Jess Endure Mentoring. Use recent Jessica De Bortoli / Jess Endure Mentoring Slack or call memory if available. Return it here as a branded PDF.

3. Ask a status follow-up:

   Where is the asset I just asked for?

Expected behavior:

- Atlas should acknowledge without technical bloat.
- Atlas should return a real file for supported workflows.
- The follow-up should answer from job state immediately.
- If the workflow is unsupported, Atlas should say it cannot verify that workflow yet.

## Operator Rule

If a Slack request needs more than the verified adapter can do, move it into Workspace/operator review. Do not let Slack become the primary builder again.
