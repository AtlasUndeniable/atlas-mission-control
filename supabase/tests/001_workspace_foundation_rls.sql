-- Atlas Workspace foundation RLS/RPC smoke tests.
-- Run only against a local Supabase database after applying
-- supabase/migrations/001_atlas_workspace_foundation.sql.
-- Draft safety label: not executed in this repo yet because local
-- Supabase/Postgres tooling was unavailable when created.

begin;

create schema if not exists test_private;

create or replace function test_private.assert_text_array_eq(test_name text, actual text[], expected text[])
returns void
language plpgsql
as $$
begin
  if coalesce(actual, '{}'::text[]) <> expected then
    raise exception '% expected %, got %', test_name, expected, actual;
  end if;
end;
$$;

create or replace function test_private.assert_int_eq(test_name text, actual integer, expected integer)
returns void
language plpgsql
as $$
begin
  if actual <> expected then
    raise exception '% expected %, got %', test_name, expected, actual;
  end if;
end;
$$;

create or replace function test_private.assert_bool_eq(test_name text, actual boolean, expected boolean)
returns void
language plpgsql
as $$
begin
  if actual is distinct from expected then
    raise exception '% expected %, got %', test_name, expected, actual;
  end if;
end;
$$;

grant usage on schema test_private to authenticated;
grant execute on all functions in schema test_private to authenticated;

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rhys@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pat@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'jian@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'corey@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dante@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'worker@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into public.users (id, email, display_name, default_role_id)
select v.id::uuid, v.email, v.name, r.id
from (values
  ('00000000-0000-0000-0000-000000000001', 'rhys@test.local', 'Rhys', 'rhys'),
  ('00000000-0000-0000-0000-000000000002', 'pat@test.local', 'Pat', 'pat'),
  ('00000000-0000-0000-0000-000000000003', 'jian@test.local', 'Jian', 'jian'),
  ('00000000-0000-0000-0000-000000000004', 'corey@test.local', 'Corey', 'corey'),
  ('00000000-0000-0000-0000-000000000005', 'dante@test.local', 'Dante', 'dante_admin'),
  ('00000000-0000-0000-0000-000000000006', 'worker@test.local', 'Worker', 'worker')
) as v(id, email, name, role_key)
join public.roles r on r.key = v.role_key
on conflict (id) do update set default_role_id = excluded.default_role_id;

-- Anonymous/no-JWT behavior:
-- Direct `set local role anon; select count(*) from public.projects;` should fail
-- with permission denied because anon has no table grants.
-- An authenticated session with no JWT subject should see zero rows.
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
do $$
declare
  n integer;
begin
  select count(*) into n from public.projects;
  perform test_private.assert_int_eq('authenticated without jwt sees no projects', n, 0);
end;
$$;

-- Rhys sees all seeded business projects.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare
  actual text[];
begin
  select array_agg(key order by key) into actual from public.projects;
  perform test_private.assert_text_array_eq(
    'rhys projects',
    actual,
    array['audits', 'content', 'monday-delivery', 'ops', 'undeniable-os']
  );
end;
$$;

-- Pat sees ops/delegated surface.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}';
do $$
declare
  actual text[];
begin
  select array_agg(key order by key) into actual from public.projects;
  perform test_private.assert_text_array_eq('pat projects', actual, array['ops']);
end;
$$;

-- Jian sees monday-delivery only. Spelling is intentionally Jian.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}';
do $$
declare
  actual text[];
begin
  select array_agg(key order by key) into actual from public.projects;
  perform test_private.assert_text_array_eq('jian projects', actual, array['monday-delivery']);
end;
$$;

-- Corey sees content only and cannot see audit/private ops artifacts by default.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}';
do $$
declare
  actual text[];
begin
  select array_agg(key order by key) into actual from public.projects;
  perform test_private.assert_text_array_eq('corey projects', actual, array['content']);
end;
$$;

reset role;

-- Seed local-only rows for task, approval, artifact, and worker RPC tests.
insert into public.jobs (id, project_id, type, title, status, input, source_refs)
select
  '10000000-0000-0000-0000-000000000001',
  p.id,
  'ops',
  'Local worker claim smoke test',
  'queued',
  '{"fixture":true}'::jsonb,
  '[]'::jsonb
