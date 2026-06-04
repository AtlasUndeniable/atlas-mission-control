-- Atlas Workspace Supabase foundation.
-- Local/dev migration only. Do not apply to production yet.
-- Draft safety label: not executed against Postgres in this repo yet.
-- Requires local Supabase/Postgres validation before any application use.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists vector;

create schema if not exists app_private;

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null unique,
  display_name text,
  avatar_url text,
  status text not null default 'active'
    check (status in ('active', 'disabled', 'invited')),
  default_role_id uuid references public.roles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  type text not null
    check (type in ('workspace', 'audit', 'content', 'delivery', 'ops')),
  status text not null default 'active'
    check (status in ('active', 'paused', 'archived')),
  sensitivity text not null default 'internal'
    check (sensitivity in ('content', 'ops', 'internal', 'client_sensitive', 'financial', 'admin')),
  owner_user_id uuid references public.users(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_role_access (
  project_id uuid not null references public.projects(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, role_id)
);

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id, role_id)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  type text not null
    check (type in ('audit', 'content_batch', 'approval_projection', 'memory_maintenance', 'call_processor', 'doc_export', 'ops')),
  title text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'ready_for_review', 'completed', 'failed_recoverable', 'failed_blocked', 'cancelled')),
  requested_by uuid references public.users(id),
  owner_user_id uuid references public.users(id),
  owner_role_key text,
  current_step text,
  progress_pct integer check (progress_pct is null or (progress_pct >= 0 and progress_pct <= 100)),
  input jsonb not null default '{}'::jsonb,
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  recovery jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  lease_token uuid,
  locked_by_user_id uuid references public.users(id),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_events (
  id bigserial primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  actor_user_id uuid references public.users(id),
  actor_kind text not null default 'user'
    check (actor_kind in ('user', 'worker', 'system', 'admin')),
  event_type text not null
    check (event_type in ('created', 'phase_started', 'phase_completed', 'artifact_created', 'validation_result', 'approval_requested', 'approval_decided', 'heartbeat', 'warning', 'failed', 'recovered', 'completed')),
  step text,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'error')),
  created_at timestamptz not null default now()
);

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete set null,
  title text not null,
  type text not null
    check (type in ('doc', 'pdf', 'transcript', 'overview', 'content_batch', 'report', 'data', 'markdown', 'preview', 'validation', 'approval_packet')),
  status text not null default 'draft'
    check (status in ('draft', 'ready_for_review', 'approved', 'archived', 'blocked', 'quarantined')),
  storage_bucket text,
  storage_path text,
  preview_path text,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  sha256 text,
  validation_status text not null default 'unknown'
    check (validation_status in ('unknown', 'pending', 'passed', 'warning', 'failed')),
  validation jsonb not null default '{}'::jsonb,
  sensitivity text not null default 'internal'
    check (sensitivity in ('public', 'internal', 'client_confidential', 'restricted')),
  visibility text not null default 'team'
    check (visibility in ('owner', 'team', 'role_restricted', 'admin_only')),
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete set null,
  artifact_id uuid references public.artifacts(id) on delete set null,
  action_type text not null
    check (action_type in ('slack_reply', 'monday_update', 'client_notice', 'audit_delivery', 'content_publish', 'task_update')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'held', 'expired', 'executed', 'failed', 'cancelled')),
  subject text not null,
  destination jsonb not null default '{}'::jsonb,
  exact_payload jsonb not null,
  payload_hash text not null,
  required_permission text not null,
  requested_by uuid references public.users(id),
  decided_by uuid references public.users(id),
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting_for_review', 'done', 'cancelled')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  owner_user_id uuid references public.users(id),
  owner_role_key text,
  due_at timestamptz,
  source_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(source_refs) = 'array'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memory_references (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  kind text not null
    check (kind in ('memory_report', 'context_pack', 'librarian_review', 'source_index')),
  title text not null,
  scope text not null
    check (scope in ('strategy', 'ops', 'content', 'monday', 'client_sensitive', 'admin')),
  sensitivity text not null default 'internal'
    check (sensitivity in ('internal', 'client_sensitive', 'restricted')),
  source_system text not null default 'workspace',
  source_ref text not null,
  artifact_id uuid references public.artifacts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigserial primary key,
  actor_user_id uuid references public.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  project_id uuid references public.projects(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.projects enable row level security;
alter table public.project_role_access enable row level security;
alter table public.project_members enable row level security;
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.artifacts enable row level security;
alter table public.approvals enable row level security;
alter table public.tasks enable row level security;
alter table public.memory_references enable row level security;
alter table public.audit_logs enable row level security;

revoke all on table
  public.users,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.projects,
  public.project_role_access,
  public.project_members,
  public.jobs,
  public.job_events,
  public.artifacts,
  public.approvals,
  public.tasks,
  public.memory_references,
  public.audit_logs
from anon, authenticated;

create index if not exists idx_users_default_role_id on public.users(default_role_id);
create index if not exists idx_users_status on public.users(status);
create index if not exists idx_role_permissions_permission_id on public.role_permissions(permission_id);
create index if not exists idx_projects_status on public.projects(status);
create index if not exists idx_projects_type on public.projects(type);
create index if not exists idx_projects_sensitivity on public.projects(sensitivity);
create index if not exists idx_projects_owner_user_id on public.projects(owner_user_id);
create index if not exists idx_project_role_access_role_id on public.project_role_access(role_id);
create index if not exists idx_project_members_user_id on public.project_members(user_id);
create index if not exists idx_project_members_role_id on public.project_members(role_id);
create index if not exists idx_jobs_project_status on public.jobs(project_id, status);
create index if not exists idx_jobs_status_queued_at on public.jobs(status, queued_at);
create index if not exists idx_jobs_locked_by_user_id on public.jobs(locked_by_user_id);
create index if not exists idx_jobs_claimable on public.jobs(queued_at) where status in ('queued', 'failed_recoverable');
create index if not exists idx_job_events_job_created on public.job_events(job_id, created_at);
create index if not exists idx_artifacts_project_status on public.artifacts(project_id, status);
create index if not exists idx_artifacts_job_id on public.artifacts(job_id);
create index if not exists idx_approvals_project_status on public.approvals(project_id, status);
create index if not exists idx_approvals_job_id on public.approvals(job_id);
create index if not exists idx_approvals_artifact_id on public.approvals(artifact_id);
create index if not exists idx_tasks_project_status on public.tasks(project_id, status);
create index if not exists idx_tasks_owner_user_id on public.tasks(owner_user_id);
create index if not exists idx_memory_references_project_scope on public.memory_references(project_id, scope);
create index if not exists idx_memory_references_artifact_id on public.memory_references(artifact_id);
create index if not exists idx_audit_logs_actor_created on public.audit_logs(actor_user_id, created_at);
create index if not exists idx_audit_logs_project_created on public.audit_logs(project_id, created_at);

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_set_updated_at
before update on public.users
for each row execute function app_private.set_updated_at();

create trigger projects_set_updated_at
before update on public.projects
for each row execute function app_private.set_updated_at();

create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function app_private.set_updated_at();

create trigger artifacts_set_updated_at
before update on public.artifacts
for each row execute function app_private.set_updated_at();

create trigger approvals_set_updated_at
before update on public.approvals
for each row execute function app_private.set_updated_at();

create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function app_private.set_updated_at();

create trigger memory_references_set_updated_at
before update on public.memory_references
for each row execute function app_private.set_updated_at();

insert into public.roles (key, name, description) values
  ('rhys', 'Rhys', 'Business owner and final approver'),
  ('pat', 'Pat', 'Operations and delegated task reviewer'),
  ('jian', 'Jian', 'Monday and delivery approval reviewer'),
  ('corey', 'Corey', 'Content workflow user'),
  ('dante_admin', 'Dante/Admin', 'Workspace operator and system administrator'),
  ('worker', 'Worker', 'Server-side worker/runtime identity')
on conflict (key) do update set name = excluded.name, description = excluded.description;

insert into public.permissions (key, description)
select *
from (values
  ('users.read_team', 'Read team user directory'),
  ('users.invite', 'Invite users'),
  ('users.disable', 'Disable users'),
  ('users.manage_roles', 'Manage user roles'),
  ('projects.read_all', 'Read all project metadata'),
  ('projects.read_assigned', 'Read assigned or role-scoped projects'),
  ('projects.create', 'Create projects'),
  ('projects.update', 'Update projects'),
  ('projects.archive', 'Archive projects'),
  ('jobs.read', 'Read allowed jobs'),
  ('jobs.create.audit', 'Create Executive Audit Typeform/business-intake jobs'),
  ('jobs.create.content', 'Create content jobs'),
  ('jobs.create.ops', 'Create operations jobs'),
  ('jobs.retry', 'Retry recoverable jobs'),
  ('jobs.cancel', 'Cancel jobs'),
  ('jobs.operator_claim', 'Claim jobs as worker/operator'),
  ('job_events.append', 'Append job progress events'),
  ('approvals.read', 'Read allowed approvals'),
  ('approvals.create', 'Create approval requests'),
  ('approvals.decide.comms', 'Decide delegated communications approvals'),
  ('approvals.decide.monday', 'Decide Monday/delivery approvals'),
  ('approvals.decide.artifact_review', 'Decide artifact review approvals'),
  ('artifacts.read', 'Read allowed artifacts'),
  ('artifacts.upload', 'Upload artifacts'),
  ('artifacts.validate', 'Validate artifacts'),
  ('artifacts.sign_url', 'Create signed artifact URLs'),
  ('artifacts.quarantine', 'Quarantine unsafe artifacts'),
  ('memory.read.strategy', 'Read strategic memory references'),
  ('memory.read.ops', 'Read operations memory references'),
  ('memory.read.content', 'Read content memory references'),
  ('memory.read.monday', 'Read Monday/delivery memory references'),
  ('memory.read.client_sensitive', 'Read client-sensitive memory references'),
  ('memory.write.librarian', 'Write curated memory references'),
  ('memory.manage', 'Manage memory scopes and quality'),
  ('tasks.read', 'Read allowed tasks'),
  ('tasks.create', 'Create tasks'),
  ('tasks.assign', 'Assign tasks'),
  ('tasks.update_status', 'Update task status'),
  ('tasks.review', 'Review delegated tasks'),
  ('integrations.read', 'Read integration status'),
  ('integrations.sync', 'Run integration syncs'),
  ('integrations.configure', 'Configure integrations'),
  ('admin.read_audit_logs', 'Read audit logs'),
  ('admin.read_safe_logs', 'Read safe operator logs'),
  ('admin.recover_jobs', 'Recover jobs'),
  ('admin.manage_system', 'Manage system configuration')
) as p(key, description)
on conflict (key) do update set description = excluded.description;

create or replace function app_private.seed_role_permissions(role_key text, permission_keys text[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.key = any(permission_keys)
  where r.key = role_key
  on conflict do nothing;
end;
$$;

select app_private.seed_role_permissions('rhys', array[
  'users.read_team',
  'projects.read_all','projects.create','projects.update','projects.archive',
  'jobs.read','jobs.create.audit','jobs.create.content','jobs.create.ops','jobs.retry','jobs.cancel',
  'job_events.append',
  'approvals.read','approvals.create','approvals.decide.comms','approvals.decide.monday',
  'approvals.decide.artifact_review',
  'artifacts.read','artifacts.sign_url',
  'memory.read.strategy','memory.read.ops','memory.read.content','memory.read.monday','memory.read.client_sensitive',
  'tasks.read','tasks.create','tasks.assign','tasks.update_status','tasks.review',
  'integrations.read'
]);

select app_private.seed_role_permissions('pat', array[
  'projects.read_assigned',
  'jobs.read','jobs.create.ops',
  'approvals.read','approvals.create','approvals.decide.comms',
  'artifacts.read','artifacts.sign_url',
  'memory.read.ops',
  'tasks.read','tasks.create','tasks.update_status','tasks.review',
  'integrations.read'
]);

select app_private.seed_role_permissions('jian', array[
  'projects.read_assigned',
  'jobs.read',
  'approvals.read','approvals.decide.monday',
  'artifacts.read','artifacts.sign_url',
  'memory.read.monday',
  'tasks.read','tasks.update_status'
]);

select app_private.seed_role_permissions('corey', array[
  'projects.read_assigned',
  'jobs.read','jobs.create.content',
  'artifacts.read','artifacts.sign_url',
  'memory.read.content',
  'tasks.read','tasks.update_status'
]);

select app_private.seed_role_permissions('dante_admin', array[
  'users.read_team','users.invite','users.disable','users.manage_roles',
  'projects.read_all','projects.create','projects.update','projects.archive',
  'jobs.read','jobs.retry','jobs.cancel','jobs.operator_claim',
  'job_events.append',
  'approvals.read',
  'artifacts.read','artifacts.sign_url','artifacts.quarantine',
  'memory.manage',
  'tasks.read',
  'integrations.read','integrations.sync','integrations.configure',
  'admin.read_audit_logs','admin.read_safe_logs','admin.recover_jobs','admin.manage_system'
]);

select app_private.seed_role_permissions('worker', array[
  'jobs.operator_claim',
  'job_events.append',
  'approvals.create',
  'artifacts.upload',
  'artifacts.validate'
]);

drop function app_private.seed_role_permissions(text, text[]);

insert into public.projects (key, name, type, sensitivity, metadata) values
  ('undeniable-os', 'Undeniable OS', 'workspace', 'internal', '{"canonical": true}'::jsonb),
  ('audits', 'Executive Audits', 'audit', 'client_sensitive',
    '{"source": "typeform_business_intake", "short_term_slack_bridge": "#l2-audits", "canonical_state": "workspace_jobs_and_artifacts"}'::jsonb),
  ('content', 'Content', 'content', 'content', '{"cadence": "thursday_pack_friday_review_monday_filming"}'::jsonb),
  ('monday-delivery', 'Monday / Delivery', 'delivery', 'ops', '{"approval_scope": "monday_updates"}'::jsonb),
  ('ops', 'Operations', 'ops', 'ops', '{"approval_scope": "pat_tasks_reaper_comms"}'::jsonb)
on conflict (key) do update set
  name = excluded.name,
  type = excluded.type,
  sensitivity = excluded.sensitivity,
  metadata = excluded.metadata;

insert into public.project_role_access (project_id, role_id)
select p.id, r.id
from public.projects p
join public.roles r on (
  (p.key = 'undeniable-os' and r.key in ('rhys', 'dante_admin')) or
  (p.key = 'audits' and r.key in ('rhys', 'dante_admin')) or
  (p.key = 'content' and r.key in ('rhys', 'corey', 'dante_admin')) or
  (p.key = 'monday-delivery' and r.key in ('rhys', 'jian', 'dante_admin')) or
  (p.key = 'ops' and r.key in ('rhys', 'pat', 'dante_admin'))
)
on conflict do nothing;

create or replace function app_private.current_role_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.key
  from public.users u
  join public.roles r on r.id = u.default_role_id
  where u.id = auth.uid()
    and u.status = 'active';
$$;

create or replace function app_private.current_role_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.default_role_id
  from public.users u
  where u.id = auth.uid()
    and u.status = 'active';
$$;

create or replace function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(app_private.current_role_key() = 'dante_admin', false);
$$;

create or replace function app_private.has_permission(permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.users u
    join public.role_permissions rp on rp.role_id = u.default_role_id
    join public.permissions p on p.id = rp.permission_id
    where u.id = auth.uid()
      and u.status = 'active'
      and p.key = permission_key
  ), false);
$$;

create or replace function app_private.can_access_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.status = 'active'
      and (
        app_private.has_permission('projects.read_all')
        or exists (
          select 1
          from public.project_role_access pra
          where pra.project_id = target_project_id
            and pra.role_id = u.default_role_id
        )
        or exists (
          select 1
          from public.project_members pm
          where pm.project_id = target_project_id
            and pm.user_id = auth.uid()
        )
      )
  ), false);
$$;

create or replace function app_private.can_read_memory_scope(scope_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case scope_key
    when 'strategy' then app_private.has_permission('memory.read.strategy') or app_private.has_permission('memory.manage')
    when 'ops' then app_private.has_permission('memory.read.ops') or app_private.has_permission('memory.manage')
    when 'content' then app_private.has_permission('memory.read.content') or app_private.has_permission('memory.manage')
    when 'monday' then app_private.has_permission('memory.read.monday') or app_private.has_permission('memory.manage')
    when 'client_sensitive' then app_private.has_permission('memory.read.client_sensitive') or app_private.has_permission('memory.manage')
    when 'admin' then app_private.has_permission('memory.manage')
    else false
  end;
$$;

create or replace function app_private.has_valid_job_lease(target_job_id uuid, target_lease_token uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(exists (
    select 1
    from public.jobs j
    where j.id = target_job_id
      and j.lease_token = target_lease_token
      and j.locked_by_user_id = auth.uid()
      and j.lease_expires_at > now()
  ), false);
$$;

create or replace function app_private.log_audit(
  action text,
  entity_type text,
  entity_id uuid,
  project_id uuid,
  details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, project_id, details)
  values (auth.uid(), action, entity_type, entity_id, project_id, coalesce(details, '{}'::jsonb));
end;
$$;

create or replace function public.create_job(
  project_key text,
  job_type text,
  title text,
  input jsonb default '{}'::jsonb,
  source_refs jsonb default '[]'::jsonb,
  idempotency_key text default null
)
returns table (job_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_project_id uuid;
  required_permission text;
  existing_job public.jobs;
  inserted_job public.jobs;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select p.id into target_project_id
  from public.projects p
  where p.key = create_job.project_key
    and p.status = 'active';

  if target_project_id is null then
    raise exception 'project not found';
  end if;

  if not app_private.can_access_project(target_project_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  required_permission := case job_type
    when 'audit' then 'jobs.create.audit'
    when 'content_batch' then 'jobs.create.content'
    when 'ops' then 'jobs.create.ops'
    when 'approval_projection' then 'jobs.create.ops'
    when 'memory_maintenance' then 'admin.recover_jobs'
    when 'call_processor' then 'jobs.create.ops'
    when 'doc_export' then 'jobs.create.ops'
    else null
  end;

  if required_permission is null or not app_private.has_permission(required_permission) then
    raise exception 'missing permission for job type' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(source_refs, '[]'::jsonb)) <> 'array' then
    raise exception 'source_refs must be a json array';
  end if;

  if idempotency_key is not null then
    select * into existing_job
    from public.jobs j
    where j.idempotency_key = create_job.idempotency_key;

    if found then
      if not app_private.can_access_project(existing_job.project_id) then
        raise exception 'forbidden' using errcode = '42501';
      end if;
      return query select existing_job.id, existing_job.status;
      return;
    end if;
  end if;

  insert into public.jobs (
    project_id,
    type,
    title,
    requested_by,
    input,
    source_refs,
    idempotency_key,
    status,
    current_step
  )
  values (
    target_project_id,
    job_type,
    title,
    auth.uid(),
    coalesce(input, '{}'::jsonb),
    coalesce(source_refs, '[]'::jsonb),
    idempotency_key,
    'queued',
    'Queued'
  )
  returning * into inserted_job;

  insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, step, summary)
  values (inserted_job.id, auth.uid(), 'user', 'created', 'Queued', 'Job created in Workspace.');

  perform app_private.log_audit('create_job', 'job', inserted_job.id, target_project_id, jsonb_build_object('type', job_type));

  return query select inserted_job.id, inserted_job.status;
end;
$$;

create or replace function public.claim_next_job(
  job_types text[] default null,
  lease_seconds integer default 300
)
returns table (job_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.jobs;
  next_lease uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not app_private.has_permission('jobs.operator_claim') then
    raise exception 'missing job claim permission' using errcode = '42501';
  end if;

  if lease_seconds is null or lease_seconds < 30 or lease_seconds > 3600 then
    raise exception 'lease_seconds must be between 30 and 3600';
  end if;

  update public.jobs j
  set
    status = 'running',
    started_at = coalesce(j.started_at, now()),
    heartbeat_at = now(),
    locked_by_user_id = auth.uid(),
    lease_token = next_lease,
    lease_expires_at = now() + make_interval(secs => lease_seconds),
    current_step = coalesce(j.current_step, 'Claimed by worker')
  where j.id = (
    select q.id
    from public.jobs q
    where q.status in ('queued', 'failed_recoverable')
      and (job_types is null or q.type = any(job_types))
      and (q.lease_expires_at is null or q.lease_expires_at <= now())
    order by q.queued_at asc
    for update skip locked
    limit 1
  )
  returning * into claimed;

  if not found then
    return;
  end if;

  insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, step, summary)
  values (claimed.id, auth.uid(), 'worker', 'phase_started', claimed.current_step, 'Job claimed by worker.');

  perform app_private.log_audit('claim_next_job', 'job', claimed.id, claimed.project_id, '{}'::jsonb);

  return query select claimed.id, next_lease;
end;
$$;

create or replace function public.append_job_event(
  job_id uuid,
  lease_token uuid,
  event_type text,
  step text default null,
  summary text default null,
  payload jsonb default '{}'::jsonb,
  severity text default 'info'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_job public.jobs;
  inserted_id bigint;
  actor_kind text := 'user';
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into target_job from public.jobs j where j.id = append_job_event.job_id;
  if not found then
    raise exception 'job not found';
  end if;

  if not (
    app_private.is_admin()
    or app_private.has_valid_job_lease(job_id, lease_token)
    or (app_private.can_access_project(target_job.project_id) and app_private.has_permission('job_events.append'))
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if app_private.current_role_key() = 'worker' then
    actor_kind := 'worker';
  elsif app_private.is_admin() then
    actor_kind := 'admin';
  end if;

  insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, step, summary, payload, severity)
  values (job_id, auth.uid(), actor_kind, event_type, step, summary, coalesce(payload, '{}'::jsonb), severity)
  returning id into inserted_id;

  update public.jobs j
  set
    heartbeat_at = case when event_type = 'heartbeat' then now() else j.heartbeat_at end,
    current_step = coalesce(step, j.current_step),
    updated_at = now()
  where j.id = job_id;

  return inserted_id;
end;
$$;

create or replace function public.complete_job(
  job_id uuid,
  lease_token uuid,
  next_status text default 'completed',
  summary text default 'Job completed.'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_job public.jobs;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if next_status not in ('ready_for_review', 'waiting_for_approval', 'completed') then
    raise exception 'invalid completion status';
  end if;

  select * into target_job from public.jobs j where j.id = complete_job.job_id;
  if not found then
    raise exception 'job not found';
  end if;

  if not (app_private.is_admin() or app_private.has_valid_job_lease(job_id, lease_token)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.jobs j
  set
    status = next_status,
    current_step = summary,
    progress_pct = case when next_status = 'completed' then 100 else j.progress_pct end,
    heartbeat_at = now(),
    lease_expires_at = null,
    lease_token = null,
    locked_by_user_id = null,
    finished_at = case when next_status = 'completed' then now() else j.finished_at end
  where j.id = job_id;

  insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, step, summary)
  values (job_id, auth.uid(), case when app_private.current_role_key() = 'worker' then 'worker' else 'admin' end, 'completed', next_status, summary);

  perform app_private.log_audit('complete_job', 'job', job_id, target_job.project_id, jsonb_build_object('status', next_status));

  return true;
end;
$$;

create or replace function public.fail_job(
  job_id uuid,
  lease_token uuid,
  recoverable boolean default true,
  safe_message text default 'Job failed.'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_job public.jobs;
  next_status text := case when recoverable then 'failed_recoverable' else 'failed_blocked' end;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into target_job from public.jobs j where j.id = fail_job.job_id;
  if not found then
    raise exception 'job not found';
  end if;

  if not (app_private.is_admin() or app_private.has_valid_job_lease(job_id, lease_token)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.jobs j
  set
    status = next_status,
    current_step = safe_message,
    recovery = jsonb_set(coalesce(j.recovery, '{}'::jsonb), '{last_failure}', jsonb_build_object('message', safe_message, 'recoverable', recoverable, 'at', now())),
    heartbeat_at = now(),
    lease_expires_at = null,
    lease_token = null,
    locked_by_user_id = null,
    finished_at = case when recoverable then j.finished_at else now() end
  where j.id = job_id;

  insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, step, summary, severity)
  values (job_id, auth.uid(), case when app_private.current_role_key() = 'worker' then 'worker' else 'admin' end, 'failed', next_status, safe_message, 'error');

  perform app_private.log_audit('fail_job', 'job', job_id, target_job.project_id, jsonb_build_object('status', next_status));

  return true;
end;
$$;

create or replace function public.create_approval(
  job_id uuid,
  action_type text,
  subject text,
  exact_payload jsonb,
  required_permission text,
  destination jsonb default '{}'::jsonb,
  artifact_id uuid default null,
  lease_token uuid default null,
  expires_at timestamptz default null
)
returns table (approval_id uuid, payload_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_job public.jobs;
  target_artifact public.artifacts;
  computed_hash text;
  inserted public.approvals;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not app_private.has_permission('approvals.create') then
    raise exception 'missing approval create permission' using errcode = '42501';
  end if;

  if exact_payload is null then
    raise exception 'exact_payload is required';
  end if;

  if subject is null or btrim(subject) = '' then
    raise exception 'subject is required';
  end if;

  select * into target_job from public.jobs j where j.id = create_approval.job_id;
  if not found then
    raise exception 'job not found';
  end if;

  if create_approval.artifact_id is not null then
    select * into target_artifact from public.artifacts a where a.id = create_approval.artifact_id;
    if not found or target_artifact.project_id <> target_job.project_id then
      raise exception 'artifact does not belong to job project';
    end if;
  end if;

  if not (
    app_private.can_access_project(target_job.project_id)
    or app_private.has_valid_job_lease(job_id, lease_token)
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if app_private.current_role_key() = 'worker' and not app_private.has_valid_job_lease(job_id, lease_token) then
    raise exception 'worker approval requests require a valid job lease' using errcode = '42501';
  end if;

  if required_permission not like 'approvals.decide.%' then
    raise exception 'required_permission must be an approval decision permission';
  end if;

  computed_hash := encode(extensions.digest(exact_payload::text, 'sha256'), 'hex');

  insert into public.approvals (
    project_id,
    job_id,
    artifact_id,
    action_type,
    subject,
    destination,
    exact_payload,
    payload_hash,
    required_permission,
    requested_by,
    expires_at
  )
  values (
    target_job.project_id,
    job_id,
    artifact_id,
    action_type,
    subject,
    coalesce(destination, '{}'::jsonb),
    exact_payload,
    computed_hash,
    required_permission,
    auth.uid(),
    expires_at
  )
  returning * into inserted;

  insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, summary, payload)
  values (
    job_id,
    auth.uid(),
    case when app_private.current_role_key() = 'worker' then 'worker' else 'user' end,
    'approval_requested',
    'Approval requested.',
    jsonb_build_object('approval_id', inserted.id)
  );

  perform app_private.log_audit('create_approval', 'approval', inserted.id, target_job.project_id, jsonb_build_object('action_type', action_type));

  return query select inserted.id, inserted.payload_hash;
end;
$$;

create or replace function public.decide_approval(
  approval_id uuid,
  decision text,
  payload_hash text,
  decision_note text default null
)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.approvals;
  next_status text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if app_private.current_role_key() = 'worker' then
    raise exception 'workers cannot decide approvals' using errcode = '42501';
  end if;

  if decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into target
  from public.approvals a
  where a.id = decide_approval.approval_id
  for update;

  if not found then
    raise exception 'approval not found';
  end if;

  if target.status <> 'pending' then
    raise exception 'approval is not pending';
  end if;

  if target.expires_at is not null and target.expires_at <= now() then
    update public.approvals a
    set status = 'expired'
    where a.id = target.id;
    raise exception 'approval expired';
  end if;

  if target.payload_hash <> decide_approval.payload_hash then
    raise exception 'payload hash mismatch' using errcode = '22000';
  end if;

  if not app_private.can_access_project(target.project_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not app_private.has_permission(target.required_permission) then
    raise exception 'missing approval decision permission' using errcode = '42501';
  end if;

  next_status := decision;

  update public.approvals a
  set
    status = next_status,
    decided_by = auth.uid(),
    decided_at = now(),
    decision_note = decide_approval.decision_note
  where a.id = target.id;

  if target.job_id is not null then
    insert into public.job_events (job_id, actor_user_id, actor_kind, event_type, summary, payload)
    values (target.job_id, auth.uid(), 'user', 'approval_decided', 'Approval ' || next_status || '.', jsonb_build_object('approval_id', target.id, 'decision', next_status));
  end if;

  perform app_private.log_audit('decide_approval', 'approval', target.id, target.project_id, jsonb_build_object('decision', next_status));

  return query select target.id, next_status;
end;
$$;

revoke all on schema app_private from public;
revoke all on all functions in schema app_private from public;
revoke all on function public.create_job(text, text, text, jsonb, jsonb, text) from public;
revoke all on function public.claim_next_job(text[], integer) from public;
revoke all on function public.append_job_event(uuid, uuid, text, text, text, jsonb, text) from public;
revoke all on function public.complete_job(uuid, uuid, text, text) from public;
revoke all on function public.fail_job(uuid, uuid, boolean, text) from public;
revoke all on function public.create_approval(uuid, text, text, jsonb, text, jsonb, uuid, uuid, timestamptz) from public;
revoke all on function public.decide_approval(uuid, text, text, text) from public;

grant usage on schema app_private to authenticated;
grant execute on function app_private.current_role_key() to authenticated;
grant execute on function app_private.current_role_id() to authenticated;
grant execute on function app_private.is_admin() to authenticated;
grant execute on function app_private.has_permission(text) to authenticated;
grant execute on function app_private.can_access_project(uuid) to authenticated;
grant execute on function app_private.can_read_memory_scope(text) to authenticated;
grant execute on function app_private.has_valid_job_lease(uuid, uuid) to authenticated;

grant select on table
  public.users,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.projects,
  public.project_role_access,
  public.project_members,
  public.jobs,
  public.job_events,
  public.artifacts,
  public.approvals,
  public.tasks,
  public.memory_references,
  public.audit_logs
to authenticated;

grant execute on function public.create_job(text, text, text, jsonb, jsonb, text) to authenticated;
grant execute on function public.claim_next_job(text[], integer) to authenticated;
grant execute on function public.append_job_event(uuid, uuid, text, text, text, jsonb, text) to authenticated;
grant execute on function public.complete_job(uuid, uuid, text, text) to authenticated;
grant execute on function public.fail_job(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.create_approval(uuid, text, text, jsonb, text, jsonb, uuid, uuid, timestamptz) to authenticated;
grant execute on function public.decide_approval(uuid, text, text, text) to authenticated;

create policy users_select_self_or_team
on public.users
for select
to authenticated
using (
  auth.uid() is not null
  and (id = auth.uid() or app_private.has_permission('users.read_team'))
);

create policy roles_select_catalog
on public.roles
for select
to authenticated
using (auth.uid() is not null);

create policy permissions_select_own_or_admin
on public.permissions
for select
to authenticated
using (
  auth.uid() is not null
  and (
    app_private.is_admin()
    or exists (
      select 1
      from public.role_permissions rp
      where rp.permission_id = permissions.id
        and rp.role_id = app_private.current_role_id()
    )
  )
);

create policy role_permissions_select_own_or_admin
on public.role_permissions
for select
to authenticated
using (
  auth.uid() is not null
  and (app_private.is_admin() or role_id = app_private.current_role_id())
);

create policy projects_select_accessible
on public.projects
for select
to authenticated
using (
  auth.uid() is not null
  and app_private.can_access_project(id)
);

create policy project_role_access_select_own_or_admin
on public.project_role_access
for select
to authenticated
using (
  auth.uid() is not null
  and (app_private.is_admin() or role_id = app_private.current_role_id())
);

create policy project_members_select_accessible
on public.project_members
for select
to authenticated
using (
  auth.uid() is not null
  and (user_id = auth.uid() or app_private.can_access_project(project_id))
);

create policy jobs_select_accessible
on public.jobs
for select
to authenticated
using (
  auth.uid() is not null
  and app_private.can_access_project(project_id)
);

create policy job_events_select_accessible
on public.job_events
for select
to authenticated
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.jobs j
    where j.id = job_events.job_id
      and app_private.can_access_project(j.project_id)
  )
);

create policy artifacts_select_accessible
on public.artifacts
for select
to authenticated
using (
  auth.uid() is not null
  and app_private.can_access_project(project_id)
  and (
    visibility <> 'admin_only'
    or app_private.is_admin()
  )
);

create policy approvals_select_accessible
on public.approvals
for select
to authenticated
using (
  auth.uid() is not null
  and app_private.can_access_project(project_id)
  and app_private.has_permission('approvals.read')
);

create policy tasks_select_accessible
on public.tasks
for select
to authenticated
using (
  auth.uid() is not null
  and (
    owner_user_id = auth.uid()
    or (app_private.can_access_project(project_id) and app_private.has_permission('tasks.read'))
  )
);

create policy memory_references_select_accessible
on public.memory_references
for select
to authenticated
using (
  auth.uid() is not null
  and app_private.can_access_project(project_id)
  and app_private.can_read_memory_scope(scope)
);

create policy audit_logs_select_admin
on public.audit_logs
for select
to authenticated
using (
  auth.uid() is not null
  and app_private.has_permission('admin.read_audit_logs')
);

commit;
