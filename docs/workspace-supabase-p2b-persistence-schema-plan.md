# Workspace Supabase P2b Persistence Schema Plan

Status: readiness draft only. Do not apply to production Supabase yet.

This plan prepares the next Supabase-backed Workspace persistence pass without replacing the current local JSON session store.

## Current Blockers

- `docker` is not available in `PATH`.
- `supabase` CLI is not available in `PATH`.
- `psql` is not available in `PATH`.
- `supabase/config.toml` is missing.

Do not create or apply a real migration until the local Supabase stack can run `supabase db reset` and the SQL/RLS tests.

## Existing Foundation

Already committed:

- `supabase/migrations/001_atlas_workspace_foundation.sql`
- `supabase/tests/001_workspace_foundation_rls.sql`
- `supabase/reset_workspace_foundation.sql`
- `supabase/migrations/002_workspace_event_spine.sql`
- `src/lib/workspace-event-log.ts`
- `src/lib/workspace-realtime-event-source.ts`
- `tests/workspace-event-log.test.ts`

P2a currently provides an AgentEvent log foundation through `public.events`, plus `public.workspaces`, `public.messages`, and workspace-linked task/artifact columns. P2b should extend that foundation for durable Workspace sessions rather than bypassing it.

## Current Local JSON Contract

Local session root:

`/Users/atlasai/.openclaw/workspace/state/workspace-demo-sessions`

Current files per session:

- `metadata.json`
- `events.jsonl`
- `session.json`

Current metadata shape:

- `id`
- `workspaceId`
- `project`
- `room`
- `title`
- `createdAt`
- `updatedAt`
- `eventCount`
- `selectedArtifactId`

Current persisted events:

- presentation-only AgentEvents
- `message.delta`
- `message.complete`
- `artifact.created`
- `task.step`
- `task.complete`

Internal diagnostics stay out of local session hydration. Thread state is derived from events, not treated as canonical state.

## Proposed Tables

### `public.workspace_sessions`

Canonical Supabase replacement for local `metadata.json` and the session list.

Suggested columns:

- `id text primary key`
- `workspace_id text not null references public.workspaces(id) on delete cascade`
- `project_id uuid references public.projects(id) on delete set null`
- `project_slug text not null`
- `room text not null`
- `title text not null`
- `status text not null default 'active' check (status in ('active', 'archived'))`
- `selected_artifact_id text`
- `event_count integer not null default 0 check (event_count >= 0)`
- `metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Recommended indexes:

- `(workspace_id, updated_at desc)`
- `(project_slug, room, updated_at desc)`
- partial index for active sessions: `(workspace_id, updated_at desc) where status = 'active'`

Notes:

- Keep `project_slug` and `room` because the local contract is project/room scoped even when project UUID lookup is not wired.
- Keep `selected_artifact_id` on the session metadata because it is user/UI state, not an AgentEvent.

### `public.workspace_events`

Session-scoped append-only event log. This can either wrap or eventually replace P2a `public.events`, but P2b should prefer a compatibility view or adapter rather than deleting `public.events`.

Suggested columns:

- `id text primary key`
- `session_id text not null references public.workspace_sessions(id) on delete cascade`
- `workspace_id text not null references public.workspaces(id) on delete cascade`
- `task_id text not null`
- `run_id text not null`
- `kind text not null check (kind in ('message.delta', 'message.complete', 'tool.call', 'tool.result', 'artifact.created', 'task.step', 'task.complete', 'error'))`
- `visibility text not null check (visibility in ('internal', 'presentation'))`
- `payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object')`
- `created_at timestamptz not null default now()`

Recommended indexes:

- `(session_id, created_at, id)`
- `(workspace_id, task_id, created_at, id)`
- `(workspace_id, run_id, created_at, id)`
- `(workspace_id, visibility, created_at)`
- partial replay index: `(session_id, created_at, id) where visibility = 'presentation'`

Notes:

- Keep payload compatible with `agentEventToDbInsert` and `dbRowToAgentEvent`.
- Store internal events only when explicit Inspector recovery is required. Default hydration should query `visibility = 'presentation'`.
- Use append-only semantics. Do not update or delete event rows in normal operation.

### `public.workspace_artifacts`

Safe artifact metadata for Workspace cards and preview/open state. This table stores metadata only, not raw local filesystem paths.

Suggested columns:

- `id text primary key`
- `session_id text references public.workspace_sessions(id) on delete cascade`
- `workspace_id text not null references public.workspaces(id) on delete cascade`
- `event_artifact_id text not null`
- `type text not null check (type in ('markdown', 'pdf', 'document', 'spreadsheet', 'audit', 'brief', 'playbook'))`
- `title text not null`
- `subtitle text not null default ''`
- `preview text not null default ''`
- `source_event_id text references public.workspace_events(id) on delete set null`
- `storage_status text not null default 'local_only' check (storage_status in ('local_only', 'supabase_storage', 'external'))`
- `storage_ref text`
- `metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object')`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Recommended indexes:

- `(session_id, created_at desc)`
- `(workspace_id, created_at desc)`
- unique `(session_id, event_artifact_id)` where `session_id is not null`

Notes:

- Do not persist local paths in presentation-safe artifact metadata.
- If Supabase Storage is introduced later, put object keys in `storage_ref`, not host paths.
- PDF/DOCX export remains out of scope until the export path is explicitly wired.

### Optional `public.workspace_session_state`

Use only if selected UI state grows beyond `selected_artifact_id`.

Suggested columns:

- `session_id text primary key references public.workspace_sessions(id) on delete cascade`
- `selected_artifact_id text`
- `selected_task_id text`
- `collapsed_panels jsonb not null default '{}'::jsonb`
- `metadata jsonb not null default '{}'::jsonb`
- `updated_at timestamptz not null default now()`

Recommendation: start without this table. Add it only when session UI state needs to be independently updated without touching `workspace_sessions`.

## RLS Plan

Enable RLS on all new tables from the first migration.

No anonymous grants.

Initial policies should be authenticated-only and workspace/project scoped:

- user can select sessions/events/artifacts when they can access the parent `workspaces.project_id`, own the workspace, or are admin.
- inserts/updates should remain service-role only until auth and ownership write paths are explicitly designed.

## Migration Strategy

1. Restore local tooling:
   - install Docker
   - install Supabase CLI
   - install `psql`
   - add `supabase/config.toml`
2. Run existing foundation:
   - `supabase start`
   - `supabase db reset`
   - run `supabase/tests/001_workspace_foundation_rls.sql`
3. Add a tested P2b migration as `supabase/migrations/003_workspace_session_persistence.sql`.
4. Add SQL RLS tests for:
   - no anonymous reads
   - authenticated user can read accessible workspace sessions
   - inaccessible workspace sessions/events/artifacts are hidden
   - presentation replay query excludes internal events by default
5. Add TypeScript persistence helpers behind the existing event-log seam:
   - local JSON remains default
   - Supabase adapter remains dormant unless explicitly configured
   - no production Supabase connection in this pass

## Safety Notes

- Keep local JSON persistence as the active Workspace store until Supabase migrations and RLS tests run locally.
- Do not wire production Supabase env vars or service-role keys.
- Do not touch Slack, OpenClaw, Monday, Typeform, or external sends.
- Do not store local filesystem paths in presentation-visible rows.
- Treat `session.json` thread snapshots as derived cache. The canonical Supabase record should be `workspace_sessions` plus ordered `workspace_events`.
