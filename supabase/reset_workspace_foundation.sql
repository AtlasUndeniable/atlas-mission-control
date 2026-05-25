-- Local-only reset for the Atlas Workspace foundation migration.
-- Do not run in production.
-- Draft safety label: use only in a disposable local Supabase/Postgres
-- database after the foundation migration has been tested.

begin;

drop function if exists public.decide_approval(uuid, text, text, text) cascade;
drop function if exists public.create_approval(uuid, text, text, jsonb, text, jsonb, uuid, uuid, timestamptz) cascade;
drop function if exists public.fail_job(uuid, uuid, boolean, text) cascade;
drop function if exists public.complete_job(uuid, uuid, text, text) cascade;
drop function if exists public.append_job_event(uuid, uuid, text, text, text, jsonb, text) cascade;
drop function if exists public.claim_next_job(text[], integer) cascade;
drop function if exists public.create_job(text, text, text, jsonb, jsonb, text) cascade;

drop policy if exists audit_logs_select_admin on public.audit_logs;
drop policy if exists memory_references_select_accessible on public.memory_references;
drop policy if exists tasks_select_accessible on public.tasks;
drop policy if exists approvals_select_accessible on public.approvals;
drop policy if exists artifacts_select_accessible on public.artifacts;
drop policy if exists job_events_select_accessible on public.job_events;
drop policy if exists jobs_select_accessible on public.jobs;
drop policy if exists project_members_select_accessible on public.project_members;
drop policy if exists project_role_access_select_own_or_admin on public.project_role_access;
drop policy if exists projects_select_accessible on public.projects;
drop policy if exists role_permissions_select_own_or_admin on public.role_permissions;
drop policy if exists permissions_select_own_or_admin on public.permissions;
drop policy if exists roles_select_catalog on public.roles;
drop policy if exists users_select_self_or_team on public.users;

drop table if exists public.audit_logs cascade;
drop table if exists public.memory_references cascade;
drop table if exists public.tasks cascade;
drop table if exists public.approvals cascade;
drop table if exists public.artifacts cascade;
drop table if exists public.job_events cascade;
drop table if exists public.jobs cascade;
drop table if exists public.project_members cascade;
drop table if exists public.project_role_access cascade;
drop table if exists public.projects cascade;
drop table if exists public.users cascade;
drop table if exists public.role_permissions cascade;
drop table if exists public.permissions cascade;
drop table if exists public.roles cascade;

drop schema if exists app_private cascade;

commit;
