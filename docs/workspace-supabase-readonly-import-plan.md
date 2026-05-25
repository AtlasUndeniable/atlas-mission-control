# Atlas Workspace Supabase Read-Only Import Plan

Status: draft/local foundation only. The accompanying migration has not been executed against Postgres in this repo yet and is not production-ready. Validate with local Supabase/Postgres before using it for any application code.

This plan is for a later local/dev-only importer pass. It does not connect current production workflows to Supabase and does not mutate existing local JSON, export, Slack, Monday, Typeform, OpenClaw, or LaunchAgent state.

## Purpose

Move the current Workspace projections toward durable Supabase records while keeping Atlas Workspace canonical over time:

- Projects and role access are seeded by `001_atlas_workspace_foundation.sql`.
- Executive Audit remains a Typeform/business-intake workflow with a short-term `#l2-audits` Slack bridge and long-term Workspace job/artifact state.
- Slack can mirror or discuss audit workflow state, but the durable job/artifact rows become canonical after cutover.

## Import Sources

Read-only candidates:

- Workspace approval projections from local JSON queues.
- Workspace artifact metadata from export directories and existing artifact-control JSON/JSONL.
- Audit run records from the local audit-runs state directory.
- Memory maintenance reports, context packs, and review queue summaries.
- Task/Reaper projection metadata.

## Import Stages

1. **Dry-run inventory**
   - Count candidate records by source.
   - Hash files without reading sensitive bodies into logs.
   - Emit a summary report only.

2. **Fixture import**
   - Use local fixture JSON under a non-production directory.
   - Insert into Supabase local/dev only.
   - Verify RLS by role before touching real local state.

3. **Metadata-only backfill**
   - Insert `jobs` from durable run records when available.
   - Insert inferred `artifacts` from metadata only.
   - Insert `approvals` from approval projections with exact payload hashes where safe.
   - Insert `memory_references` for report/context-pack pointers only.

4. **Parity checks**
   - Compare source counts to imported counts.
   - Compare artifact file hashes when available.
   - Ensure inferred jobs do not overstate readiness.
   - Ensure Corey cannot see audit/private ops rows.
   - Ensure worker role cannot decide approvals.

5. **Dual-write design**
   - Current workflows continue to run locally.
   - New local/dev adapter writes safe job events and artifact metadata to Supabase.
   - No external sends or mutations are introduced by the importer.

## Non-Goals

- No production Supabase cutover.
- No live Slack sends.
- No Monday mutations.
- No Typeform webhook wiring.
- No OpenClaw configuration edits.
- No LaunchAgent edits or restarts.
- No secrets in importer fixtures, logs, or migrations.

## Cutover Gates Before Production

- Google Auth domain and onboarding flow are defined.
- Role assignment is audited and server-side only.
- Storage buckets and signed URL policies are tested.
- RLS tests pass for Rhys, Pat, Jian, Corey, Dante/admin, worker, and anonymous.
- `decide_approval` remains impossible for worker/model identities.
- Executive Audit jobs survive UI/Slack timeouts and produce validated artifacts before `ready_for_review`.
