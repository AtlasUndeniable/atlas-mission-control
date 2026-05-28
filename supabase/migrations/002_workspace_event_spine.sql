-- Atlas Workspace P2 event spine.
-- Local/dev migration only. Do not apply to production yet.
-- Extends the P1 /workspace-demo event contract without replacing the mock renderer.

begin;

create table if not exists public.workspaces (
  id text primary key,
  project_id uuid references public.projects(id) on delete restrict,
  title text not null,
  project_title text,
  active_task_id text,
  status text not null default 'active'
    check (status in ('active', 'archived')),
  owner_user_id uuid references public.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tasks
  add column if not exists workspace_id text references public.workspaces(id) on delete set null,
  add column if not exists event_task_id text,
  add column if not exists run_id text;

alter table public.artifacts
  add column if not exists workspace_id text references public.workspaces(id) on delete set null,
  add column if not exists event_artifact_id text,
  add column if not exists run_id text,
  add column if not exists subtitle text,
  add column if not exists preview text;

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('open', 'in_progress', 'waiting_for_review', 'done', 'cancelled', 'idle', 'running', 'complete', 'error'));

alter table public.artifacts drop constraint if exists artifacts_type_check;
alter table public.artifacts add constraint artifacts_type_check
  check (type in ('doc', 'pdf', 'transcript', 'overview', 'content_batch', 'report', 'data', 'markdown', 'preview', 'validation', 'approval_packet', 'document', 'spreadsheet', 'audit', 'brief', 'playbook'));

create table if not exists public.messages (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  task_id text,
  run_id text,
  role text not null
    check (role in ('user', 'assistant')),
  content text not null default '',
  complete boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.events (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  task_id text not null,
  run_id text not null,
  kind text not null
    check (kind in ('message.delta', 'message.complete', 'tool.call', 'tool.result', 'artifact.created', 'task.step', 'task.complete', 'error')),
  visibility text not null
    check (visibility in ('internal', 'presentation')),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create table if not exists public.plugins (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  key text not null,
  name text not null,
  status text not null default 'enabled'
    check (status in ('enabled', 'disabled')),
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table if not exists public.watchers (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  plugin_id text references public.plugins(id) on delete set null,
  kind text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'disabled', 'error')),
  target jsonb not null default '{}'::jsonb
    check (jsonb_typeof(target) = 'object'),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;
alter table public.tasks enable row level security;
alter table public.messages enable row level security;
alter table public.events enable row level security;
alter table public.artifacts enable row level security;
alter table public.plugins enable row level security;
alter table public.watchers enable row level security;

revoke all on table
  public.workspaces,
  public.messages,
  public.events,
  public.plugins,
  public.watchers
from anon, authenticated;

revoke all on table
  public.tasks,
  public.artifacts
from anon;

grant select on table
  public.workspaces,
  public.messages,
  public.events,
  public.plugins,
  public.watchers
to authenticated;

create index if not exists idx_workspaces_project_status on public.workspaces(project_id, status);
create index if not exists idx_workspaces_owner_user_id on public.workspaces(owner_user_id);
create index if not exists idx_tasks_workspace_status_updated_at on public.tasks(workspace_id, status, updated_at desc);
create unique index if not exists idx_tasks_workspace_event_task_id
  on public.tasks(workspace_id, event_task_id)
  where workspace_id is not null and event_task_id is not null;
create index if not exists idx_artifacts_workspace_created_at on public.artifacts(workspace_id, created_at desc);
create unique index if not exists idx_artifacts_workspace_event_artifact_id
  on public.artifacts(workspace_id, event_artifact_id)
  where workspace_id is not null and event_artifact_id is not null;
create index if not exists idx_messages_workspace_task_created_at on public.messages(workspace_id, task_id, created_at);
create index if not exists idx_events_workspace_task_created_at on public.events(workspace_id, task_id, created_at);
create index if not exists idx_events_workspace_run_created_at on public.events(workspace_id, run_id, created_at);
create index if not exists idx_events_workspace_visibility_created_at on public.events(workspace_id, visibility, created_at);
create index if not exists idx_events_visibility_created_at on public.events(visibility, created_at);
create index if not exists idx_events_presentation_replay on public.events(workspace_id, task_id, created_at)
  where visibility = 'presentation';
create index if not exists idx_plugins_workspace_status on public.plugins(workspace_id, status);
create index if not exists idx_watchers_workspace_status on public.watchers(workspace_id, status);

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function app_private.set_updated_at();

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at
before update on public.messages
for each row execute function app_private.set_updated_at();

drop trigger if exists plugins_set_updated_at on public.plugins;
create trigger plugins_set_updated_at
before update on public.plugins
for each row execute function app_private.set_updated_at();

drop trigger if exists watchers_set_updated_at on public.watchers;
create trigger watchers_set_updated_at
before update on public.watchers
for each row execute function app_private.set_updated_at();

drop policy if exists workspaces_select_accessible on public.workspaces;
create policy workspaces_select_accessible
on public.workspaces
for select
to authenticated
using (
  auth.uid() is not null
  and (
    owner_user_id = auth.uid()
    or app_private.is_admin()
    or (project_id is not null and app_private.can_access_project(project_id))
  )
);

drop policy if exists messages_select_accessible on public.messages;
create policy messages_select_accessible
on public.messages
for select
to authenticated
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.workspaces w
    where w.id = messages.workspace_id
      and (
        w.owner_user_id = auth.uid()
        or app_private.is_admin()
        or (w.project_id is not null and app_private.can_access_project(w.project_id))
      )
  )
);

drop policy if exists events_select_accessible on public.events;
create policy events_select_accessible
on public.events
for select
to authenticated
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.workspaces w
    where w.id = events.workspace_id
      and (
        w.owner_user_id = auth.uid()
        or app_private.is_admin()
        or (w.project_id is not null and app_private.can_access_project(w.project_id))
      )
  )
);

drop policy if exists plugins_select_accessible on public.plugins;
create policy plugins_select_accessible
on public.plugins
for select
to authenticated
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.workspaces w
    where w.id = plugins.workspace_id
      and (
        w.owner_user_id = auth.uid()
        or app_private.is_admin()
        or (w.project_id is not null and app_private.can_access_project(w.project_id))
      )
  )
);

drop policy if exists watchers_select_accessible on public.watchers;
create policy watchers_select_accessible
on public.watchers
for select
to authenticated
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.workspaces w
    where w.id = watchers.workspace_id
      and (
        w.owner_user_id = auth.uid()
        or app_private.is_admin()
        or (w.project_id is not null and app_private.can_access_project(w.project_id))
      )
  )
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.events;
    exception
      when duplicate_object then null;
    end;
  end if;
end;
$$;

commit;