from public.projects p
where p.key = 'ops'
on conflict (id) do nothing;

insert into public.tasks (id, project_id, title, status, owner_role_key)
select
  '20000000-0000-0000-0000-000000000001',
  p.id,
  'Pat local task surface',
  'open',
  'pat'
from public.projects p
where p.key = 'ops'
on conflict (id) do nothing;

insert into public.artifacts (id, project_id, job_id, title, type, status, validation_status, sensitivity, visibility)
select
  '30000000-0000-0000-0000-000000000001',
  p.id,
  null,
  'Audit artifact fixture',
  'pdf',
  'ready_for_review',
  'passed',
  'client_confidential',
  'role_restricted'
from public.projects p
where p.key = 'audits'
on conflict (id) do nothing;

insert into public.approvals (
  id,
  project_id,
  action_type,
  subject,
  exact_payload,
  payload_hash,
  required_permission,
  status
)
select
  '40000000-0000-0000-0000-000000000001',
  p.id,
  'slack_reply',
  'Pat local approval surface',
  '{"text":"fixture"}'::jsonb,
  encode(digest('{"text": "fixture"}', 'sha256'), 'hex'),
  'approvals.decide.comms',
  'pending'
from public.projects p
where p.key = 'ops'
on conflict (id) do nothing;

-- Pat can see ops approval/task surfaces.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}';
do $$
declare
  task_count integer;
  approval_count integer;
begin
  select count(*) into task_count from public.tasks where title = 'Pat local task surface';
  select count(*) into approval_count from public.approvals where subject = 'Pat local approval surface';
  perform test_private.assert_int_eq('pat task surface count', task_count, 1);
  perform test_private.assert_int_eq('pat approval surface count', approval_count, 1);
end;
$$;

-- Corey cannot see audit artifact rows.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}';
do $$
declare
  artifact_count integer;
  approval_count integer;
begin
  select count(*) into artifact_count from public.artifacts where title = 'Audit artifact fixture';
  select count(*) into approval_count from public.approvals where subject = 'Pat local approval surface';
  perform test_private.assert_int_eq('corey audit artifact count', artifact_count, 0);
  perform test_private.assert_int_eq('corey ops approval count', approval_count, 0);
end;
$$;

-- Rhys can see audit artifact rows.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}';
do $$
declare
  artifact_count integer;
begin
  select count(*) into artifact_count from public.artifacts where title = 'Audit artifact fixture';
  perform test_private.assert_int_eq('rhys audit artifact count', artifact_count, 1);
end;
$$;

-- Worker can claim and append events, can request an approval for a leased job,
-- but cannot decide approvals.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000006';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000006","role":"authenticated"}';
do $$
declare
  claimed_job_id uuid;
  claimed_lease uuid;
  event_id bigint;
  approval_id uuid;
  approval_hash text;
  worker_project_count integer;
  can_decide boolean;
begin
  select count(*) into worker_project_count from public.projects;
  perform test_private.assert_int_eq('worker broad project count', worker_project_count, 0);

  select c.job_id, c.lease_token
  into claimed_job_id, claimed_lease
  from public.claim_next_job(array['ops'], 300) c;

  if claimed_job_id is null or claimed_lease is null then
    raise exception 'worker did not claim queued job';
  end if;

  event_id := public.append_job_event(
    claimed_job_id,
    claimed_lease,
    'heartbeat',
    'Local smoke',
    'Worker heartbeat written by RPC.',
    '{}'::jsonb,
    'info'
  );

  if event_id is null then
    raise exception 'worker did not append event';
  end if;

  select ca.approval_id, ca.payload_hash
  into approval_id, approval_hash
  from public.create_approval(
    claimed_job_id,
    'task_update',
    'Worker-created local approval request',
    '{"body":"fixture"}'::jsonb,
    'approvals.decide.comms',
    '{"kind":"workspace","label":"local"}'::jsonb,
    null,
    claimed_lease,
    null
  ) ca;

  begin
    perform * from public.decide_approval(approval_id, 'approved', approval_hash, 'worker should fail');
    can_decide := true;
  exception when others then
    can_decide := false;
  end;

  perform test_private.assert_bool_eq('worker cannot decide approval', can_decide, false);
end;
$$;

rollback;
