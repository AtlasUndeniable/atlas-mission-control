--
-- PostgreSQL database dump
--

\restrict P5AjCR2gMlF4MzUCeB65s3js73NAYV3jFz1QdeOzlNExpNaIxMfXGTibHknqUOT

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app_private; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA app_private;


ALTER SCHEMA app_private OWNER TO postgres;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: bounded_retrieve_policy(text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.bounded_retrieve_policy(p_audience text) RETURNS TABLE(recognised boolean, allow_financial boolean, allow_training boolean, allowed_scopes text[])
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
  select
    true,
    m.allow_financial,
    m.allow_training,
    m.allowed_scopes
  from (values
    ('rhys',  true,  true,  array['strategy','ops','content','monday','client_sensitive']),
    ('pat',   true,  false, array['ops']),
    ('staff', false, false, array['content','monday'])
  ) as m(key, allow_financial, allow_training, allowed_scopes)
  where m.key = pg_catalog.btrim(pg_catalog.lower(coalesce(p_audience, '')))
  union all
  select false, false, false, array[]::text[]
  where pg_catalog.btrim(pg_catalog.lower(coalesce(p_audience, ''))) not in ('rhys','pat','staff')
$$;


ALTER FUNCTION app_private.bounded_retrieve_policy(p_audience text) OWNER TO postgres;

--
-- Name: can_access_project(uuid); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.can_access_project(project_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select
    case
      when (select auth.uid()) is null then false        -- anon: nothing
      else (
        app_private.is_admin()
        or app_private.has_permission('projects.read_all')
        or exists (
          select 1
          from public.project_members pm
          where pm.project_id = can_access_project.project_id
            and pm.user_id = (select auth.uid())
        )
      )
    end;
$$;


ALTER FUNCTION app_private.can_access_project(project_id uuid) OWNER TO postgres;

--
-- Name: can_decide_in_project(text, uuid); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.can_decide_in_project(perm_key text, p_project_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select app_private.has_permission(perm_key)
     and app_private.can_access_project(p_project_id);
$$;


ALTER FUNCTION app_private.can_decide_in_project(perm_key text, p_project_id uuid) OWNER TO postgres;

--
-- Name: current_projection_worker(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.current_projection_worker() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_claims jsonb;
  v_role text;
  v_worker_id uuid;
begin
  begin
    v_claims := nullif(
      pg_catalog.current_setting('request.jwt.claims', true), ''
    )::jsonb;
  exception when others then
    raise exception using
      errcode = '42501',
      message = 'projection_actor_invalid';
  end;

  v_role := coalesce(v_claims ->> 'role', '');
  if v_role <> 'service_role'
     or pg_catalog.current_setting('role', true) <> 'service_role' then
    raise exception using
      errcode = '42501',
      message = 'projection_service_role_required';
  end if;

  begin
    v_worker_id := nullif(
      pg_catalog.current_setting('app.projection_worker_id', true), ''
    )::uuid;
  exception when others then
    raise exception using
      errcode = '42501',
      message = 'projection_worker_claim_invalid';
  end;

  if v_worker_id is null
     or not exists (
       select 1
       from public.projection_worker_principals p
       where p.id = v_worker_id
         and p.enabled
         and p.permission_key = 'memory.write.librarian'
     ) then
    raise exception using
      errcode = '42501',
      message = 'projection_worker_not_authorized';
  end if;

  return v_worker_id;
end;
$$;


ALTER FUNCTION app_private.current_projection_worker() OWNER TO postgres;

--
-- Name: FUNCTION current_projection_worker(); Type: COMMENT; Schema: app_private; Owner: postgres
--

COMMENT ON FUNCTION app_private.current_projection_worker() IS 'Local service actor seam. Hosted activation requires a non-forgeable principal boundary beyond service_role.';


--
-- Name: forbid_identity_escalation(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.forbid_identity_escalation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  jwt_claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  -- jwt_claims is non-null/non-empty only for a real end-user session.
  if jwt_claims is not null and jwt_claims <> '' then
    if new.role_id is distinct from old.role_id
       or new.id is distinct from old.id then
      raise exception 'role_id and id are not self-mutable (attempted privilege escalation)';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION app_private.forbid_identity_escalation() OWNER TO postgres;

--
-- Name: forbid_worker_human(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.forbid_worker_human() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.role_id = (select id from public.roles where key = 'worker') then
    raise exception 'the worker role cannot be assigned to an auth user (headless adapter only)';
  end if;
  return new;
end;
$$;


ALTER FUNCTION app_private.forbid_worker_human() OWNER TO postgres;

--
-- Name: has_permission(text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.has_permission(permission_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.users u
    join public.role_permissions rp on rp.role_id = u.role_id
    join public.permissions p        on p.id = rp.permission_id
    where u.id = (select auth.uid())   -- NULL for anon -> no row -> false
      and u.is_active
      and p.key = (has_permission.permission_key)::extensions.citext
      and pg_catalog.length(pg_catalog.btrim(has_permission.permission_key)) > 0
  );
$$;


ALTER FUNCTION app_private.has_permission(permission_key text) OWNER TO postgres;

--
-- Name: is_admin(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.id = (select auth.uid())      -- NULL for anon -> no row -> false
      and u.is_active
      and r.key = 'dante_admin'
  );
$$;


ALTER FUNCTION app_private.is_admin() OWNER TO postgres;

--
-- Name: is_person_key(text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.is_person_key(p_value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select
    p_value is not null
    and pg_catalog.length(p_value) between 2 and 64
    and p_value ~ '^[a-z0-9][a-z0-9_.-]*$';
$_$;


ALTER FUNCTION app_private.is_person_key(p_value text) OWNER TO postgres;

--
-- Name: is_safe_relative_markdown_path(text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.is_safe_relative_markdown_path(p_value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select
    p_value is not null
    and pg_catalog.length(p_value) between 4 and 2048
    and p_value = pg_catalog.replace(p_value, E'\\', '/')
    and p_value !~ '(^/|(^|/)\.\.?(/|$)|//|[[:cntrl:]])'
    and p_value ~ '\.md$';
$_$;


ALTER FUNCTION app_private.is_safe_relative_markdown_path(p_value text) OWNER TO postgres;

--
-- Name: is_sha256(text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.is_sha256(p_value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select p_value ~ '^[0-9a-f]{64}$';
$_$;


ALTER FUNCTION app_private.is_sha256(p_value text) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: workspace_actors; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.workspace_actors (
    db_role name NOT NULL,
    actor text NOT NULL,
    workspace_id uuid NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    epoch bigint DEFAULT 1 NOT NULL,
    CONSTRAINT workspace_actors_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'builder'::text])))
);

ALTER TABLE ONLY app_private.workspace_actors FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.workspace_actors OWNER TO postgres;

--
-- Name: meeting_actor(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.meeting_actor() RETURNS app_private.workspace_actors
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a app_private.workspace_actors:=app_private.workspace_actor();
begin
 perform 1 from app_private.meeting_reviewers where actor=a.actor and active for share;
 if not found then raise exception 'meeting_access_denied' using errcode='42501'; end if;return a;
end $$;


ALTER FUNCTION app_private.meeting_actor() OWNER TO postgres;

--
-- Name: meeting_add_item(text, jsonb, text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.meeting_add_item(sid text, candidate jsonb, creator text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare m app_private.meetings;s app_private.meeting_scope;p app_private.meeting_policy;rid uuid; requested jsonb;
begin
 select * into m from app_private.meetings where source_id=sid;
 select * into s from app_private.meeting_scope where source_id=sid and active;
 select * into p from app_private.meeting_policy where id=m.policy and active;
 if s.source_id is null or p.id is null then raise exception 'source_not_released' using errcode='42501';end if;
 if candidate->>'key' !~ '^mc2:[a-f0-9]{32}$' or length(candidate->>'title') not between 1 and 300
 or length(candidate->>'quote') not between 1 and 2000 or candidate->>'sourceRevision' is distinct from m.revision
 or candidate->>'kind' not in ('promise','request','suggestion') or candidate->>'provenance' not in ('transcript','provider_summary') then raise exception 'invalid_candidate';end if;
 select request_id into rid from app_private.meeting_keys where source_id=sid and commitment_key=candidate->>'key';if found then return rid;end if;
 if exists(select 1 from public.requests where idempotency_key=candidate->>'key') or exists(select 1 from public.request_source_bindings where commitment_key=candidate->>'key') then raise exception 'existing_commitment_requires_lineage_review';end if;
 requested:=jsonb_build_object('title',candidate->>'title','lane','business','kind','generic','owner',null,'due',candidate->'due','source_quote',candidate->>'quote');
 insert into public.requests(adapter,requester_principal,requested_by,requester_role,idempotency_key,client,project_key,source_type,source_id,origin_ref,permitted_audience,requested,input_hash)
 values('meeting_intake',creator,creator,'worker',candidate->>'key',s.client,(select key from public.projects where id=p.workspace_id),'call',sid,jsonb_build_object('provider','fireflies','revision',m.revision),array[creator],requested,repeat('0',64)) returning id into rid;
 insert into app_private.meeting_items(request_id,source_id,commitment_key,evidence,reviewed_revision)values(rid,sid,candidate->>'key',candidate,m.revision);
 insert into app_private.meeting_keys values(sid,candidate->>'key',rid);
 return rid;
end $_$;


ALTER FUNCTION app_private.meeting_add_item(sid text, candidate jsonb, creator text) OWNER TO postgres;

--
-- Name: meeting_binding_guard(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.meeting_binding_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if exists(select 1 from app_private.meeting_items where request_id=case when tg_op='DELETE' then old.request_id else new.request_id end)then raise exception 'meeting_requires_scoped_source_review' using errcode='42501';end if;
 if tg_op='DELETE'then return old;end if;return new;
end $$;


ALTER FUNCTION app_private.meeting_binding_guard() OWNER TO postgres;

--
-- Name: meeting_can_read(text, text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.meeting_can_read(sid text, person text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select exists(select 1 from app_private.meeting_scope s join app_private.meeting_policy p on p.id=s.policy
 join app_private.workspace_actors a on a.actor=person and a.workspace_id=p.workspace_id and a.active
 join app_private.meeting_reviewers r on r.actor=a.actor and r.active
 join app_private.workspace_clients c on c.actor=a.actor and c.client=s.client and c.active
 join app_private.meeting_source_people sp on sp.source_id=s.source_id and sp.actor=a.actor and sp.active
 where s.source_id=sid and s.active and p.active)
$$;


ALTER FUNCTION app_private.meeting_can_read(sid text, person text) OWNER TO postgres;

--
-- Name: meeting_write_guard(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.meeting_write_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
 if (tg_table_name='requests' and exists(select 1 from app_private.meeting_items where request_id=old.id))
 or (tg_table_name='tasks' and (to_jsonb(old)->>'meeting_action')::boolean) then
  if tg_op='DELETE' or current_setting('atlas.meeting_write',true) is distinct from 'authorized' then
   raise exception 'meeting_requires_scoped_transition' using errcode='42501'; end if;
  perform app_private.meeting_actor();
 end if;
 if tg_op='DELETE' then return old; end if;return new;
end $$;


ALTER FUNCTION app_private.meeting_write_guard() OWNER TO postgres;

--
-- Name: receipts_shape_error(jsonb); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.receipts_shape_error(p_receipts jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  c_allowed constant text[]  := array['slack_ts','channel','file_id','file_name'];
  c_max_len constant integer := 500;
  v_unknown text[];
  v_keys    integer;
  v_key     text;
  v_val     jsonb;
  v_text    text;
begin
  if p_receipts is null then
    return 'receipts is required and must be a json object';
  end if;

  if pg_catalog.jsonb_typeof(p_receipts) <> 'object' then
    return 'receipts must be a json object, got ' || pg_catalog.jsonb_typeof(p_receipts);
  end if;

  select pg_catalog.array_agg(k order by k)
    into v_unknown
    from pg_catalog.jsonb_object_keys(p_receipts) k
   where not (k = any (c_allowed));

  if v_unknown is not null then
    return 'receipts has unrecognised key(s): '
        || pg_catalog.array_to_string(v_unknown, ', ')
        || '. Allowed keys are: '
        || pg_catalog.array_to_string(c_allowed, ', ');
  end if;

  select pg_catalog.count(*) into v_keys
    from pg_catalog.jsonb_object_keys(p_receipts) k;

  if v_keys = 0 then
    return 'receipts must carry at least one of: '
        || pg_catalog.array_to_string(c_allowed, ', ')
        || '. An empty object is not a receipt.';
  end if;

  for v_key, v_val in
    select k.key, k.value from pg_catalog.jsonb_each(p_receipts) k
  loop
    if pg_catalog.jsonb_typeof(v_val) <> 'string' then
      return 'receipts.' || v_key || ' must be a string, got '
          || pg_catalog.jsonb_typeof(v_val);
    end if;

    v_text := v_val #>> '{}';

    if pg_catalog.length(pg_catalog.btrim(v_text)) = 0 then
      return 'receipts.' || v_key || ' must not be empty';
    end if;

    if pg_catalog.length(v_text) > c_max_len then
      return 'receipts.' || v_key || ' exceeds ' || c_max_len || ' characters';
    end if;
  end loop;

  return null;
end;
$$;


ALTER FUNCTION app_private.receipts_shape_error(p_receipts jsonb) OWNER TO postgres;

--
-- Name: request_canonical_input(jsonb, text, text, text, text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.request_canonical_input(p_requested jsonb, p_client text, p_project_key text, p_source_type text, p_source_id text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.jsonb_build_object(
    'requested',   p_requested,
    'client',      p_client,
    'project_key', p_project_key,
    'source_type', p_source_type,
    'source_id',   p_source_id
  );
$$;


ALTER FUNCTION app_private.request_canonical_input(p_requested jsonb, p_client text, p_project_key text, p_source_type text, p_source_id text) OWNER TO postgres;

--
-- Name: request_input_hash(jsonb); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.request_input_hash(p_canonical jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select pg_catalog.encode(
           extensions.digest(p_canonical::text, 'sha256'),
           'hex'
         );
$$;


ALTER FUNCTION app_private.request_input_hash(p_canonical jsonb) OWNER TO postgres;

--
-- Name: request_transition_allowed(text, text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.request_transition_allowed(p_from text, p_to text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select (p_from, p_to) in (
    ('pending_approval', 'approved'),
    ('pending_approval', 'declined')
  );
$$;


ALTER FUNCTION app_private.request_transition_allowed(p_from text, p_to text) OWNER TO postgres;

--
-- Name: requests_derive_and_freeze(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.requests_derive_and_freeze() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_hash text;
begin
  v_hash := app_private.request_input_hash(
    app_private.request_canonical_input(
      new.requested, new.client, new.project_key::text, new.source_type, new.source_id
    )
  );
  if tg_op = 'INSERT' then
    new.input_hash    := v_hash;
    new.input_version := 1;
    return new;
  end if;
  if new.id is distinct from old.id then
    raise exception 'request id is immutable' using errcode = 'check_violation';
  end if;
  if new.adapter is distinct from old.adapter
     or new.requester_principal is distinct from old.requester_principal then
    raise exception 'request adapter/principal is immutable' using errcode = 'check_violation';
  end if;
  if new.requested_by is distinct from old.requested_by
     or new.requester_role is distinct from old.requester_role then
    raise exception 'request requester attribution is immutable' using errcode = 'check_violation';
  end if;
  if new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'request idempotency_key is immutable' using errcode = 'check_violation';
  end if;
  if new.source_type is distinct from old.source_type
     or new.source_id is distinct from old.source_id then
    raise exception 'request source reference is immutable' using errcode = 'check_violation';
  end if;
  if new.permitted_audience is distinct from old.permitted_audience then
    raise exception 'request permitted_audience is derived and immutable'
      using errcode = 'check_violation';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'request created_at is immutable' using errcode = 'check_violation';
  end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then
    raise exception 'request task association is immutable once made'
      using errcode = 'check_violation';
  end if;
  if new.state is distinct from old.state
     and not app_private.request_transition_allowed(old.state, new.state) then
    raise exception 'request % state transition % -> % is not allowed',
      old.id, old.state, new.state
      using errcode = 'check_violation';
  end if;
  if v_hash is distinct from old.input_hash then
    if new.input_version is distinct from old.input_version + 1 then
      raise exception
        'request input changed: input_version must go from % to %, got %',
        old.input_version, old.input_version + 1, new.input_version
        using errcode = 'check_violation';
    end if;
  elsif new.input_version is distinct from old.input_version then
    raise exception 'request input_version cannot change while the input does not'
      using errcode = 'check_violation';
  end if;
  new.input_hash := v_hash;
  return new;
end;
$$;


ALTER FUNCTION app_private.requests_derive_and_freeze() OWNER TO postgres;

--
-- Name: safe_excerpt(text, integer); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.safe_excerpt(p_text text, p_max integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
  with c1 as (select regexp_replace(p_text, '\[\[[^]]*/[^]]*\]\]', '[reference removed]', 'g') as t),
       c2 as (select regexp_replace(t, '\[\[[^]|]*\|([^]]*)\]\]', '\1', 'g')                   as t from c1),
       c3 as (select regexp_replace(t, '\[\[([^]]*)\]\]', '\1', 'g')                           as t from c2),
       c4 as (select regexp_replace(t, '\[([^]]*)\]\([^)]*\)', '\1', 'g')                      as t from c3),
       -- any ']]' left at this point is a chunk-boundary orphan, not a link
       c5 as (select regexp_replace(t, '^[^\n]*?\]\]', '')                                     as t from c4),
       c6 as (select regexp_replace(t, '\[\[.*$', '[reference removed]')                       as t from c5),
       c7 as (select regexp_replace(t, '[^[:space:]]*/[^[:space:]]*\.md',
                                       '[reference removed]', 'g')                             as t from c6),
       -- bare vault-root paths with no .md extension; absent from v1
       c8 as (select regexp_replace(t,
                '(brain|content|knowledge|memory|audit|exports|tools|\.claude)/[^][:space:]|)]*',
                '[reference removed]', 'g')                                                    as t from c7),
       c9 as (select pg_catalog.left(t, p_max)                                                 as t from c8),
       -- truncation can sever a link or a path token of its own making
       cA as (select regexp_replace(t, '\[\[.*$', '[reference removed]')                       as t from c9),
       cB as (select regexp_replace(t,
                '(brain|content|knowledge|memory|audit|exports|tools|\.claude)/[^][:space:]|)]*$',
                '[reference removed]')                                                         as t from cA),
       cC as (select regexp_replace(t, '[^[:space:]]*/[^[:space:]]*$', '[reference removed]')  as t from cB)
  select pg_catalog.left(t, p_max) from cC
$_$;


ALTER FUNCTION app_private.safe_excerpt(p_text text, p_max integer) OWNER TO postgres;

--
-- Name: FUNCTION safe_excerpt(p_text text, p_max integer); Type: COMMENT; Schema: app_private; Owner: postgres
--

COMMENT ON FUNCTION app_private.safe_excerpt(p_text text, p_max integer) IS 'v2, gate S5c. Strips wikilinks, markdown link targets, .md paths and bare vault-root paths from a retrieval excerpt, and handles wikilinks severed by the 1600-char chunk boundary at either end, including the case where the cut lands inside the opening bracket pair and leaves a source FILENAME as bare display text. Read-time only: memory_chunks.chunk_text is never modified.';


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;


ALTER FUNCTION app_private.set_updated_at() OWNER TO postgres;

--
-- Name: task_board_policy(text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.task_board_policy(p_audience text) RETURNS TABLE(recognised boolean, all_lanes boolean, owner_key text)
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select
    p_audience in ('rhys','pat','corey','jian','dante')  as recognised,
    p_audience = 'rhys'                                  as all_lanes,
    p_audience                                           as owner_key;
$$;


ALTER FUNCTION app_private.task_board_policy(p_audience text) OWNER TO postgres;

--
-- Name: task_history_immutable(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.task_history_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$begin raise exception 'immutable_task_history' using errcode='42501';end $$;


ALTER FUNCTION app_private.task_history_immutable() OWNER TO postgres;

--
-- Name: task_transition_allowed(text, text); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.task_transition_allowed(p_from text, p_to text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select (p_from, p_to) in (
    ('queued',         'needs_approval'),
    ('queued',         'in_build'),
    ('queued',         'declined'),
    ('needs_approval', 'approved'),
    ('needs_approval', 'declined'),
    ('needs_approval', 'sent_back'),
    ('sent_back',      'needs_approval'),
    ('sent_back',      'queued'),
    ('sent_back',      'declined'),
    ('approved',       'in_build'),
    ('approved',       'declined'),
    ('in_build',       'delivered'),
    ('in_build',       'sent_back'),
    ('in_build',       'declined')
  );
$$;


ALTER FUNCTION app_private.task_transition_allowed(p_from text, p_to text) OWNER TO postgres;

--
-- Name: tasks_enforce_entry_state(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.tasks_enforce_entry_state() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.state not in ('queued','needs_approval') then
    raise exception
      'task cannot be created in state %; entry states are queued and needs_approval',
      new.state
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;


ALTER FUNCTION app_private.tasks_enforce_entry_state() OWNER TO postgres;

--
-- Name: tasks_enforce_transition(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.tasks_enforce_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if new.state is distinct from old.state then
    if not app_private.task_transition_allowed(old.state, new.state) then
      raise exception
        'task % state transition % -> % is not allowed',
        old.id, old.state, new.state
        using errcode = 'check_violation';
    end if;
  end if;

  if new.id is distinct from old.id then
    raise exception 'task id is immutable' using errcode = 'check_violation';
  end if;
  if new.origin is distinct from old.origin then
    raise exception 'task origin is immutable' using errcode = 'check_violation';
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'task created_by is immutable' using errcode = 'check_violation';
  end if;
  if new.source_quote is distinct from old.source_quote then
    raise exception 'task source_quote is immutable' using errcode = 'check_violation';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'task created_at is immutable' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;


ALTER FUNCTION app_private.tasks_enforce_transition() OWNER TO postgres;

--
-- Name: workspace_actor(); Type: FUNCTION; Schema: app_private; Owner: postgres
--

CREATE FUNCTION app_private.workspace_actor() RETURNS app_private.workspace_actors
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a app_private.workspace_actors;
begin
 select * into a from app_private.workspace_actors where db_role=current_setting('role',true)::name and active for share;
 if not found then raise exception 'workspace_access_denied' using errcode='42501'; end if;
 return a;
end $$;


ALTER FUNCTION app_private.workspace_actor() OWNER TO postgres;

--
-- Name: apply_memory_projection(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_memory_projection(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_item public.projection_items%rowtype;
  v_subject public.projection_subjects%rowtype;
  v_note public.memory_notes%rowtype;
  v_version public.memory_note_versions%rowtype;
  v_project_id uuid;
  v_receipt uuid := extensions.gen_random_uuid();
  v_item_id uuid := (p_payload ->> 'item_id')::uuid;
  v_claim_token uuid := (p_payload ->> 'claim_token')::uuid;
  v_source_hash text := p_payload ->> 'source_hash';
  v_version_key text := p_payload ->> 'version_key';
  v_links jsonb := coalesce(p_payload -> 'links', '[]'::jsonb);
  v_chunks jsonb := coalesce(p_payload -> 'chunks', '[]'::jsonb);
begin
  if pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or not app_private.is_sha256(v_source_hash)
     or not app_private.is_sha256(v_version_key)
     or pg_catalog.jsonb_typeof(v_links) <> 'array'
     or pg_catalog.jsonb_typeof(v_chunks) <> 'array' then
    raise exception using errcode = '22023', message = 'projection_publish_payload_invalid';
  end if;

  select * into v_item
  from public.projection_items
  where id = v_item_id
  for update;
  if not found
     or v_item.state <> 'processing'
     or v_item.claim_token <> v_claim_token
     or v_item.claimed_by <> v_worker
     or v_item.lease_expires_at <= pg_catalog.now()
     or v_item.source_hash <> v_source_hash then
    raise exception using errcode = '55000', message = 'projection_claim_invalid_or_expired';
  end if;

  select * into v_subject
  from public.projection_subjects
  where feed_id = v_item.feed_id and source_path = v_item.source_path
  for update;
  if v_subject.active_claim_token <> v_claim_token
     or v_subject.claimed_by <> v_worker
     or v_subject.generation <> v_item.expected_subject_generation then
    raise exception using errcode = '40001', message = 'projection_subject_generation_conflict';
  end if;

  select id into v_project_id
  from public.projects
  where key = (p_payload ->> 'project_key')::extensions.citext;
  if v_project_id is null then
    raise exception using errcode = '22023', message = 'projection_project_unknown';
  end if;

  if (p_payload ->> 'scope') not in ('strategy','ops','content','monday','client_sensitive')
     or (p_payload ->> 'sensitivity') not in ('standard','internal_financial')
     or (p_payload ->> 'source_class') not in ('workspace_knowledge','atlas_training_source')
     or (p_payload ->> 'review_state') <> 'approved'
     or coalesce(p_payload ->> 'title', '') = ''
     or coalesce(p_payload ->> 'body', '') = '' then
    raise exception using errcode = '22023', message = 'projection_classification_invalid';
  end if;

  if exists (
       select 1
       from pg_catalog.jsonb_to_recordset(v_links)
         as x(target_path text, target_section text)
       where not app_private.is_safe_relative_markdown_path(x.target_path)
     )
     or exists (
       select 1
       from pg_catalog.jsonb_to_recordset(v_chunks)
         as x(ordinal integer, chunk_text_hash text, chunk_text text)
       where x.ordinal is null
          or x.ordinal < 0
          or not app_private.is_sha256(x.chunk_text_hash)
          or pg_catalog.length(x.chunk_text) not between 1 and 12000
     )
     or (
       select pg_catalog.count(*) from pg_catalog.jsonb_to_recordset(v_chunks)
         as x(ordinal integer, chunk_text_hash text, chunk_text text)
     ) <> (
       select pg_catalog.count(distinct x.ordinal)
       from pg_catalog.jsonb_to_recordset(v_chunks)
         as x(ordinal integer, chunk_text_hash text, chunk_text text)
     ) then
    raise exception using errcode = '22023', message = 'projection_derived_rows_invalid';
  end if;

  insert into public.memory_notes(
    feed_id, source_path, current_source_hash, title, body, metadata,
    project_id, scope, sensitivity, source_class, classification_state,
    review_state, retrieval_enabled, parser_profile, classification_profile,
    chunk_profile, embedding_profile, last_source_observed_at
  )
  values (
    v_item.feed_id, v_item.source_path, v_source_hash,
    p_payload ->> 'title', p_payload ->> 'body',
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    v_project_id, p_payload ->> 'scope', p_payload ->> 'sensitivity',
    p_payload ->> 'source_class', 'classified', 'approved', false,
    p_payload ->> 'parser_profile', p_payload ->> 'classification_profile',
    p_payload ->> 'chunk_profile', p_payload ->> 'embedding_profile',
    pg_catalog.now()
  )
  on conflict (feed_id, source_path)
  do update set
    current_source_hash = excluded.current_source_hash,
    title = excluded.title,
    body = excluded.body,
    metadata = excluded.metadata,
    project_id = excluded.project_id,
    scope = excluded.scope,
    sensitivity = excluded.sensitivity,
    source_class = excluded.source_class,
    classification_state = 'classified',
    review_state = 'approved',
    retrieval_enabled = false,
    parser_profile = excluded.parser_profile,
    classification_profile = excluded.classification_profile,
    chunk_profile = excluded.chunk_profile,
    embedding_profile = excluded.embedding_profile,
    last_source_observed_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  returning * into v_note;

  update public.memory_note_versions
    set publication_state = 'superseded',
        superseded_at = coalesce(superseded_at, pg_catalog.now())
  where memory_note_id = v_note.id
    and publication_state = 'current'
    and version_key <> v_version_key;

  insert into public.memory_note_versions(
    memory_note_id, version_key, source_content_hash, parser_profile,
    classification_profile, chunk_profile, embedding_profile, project_id,
    scope, sensitivity, source_class, review_evidence_version,
    publication_state, metadata, activated_at
  )
  values (
    v_note.id, v_version_key, v_source_hash,
    p_payload ->> 'parser_profile', p_payload ->> 'classification_profile',
    p_payload ->> 'chunk_profile', p_payload ->> 'embedding_profile',
    v_project_id, p_payload ->> 'scope', p_payload ->> 'sensitivity',
    p_payload ->> 'source_class', p_payload ->> 'review_evidence_version',
    'current', coalesce(p_payload -> 'version_metadata', '{}'::jsonb),
    pg_catalog.now()
  )
  on conflict (memory_note_id, version_key)
  do update set
    publication_state = 'current',
    activated_at = coalesce(public.memory_note_versions.activated_at, pg_catalog.now()),
    superseded_at = null
  returning * into v_version;

  update public.memory_chunks
    set active = false
  where note_version_id in (
    select id from public.memory_note_versions where memory_note_id = v_note.id
  );

  delete from public.memory_note_links where note_version_id = v_version.id;
  insert into public.memory_note_links(
    note_version_id, target_path, target_section, target_note_id, edge_kind
  )
  select
    v_version.id,
    x.target_path,
    nullif(x.target_section, ''),
    n.id,
    'wikilink'
  from pg_catalog.jsonb_to_recordset(v_links)
    as x(target_path text, target_section text)
  left join public.memory_notes n
    on n.feed_id = v_item.feed_id and n.source_path = x.target_path
  where app_private.is_safe_relative_markdown_path(x.target_path)
  on conflict do nothing;

  delete from public.memory_chunks where note_version_id = v_version.id;
  insert into public.memory_chunks(
    note_version_id, ordinal, chunk_text_hash, chunk_text,
    chunk_profile, embedding_profile, embedding, active
  )
  select
    v_version.id, x.ordinal, x.chunk_text_hash, x.chunk_text,
    p_payload ->> 'chunk_profile', p_payload ->> 'embedding_profile',
    null::extensions.vector, true
  from pg_catalog.jsonb_to_recordset(v_chunks)
    as x(ordinal integer, chunk_text_hash text, chunk_text text)
  where x.ordinal >= 0
    and app_private.is_sha256(x.chunk_text_hash)
    and pg_catalog.length(x.chunk_text) between 1 and 12000;

  update public.memory_notes
    set current_version_id = v_version.id,
        retrieval_enabled = true,
        classification_state = 'classified',
        updated_at = pg_catalog.now()
  where id = v_note.id;

  update public.projection_items
    set state = 'succeeded',
        claim_token = null,
        claimed_by = null,
        lease_expires_at = null,
        processing_receipt = v_receipt,
        safe_error_code = null,
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
  where id = v_item.id;

  update public.projection_subjects
    set current_source_hash = v_source_hash,
        current_note_id = v_note.id,
        pending_count = greatest(pending_count - 1, 0),
        generation = generation + 1,
        active_claim_token = null,
        claimed_by = null,
        lease_expires_at = null,
        last_outcome = 'succeeded',
        updated_at = pg_catalog.now()
  where feed_id = v_item.feed_id and source_path = v_item.source_path;

  update public.projection_batches b
    set state = 'completed',
        completed_at = pg_catalog.now()
  where b.id = v_item.batch_id
    and not exists (
      select 1
      from public.projection_items i
      where i.batch_id = b.id
        and i.state in ('pending','processing','retry_source_changed','retry_publish')
    );

  -- Resolve previously unresolved current graph edges to this newly current note.
  update public.memory_note_links l
    set target_note_id = v_note.id
  from public.memory_note_versions sv
  join public.memory_notes sn on sn.id = sv.memory_note_id
  where l.note_version_id = sv.id
    and sv.publication_state = 'current'
    and sn.feed_id = v_item.feed_id
    and l.target_path = v_item.source_path
    and l.target_note_id is null;

  return pg_catalog.jsonb_build_object(
    'receipt', v_receipt,
    'note_id', v_note.id,
    'version_id', v_version.id,
    'source_hash', v_source_hash,
    'worker_id', v_worker
  );
end;
$$;


ALTER FUNCTION public.apply_memory_projection(p_payload jsonb) OWNER TO postgres;

--
-- Name: apply_supervised_memory_projection(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.apply_supervised_memory_projection(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_item public.projection_items%rowtype;
  v_decision public.projection_classification_decisions%rowtype;
  v_result jsonb;
begin
  select * into v_item from public.projection_items
  where id = (p_payload ->> 'item_id')::uuid for update;
  if not found or v_item.scan_run_id is null
     or v_item.state <> 'processing'
     or v_item.claim_token <> (p_payload ->> 'claim_token')::uuid
     or v_item.claimed_by <> v_worker then
    raise exception using errcode = '55000', message = 'supervised_projection_claim_invalid';
  end if;
  select * into v_decision from public.projection_classification_decisions
  where scan_run_id = v_item.scan_run_id and source_path = v_item.source_path;
  if not found or v_decision.disposition <> 'projected'
     or v_decision.exposure_mode <> 'browseable'
     or v_decision.review_state <> 'approved'
     or v_decision.source_hash <> (p_payload ->> 'source_hash')
     or v_decision.decision_hash <> (p_payload ->> 'classification_decision_hash')
     or v_decision.content_class <> (p_payload ->> 'content_class')
     or v_decision.project_key <> (p_payload ->> 'project_key')
     or v_decision.scope <> (p_payload ->> 'scope')
     or v_decision.sensitivity <> (p_payload ->> 'sensitivity')
     or v_decision.source_class <> (p_payload ->> 'source_class') then
    raise exception using errcode = '22023', message = 'supervised_projection_decision_mismatch';
  end if;

  v_result := public.apply_memory_projection(p_payload);
  update public.memory_notes set
    content_class = v_decision.content_class,
    exposure_mode = v_decision.exposure_mode,
    classification_decision_hash = v_decision.decision_hash
  where feed_id = v_item.feed_id and source_path = v_item.source_path;
  update public.memory_note_versions set
    content_class = v_decision.content_class,
    exposure_mode = v_decision.exposure_mode,
    classification_decision_hash = v_decision.decision_hash
  where id = (v_result ->> 'version_id')::uuid;
  return v_result || pg_catalog.jsonb_build_object('classification_decision_hash', v_decision.decision_hash);
end;
$$;


ALTER FUNCTION public.apply_supervised_memory_projection(p_payload jsonb) OWNER TO postgres;

--
-- Name: begin_supervised_classification_run(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.begin_supervised_classification_run(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_feed public.projection_feeds%rowtype;
  v_run public.projection_scan_runs%rowtype;
  v_feed_id uuid := (p_payload ->> 'feed_id')::uuid;
  v_manifest text := p_payload ->> 'decision_manifest_sha256';
  v_replayed boolean := false;
begin
  if pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or not app_private.is_sha256(v_manifest)
     or not app_private.is_sha256(p_payload ->> 'rule_set_sha256')
     or not app_private.is_sha256(p_payload ->> 'sensitivity_profile_sha256')
     or not app_private.is_sha256(p_payload ->> 'sensitivity_manifest_sha256')
     or coalesce(p_payload ->> 'vault_head','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     or not app_private.is_sha256(p_payload ->> 'vault_status_sha256')
     or coalesce((p_payload ->> 'total_count')::integer, 0) < 1 then
    raise exception using errcode = '22023', message = 'classification_run_payload_invalid';
  end if;

  select * into v_feed from public.projection_feeds where id = v_feed_id for update;
  if not found or not v_feed.enabled
     or v_feed.policy_version <> (p_payload ->> 'policy_version') then
    raise exception using errcode = '55000', message = 'classification_feed_not_authorized';
  end if;

  select * into v_run from public.projection_scan_runs
  where feed_id = v_feed_id and decision_manifest_sha256 = v_manifest;
  if found then
    v_replayed := true;
  else
    insert into public.projection_scan_runs(
      feed_id, mode, state, writes_allowed, policy_version, manifest_sha256,
      total_count, rule_set_id, rule_set_version, rule_set_sha256,
      sensitivity_profile_id, sensitivity_profile_version,
      sensitivity_profile_sha256, sensitivity_manifest_sha256,
      decision_manifest_sha256, vault_head, vault_status_sha256
    ) values (
      v_feed_id, 'backfill', 'running', true, p_payload ->> 'policy_version', v_manifest,
      (p_payload ->> 'total_count')::integer,
      p_payload ->> 'rule_set_id', p_payload ->> 'rule_set_version', p_payload ->> 'rule_set_sha256',
      p_payload ->> 'sensitivity_profile_id', p_payload ->> 'sensitivity_profile_version',
      p_payload ->> 'sensitivity_profile_sha256', p_payload ->> 'sensitivity_manifest_sha256',
      v_manifest, p_payload ->> 'vault_head', p_payload ->> 'vault_status_sha256'
    ) returning * into v_run;
  end if;

  return pg_catalog.jsonb_build_object('id', v_run.id, 'replayed', v_replayed, 'worker_id', v_worker);
end;
$_$;


ALTER FUNCTION public.begin_supervised_classification_run(p_payload jsonb) OWNER TO postgres;

--
-- Name: bounded_retrieve(text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.bounded_retrieve(query text, audience text) RETURNS json
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'extensions', 'pg_temp'
    AS $$
#variable_conflict use_variable
declare
  max_passages      constant integer := 8;
  max_excerpt_chars constant integer := 1200;
  max_query_chars   constant integer := 2000;
  -- ranking weights; see the composite score below
  graph_weight      constant numeric := 0.15;
  vector_weight     constant numeric := 0.0;   -- inert until embeddings land

  v_query     text := pg_catalog.btrim(coalesce(query, ''));
  v_audience  text := pg_catalog.btrim(pg_catalog.lower(coalesce(audience, '')));
  v_pol       record;
  v_tsq       tsquery;
  v_tsq_or    tsquery;
  v_passages  json;
  v_count     integer;
  v_attempt   integer;
  v_vector_ready boolean;
begin
  select * into v_pol from app_private.bounded_retrieve_policy(v_audience);

  -- (3) unknown / invalid / missing audience: fail closed. No scope is
  -- widened, no passage is returned, and the reason is stated.
  if not v_pol.recognised then
    return json_build_object(
      'passages', '[]'::json,
      'policy',
      'Refused: unrecognised audience. Permitted values are rhys, pat, staff. '
      || 'No passages were retrieved and no default scope was applied.'
    );
  end if;

  -- Blank, wildcard and count-only queries must not enumerate the corpus
  -- (CLASSIFICATION-MAP.md §8). An empty tsquery returns nothing.
  if v_query = '' or pg_catalog.length(v_query) > max_query_chars then
    return json_build_object(
      'passages', '[]'::json,
      'policy',
      'Refused: query must be between 1 and ' || max_query_chars
      || ' characters. Enumeration queries are not served.'
    );
  end if;

  -- plainto_tsquery ANDs every term, which returns nothing for most
  -- natural-language questions. Build an OR variant as a RELEVANCE
  -- fallback used only when the strict AND match yields no passage.
  --
  -- This widens MATCHING, never AUTHORIZATION. Both queries run inside
  -- the identical predicate stack below, so no scope, sensitivity or
  -- source class becomes reachable that was not already reachable. It is
  -- not the "wider scope" that requirement 3 forbids.
  v_tsq := plainto_tsquery('english', v_query);
  v_tsq_or := pg_catalog.replace(v_tsq::text, ' & ', ' | ')::tsquery;
  if v_tsq is null or pg_catalog.numnode(v_tsq) = 0 then
    return json_build_object(
      'passages', '[]'::json,
      'policy',
      'No searchable terms in query. Nothing retrieved for audience '
      || v_audience || '.'
    );
  end if;

  -- The predicate stack. Every clause of w1-projection-design.md §10.3 is
  -- applied here, before any text leaves the database:
  --   * retrieval_enabled on the current version
  --   * classification_state = classified AND review_state = approved
  --   * exposure_mode = browseable ONLY. usable_not_visible is excluded
  --     for EVERY audience including rhys: at this stage it may inform
  --     nothing, and CLASSIFICATION-MAP.md §7.2 permits it only inside an
  --     internal ephemeral generation envelope that emits no source,
  --     title or citation. This RPC is a client-facing surface, so it is
  --     not that envelope.
  --   * financial predicate, exactly {rhys, pat}
  --   * training-source predicate, exactly {rhys}
  --   * the permission implied by note scope
  -- Anything not matching an allowed scope fails closed by omission.
  -- Retrieval mode is derived from the DATA, not hardcoded, so the day an
  -- embedding backfill runs this reports 'lexical + graph + vector' with no
  -- code change and no contract change.
  select exists (
    select 1 from public.memory_chunks where active and embedding is not null
  ) into v_vector_ready;

  for v_attempt in 1..2 loop
  if v_attempt = 2 then v_tsq := v_tsq_or; end if;
  with
  -- Graph signal. Inbound wikilink count per candidate note, used ONLY to
  -- re-rank notes that have already passed the full predicate stack.
  --
  -- The linking note must itself satisfy the SAME audience predicates. A
  -- link from a note this audience cannot see contributes nothing, so the
  -- existence of hidden material cannot alter the visible ranking.
  -- CLASSIFICATION-MAP.md section 7.1: "Graph expansion repeats the
  -- complete parent-note predicate on every candidate edge; graph
  -- membership never grants access." Here it does not even expand the
  -- candidate set: it only reorders it.
  graph as (
    select l.target_note_id as note_id, pg_catalog.count(*)::numeric as inbound
    from public.memory_note_links l
    join public.memory_note_versions sv on sv.id = l.note_version_id
    join public.memory_notes sn         on sn.current_version_id = sv.id
    where l.target_note_id is not null
      and sn.retrieval_enabled
      and sn.classification_state = 'classified'
      and sn.review_state         = 'approved'
      and sn.exposure_mode        = 'browseable'
      and (sn.sensitivity  <> 'internal_financial'   or v_pol.allow_financial)
      and (sn.source_class <> 'atlas_training_source' or v_pol.allow_training)
      and sn.scope = any (v_pol.allowed_scopes)
    group by 1
  ),
  candidate as (
    select distinct on (n.id)
      c.id           as chunk_id,
      n.scope        as scope,
      n.title        as title,
      n.sensitivity  as sensitivity,
      c.chunk_text   as chunk_text,
      -- Composite score. Three terms, so an embedding column can arrive
      -- later WITHOUT touching the JSON contract: ranking is internal to
      -- this function and no response field carries a score.
      --
      --   lexical : ts_rank over the chunk text
      --   graph   : gentle boost by inbound links from audience-visible notes
      --   vector  : INERT. Every one of the 4,309 active chunks has a null
      --             embedding by decision (embeddingProfile
      --             'none-local-validation'), and the Eve contract carries
      --             no query vector, so there is nothing to compare against.
      --             When embeddings land, replace the literal 0 below with
      --             the similarity term against a server-derived query
      --             embedding and raise vector_weight. Input and output
      --             JSON are unchanged by that edit.
      (
        ts_rank(to_tsvector('english', c.chunk_text), v_tsq)
          * (1 + graph_weight * pg_catalog.ln(1 + coalesce(g.inbound, 0)))
        + vector_weight * 0
      ) as rank
    from public.memory_chunks c
    join public.memory_note_versions v on v.id = c.note_version_id
    join public.memory_notes n         on n.current_version_id = v.id
    left join graph g                  on g.note_id = n.id
    where c.active
      and n.retrieval_enabled
      and n.classification_state = 'classified'
      and n.review_state         = 'approved'
      -- browseable ONLY, for every audience including rhys. This is the
      -- third of three independent barriers keeping usable_not_visible
      -- (207 files) and held_unmatched (2 files) out of every response;
      -- see the header note on structural unreachability.
      and n.exposure_mode        = 'browseable'
      and (n.sensitivity  <> 'internal_financial'   or v_pol.allow_financial)
      and (n.source_class <> 'atlas_training_source' or v_pol.allow_training)
      and n.scope = any (v_pol.allowed_scopes)
      and to_tsvector('english', c.chunk_text) @@ v_tsq
    order by n.id,
      ts_rank(to_tsvector('english', c.chunk_text), v_tsq)
        * (1 + graph_weight * pg_catalog.ln(1 + coalesce(g.inbound, 0))) desc,
      c.ordinal
  ),
  bounded as (
    select * from candidate order by rank desc, chunk_id limit max_passages
  )
  select
    coalesce(json_agg(json_build_object(
      -- opaque passage identity. Not a path, not a filename.
      'id',      b.chunk_id::text,
      -- (2) safe logical label only: scope plus the note's own title.
      -- source_path never leaves this function, so no absolute path, no
      -- vault-relative path, and no training-source provenance.
      'source',  b.scope || ' · ' || b.title,
      -- bounded excerpt, always shorter than the stored chunk
      'content', app_private.safe_excerpt(b.chunk_text, max_excerpt_chars),
      'policy_note',
        case
          when b.sensitivity = 'internal_financial'
            then 'Internal financial content. Released to rhys and pat only.'
          else 'Browseable ' || b.scope || '-scope material, released to audience '
               || v_audience || '.'
        end
    ) order by b.rank desc), '[]'::json),
    pg_catalog.count(*)
  into v_passages, v_count
  from bounded b;

    exit when v_count > 0;
    exit when v_tsq_or is null or v_tsq_or = v_tsq;
  end loop;

  return json_build_object(
    'passages', v_passages,
    'policy',
    'Audience ' || v_audience || '. Scopes ' ||
    array_to_string(v_pol.allowed_scopes, ', ') || '. ' ||
    case when v_pol.allow_financial
         then 'Internal financial permitted. '
         else 'Internal financial excluded. ' end ||
    case when v_pol.allow_training
         then 'Training-source material permitted. '
         else 'Training-source material excluded. ' end ||
    'Held, excluded and usable-not-visible material is never served. ' ||
    'Ranking: lexical + graph' ||
    case when v_vector_ready then ' + vector. ' else ' (no embeddings present). ' end ||
    'Returned ' || v_count || ' of at most ' || max_passages ||
    ' passages, each truncated to ' || max_excerpt_chars || ' characters. ' ||
    'Sources are logical labels and excerpts are path-stripped; file paths are not disclosed.'
  );
end;
$$;


ALTER FUNCTION public.bounded_retrieve(query text, audience text) OWNER TO postgres;

--
-- Name: FUNCTION bounded_retrieve(query text, audience text); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.bounded_retrieve(query text, audience text) IS 'Gate S3 bounded retrieval for the Eve pilot. Applies the w1-projection-design section 10.3 read-policy stack server side and returns only logical labels and truncated excerpts. WARNING: the audience argument is caller-asserted and NOT authenticated; EXECUTE is restricted to service_role for that reason. Replace the audience argument with auth.uid()-resolved has_permission() once per-user identity reaches this RPC.';


--
-- Name: claim_projection_item(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.claim_projection_item(p_feed_id uuid, p_lease_seconds integer DEFAULT 60) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_item public.projection_items%rowtype;
  v_subject public.projection_subjects%rowtype;
  v_token uuid := extensions.gen_random_uuid();
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception using errcode = '22023', message = 'projection_lease_invalid';
  end if;

  select i.* into v_item
  from public.projection_items i
  join public.projection_subjects s
    on s.feed_id = i.feed_id and s.source_path = i.source_path
  where i.feed_id = p_feed_id
    and (
      i.state in ('pending','retry_source_changed','retry_publish')
      or (i.state = 'processing' and i.lease_expires_at <= pg_catalog.now())
    )
    and (i.next_retry_at is null or i.next_retry_at <= pg_catalog.now())
    and (s.lease_expires_at is null or s.lease_expires_at <= pg_catalog.now())
  order by i.created_at, i.id
  for update of i skip locked
  limit 1;

  if not found then
    return null;
  end if;

  select * into v_subject
  from public.projection_subjects
  where feed_id = v_item.feed_id and source_path = v_item.source_path
  for update;

  update public.projection_items
    set state = 'processing',
        attempt = attempt + 1,
        claim_token = v_token,
        claimed_by = v_worker,
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
        expected_subject_generation = v_subject.generation,
        next_retry_at = null,
        updated_at = pg_catalog.now()
  where id = v_item.id
  returning * into v_item;

  update public.projection_subjects
    set active_claim_token = v_token,
        claimed_by = v_worker,
        lease_expires_at = v_item.lease_expires_at,
        claim_attempt = v_item.attempt,
        updated_at = pg_catalog.now()
  where feed_id = v_item.feed_id and source_path = v_item.source_path;

  return pg_catalog.jsonb_build_object(
    'id', v_item.id,
    'feed_id', v_item.feed_id,
    'batch_id', v_item.batch_id,
    'source_path', v_item.source_path,
    'claim_token', v_token,
    'attempt', v_item.attempt,
    'expected_subject_generation', v_subject.generation,
    'lease_expires_at', v_item.lease_expires_at
  );
end;
$$;


ALTER FUNCTION public.claim_projection_item(p_feed_id uuid, p_lease_seconds integer) OWNER TO postgres;

--
-- Name: complete_supervised_classification_run(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.complete_supervised_classification_run(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_run public.projection_scan_runs%rowtype;
  v_decisions integer;
  v_open integer;
  v_failed integer;
begin
  select * into v_run from public.projection_scan_runs
  where id = (p_payload ->> 'run_id')::uuid for update;
  if not found then raise exception using errcode = '22023', message = 'classification_run_unknown'; end if;
  select pg_catalog.count(*) into v_decisions from public.projection_classification_decisions where scan_run_id = v_run.id;
  select pg_catalog.count(*) filter (where state in ('pending','processing','retry_source_changed','retry_publish')),
         pg_catalog.count(*) filter (where state <> 'succeeded')
    into v_open, v_failed from public.projection_items where scan_run_id = v_run.id;
  if v_decisions <> v_run.total_count then
    raise exception using errcode = '55000', message = 'classification_manifest_incomplete';
  end if;
  if v_open > 0 or v_failed > 0 then
    raise exception using errcode = '55000', message = 'classification_projection_incomplete';
  end if;
  update public.projection_scan_runs set
    state = 'completed',
    classified_count = (select pg_catalog.count(*) from public.projection_classification_decisions where scan_run_id = v_run.id and disposition = 'projected'),
    held_count = (select pg_catalog.count(*) from public.projection_classification_decisions where scan_run_id = v_run.id and disposition like 'held_%'),
    excluded_count = (select pg_catalog.count(*) from public.projection_classification_decisions where scan_run_id = v_run.id and disposition in ('excluded','derived_metadata')),
    completed_at = pg_catalog.now()
  where id = v_run.id returning * into v_run;
  return pg_catalog.jsonb_build_object(
    'run_id', v_run.id, 'state', v_run.state, 'total', v_run.total_count,
    'projected', v_run.classified_count, 'held', v_run.held_count,
    'excluded_or_metadata', v_run.excluded_count, 'worker_id', v_worker
  );
end;
$$;


ALTER FUNCTION public.complete_supervised_classification_run(p_payload jsonb) OWNER TO postgres;

--
-- Name: enqueue_projection_item(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.enqueue_projection_item(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_batch public.projection_batches%rowtype;
  v_item public.projection_items%rowtype;
  v_inserted boolean := false;
  v_path text := p_payload ->> 'source_path';
begin
  if not app_private.is_safe_relative_markdown_path(v_path) then
    raise exception using errcode = '22023', message = 'projection_source_path_invalid';
  end if;

  select * into v_batch
  from public.projection_batches
  where id = (p_payload ->> 'batch_id')::uuid
  for update;
  if not found or v_batch.state not in ('ready','degraded','processing') then
    raise exception using errcode = '55000', message = 'projection_batch_not_enqueueable';
  end if;

  insert into public.projection_subjects(feed_id, source_path)
  values (v_batch.feed_id, v_path)
  on conflict do nothing;

  insert into public.projection_items(
    feed_id, batch_id, source_path, discovery_kind, state
  )
  values (v_batch.feed_id, v_batch.id, v_path, 'journal', 'pending')
  on conflict (batch_id, source_path) where batch_id is not null
  do nothing
  returning * into v_item;

  if found then
    v_inserted := true;
    update public.projection_subjects
      set pending_count = pending_count + 1,
          updated_at = pg_catalog.now()
    where feed_id = v_batch.feed_id and source_path = v_path;
  else
    select * into v_item
    from public.projection_items
    where batch_id = v_batch.id and source_path = v_path;
  end if;

  update public.projection_batches
    set state = case when state in ('ready','degraded') then 'processing' else state end,
        started_at = coalesce(started_at, pg_catalog.now())
  where id = v_batch.id;

  return pg_catalog.jsonb_build_object(
    'id', v_item.id,
    'state', v_item.state,
    'inserted', v_inserted,
    'worker_id', v_worker
  );
end;
$$;


ALTER FUNCTION public.enqueue_projection_item(p_payload jsonb) OWNER TO postgres;

--
-- Name: evidence_revision_set(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.evidence_revision_set(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_scope    text := payload ->> 'scope';
  v_ref      text := pg_catalog.btrim(coalesce(payload ->> 'ref', ''));
  v_revision text := pg_catalog.lower(pg_catalog.btrim(coalesce(payload ->> 'revision', '')));
  v_note     text := pg_catalog.btrim(coalesce(payload ->> 'note', ''));
  v_expect   text := pg_catalog.lower(pg_catalog.btrim(coalesce(
                       payload ->> 'expected_prior_revision', '')));
  v_has_expect boolean := payload ? 'expected_prior_revision';
  v_prior    text;
  v_row      public.evidence_revisions;
begin
  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'evidence_revision_set payload must be a json object'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_scope not in ('call_source', 'identity_ruling') then
    raise exception 'evidence_revision_set scope must be call_source or identity_ruling, got %',
      coalesce(v_scope, '<null>')
      using errcode = 'invalid_parameter_value';
  end if;
  select revision into v_prior
    from public.evidence_revisions
   where scope = v_scope and ref = v_ref
   for update;
  if v_has_expect then
    if v_prior is distinct from nullif(v_expect, '') then
      raise exception
        'evidence_revision_set: % % is at %, not the expected %; re-read and retry',
        v_scope, v_ref,
        coalesce(pg_catalog.left(v_prior, 12), '<unregistered>'),
        coalesce(pg_catalog.left(nullif(v_expect, ''), 12), '<unregistered>')
        using errcode = 'check_violation';
    end if;
  end if;
  insert into public.evidence_revisions (scope, ref, revision, note)
  values (v_scope, v_ref, v_revision, v_note)
  on conflict (scope, ref) do nothing
  returning * into v_row;
  if not found then
    if v_prior is null then
      raise exception 'competing first registration; re-read actual source'
        using errcode = 'check_violation';
    end if;
    update public.evidence_revisions
      set revision = v_revision, note = v_note, recorded_at = pg_catalog.now()
      where scope = v_scope and ref = v_ref returning * into v_row;
  end if;
  return pg_catalog.jsonb_build_object(
    'evidence', pg_catalog.to_jsonb(v_row),
    'superseded', v_prior is distinct from v_revision,
    'prior_revision', v_prior,
    'policy',
    case when v_prior is null
         then 'First revision recorded for ' || v_scope || ' ' || v_ref || '.'
         when v_prior = v_revision
         then 'Unchanged: ' || v_scope || ' ' || v_ref || ' is still at this revision.'
         else 'Superseded. Every approval bound to ' || pg_catalog.left(v_prior, 12) ||
              '... is now refused by request_decide and needs a fresh reviewed version.'
    end
  );
end;
$$;


ALTER FUNCTION public.evidence_revision_set(payload jsonb) OWNER TO postgres;

--
-- Name: finish_projection_item(uuid, uuid, text, text, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.finish_projection_item(p_item_id uuid, p_claim_token uuid, p_state text, p_safe_error_code text DEFAULT NULL::text, p_retry_seconds integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_item public.projection_items%rowtype;
  v_terminal boolean;
begin
  if p_state not in (
    'retry_source_changed','retry_publish','held_unclassified',
    'held_parse_error','held_oversize','held_unjournaled',
    'withdrawal_pending','blocked_security','quarantined','not_applied'
  ) then
    raise exception using errcode = '22023', message = 'projection_finish_state_invalid';
  end if;
  if p_retry_seconds < 0 or p_retry_seconds > 86400 then
    raise exception using errcode = '22023', message = 'projection_retry_delay_invalid';
  end if;

  select * into v_item
  from public.projection_items
  where id = p_item_id
  for update;
  if not found
     or v_item.state <> 'processing'
     or v_item.claim_token <> p_claim_token
     or v_item.claimed_by <> v_worker then
    raise exception using errcode = '55000', message = 'projection_claim_invalid';
  end if;

  v_terminal := p_state not in ('retry_source_changed','retry_publish');

  update public.projection_items
    set state = p_state,
        claim_token = null,
        claimed_by = null,
        lease_expires_at = null,
        next_retry_at = case when v_terminal then null
          else pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_seconds) end,
        safe_error_code = pg_catalog.left(p_safe_error_code, 120),
        completed_at = case when v_terminal then pg_catalog.now() end,
        updated_at = pg_catalog.now()
  where id = p_item_id;

  update public.projection_subjects
    set active_claim_token = null,
        claimed_by = null,
        lease_expires_at = null,
        pending_count = case when v_terminal then greatest(pending_count - 1, 0)
          else pending_count end,
        last_outcome = p_state,
        updated_at = pg_catalog.now()
  where feed_id = v_item.feed_id and source_path = v_item.source_path;

  update public.projection_batches b
    set state = 'completed',
        completed_at = pg_catalog.now()
  where b.id = v_item.batch_id
    and not exists (
      select 1
      from public.projection_items i
      where i.batch_id = b.id
        and i.state in ('pending','processing','retry_source_changed','retry_publish')
    );

  return pg_catalog.jsonb_build_object(
    'id', p_item_id,
    'state', p_state,
    'retryable', not v_terminal
  );
end;
$$;


ALTER FUNCTION public.finish_projection_item(p_item_id uuid, p_claim_token uuid, p_state text, p_safe_error_code text, p_retry_seconds integer) OWNER TO postgres;

--
-- Name: get_supervised_projection_decision(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_supervised_projection_decision(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_item public.projection_items%rowtype;
  v_decision public.projection_classification_decisions%rowtype;
begin
  select * into v_item from public.projection_items
  where id = (p_payload ->> 'item_id')::uuid;
  if not found then
    raise exception using errcode = '22023', message = 'projection_item_unknown';
  end if;
  if v_item.scan_run_id is null then
    return pg_catalog.jsonb_build_object('supervised', false);
  end if;
  if v_item.state <> 'processing'
     or v_item.claim_token <> (p_payload ->> 'claim_token')::uuid
     or v_item.claimed_by <> v_worker or v_item.lease_expires_at <= pg_catalog.now() then
    raise exception using errcode = '55000', message = 'projection_claim_invalid_or_expired';
  end if;
  select * into v_decision from public.projection_classification_decisions
  where scan_run_id = v_item.scan_run_id and source_path = v_item.source_path;
  if not found or v_decision.disposition <> 'projected' then
    raise exception using errcode = '55000', message = 'projection_decision_not_projectable';
  end if;
  return pg_catalog.jsonb_build_object(
    'supervised', true,
    'decision_hash', v_decision.decision_hash, 'source_hash', v_decision.source_hash,
    'content_class', v_decision.content_class, 'exposure_mode', v_decision.exposure_mode,
    'project_key', v_decision.project_key, 'scope', v_decision.scope,
    'sensitivity', v_decision.sensitivity, 'source_class', v_decision.source_class,
    'review_state', v_decision.review_state
  );
end;
$$;


ALTER FUNCTION public.get_supervised_projection_decision(p_payload jsonb) OWNER TO postgres;

--
-- Name: intake_source_capture(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.intake_source_capture(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
 id text := payload->>'source_id'; rev text := payload->>'revision';
 prior text; v_raw jsonb := payload->'raw';
begin
 if id is null or id = '' or rev is null or rev !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(v_raw) is distinct from 'object' or v_raw->>'id' is distinct from id
    or not (payload ? 'expected_prior_revision')
    or coalesce(payload->>'source_path','') !~ '^content/calls/[A-Za-z0-9][A-Za-z0-9_-]*[.]md$' then
   raise exception 'invalid source capture' using errcode='22023';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('atlas-intake:'||id, 0));
 select revision into prior from public.intake_sources where source_id=id for update;
 if exists(select 1 from public.intake_sources where source_id=id and source_path <> payload->>'source_path') then
   raise exception 'source path rebinding requires separate adjudication' using errcode='23514';
 end if;
 if prior is distinct from payload->>'expected_prior_revision' then
   raise exception 'source changed; re-read actual source' using errcode='23514';
 end if;
 insert into public.intake_source_versions values(id, rev, v_raw) on conflict do nothing;
 if exists(select 1 from public.intake_source_versions v where v.source_id=id and v.revision=rev and v.raw <> v_raw) then
   raise exception 'revision reused for different source bytes' using errcode='23514';
 end if;
 insert into public.intake_sources(source_id,revision,source_path) values(id,rev,payload->>'source_path')
 on conflict(source_id) do update set revision=excluded.revision, source_path=excluded.source_path;
 perform public.evidence_revision_set(jsonb_build_object('scope','call_source','ref',id,
   'revision',rev,'expected_prior_revision',prior,'note','intake saved-source capture'));
 return public.intake_source_current(id);
end $_$;


ALTER FUNCTION public.intake_source_capture(payload jsonb) OWNER TO postgres;

--
-- Name: intake_source_current(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.intake_source_current(id text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
 select to_jsonb(s) || jsonb_build_object('raw',v.raw) from public.intake_sources s
 join public.intake_source_versions v using(source_id,revision) where s.source_id=id
$$;


ALTER FUNCTION public.intake_source_current(id text) OWNER TO postgres;

--
-- Name: meeting_capability(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.meeting_capability() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare a app_private.workspace_actors:=app_private.meeting_actor();r app_private.meeting_reviewers;
begin select * into r from app_private.meeting_reviewers where actor=a.actor;return jsonb_build_object('actor',a.actor,'triage',r.can_triage,'review',r.can_review,'rhysActor',r.rhys_actor);end $$;


ALTER FUNCTION public.meeting_capability() OWNER TO postgres;

--
-- Name: meeting_ingest(text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.meeting_ingest(action text, payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare p app_private.meeting_policy;m app_private.meetings;entry jsonb;source jsonb;c jsonb;sid text:=payload->>'id';rid uuid;
begin
 select * into p from app_private.meeting_policy where db_role=current_setting('role',true)::name and active for share;
 if not found then raise exception 'ingestion_capability_denied' using errcode='42501';end if;
 if action in ('scan_start','scan_fail','inventory') then
  if payload->>'policy' is distinct from p.id or (payload->>'start')::timestamptz<p.starts_at or (payload->>'end')::timestamptz>clock_timestamp()+interval '1 day' then raise exception 'window_outside_policy' using errcode='42501';end if;
  insert into app_private.meeting_scans(policy,starts_at,ends_at,status,ids,note)values(p.id,(payload->>'start')::timestamptz,(payload->>'end')::timestamptz,case action when 'scan_start' then 'scanning' when 'scan_fail' then 'failed' else 'covered' end,coalesce(payload->'meetings','[]'),payload->>'note')
  on conflict(policy,starts_at,ends_at) do update set status=excluded.status,ids=excluded.ids,note=excluded.note,observed_at=clock_timestamp();
  if action='inventory' then
   for entry in select * from jsonb_array_elements(payload->'meetings') loop
    if (entry->>'instant')::timestamptz < (payload->>'start')::timestamptz or (entry->>'instant')::timestamptz >= (payload->>'end')::timestamptz then raise exception 'meeting_outside_window';end if;
    if (entry->>'live')::boolean then continue;end if;
    insert into app_private.meetings(source_id,policy,title,instant,state,note)values(entry->>'id',p.id,entry->>'title',(entry->>'instant')::timestamptz,'awaiting_source','Awaiting transcript or provider summary')on conflict(source_id)do nothing;
   end loop;
  end if;return jsonb_build_object('ok',true);
 end if;
 select * into m from app_private.meetings where source_id=sid and policy=p.id for update;
 if not found then raise exception 'meeting_not_in_inventory';end if;
 if action='source_state' then return jsonb_build_object('revision',m.revision);end if;
 perform 1 from app_private.meeting_scope where source_id=sid for share;
 if not exists(select 1 from app_private.meeting_scope where source_id=sid and policy=p.id and active) then
  update app_private.meetings set state='held',note='Source scope/release decision required' where source_id=sid;
  return jsonb_build_object('settled',true,'held',true);
 end if;
 if action='capture' then
  source:=payload->'source';
  if m.revision is null and (sid='01M1XBMMKJZSV91JHJ5G1Z7WS7' or exists(select 1 from public.intake_sources where source_id=sid))then
   update app_private.meetings set state='held',note='Existing accepted source lineage belongs to another intake lane; explicit correspondence decision required' where source_id=sid;
   return jsonb_build_object('settled',true,'held',true);
  end if;
  if m.revision is distinct from payload->>'expected' then raise exception 'source_CAS_conflict' using errcode='PT409';end if;
  if source->>'id' is distinct from sid or (source->>'live')::boolean or source->>'revision' !~ '^[a-f0-9]{64}$' then raise exception 'invalid_source';end if;
  if m.revision=source->>'revision' then return jsonb_build_object('settled',m.extraction_revision=m.revision and m.state in ('ready','no_actions','held'));end if;
  perform public.intake_source_capture(jsonb_build_object('source_id',sid,'revision',source->>'revision','raw',source,'source_path','content/calls/'||sid||'.md','expected_prior_revision',m.revision));
  update app_private.meetings set revision=source->>'revision',state='awaiting_source',lease_token=null,lease_until=null,
   source_review_required=exists(select 1 from app_private.meeting_items where source_id=sid),note='New source captured; extraction pending' where source_id=sid;
  return jsonb_build_object('settled',false);
 end if;
 if action in ('waiting','source_fail') then
  if m.revision is distinct from payload->>'revision' then raise exception 'stale_wait' using errcode='PT409';end if;
  update app_private.meetings set state=case action when 'waiting' then 'awaiting_source' else 'failed' end,note=coalesce(payload->>'note','Awaiting transcript or summary') where source_id=sid;return '{}';
 end if;
 if m.revision is distinct from payload->>'revision' then raise exception 'obsolete_source' using errcode='PT409';end if;
 if action='claim' then
  if m.lease_token is not null then
   if m.lease_until<clock_timestamp() then update app_private.meetings set state='held',note='Interrupted extraction: unknown provider outcome. Operator reconciliation required.' where source_id=sid;end if;
   return jsonb_build_object('held',true);
  end if;
  update app_private.meetings set state='processing',lease_token=extensions.gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' where source_id=sid returning * into m;
  return jsonb_build_object('token',m.lease_token);
 end if;
 if m.lease_token is null or m.lease_token::text is distinct from payload->>'token' or m.lease_until<clock_timestamp() then raise exception 'lease_expired_or_stale' using errcode='PT409';end if;
 if action='fail' then update app_private.meetings set state='held',note=payload->>'note' where source_id=sid;return '{}';end if;
 if action<>'publish' or jsonb_typeof(payload->'items')<>'array' or jsonb_array_length(payload->'items')>100 then raise exception 'invalid_publication';end if;
 if jsonb_typeof(payload->'complete') is distinct from 'boolean' then raise exception 'invalid_completion_contract';end if;
 if payload->>'complete'='true' then
  source:=public.intake_source_current(sid)->'raw';
  if jsonb_typeof(source->'passages') is distinct from 'array' or jsonb_array_length(source->'passages')=0
   or payload->'coverage'->>'completeTranscript' is distinct from 'true'
   or payload->'coverage'->>'sourceRevision' is distinct from m.revision
   or payload->'coverage'->>'passageCount' is distinct from jsonb_array_length(source->'passages')::text then raise exception 'complete_transcript_receipt_required';end if;
 end if;
 -- Initial candidates create canonical proposals. Reprocessing can NEVER overwrite them.
 if not m.source_review_required then
  for c in select * from jsonb_array_elements(payload->'items')loop
   rid:=app_private.meeting_add_item(sid,c,p.ingestion_actor);
  end loop;
 end if;
 update app_private.meetings set pending=payload->'items',extraction_revision=m.revision,lease_token=null,lease_until=null,
 state=case when m.source_review_required then 'held' when jsonb_array_length(payload->'items')>0 then 'ready' when (payload->>'complete')::boolean then 'no_actions' else 'held' end,
 note=case when m.source_review_required then 'Source changed. Review correspondence before using new evidence.' else payload->>'note' end where source_id=sid;
 return jsonb_build_object('ok',true);
end $_$;


ALTER FUNCTION public.meeting_ingest(action text, payload jsonb) OWNER TO postgres;

--
-- Name: meeting_queue(text, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.meeting_queue(action text DEFAULT 'list'::text, payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare a app_private.workspace_actors;r app_private.meeting_reviewers;m app_private.meetings;i app_private.meeting_items;
 q public.requests;t public.tasks;rows jsonb:='[]';items jsonb;v jsonb;c jsonb;mapping jsonb;newq jsonb;rid uuid;
 prior app_private.meeting_history;opid uuid;result jsonb;target text;sid text:=payload->>'sourceId';note text:=btrim(coalesce(payload->>'note',''));
begin
 -- Same lock for source capture/publication and review: source cannot move during acceptance.
 if action<>'list' then select * into m from app_private.meetings where source_id=sid for update;end if;
 a:=app_private.meeting_actor();select * into r from app_private.meeting_reviewers where actor=a.actor and active for share;
 if action='list' then
  for m in select mm.* from app_private.meetings mm where app_private.meeting_can_read(mm.source_id,a.actor) order by instant desc,source_id loop
   perform 1 from app_private.meeting_scope s join app_private.meeting_policy p on p.id=s.policy join app_private.workspace_clients wc on wc.client=s.client and wc.actor=a.actor join app_private.meeting_source_people sp on sp.source_id=s.source_id and sp.actor=a.actor where s.source_id=m.source_id for share of s,p,wc,sp;
   if not app_private.meeting_can_read(m.source_id,a.actor)then continue;end if;
   if m.revision is distinct from (select revision from public.intake_sources where source_id=m.source_id)then m.state:='held';m.note:='Canonical source changed; intake reconciliation required';m.source_review_required:=true;m.pending:=null;end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',mi.request_id,'revision',mi.revision,'title',rq.requested->>'title','due',rq.requested->'due','owner',rq.requested->'owner','state',rq.state,'deferred',mi.deferred,'evidence',mi.evidence,'sourceRevision',mi.reviewed_revision,'reconciliationRequired',(rq.state<>'declined' and coalesce(tt.work_status,'todo')<>'completed' and (m.source_review_required or (mi.reviewed_revision is distinct from m.revision and mi.continuity_revision is distinct from m.revision))),'task',to_jsonb(tt)) order by rq.created_at),'[]')into items
   from app_private.meeting_items mi join public.requests rq on rq.id=mi.request_id left join public.tasks tt on tt.id=rq.task_id where mi.source_id=m.source_id;
   rows:=rows||jsonb_build_array(jsonb_build_object('id',m.source_id,'title',m.title,'instant',m.instant,'state',m.state,'note',m.note,'revision',m.revision,'sourceChanged',m.source_review_required,'pending',case when m.source_review_required then m.pending else null end,'items',items,'assignees',(select coalesce(jsonb_agg(jsonb_build_object('actor',wa.actor,'review',mr.can_review)),'[]')from app_private.workspace_actors wa join app_private.meeting_reviewers mr on mr.actor=wa.actor where app_private.meeting_can_read(m.source_id,wa.actor))));
  end loop;
  return jsonb_build_object('capability',public.meeting_capability(),'meetings',rows,'coverage',
   (select coalesce(jsonb_agg(jsonb_build_object('start',s.starts_at,'end',s.ends_at,'status',s.status,'observedAt',s.observed_at,'note',s.note)),'[]')from app_private.meeting_scans s join app_private.meeting_policy p on p.id=s.policy where p.workspace_id=a.workspace_id and p.active),
   'coverageBoundary','Fireflies recorded meetings in approved windows. Missing recordings require an independent expected-meeting roster.');
 end if;
 if m.source_id is null or not app_private.meeting_can_read(sid,a.actor) then raise exception 'meeting_scope_denied' using errcode='42501';end if;
 -- Lock live policy/scope/client rows so a concurrent revocation linearizes with this action.
 perform 1 from app_private.meeting_scope s join app_private.meeting_policy p on p.id=s.policy join app_private.workspace_clients wc on wc.client=s.client and wc.actor=a.actor join app_private.meeting_source_people sp on sp.source_id=s.source_id and sp.actor=a.actor where s.source_id=sid for share of s,p,wc,sp;
 if not app_private.meeting_can_read(sid,a.actor) then raise exception 'meeting_scope_denied' using errcode='42501';end if;
 perform 1 from public.intake_sources where source_id=sid for share;
 if m.revision is distinct from (select revision from public.intake_sources where source_id=sid) then raise exception 'canonical_source_changed_reconcile_first' using errcode='PT409';end if;
 if action='context' then
  return jsonb_build_object('source',public.intake_source_current(sid)->'raw','history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at),'[]')from app_private.meeting_history h where h.source_id=sid));
 end if;
 if not r.can_triage and action not in ('complete','review','request_changes') then raise exception 'triage_denied' using errcode='42501';end if;
 opid:=(payload->>'operationId')::uuid;if opid is null then raise exception 'operation_id_required';end if;
 select * into prior from app_private.meeting_history where actor=a.actor and operation_id=opid;
 if found then if prior.input is distinct from payload or prior.operation<>action then raise exception 'idempotency_conflict' using errcode='PT409';end if;return prior.result;end if;
 perform set_config('atlas.meeting_write','authorized',true);
 if action='source_review' then
  if payload->>'revision' is distinct from m.revision or not m.source_review_required or m.extraction_revision is distinct from m.revision then raise exception 'source_review_stale' using errcode='PT409';end if;
  if length(note)<3 or jsonb_array_length(payload->'mapping')<>jsonb_array_length(m.pending) then raise exception 'full_correspondence_review_required';end if;
  if (select count(distinct x->>'key')from jsonb_array_elements(payload->'mapping')x)<>jsonb_array_length(m.pending) then raise exception 'duplicate_mapping';end if;
  if (select count(*)from jsonb_array_elements(payload->'mapping')x where x->>'requestId' is not null)<>(select count(distinct x->>'requestId')from jsonb_array_elements(payload->'mapping')x where x->>'requestId' is not null)then raise exception 'ambiguous_correspondence';end if;
  for c in select * from jsonb_array_elements(m.pending)loop
   select x into mapping from jsonb_array_elements(payload->'mapping')x where x->>'key'=c->>'key';if mapping is null then raise exception 'missing_mapping';end if;
   if mapping->>'requestId' is null then
    if exists(select 1 from app_private.meeting_keys where source_id=sid and commitment_key=c->>'key')then raise exception 'existing_commitment_must_be_mapped';end if;
    rid:=app_private.meeting_add_item(sid,c,a.actor);
   else
    rid:=(mapping->>'requestId')::uuid;
    if exists(select 1 from app_private.meeting_keys where source_id=sid and commitment_key=c->>'key' and request_id<>rid)then raise exception 'commitment_lineage_conflict';end if;
    update app_private.meeting_items set evidence=c,reviewed_revision=m.revision,revision=revision+1 where request_id=rid and source_id=sid;
    if not found then raise exception 'mapping_outside_source';end if;
    insert into app_private.meeting_keys values(sid,c->>'key',rid)on conflict(source_id,commitment_key)do nothing;
   end if;
  end loop;
  -- Unmatched reviewed work remains tracked with its original evidence; no resurrection/deletion.
  update app_private.meetings set source_review_required=false,state='ready',note='Source correspondence reviewed; human task fields preserved' where source_id=sid;
 elsif action in ('edit','accept','defer','dismiss','complete','review','request_changes','retain_original') then
  select * into i from app_private.meeting_items where request_id=(payload->>'id')::uuid and source_id=sid for update;
  if not found then raise exception 'item_not_visible' using errcode='42501';end if;
  select * into q from public.requests where id=i.request_id for update;
  if i.revision is distinct from (payload->>'revision')::bigint then raise exception 'item_changed_refresh' using errcode='PT409';end if;
  if action in ('edit','accept') and (m.source_review_required or (i.reviewed_revision is distinct from m.revision and i.continuity_revision is distinct from m.revision)) then raise exception 'source_review_required' using errcode='PT409';end if;
  if q.state='declined' then raise exception 'dismissed_item_is_terminal' using errcode='PT409';end if;
  if action in ('edit','accept') then
   foreach target in array array[case when action='edit' and payload?'owner' then payload->>'owner' else q.requested->>'owner' end,payload->>'executor',payload->>'reviewer']loop
    if target is not null and target<>'atlas' then
     perform 1 from app_private.workspace_actors wa join app_private.meeting_reviewers mr on mr.actor=wa.actor join app_private.workspace_clients wc on wc.actor=wa.actor join app_private.meeting_scope ms on ms.client=wc.client join app_private.meeting_source_people sp on sp.source_id=ms.source_id and sp.actor=wa.actor where wa.actor=target and ms.source_id=sid for share of wa,mr,wc,sp;
     if not app_private.meeting_can_read(sid,target)then raise exception 'assignment_scope_denied' using errcode='42501';end if;
    end if;
   end loop;
  end if;
  if action='retain_original' then
   if m.source_review_required or m.extraction_revision is distinct from m.revision or payload->>'sourceRevision' is distinct from m.revision then raise exception 'source_review_stale' using errcode='PT409';end if;
   if i.reviewed_revision=m.revision or i.continuity_revision=m.revision then raise exception 'item_already_reconciled' using errcode='PT409';end if;
   if length(note)<3 then raise exception 'original_obligation_reason_required';end if;
   if q.task_id is not null and exists(select 1 from public.tasks where id=q.task_id and work_status='completed')then raise exception 'completed_item_is_terminal';end if;
   -- A human confirms continuity, not new source support. Original evidence/revision remain intact.
   update app_private.meeting_items set continuity_revision=m.revision where request_id=i.request_id;
  elsif action='edit' then
   if q.task_id is not null then select * into t from public.tasks where id=q.task_id for update;if t.work_status='completed'then raise exception 'completed_item_is_terminal';end if;end if;
   newq:=q.requested;
   if payload ? 'title' then if jsonb_typeof(payload->'title') is distinct from 'string' or length(btrim(payload->>'title')) not between 1 and 300 or payload->>'title'~'[[:cntrl:]]'then raise exception 'invalid_next_step';end if;newq:=jsonb_set(newq,'{title}',payload->'title');end if;
   if payload ? 'due' then if jsonb_typeof(payload->'due') not in ('string','null') then raise exception 'invalid_due';end if;if payload->>'due' is not null then perform (payload->>'due')::date;if payload->>'due' !~ '^\d{4}-\d{2}-\d{2}$'then raise exception 'invalid_due';end if;end if;newq:=jsonb_set(newq,'{due}',payload->'due');end if;
   if payload ? 'owner' then target:=payload->>'owner';if target is not null and not app_private.meeting_can_read(sid,target)then raise exception 'assignment_scope_denied' using errcode='42501';end if;newq:=jsonb_set(newq,'{owner}',payload->'owner');end if;
   if q.task_id is not null and newq->>'owner' is null then raise exception 'task_owner_required';end if;
   update public.requests set requested=newq,input_version=input_version+case when newq<>q.requested then 1 else 0 end where id=q.id;
   if q.task_id is not null then
    foreach target in array array[payload->>'executor',payload->>'reviewer']loop
     if target is not null and target<>'atlas' and not app_private.meeting_can_read(sid,target)then raise exception 'assignment_scope_denied' using errcode='42501';end if;
    end loop;
    if t.next_reviewer is not null and payload?'reviewer' and payload->>'reviewer' is distinct from t.next_reviewer and not r.can_review then raise exception 'required_reviewer_change_denied' using errcode='42501';end if;
    if payload->>'reviewer' is not null and not exists(select 1 from app_private.meeting_reviewers where actor=payload->>'reviewer' and can_review and active)then raise exception 'reviewer_denied';end if;
    update public.tasks set title=newq->>'title',owner=newq->>'owner',due=(newq->>'due')::date,due_origin=case when payload ? 'due' then 'owner_override' else due_origin end,
     executor=case when payload?'executor' then payload->>'executor' else executor end,next_reviewer=case when payload?'reviewer' then payload->>'reviewer' else next_reviewer end,
     work_status=case when payload?'executor' and payload->>'executor' is distinct from executor then case when payload->>'executor'='atlas' then 'atlas_held' else 'todo' end else work_status end,task_revision=task_revision+1 where id=q.task_id;
   end if;
  elsif action='accept' then
   if q.task_id is not null then result:=jsonb_build_object('taskId',q.task_id,'replay',true);
   else
    target:=q.requested->>'owner';if target is null or not app_private.meeting_can_read(sid,target)then raise exception 'accountable_owner_required';end if;
    if (i.evidence->>'kind'<>'promise' or i.evidence->>'uncertainty'<>'') and (payload->>'confirmed' is distinct from 'true' or payload->'confirmation'->>'itemRevision' is distinct from i.revision::text or payload->'confirmation'->>'sourceRevision' is distinct from m.revision) then raise exception 'uncertainty_confirmation_required';end if;
    insert into public.tasks(title,client,lane,owner,origin,state,due,source_quote,created_by,meeting_action,executor,work_status,execution_gate)
     values(q.requested->>'title',q.client,'business',target,'atlas_signal','queued',(q.requested->>'due')::date,i.evidence->>'quote',a.actor,true,target,'todo','review_required')returning * into t;
    update public.requests set state='approved',task_id=t.id where id=q.id;result:=jsonb_build_object('taskId',t.id);
   end if;
  elsif action='defer' then if q.task_id is not null then raise exception 'accepted_work_stays_tracked';end if;update app_private.meeting_items set deferred=not deferred where request_id=q.id;
  elsif action='dismiss' then if q.task_id is not null then raise exception 'accepted_work_requires_completion';end if;if length(note)<3 then raise exception 'dismiss_reason_required';end if;update public.requests set state='declined' where id=q.id;
  else
   select * into t from public.tasks where id=q.task_id for update;
   if t.id is null or t.work_status='completed' then raise exception 'no_open_task';end if;
   if action in ('review','request_changes') then
    if not r.can_review or t.next_reviewer is distinct from a.actor or t.work_status<>'needs_review' then raise exception 'review_denied'using errcode='42501';end if;
   elsif t.executor is distinct from a.actor and t.owner is distinct from a.actor then raise exception 'completion_denied' using errcode='42501';end if;
   if t.executor='atlas' then raise exception 'atlas_executor_unavailable' using errcode='42501';end if;
   if length(note)<3 then raise exception 'completion_evidence_required';end if;
   -- Generic work completion is an attributed receipt, not an invented document or external delivery.
   update public.tasks set work_status=case when action='request_changes' then 'todo' when action='complete' and next_reviewer is not null then 'needs_review' else 'completed' end,
    receipts=jsonb_build_object('kind',case when action='request_changes' then 'review_changes_requested' else 'internal_work_completion' end,'actor',a.actor,'note',note,'at',clock_timestamp()),task_revision=task_revision+1 where id=t.id;
  end if;
  update app_private.meeting_items set revision=revision+1 where request_id=i.request_id;
 else raise exception 'unsupported_meeting_action';end if;
 if action in ('source_review','retain_original') then
  update app_private.meetings mm set state=case when exists(select 1 from app_private.meeting_items mi join public.requests rq on rq.id=mi.request_id left join public.tasks tt on tt.id=rq.task_id where mi.source_id=sid and rq.state<>'declined' and coalesce(tt.work_status,'todo')<>'completed' and mi.reviewed_revision is distinct from mm.revision and mi.continuity_revision is distinct from mm.revision)then 'held'else 'ready'end,
   note='Source correspondence reviewed. Unmatched outstanding items require explicit original-obligation review; prior evidence remains intact.' where mm.source_id=sid;
 end if;
 result:=coalesce(result,'{}')||jsonb_build_object('ok',true);
 insert into app_private.meeting_history(source_id,request_id,actor,operation,operation_id,input,result)values(sid,i.request_id,a.actor,action,opid,payload,result);
 return result;
end $_$;


ALTER FUNCTION public.meeting_queue(action text, payload jsonb) OWNER TO postgres;

--
-- Name: prepare_projection_item(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.prepare_projection_item(p_item_id uuid, p_claim_token uuid, p_source_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_item public.projection_items%rowtype;
  v_note public.memory_notes%rowtype;
  v_withdrawn boolean := false;
begin
  if not app_private.is_sha256(p_source_hash) then
    raise exception using errcode = '22023', message = 'projection_source_hash_invalid';
  end if;

  select * into v_item
  from public.projection_items
  where id = p_item_id
  for update;
  if not found
     or v_item.state <> 'processing'
     or v_item.claim_token <> p_claim_token
     or v_item.claimed_by <> v_worker
     or v_item.lease_expires_at <= pg_catalog.now() then
    raise exception using errcode = '55000', message = 'projection_claim_invalid_or_expired';
  end if;

  update public.projection_items
    set source_hash = p_source_hash, updated_at = pg_catalog.now()
  where id = p_item_id;

  select * into v_note
  from public.memory_notes
  where feed_id = v_item.feed_id and source_path = v_item.source_path
  for update;

  if found and v_note.current_source_hash <> p_source_hash and v_note.retrieval_enabled then
    update public.memory_notes
      set retrieval_enabled = false,
          classification_state = 'stale_pending',
          updated_at = pg_catalog.now()
    where id = v_note.id;
    update public.projection_subjects
      set withdrawal_generation = withdrawal_generation + 1,
          last_outcome = 'stale_pending',
          updated_at = pg_catalog.now()
    where feed_id = v_item.feed_id and source_path = v_item.source_path;
    v_withdrawn := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'prepared', true,
    'prior_withdrawn', v_withdrawn,
    'worker_id', v_worker
  );
end;
$$;


ALTER FUNCTION public.prepare_projection_item(p_item_id uuid, p_claim_token uuid, p_source_hash text) OWNER TO postgres;

--
-- Name: register_projection_batch(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.register_projection_batch(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_feed public.projection_feeds%rowtype;
  v_batch public.projection_batches%rowtype;
  v_feed_id uuid := (p_payload ->> 'feed_id')::uuid;
  v_name text := p_payload ->> 'journal_relative_name';
  v_sha text := p_payload ->> 'journal_sha256';
  v_state text := p_payload ->> 'state';
  v_conflict boolean;
  v_replayed boolean;
begin
  if pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or v_name is null
     or not app_private.is_sha256(v_sha)
     or v_state not in ('ready','degraded','quarantined','not_applied') then
    raise exception using errcode = '22023', message = 'projection_batch_payload_invalid';
  end if;

  select * into v_feed
  from public.projection_feeds
  where id = v_feed_id
  for update;

  if not found or not v_feed.enabled then
    raise exception using errcode = '42501', message = 'projection_feed_disabled';
  end if;
  if v_feed.vault_root_fingerprint <> p_payload ->> 'vault_root_fingerprint'
     or v_feed.journal_root_fingerprint <> p_payload ->> 'journal_root_fingerprint'
     or v_feed.adapter_version <> p_payload ->> 'adapter_version'
     or v_feed.policy_version <> p_payload ->> 'policy_version' then
    raise exception using errcode = '42501', message = 'projection_feed_identity_mismatch';
  end if;

  select exists (
    select 1 from public.projection_batches b
    where b.feed_id = v_feed_id
      and b.journal_relative_name = v_name
      and b.journal_sha256 <> v_sha
  ) into v_conflict;

  select exists (
    select 1 from public.projection_batches b
    where b.feed_id = v_feed_id
      and b.journal_relative_name = v_name
      and b.journal_sha256 = v_sha
  ) into v_replayed;

  if v_conflict then
    update public.projection_batches
      set state = 'identity_conflict',
          safe_error_code = 'journal_identity_conflict',
          completed_at = pg_catalog.now()
    where feed_id = v_feed_id
      and journal_relative_name = v_name;
    v_state := 'identity_conflict';
  end if;

  insert into public.projection_batches (
    feed_id, journal_relative_name, journal_sha256, producer_run_id,
    terminal_action, state, record_count, pre_apply_count, applied_count,
    folded_skip_count, warning_count, target_count, safe_error_code,
    completed_at
  )
  values (
    v_feed_id, v_name, v_sha, p_payload ->> 'producer_run_id',
    p_payload ->> 'terminal_action', v_state,
    coalesce((p_payload ->> 'record_count')::integer, 0),
    coalesce((p_payload ->> 'pre_apply_count')::integer, 0),
    coalesce((p_payload ->> 'applied_count')::integer, 0),
    coalesce((p_payload ->> 'folded_skip_count')::integer, 0),
    coalesce((p_payload ->> 'warning_count')::integer, 0),
    coalesce((p_payload ->> 'target_count')::integer, 0),
    coalesce(
      case when v_conflict then 'journal_identity_conflict' end,
      p_payload ->> 'safe_error_code'
    ),
    case when v_state in ('quarantined','identity_conflict','not_applied')
      then pg_catalog.now() end
  )
  on conflict (feed_id, journal_relative_name, journal_sha256)
  do update set
    state = case
      when public.projection_batches.state = 'identity_conflict'
        then 'identity_conflict'
      else public.projection_batches.state
    end
  returning * into v_batch;

  return pg_catalog.jsonb_build_object(
    'id', v_batch.id,
    'state', v_batch.state,
    'replayed', v_replayed,
    'worker_id', v_worker
  );
end;
$$;


ALTER FUNCTION public.register_projection_batch(p_payload jsonb) OWNER TO postgres;

--
-- Name: register_supervised_decision_batch(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.register_supervised_decision_batch(p_payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_worker uuid := app_private.current_projection_worker();
  v_run public.projection_scan_runs%rowtype;
  v_row jsonb;
  v_decision public.projection_classification_decisions%rowtype;
  v_item_id uuid;
  v_inserted integer := 0;
  v_enqueued integer := 0;
  v_derived integer := 0;
begin
  if pg_catalog.jsonb_typeof(p_payload -> 'decisions') <> 'array'
     or pg_catalog.jsonb_array_length(p_payload -> 'decisions') not between 1 and 100 then
    raise exception using errcode = '22023', message = 'classification_batch_invalid';
  end if;
  select * into v_run from public.projection_scan_runs
  where id = (p_payload ->> 'run_id')::uuid for update;
  if not found or v_run.state not in ('running','completed') or not v_run.writes_allowed then
    raise exception using errcode = '55000', message = 'classification_run_not_writable';
  end if;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_payload -> 'decisions') loop
    if not app_private.is_safe_relative_markdown_path(v_row ->> 'sourcePath')
       or not app_private.is_sha256(v_row ->> 'decisionHash')
       or (v_row ->> 'ruleSetId') <> v_run.rule_set_id
       or (v_row ->> 'ruleSetVersion') <> v_run.rule_set_version
       or (v_row ->> 'ruleSetSha256') <> v_run.rule_set_sha256 then
      raise exception using errcode = '22023', message = 'classification_decision_invalid';
    end if;

    select * into v_decision
    from public.projection_classification_decisions
    where scan_run_id = v_run.id and source_path = v_row ->> 'sourcePath';
    if found then
      if v_decision.decision_hash <> (v_row ->> 'decisionHash') then
        raise exception using errcode = '23505', message = 'classification_decision_replay_conflict';
      end if;
      continue;
    end if;
    if v_run.state = 'completed' then
      raise exception using errcode = '55000', message = 'classification_completed_run_replay_incomplete';
    end if;

    insert into public.projection_classification_decisions(
      scan_run_id, feed_id, source_path, source_hash, source_size, decision_hash,
      rule_set_id, rule_set_version, rule_set_sha256, rule_id, rule_version, rule_sha256,
      content_class, exposure_mode, project_key, scope, sensitivity, source_class,
      review_state, disposition, reason_code, rule_reason, sensitivity_evidence,
      candidate_labels, derived_metadata
    ) values (
      v_run.id, v_run.feed_id, v_row ->> 'sourcePath', nullif(v_row ->> 'sourceHash',''),
      nullif(v_row ->> 'sourceSize','')::bigint, v_row ->> 'decisionHash',
      v_row ->> 'ruleSetId', v_row ->> 'ruleSetVersion', v_row ->> 'ruleSetSha256',
      v_row ->> 'ruleId', (v_row ->> 'ruleVersion')::integer, v_row ->> 'ruleSha256',
      v_row #>> '{labels,contentClass}', v_row #>> '{labels,exposureMode}',
      v_row #>> '{labels,projectKey}', v_row #>> '{labels,scope}',
      v_row #>> '{labels,sensitivity}', v_row #>> '{labels,sourceClass}',
      v_row #>> '{labels,reviewState}', v_row ->> 'disposition',
      v_row ->> 'reasonCode', v_row ->> 'ruleReason', nullif(v_row -> 'sensitivity','null'::jsonb),
      nullif(v_row -> 'candidateLabels','null'::jsonb), nullif(v_row -> 'derivedMetadata','null'::jsonb)
    ) on conflict (scan_run_id, source_path) do nothing
    returning * into v_decision;

    if not found then
      select * into v_decision from public.projection_classification_decisions
      where scan_run_id = v_run.id and source_path = v_row ->> 'sourcePath';
      if v_decision.decision_hash <> (v_row ->> 'decisionHash') then
        raise exception using errcode = '23505', message = 'classification_decision_replay_conflict';
      end if;
      continue;
    end if;
    v_inserted := v_inserted + 1;

    if v_decision.disposition = 'projected' then
      insert into public.projection_subjects(feed_id, source_path, pending_count)
      values (v_run.feed_id, v_decision.source_path, 1)
      on conflict (feed_id, source_path) do update
        set pending_count = public.projection_subjects.pending_count + 1,
            updated_at = pg_catalog.now();
      insert into public.projection_items(feed_id, scan_run_id, source_path, source_hash, discovery_kind, state)
      values (v_run.feed_id, v_run.id, v_decision.source_path, v_decision.source_hash, 'backfill', 'pending')
      returning id into v_item_id;
      insert into public.projection_scan_items(
        scan_run_id, source_path, source_hash, source_size, relation, disposition, projection_item_id
      ) values (
        v_run.id, v_decision.source_path, v_decision.source_hash, v_decision.source_size,
        'unknown', 'classified', v_item_id
      );
      v_enqueued := v_enqueued + 1;
    else
      insert into public.projection_scan_items(
        scan_run_id, source_path, source_hash, source_size, relation, disposition, safe_error_code
      ) values (
        v_run.id, v_decision.source_path,
        coalesce(v_decision.source_hash, pg_catalog.repeat('0',64)), coalesce(v_decision.source_size,0),
        'unknown', case when v_decision.disposition = 'excluded' then 'excluded' else 'held' end,
        pg_catalog.left(v_decision.reason_code,120)
      );
      if v_decision.disposition = 'derived_metadata' then
        insert into public.derived_graph_metadata(
          feed_id, source_path, source_hash, decision_id, decision_hash, title, wikilink_count
        ) values (
          v_run.feed_id, v_decision.source_path, v_decision.source_hash,
          v_decision.id, v_decision.decision_hash,
          v_decision.derived_metadata ->> 'title',
          (v_decision.derived_metadata ->> 'wikilinkCount')::integer
        ) on conflict (feed_id, source_path) do update set
          source_hash = excluded.source_hash, decision_id = excluded.decision_id,
          decision_hash = excluded.decision_hash, title = excluded.title,
          wikilink_count = excluded.wikilink_count, updated_at = pg_catalog.now();
        v_derived := v_derived + 1;
      end if;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'inserted', v_inserted, 'enqueued', v_enqueued,
    'derived_metadata', v_derived, 'worker_id', v_worker
  );
end;
$$;


ALTER FUNCTION public.register_supervised_decision_batch(p_payload jsonb) OWNER TO postgres;

--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION public.rls_auto_enable() OWNER TO postgres;

--
-- Name: task_act(uuid, text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.task_act(task_id uuid, action text, note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(action, '')));
  v_note   text := nullif(pg_catalog.btrim(coalesce(note, '')), '');
  v_target text;
  v_old    public.tasks;
  v_row    public.tasks;
begin
  if exists(select 1 from public.tasks t where t.id=task_id and t.meeting_action)then raise exception 'meeting_requires_scoped_transition'using errcode='42501';end if;
  if task_id is null then
    raise exception 'task_act requires a task_id'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_action not in ('approve','decline','send_back','edit') then
    raise exception 'task_act action must be approve, decline, send_back or edit, got %',
      coalesce(v_action, '<null>')
      using errcode = 'invalid_parameter_value';
  end if;

  if v_action = 'edit' then
    raise exception
      'task_act edit is not implemented at gate B1; it is defined so B4 can wire against it'
      using errcode = 'feature_not_supported';
  end if;

  -- Locked before the decision is read, so two approvers racing the same
  -- card cannot both observe 'needs_approval'.
  select * into v_old from public.tasks t where t.id = task_id for update;
  if not found then
    raise exception 'task % not found', task_id using errcode = 'no_data_found';
  end if;

  v_target := case v_action
                when 'approve'   then 'approved'
                when 'decline'   then 'declined'
                when 'send_back' then 'sent_back'
              end;

  if v_action = 'decline' and v_note is null then
    raise exception 'task_act decline requires a note; it becomes the declined_reason'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_action = 'send_back' and v_note is null then
    raise exception 'task_act send_back requires a note saying what to change'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Re-checked here purely for the error message. The BEFORE UPDATE
  -- trigger is what actually enforces this and would reject the write
  -- even if this block were deleted.
  if not app_private.task_transition_allowed(v_old.state, v_target) then
    raise exception
      'task_act %: a task in state % cannot become %',
      v_action, v_old.state, v_target
      using errcode = 'check_violation';
  end if;

  update public.tasks t
     set state            = v_target,
         declined_reason  = case when v_target = 'declined'  then v_note else declined_reason end,
         sent_back_reason = case when v_target = 'sent_back' then v_note else null end
   where t.id = task_id
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(v_row),
    'policy',
    'Action ' || v_action || ' moved task from ' || v_old.state || ' to ' || v_target || '. ' ||
    case when v_target = 'sent_back'
         then 'The note was recorded as sent_back_reason. '
         else '' end ||
    'No actor was recorded: task_act has no authenticated identity.'
  );
end;
$$;


ALTER FUNCTION public.task_act(task_id uuid, action text, note text) OWNER TO postgres;

--
-- Name: FUNCTION task_act(task_id uuid, action text, note text); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.task_act(task_id uuid, action text, note text) IS 'Action board decision path. approve/decline/send_back are live; edit raises feature_not_supported. As of 009 the send_back note is PERSISTED to sent_back_reason (008 required it and discarded it), and sent_back_reason is cleared whenever the card leaves sent_back. Records NO actor: there is no authenticated identity, so this is board bookkeeping and not an authorization control. Known gap: no action produces the legal sent_back -> needs_approval edge; that is B4 edit work.';


--
-- Name: task_board(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.task_board(audience text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_audience text := pg_catalog.lower(pg_catalog.btrim(coalesce(audience, '')));
  v_pol      record;
  v_tasks    jsonb;
  v_count    integer;
begin
  select * into v_pol from app_private.task_board_policy(v_audience);

  if not v_pol.recognised then
    raise exception 'task_board: unrecognised audience'
      using errcode = 'invalid_parameter_value';
  end if;

  select
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by
      t.state, t.due nulls last, t.created_at desc), '[]'::jsonb),
    pg_catalog.count(*)
  into v_tasks, v_count
  from public.tasks t
  where not t.meeting_action and (v_pol.all_lanes
     or t.lane = 'business'
     or t.owner = v_pol.owner_key);

  return pg_catalog.jsonb_build_object(
    'tasks', v_tasks,
    'policy',
    'Audience ' || v_audience || '. ' ||
    case when v_pol.all_lanes
         then 'All lanes. '
         else 'Business lane plus tasks owned by ' || v_pol.owner_key || '. ' end ||
    'Returned ' || v_count || ' tasks. ' ||
    'WARNING: audience is caller-asserted and not authenticated.'
  );
end;
$$;


ALTER FUNCTION public.task_board(audience text) OWNER TO postgres;

--
-- Name: FUNCTION task_board(audience text); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.task_board(audience text) IS 'Gate B1 action board read path. rhys sees all lanes; every other recognised audience sees the business lane plus its own tasks. WARNING: the audience argument is caller-asserted and NOT authenticated, exactly as in bounded_retrieve. Replace it with auth.uid()-resolved has_permission() once per-user identity reaches this RPC.';


--
-- Name: task_create(jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.task_create(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_title        text := pg_catalog.btrim(payload ->> 'title');
  v_client       text := nullif(pg_catalog.btrim(coalesce(payload ->> 'client', '')), '');
  v_lane         text := payload ->> 'lane';
  v_owner        text := payload ->> 'owner';
  v_origin       text := payload ->> 'origin';
  v_state        text := payload ->> 'state';
  v_kind         text := payload ->> 'kind';
  v_due_raw      text := nullif(pg_catalog.btrim(coalesce(payload ->> 'due', '')), '');
  v_quote        text := nullif(pg_catalog.btrim(coalesce(payload ->> 'source_quote', '')), '');
  v_created_by   text := payload ->> 'created_by';
  v_due          date;
  v_row          public.tasks;
begin
  if payload is null or pg_catalog.jsonb_typeof(payload) <> 'object' then
    raise exception 'task_create payload must be a json object'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_title is null or v_title = '' then
    raise exception 'task_create requires a non-empty title'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_lane is null or v_lane not in ('business','engineering') then
    raise exception 'task_create lane must be business or engineering, got %',
      coalesce(v_lane, '<null>')
      using errcode = 'invalid_parameter_value';
  end if;

  if not app_private.is_person_key(v_owner) then
    raise exception 'task_create owner must be a person key, got %',
      coalesce(v_owner, '<null>')
      using errcode = 'invalid_parameter_value';
  end if;

  if not app_private.is_person_key(v_created_by) then
    raise exception 'task_create created_by must be a person key, got %',
      coalesce(v_created_by, '<null>')
      using errcode = 'invalid_parameter_value';
  end if;

  if v_origin is null or v_origin not in ('slack_request','atlas_signal','operator') then
    raise exception 'task_create origin must be slack_request, atlas_signal or operator, got %',
      coalesce(v_origin, '<null>')
      using errcode = 'invalid_parameter_value';
  end if;

  -- Gate F1. Absent means 'generic'; an unrecognised kind is refused
  -- rather than defaulted, for the same reason task_board refuses an
  -- unrecognised audience: a typo must not silently become a category.
  v_kind := coalesce(v_kind, 'generic');
  if v_kind not in ('doc','audit','generic') then
    raise exception 'task_create kind must be doc, audit or generic, got %', v_kind
      using errcode = 'invalid_parameter_value';
  end if;

  -- State. A slack_request is a human asking for something, so it lands
  -- on the gate unconditionally: the caller cannot talk it down to
  -- 'queued'. Every other origin defaults to 'queued' and may opt UP to
  -- 'needs_approval', never anywhere else.
  if v_origin = 'slack_request' then
    if v_state is not null and v_state <> 'needs_approval' then
      raise exception
        'task_create: origin slack_request is always created as needs_approval, not %',
        v_state
        using errcode = 'invalid_parameter_value';
    end if;
    v_state := 'needs_approval';
  else
    v_state := coalesce(v_state, 'queued');
    if v_state not in ('queued','needs_approval') then
      raise exception
        'task_create state must be queued or needs_approval at creation, got %',
        v_state
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Due date. Parsed explicitly rather than cast, so a malformed date is
  -- an argument error and not a 22007 leaking out of the insert. The
  -- window is a sanity bound, not a policy: it catches a unix epoch, a
  -- year typo and a timestamp sent where a date belongs.
  if v_due_raw is not null then
    if v_due_raw !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'task_create due must be YYYY-MM-DD, got %', v_due_raw
        using errcode = 'invalid_parameter_value';
    end if;
    begin
      v_due := v_due_raw::date;
    exception when others then
      raise exception 'task_create due is not a real date: %', v_due_raw
        using errcode = 'invalid_parameter_value';
    end;
    if v_due < (pg_catalog.now()::date - 365) or v_due > (pg_catalog.now()::date + 1825) then
      raise exception
        'task_create due % is outside the accepted window (one year back to five years out)',
        v_due
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into public.tasks (
    title, client, lane, owner, origin, state, kind, due, source_quote, created_by
  )
  values (
    v_title, v_client, v_lane, v_owner, v_origin, v_state, v_kind, v_due, v_quote, v_created_by
  )
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(v_row),
    'policy',
    'Created in state ' || v_state || ' from origin ' || v_origin ||
    ', kind ' || v_kind || '. ' ||
    case when v_origin = 'slack_request'
         then 'Slack requests always land on the approval gate. '
         else 'Non-Slack origins start queued unless needs_approval was asked for. ' end ||
    'A task cannot be created already approved or already delivered.'
  );
end;
$_$;


ALTER FUNCTION public.task_create(payload jsonb) OWNER TO postgres;

--
-- Name: FUNCTION task_create(payload jsonb); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.task_create(payload jsonb) IS 'Gate B1 action board write path. Validates lane, origin, owner, created_by, state and due; forces slack_request origin onto the needs_approval gate. Cannot create an already-approved or already-delivered task.';


--
-- Name: task_deliver(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.task_deliver(task_id uuid, receipts jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_receipts jsonb := receipts;
  v_err      text;
  v_old      public.tasks;
  v_row      public.tasks;
begin
  if exists(select 1 from public.tasks t where t.id=task_id and t.meeting_action)then raise exception 'meeting_requires_scoped_transition'using errcode='42501';end if;
  if task_id is null then
    raise exception 'task_deliver requires a task_id'
      using errcode = 'invalid_parameter_value';
  end if;

  v_err := app_private.receipts_shape_error(v_receipts);
  if v_err is not null then
    raise exception 'task_deliver: %', v_err
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_old from public.tasks t where t.id = task_id for update;
  if not found then
    raise exception 'task % not found', task_id using errcode = 'no_data_found';
  end if;

  if v_old.state <> 'in_build' then
    raise exception
      'task_deliver: a task in state % cannot become delivered; it must be in_build first',
      v_old.state
      using errcode = 'check_violation';
  end if;

  update public.tasks t
     set state    = 'delivered',
         receipts = v_receipts
   where t.id = task_id
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(v_row),
    'policy',
    'Delivered: in_build -> delivered, with a receipt. ' ||
    'delivered is terminal and carries proof of the side effect; ' ||
    'approved was never a synonym for delivered and this is the only path here. ' ||
    'No actor was recorded: there is no authenticated identity at gate F1.'
  );
end;
$$;


ALTER FUNCTION public.task_deliver(task_id uuid, receipts jsonb) OWNER TO postgres;

--
-- Name: FUNCTION task_deliver(task_id uuid, receipts jsonb); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.task_deliver(task_id uuid, receipts jsonb) IS 'Gate F1 worker delivery path: in_build -> delivered, and the only path to delivered that exists. Validates the receipt shape before touching the row: object, at least one of slack_ts/channel/file_id/file_name, string values, unknown keys REJECTED, empty object refused. Records no actor, so delivered is currently a fact with no author.';


--
-- Name: task_fail(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.task_fail(task_id uuid, note text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_note text := nullif(pg_catalog.btrim(coalesce(note, '')), '');
  v_old  public.tasks;
  v_row  public.tasks;
begin
  if exists(select 1 from public.tasks t where t.id=task_id and t.meeting_action)then raise exception 'meeting_requires_scoped_transition'using errcode='42501';end if;
  if task_id is null then
    raise exception 'task_fail requires a task_id'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_note is null then
    raise exception 'task_fail requires a note saying why the build failed'
      using errcode = 'invalid_parameter_value';
  end if;

  if pg_catalog.length(v_note) > 1000 then
    raise exception 'task_fail note exceeds 1000 characters'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_old from public.tasks t where t.id = task_id for update;
  if not found then
    raise exception 'task % not found', task_id using errcode = 'no_data_found';
  end if;

  if v_old.state <> 'in_build' then
    raise exception
      'task_fail: a task in state % cannot fail a build; only in_build can',
      v_old.state
      using errcode = 'check_violation';
  end if;

  update public.tasks t
     set state            = 'sent_back',
         sent_back_reason = v_note
   where t.id = task_id
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(v_row),
    'policy',
    'Build failed: in_build -> sent_back, reason recorded. ' ||
    'The card is back with a human and is not delivered. ' ||
    'No actor was recorded: there is no authenticated identity at gate F1.'
  );
end;
$$;


ALTER FUNCTION public.task_fail(task_id uuid, note text) OWNER TO postgres;

--
-- Name: FUNCTION task_fail(task_id uuid, note text); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.task_fail(task_id uuid, note text) IS 'Gate F1 worker failure path: in_build -> sent_back with a mandatory note recorded as sent_back_reason. The card returns to a human and is not delivered.';


--
-- Name: task_start_build(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.task_start_build(task_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_old public.tasks;
  v_row public.tasks;
begin
  if exists(select 1 from public.tasks t where t.id=task_id and t.meeting_action)then raise exception 'meeting_requires_scoped_transition'using errcode='42501';end if;
  if task_id is null then
    raise exception 'task_start_build requires a task_id'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Locked before the state is read, so two workers racing the same card
  -- cannot both observe 'approved' and both start building it. This is
  -- the claim seam: whoever wins the lock owns the build.
  select * into v_old from public.tasks where id = task_id for update;
  if not found then
    raise exception 'task % not found', task_id using errcode = 'no_data_found';
  end if;

  if v_old.state <> 'approved' then
    raise exception
      'task_start_build: a task in state % cannot start a build; the worker builds approved work only',
      v_old.state
      using errcode = 'check_violation';
  end if;

  update public.tasks
     set state = 'in_build'
   where id = task_id
  returning * into v_row;

  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(v_row),
    'policy',
    'Claimed for build: approved -> in_build, kind ' || v_row.kind || '. ' ||
    'Row was locked FOR UPDATE, so this claim is exclusive. ' ||
    'No actor was recorded: there is no authenticated identity at gate F1.'
  );
end;
$$;


ALTER FUNCTION public.task_start_build(task_id uuid) OWNER TO postgres;

--
-- Name: FUNCTION task_start_build(task_id uuid); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.task_start_build(task_id uuid) IS 'Gate F1 worker claim path: approved -> in_build, row locked FOR UPDATE so the claim is exclusive. Deliberately refuses queued -> in_build, which the storage layer permits: the worker builds approved work only. Records no actor.';


--
-- Name: meeting_history; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_history (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    source_id text NOT NULL,
    request_id uuid,
    actor text NOT NULL,
    operation text NOT NULL,
    operation_id uuid NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY app_private.meeting_history FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_history OWNER TO postgres;

--
-- Name: meeting_items; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_items (
    request_id uuid NOT NULL,
    source_id text NOT NULL,
    commitment_key text NOT NULL,
    evidence jsonb NOT NULL,
    reviewed_revision text NOT NULL,
    deferred boolean DEFAULT false NOT NULL,
    continuity_revision text,
    revision bigint DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY app_private.meeting_items FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_items OWNER TO postgres;

--
-- Name: meeting_keys; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_keys (
    source_id text NOT NULL,
    commitment_key text NOT NULL,
    request_id uuid NOT NULL
);

ALTER TABLE ONLY app_private.meeting_keys FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_keys OWNER TO postgres;

--
-- Name: meeting_policy; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_policy (
    id text NOT NULL,
    workspace_id uuid NOT NULL,
    db_role name NOT NULL,
    ingestion_actor text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    active boolean DEFAULT false NOT NULL,
    review_reference text NOT NULL,
    CONSTRAINT meeting_policy_review_reference_check CHECK ((length(review_reference) > 0))
);

ALTER TABLE ONLY app_private.meeting_policy FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_policy OWNER TO postgres;

--
-- Name: meeting_reviewers; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_reviewers (
    actor text NOT NULL,
    rhys_actor text,
    can_triage boolean DEFAULT false NOT NULL,
    can_review boolean DEFAULT false NOT NULL,
    active boolean DEFAULT false NOT NULL,
    review_reference text NOT NULL,
    CONSTRAINT meeting_reviewers_review_reference_check CHECK ((length(review_reference) > 0))
);

ALTER TABLE ONLY app_private.meeting_reviewers FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_reviewers OWNER TO postgres;

--
-- Name: meeting_scans; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_scans (
    policy text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    note text,
    CONSTRAINT meeting_scans_check CHECK ((ends_at > starts_at)),
    CONSTRAINT meeting_scans_status_check CHECK ((status = ANY (ARRAY['scanning'::text, 'covered'::text, 'failed'::text])))
);

ALTER TABLE ONLY app_private.meeting_scans FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_scans OWNER TO postgres;

--
-- Name: meeting_scope; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_scope (
    source_id text NOT NULL,
    policy text NOT NULL,
    client text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    review_reference text NOT NULL,
    CONSTRAINT meeting_scope_review_reference_check CHECK ((length(review_reference) > 0))
);

ALTER TABLE ONLY app_private.meeting_scope FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_scope OWNER TO postgres;

--
-- Name: meeting_source_people; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meeting_source_people (
    source_id text NOT NULL,
    actor text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    review_reference text NOT NULL,
    CONSTRAINT meeting_source_people_review_reference_check CHECK ((length(review_reference) > 0))
);

ALTER TABLE ONLY app_private.meeting_source_people FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meeting_source_people OWNER TO postgres;

--
-- Name: meetings; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.meetings (
    source_id text NOT NULL,
    policy text NOT NULL,
    title text NOT NULL,
    instant timestamp with time zone NOT NULL,
    revision text,
    state text NOT NULL,
    note text,
    lease_token uuid,
    lease_until timestamp with time zone,
    pending jsonb,
    extraction_revision text,
    source_review_required boolean DEFAULT false NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT meetings_state_check CHECK ((state = ANY (ARRAY['awaiting_source'::text, 'processing'::text, 'ready'::text, 'no_actions'::text, 'held'::text, 'failed'::text])))
);

ALTER TABLE ONLY app_private.meetings FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.meetings OWNER TO postgres;

--
-- Name: workspace_clients; Type: TABLE; Schema: app_private; Owner: postgres
--

CREATE TABLE app_private.workspace_clients (
    actor text NOT NULL,
    client text NOT NULL,
    active boolean DEFAULT false NOT NULL,
    epoch bigint DEFAULT 1 NOT NULL
);

ALTER TABLE ONLY app_private.workspace_clients FORCE ROW LEVEL SECURITY;


ALTER TABLE app_private.workspace_clients OWNER TO postgres;

--
-- Name: derived_graph_metadata; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.derived_graph_metadata (
    feed_id uuid NOT NULL,
    source_path text NOT NULL,
    source_hash text NOT NULL,
    decision_id uuid NOT NULL,
    decision_hash text NOT NULL,
    title text NOT NULL,
    wikilink_count integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT derived_graph_metadata_decision_hash_check CHECK (app_private.is_sha256(decision_hash)),
    CONSTRAINT derived_graph_metadata_source_hash_check CHECK (app_private.is_sha256(source_hash)),
    CONSTRAINT derived_graph_metadata_source_path_check CHECK (app_private.is_safe_relative_markdown_path(source_path)),
    CONSTRAINT derived_graph_metadata_title_check CHECK (((length(title) >= 1) AND (length(title) <= 1000))),
    CONSTRAINT derived_graph_metadata_wikilink_count_check CHECK ((wikilink_count >= 0))
);

ALTER TABLE ONLY public.derived_graph_metadata FORCE ROW LEVEL SECURITY;


ALTER TABLE public.derived_graph_metadata OWNER TO postgres;

--
-- Name: TABLE derived_graph_metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.derived_graph_metadata IS 'Server-only graph metadata. Raw knowledge/ bodies are intentionally absent.';


--
-- Name: evidence_revisions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.evidence_revisions (
    scope text NOT NULL,
    ref text NOT NULL,
    revision text NOT NULL,
    note text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evidence_revisions_note_check CHECK (((length(btrim(note)) >= 1) AND (length(btrim(note)) <= 500))),
    CONSTRAINT evidence_revisions_ref_check CHECK ((((length(btrim(ref)) >= 1) AND (length(btrim(ref)) <= 200)) AND (ref !~ '[[:cntrl:]]'::text))),
    CONSTRAINT evidence_revisions_revision_check CHECK ((revision ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT evidence_revisions_scope_check CHECK ((scope = ANY (ARRAY['call_source'::text, 'identity_ruling'::text])))
);

ALTER TABLE ONLY public.evidence_revisions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.evidence_revisions OWNER TO postgres;

--
-- Name: intake_source_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.intake_source_versions (
    source_id text NOT NULL,
    revision text NOT NULL,
    raw jsonb NOT NULL
);

ALTER TABLE ONLY public.intake_source_versions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.intake_source_versions OWNER TO postgres;

--
-- Name: intake_sources; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.intake_sources (
    source_id text NOT NULL,
    revision text NOT NULL,
    source_path text NOT NULL,
    extraction jsonb,
    extraction_revision text
);

ALTER TABLE ONLY public.intake_sources FORCE ROW LEVEL SECURITY;


ALTER TABLE public.intake_sources OWNER TO postgres;

--
-- Name: memory_chunks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_chunks (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    note_version_id uuid NOT NULL,
    ordinal integer NOT NULL,
    chunk_text_hash text NOT NULL,
    chunk_text text NOT NULL,
    chunk_profile text NOT NULL,
    embedding_profile text NOT NULL,
    embedding extensions.vector(1536),
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_chunks_chunk_text_check CHECK (((length(chunk_text) >= 1) AND (length(chunk_text) <= 12000))),
    CONSTRAINT memory_chunks_chunk_text_hash_check CHECK (app_private.is_sha256(chunk_text_hash)),
    CONSTRAINT memory_chunks_ordinal_check CHECK ((ordinal >= 0))
);

ALTER TABLE ONLY public.memory_chunks FORCE ROW LEVEL SECURITY;


ALTER TABLE public.memory_chunks OWNER TO postgres;

--
-- Name: TABLE memory_chunks; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.memory_chunks IS 'Server-only chunks; browser roles have no direct SELECT.';


--
-- Name: memory_note_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_note_links (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    note_version_id uuid NOT NULL,
    target_path text NOT NULL,
    target_section text,
    target_note_id uuid,
    edge_kind text DEFAULT 'wikilink'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_note_links_edge_kind_check CHECK ((edge_kind = 'wikilink'::text)),
    CONSTRAINT memory_note_links_target_path_check CHECK (app_private.is_safe_relative_markdown_path(target_path))
);

ALTER TABLE ONLY public.memory_note_links FORCE ROW LEVEL SECURITY;


ALTER TABLE public.memory_note_links OWNER TO postgres;

--
-- Name: memory_note_versions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_note_versions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    memory_note_id uuid NOT NULL,
    version_key text NOT NULL,
    source_content_hash text NOT NULL,
    parser_profile text NOT NULL,
    classification_profile text NOT NULL,
    chunk_profile text NOT NULL,
    embedding_profile text NOT NULL,
    project_id uuid NOT NULL,
    scope text NOT NULL,
    sensitivity text NOT NULL,
    source_class text NOT NULL,
    review_evidence_version text NOT NULL,
    publication_state text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    superseded_at timestamp with time zone,
    content_class text DEFAULT 'internal_reference'::text NOT NULL,
    exposure_mode text DEFAULT 'browseable'::text NOT NULL,
    classification_decision_hash text,
    CONSTRAINT memory_note_versions_classification_decision_hash_check CHECK (((classification_decision_hash IS NULL) OR app_private.is_sha256(classification_decision_hash))),
    CONSTRAINT memory_note_versions_content_class_check CHECK ((content_class = ANY (ARRAY['published_content'::text, 'internal_reference'::text, 'deep_ip'::text, 'training_source'::text, 'client_record'::text]))),
    CONSTRAINT memory_note_versions_exposure_mode_check CHECK ((exposure_mode = ANY (ARRAY['browseable'::text, 'usable_not_visible'::text]))),
    CONSTRAINT memory_note_versions_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT memory_note_versions_publication_state_check CHECK ((publication_state = ANY (ARRAY['current'::text, 'superseded'::text, 'held'::text, 'withdrawn'::text]))),
    CONSTRAINT memory_note_versions_scope_check CHECK ((scope = ANY (ARRAY['strategy'::text, 'ops'::text, 'content'::text, 'monday'::text, 'client_sensitive'::text]))),
    CONSTRAINT memory_note_versions_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['standard'::text, 'internal_financial'::text]))),
    CONSTRAINT memory_note_versions_source_class_check CHECK ((source_class = ANY (ARRAY['workspace_knowledge'::text, 'atlas_training_source'::text]))),
    CONSTRAINT memory_note_versions_source_content_hash_check CHECK (app_private.is_sha256(source_content_hash)),
    CONSTRAINT memory_note_versions_version_key_check CHECK (app_private.is_sha256(version_key))
);

ALTER TABLE ONLY public.memory_note_versions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.memory_note_versions OWNER TO postgres;

--
-- Name: memory_notes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.memory_notes (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    source_path text NOT NULL,
    current_version_id uuid,
    current_source_hash text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    project_id uuid NOT NULL,
    scope text NOT NULL,
    sensitivity text NOT NULL,
    source_class text NOT NULL,
    classification_state text NOT NULL,
    review_state text NOT NULL,
    retrieval_enabled boolean DEFAULT false NOT NULL,
    parser_profile text NOT NULL,
    classification_profile text NOT NULL,
    chunk_profile text NOT NULL,
    embedding_profile text NOT NULL,
    last_source_observed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    content_class text DEFAULT 'internal_reference'::text NOT NULL,
    exposure_mode text DEFAULT 'browseable'::text NOT NULL,
    classification_decision_hash text,
    CONSTRAINT memory_notes_check CHECK (((retrieval_enabled = false) OR ((classification_state = 'classified'::text) AND (review_state = 'approved'::text) AND (current_version_id IS NOT NULL)))),
    CONSTRAINT memory_notes_classification_decision_hash_check CHECK (((classification_decision_hash IS NULL) OR app_private.is_sha256(classification_decision_hash))),
    CONSTRAINT memory_notes_classification_state_check CHECK ((classification_state = ANY (ARRAY['classified'::text, 'stale_pending'::text, 'held_unclassified'::text, 'withdrawn'::text]))),
    CONSTRAINT memory_notes_content_class_check CHECK ((content_class = ANY (ARRAY['published_content'::text, 'internal_reference'::text, 'deep_ip'::text, 'training_source'::text, 'client_record'::text]))),
    CONSTRAINT memory_notes_current_source_hash_check CHECK (app_private.is_sha256(current_source_hash)),
    CONSTRAINT memory_notes_exposure_mode_check CHECK ((exposure_mode = ANY (ARRAY['browseable'::text, 'usable_not_visible'::text]))),
    CONSTRAINT memory_notes_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT memory_notes_retrieval_requires_browseable CHECK (((NOT retrieval_enabled) OR (exposure_mode = 'browseable'::text))),
    CONSTRAINT memory_notes_review_state_check CHECK ((review_state = ANY (ARRAY['approved'::text, 'held'::text]))),
    CONSTRAINT memory_notes_scope_check CHECK ((scope = ANY (ARRAY['strategy'::text, 'ops'::text, 'content'::text, 'monday'::text, 'client_sensitive'::text]))),
    CONSTRAINT memory_notes_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['standard'::text, 'internal_financial'::text]))),
    CONSTRAINT memory_notes_source_class_check CHECK ((source_class = ANY (ARRAY['workspace_knowledge'::text, 'atlas_training_source'::text]))),
    CONSTRAINT memory_notes_source_path_check CHECK (app_private.is_safe_relative_markdown_path(source_path)),
    CONSTRAINT memory_notes_title_check CHECK (((length(title) >= 1) AND (length(title) <= 1000)))
);

ALTER TABLE ONLY public.memory_notes FORCE ROW LEVEL SECURITY;


ALTER TABLE public.memory_notes OWNER TO postgres;

--
-- Name: TABLE memory_notes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.memory_notes IS 'Current rebuildable vault projection. The vault remains canonical.';


--
-- Name: COLUMN memory_notes.exposure_mode; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.memory_notes.exposure_mode IS 'Structural browse boundary. usable_not_visible rows can never satisfy the browser SELECT policy.';


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.permissions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    key extensions.citext NOT NULL,
    category text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.permissions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.permissions OWNER TO postgres;

--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.role_permissions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.role_permissions OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    email extensions.citext NOT NULL,
    full_name text,
    role_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: my_permissions; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.my_permissions WITH (security_invoker='true') AS
 SELECT p.key AS permission_key,
    p.category
   FROM ((public.role_permissions rp
     JOIN public.permissions p ON ((p.id = rp.permission_id)))
     JOIN public.users u ON ((u.role_id = rp.role_id)))
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND u.is_active);


ALTER VIEW public.my_permissions OWNER TO postgres;

--
-- Name: VIEW my_permissions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON VIEW public.my_permissions IS 'Self-scoped: returns only the calling user''s effective permission keys + categories (no descriptions). security_invoker so underlying RLS applies. Anon sees nothing.';


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.project_members (
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    project_role text DEFAULT 'member'::text NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_members_project_role_check CHECK ((project_role = ANY (ARRAY['member'::text, 'reviewer'::text, 'approver'::text, 'operator'::text])))
);

ALTER TABLE ONLY public.project_members FORCE ROW LEVEL SECURITY;


ALTER TABLE public.project_members OWNER TO postgres;

--
-- Name: projection_batches; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_batches (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    journal_relative_name text NOT NULL,
    journal_sha256 text NOT NULL,
    producer_run_id text,
    terminal_action text,
    state text NOT NULL,
    record_count integer DEFAULT 0 NOT NULL,
    pre_apply_count integer DEFAULT 0 NOT NULL,
    applied_count integer DEFAULT 0 NOT NULL,
    folded_skip_count integer DEFAULT 0 NOT NULL,
    warning_count integer DEFAULT 0 NOT NULL,
    target_count integer DEFAULT 0 NOT NULL,
    safe_error_code text,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT projection_batches_applied_count_check CHECK ((applied_count >= 0)),
    CONSTRAINT projection_batches_folded_skip_count_check CHECK ((folded_skip_count >= 0)),
    CONSTRAINT projection_batches_journal_relative_name_check CHECK ((((length(journal_relative_name) >= 1) AND (length(journal_relative_name) <= 1024)) AND (journal_relative_name !~ '(^/|(^|/)\.\.?(/|$)|[[:cntrl:]])'::text))),
    CONSTRAINT projection_batches_journal_sha256_check CHECK (app_private.is_sha256(journal_sha256)),
    CONSTRAINT projection_batches_pre_apply_count_check CHECK ((pre_apply_count >= 0)),
    CONSTRAINT projection_batches_record_count_check CHECK ((record_count >= 0)),
    CONSTRAINT projection_batches_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'processing'::text, 'completed'::text, 'degraded'::text, 'quarantined'::text, 'identity_conflict'::text, 'not_applied'::text]))),
    CONSTRAINT projection_batches_target_count_check CHECK ((target_count >= 0)),
    CONSTRAINT projection_batches_warning_count_check CHECK ((warning_count >= 0))
);

ALTER TABLE ONLY public.projection_batches FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_batches OWNER TO postgres;

--
-- Name: projection_classification_decisions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_classification_decisions (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    scan_run_id uuid NOT NULL,
    feed_id uuid NOT NULL,
    source_path text NOT NULL,
    source_hash text,
    source_size bigint,
    decision_hash text NOT NULL,
    rule_set_id text NOT NULL,
    rule_set_version text NOT NULL,
    rule_set_sha256 text NOT NULL,
    rule_id text NOT NULL,
    rule_version integer NOT NULL,
    rule_sha256 text NOT NULL,
    content_class text,
    exposure_mode text NOT NULL,
    project_key text,
    scope text,
    sensitivity text NOT NULL,
    source_class text,
    review_state text NOT NULL,
    disposition text NOT NULL,
    reason_code text,
    rule_reason text NOT NULL,
    sensitivity_evidence jsonb,
    candidate_labels jsonb,
    derived_metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_classification_decisions_candidate_labels_check CHECK (((candidate_labels IS NULL) OR (jsonb_typeof(candidate_labels) = 'object'::text))),
    CONSTRAINT projection_classification_decisions_check CHECK (((disposition <> 'projected'::text) OR ((source_hash IS NOT NULL) AND (exposure_mode = 'browseable'::text) AND (review_state = 'approved'::text) AND (project_key IS NOT NULL) AND (scope IS NOT NULL) AND (sensitivity = ANY (ARRAY['standard'::text, 'internal_financial'::text])) AND (source_class IS NOT NULL)))),
    CONSTRAINT projection_classification_decisions_check1 CHECK (((disposition <> 'derived_metadata'::text) OR ((source_hash IS NOT NULL) AND (exposure_mode = 'derived_graph_only'::text) AND (derived_metadata IS NOT NULL)))),
    CONSTRAINT projection_classification_decisions_content_class_check CHECK ((content_class = ANY (ARRAY['published_content'::text, 'internal_reference'::text, 'deep_ip'::text, 'training_source'::text, 'client_record'::text, 'internal_graph'::text, 'deliverable_archive'::text, 'deliverable_current'::text, 'ops_archive'::text, 'system_operational'::text]))),
    CONSTRAINT projection_classification_decisions_decision_hash_check CHECK (app_private.is_sha256(decision_hash)),
    CONSTRAINT projection_classification_decisions_derived_metadata_check CHECK (((derived_metadata IS NULL) OR (jsonb_typeof(derived_metadata) = 'object'::text))),
    CONSTRAINT projection_classification_decisions_disposition_check CHECK ((disposition = ANY (ARRAY['projected'::text, 'held_classified'::text, 'held_sensitivity'::text, 'held_unmatched'::text, 'held_security'::text, 'derived_metadata'::text, 'excluded'::text]))),
    CONSTRAINT projection_classification_decisions_exposure_mode_check CHECK ((exposure_mode = ANY (ARRAY['browseable'::text, 'usable_not_visible'::text, 'derived_graph_only'::text, 'held'::text, 'excluded'::text]))),
    CONSTRAINT projection_classification_decisions_review_state_check CHECK ((review_state = ANY (ARRAY['approved'::text, 'held'::text]))),
    CONSTRAINT projection_classification_decisions_rule_set_sha256_check CHECK (app_private.is_sha256(rule_set_sha256)),
    CONSTRAINT projection_classification_decisions_rule_sha256_check CHECK (app_private.is_sha256(rule_sha256)),
    CONSTRAINT projection_classification_decisions_rule_version_check CHECK ((rule_version > 0)),
    CONSTRAINT projection_classification_decisions_scope_check CHECK (((scope IS NULL) OR (scope = ANY (ARRAY['strategy'::text, 'ops'::text, 'content'::text, 'monday'::text, 'client_sensitive'::text])))),
    CONSTRAINT projection_classification_decisions_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['standard'::text, 'internal_financial'::text, 'unknown'::text, 'inherited'::text]))),
    CONSTRAINT projection_classification_decisions_sensitivity_evidence_check CHECK (((sensitivity_evidence IS NULL) OR (jsonb_typeof(sensitivity_evidence) = 'object'::text))),
    CONSTRAINT projection_classification_decisions_source_class_check CHECK (((source_class IS NULL) OR (source_class = ANY (ARRAY['workspace_knowledge'::text, 'atlas_training_source'::text])))),
    CONSTRAINT projection_classification_decisions_source_hash_check CHECK (((source_hash IS NULL) OR app_private.is_sha256(source_hash))),
    CONSTRAINT projection_classification_decisions_source_path_check CHECK (app_private.is_safe_relative_markdown_path(source_path)),
    CONSTRAINT projection_classification_decisions_source_size_check CHECK (((source_size IS NULL) OR (source_size >= 0)))
);

ALTER TABLE ONLY public.projection_classification_decisions FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_classification_decisions OWNER TO postgres;

--
-- Name: TABLE projection_classification_decisions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.projection_classification_decisions IS 'Immutable per-run supervised path-rule decisions; server-only and rebuildable from the vault and signed-by-hash local manifests.';


--
-- Name: projection_feeds; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_feeds (
    id uuid NOT NULL,
    logical_name extensions.citext NOT NULL,
    adapter_version text NOT NULL,
    policy_version text NOT NULL,
    vault_root_fingerprint text NOT NULL,
    journal_root_fingerprint text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_feeds_journal_root_fingerprint_check CHECK (app_private.is_sha256(journal_root_fingerprint)),
    CONSTRAINT projection_feeds_vault_root_fingerprint_check CHECK (app_private.is_sha256(vault_root_fingerprint))
);

ALTER TABLE ONLY public.projection_feeds FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_feeds OWNER TO postgres;

--
-- Name: TABLE projection_feeds; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.projection_feeds IS 'Explicit logical feed identities. Root fingerprints are drift evidence, never identity.';


--
-- Name: projection_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_items (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    batch_id uuid,
    scan_run_id uuid,
    source_path text NOT NULL,
    source_hash text,
    discovery_kind text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_by uuid,
    lease_expires_at timestamp with time zone,
    expected_subject_generation bigint,
    next_retry_at timestamp with time zone,
    safe_error_code text,
    processing_receipt uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT projection_items_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT projection_items_check CHECK (((((batch_id IS NOT NULL))::integer + ((scan_run_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT projection_items_check1 CHECK ((((discovery_kind = 'journal'::text) AND (batch_id IS NOT NULL)) OR ((discovery_kind <> 'journal'::text) AND (scan_run_id IS NOT NULL)))),
    CONSTRAINT projection_items_check2 CHECK ((((claim_token IS NULL) AND (claimed_by IS NULL) AND (lease_expires_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_by IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT projection_items_discovery_kind_check CHECK ((discovery_kind = ANY (ARRAY['journal'::text, 'backfill'::text, 'reconcile'::text, 'repair'::text]))),
    CONSTRAINT projection_items_source_hash_check CHECK (((source_hash IS NULL) OR app_private.is_sha256(source_hash))),
    CONSTRAINT projection_items_source_path_check CHECK (app_private.is_safe_relative_markdown_path(source_path)),
    CONSTRAINT projection_items_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'processing'::text, 'retry_source_changed'::text, 'retry_publish'::text, 'succeeded'::text, 'held_unclassified'::text, 'held_parse_error'::text, 'held_oversize'::text, 'held_unjournaled'::text, 'withdrawal_pending'::text, 'blocked_security'::text, 'quarantined'::text, 'not_applied'::text])))
);

ALTER TABLE ONLY public.projection_items FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_items OWNER TO postgres;

--
-- Name: projection_health; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.projection_health WITH (security_invoker='true') AS
 SELECT f.id AS feed_id,
    f.logical_name,
    f.enabled,
    count(*) FILTER (WHERE (i.state = ANY (ARRAY['pending'::text, 'processing'::text, 'retry_source_changed'::text, 'retry_publish'::text]))) AS pending_count,
    count(*) FILTER (WHERE ((i.state ~~ 'held_%'::text) OR (i.state = ANY (ARRAY['quarantined'::text, 'blocked_security'::text])))) AS held_or_quarantined_count,
    min(i.created_at) FILTER (WHERE (i.state = ANY (ARRAY['pending'::text, 'processing'::text, 'retry_source_changed'::text, 'retry_publish'::text]))) AS oldest_pending_at,
    max(b.completed_at) FILTER (WHERE (b.state = 'completed'::text)) AS last_completed_batch_at
   FROM ((public.projection_feeds f
     LEFT JOIN public.projection_items i ON ((i.feed_id = f.id)))
     LEFT JOIN public.projection_batches b ON ((b.id = i.batch_id)))
  GROUP BY f.id, f.logical_name, f.enabled;


ALTER VIEW public.projection_health OWNER TO postgres;

--
-- Name: projection_scan_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_scan_items (
    scan_run_id uuid NOT NULL,
    source_path text NOT NULL,
    source_hash text NOT NULL,
    source_size bigint NOT NULL,
    relation text NOT NULL,
    disposition text NOT NULL,
    projection_item_id uuid,
    safe_error_code text,
    CONSTRAINT projection_scan_items_disposition_check CHECK ((disposition = ANY (ARRAY['classified'::text, 'held'::text, 'excluded'::text, 'withdrawal_candidate'::text, 'quarantined'::text]))),
    CONSTRAINT projection_scan_items_relation_check CHECK ((relation = ANY (ARRAY['new'::text, 'unchanged'::text, 'changed'::text, 'missing'::text, 'unknown'::text]))),
    CONSTRAINT projection_scan_items_source_hash_check CHECK (app_private.is_sha256(source_hash)),
    CONSTRAINT projection_scan_items_source_path_check CHECK (app_private.is_safe_relative_markdown_path(source_path)),
    CONSTRAINT projection_scan_items_source_size_check CHECK ((source_size >= 0))
);

ALTER TABLE ONLY public.projection_scan_items FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_scan_items OWNER TO postgres;

--
-- Name: projection_scan_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_scan_runs (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    feed_id uuid NOT NULL,
    mode text NOT NULL,
    state text NOT NULL,
    writes_allowed boolean DEFAULT false NOT NULL,
    policy_version text NOT NULL,
    manifest_sha256 text,
    total_count integer DEFAULT 0 NOT NULL,
    classified_count integer DEFAULT 0 NOT NULL,
    held_count integer DEFAULT 0 NOT NULL,
    excluded_count integer DEFAULT 0 NOT NULL,
    discrepancy_count integer DEFAULT 0 NOT NULL,
    safe_error_code text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    rule_set_id text,
    rule_set_version text,
    rule_set_sha256 text,
    sensitivity_profile_id text,
    sensitivity_profile_version text,
    sensitivity_profile_sha256 text,
    sensitivity_manifest_sha256 text,
    decision_manifest_sha256 text,
    vault_head text,
    vault_status_sha256 text,
    CONSTRAINT projection_scan_runs_check CHECK (((writes_allowed = false) OR (mode = ANY (ARRAY['backfill'::text, 'repair'::text])))),
    CONSTRAINT projection_scan_runs_classified_count_check CHECK ((classified_count >= 0)),
    CONSTRAINT projection_scan_runs_decision_manifest_sha256_check CHECK (((decision_manifest_sha256 IS NULL) OR app_private.is_sha256(decision_manifest_sha256))),
    CONSTRAINT projection_scan_runs_discrepancy_count_check CHECK ((discrepancy_count >= 0)),
    CONSTRAINT projection_scan_runs_excluded_count_check CHECK ((excluded_count >= 0)),
    CONSTRAINT projection_scan_runs_held_count_check CHECK ((held_count >= 0)),
    CONSTRAINT projection_scan_runs_manifest_sha256_check CHECK (((manifest_sha256 IS NULL) OR app_private.is_sha256(manifest_sha256))),
    CONSTRAINT projection_scan_runs_mode_check CHECK ((mode = ANY (ARRAY['dry_run'::text, 'reconcile'::text, 'backfill'::text, 'repair'::text]))),
    CONSTRAINT projection_scan_runs_rule_set_sha256_check CHECK (((rule_set_sha256 IS NULL) OR app_private.is_sha256(rule_set_sha256))),
    CONSTRAINT projection_scan_runs_sensitivity_manifest_sha256_check CHECK (((sensitivity_manifest_sha256 IS NULL) OR app_private.is_sha256(sensitivity_manifest_sha256))),
    CONSTRAINT projection_scan_runs_sensitivity_profile_sha256_check CHECK (((sensitivity_profile_sha256 IS NULL) OR app_private.is_sha256(sensitivity_profile_sha256))),
    CONSTRAINT projection_scan_runs_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'degraded'::text, 'failed'::text, 'quarantined'::text]))),
    CONSTRAINT projection_scan_runs_total_count_check CHECK ((total_count >= 0)),
    CONSTRAINT projection_scan_runs_vault_head_check CHECK (((vault_head IS NULL) OR (vault_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'::text))),
    CONSTRAINT projection_scan_runs_vault_status_sha256_check CHECK (((vault_status_sha256 IS NULL) OR app_private.is_sha256(vault_status_sha256)))
);

ALTER TABLE ONLY public.projection_scan_runs FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_scan_runs OWNER TO postgres;

--
-- Name: projection_subjects; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_subjects (
    feed_id uuid NOT NULL,
    source_path text NOT NULL,
    current_source_hash text,
    current_note_id uuid,
    pending_count integer DEFAULT 0 NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    active_claim_token uuid,
    claimed_by uuid,
    lease_expires_at timestamp with time zone,
    claim_attempt integer DEFAULT 0 NOT NULL,
    withdrawal_generation bigint DEFAULT 0 NOT NULL,
    last_outcome text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_subjects_check CHECK ((((active_claim_token IS NULL) AND (claimed_by IS NULL) AND (lease_expires_at IS NULL)) OR ((active_claim_token IS NOT NULL) AND (claimed_by IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT projection_subjects_claim_attempt_check CHECK ((claim_attempt >= 0)),
    CONSTRAINT projection_subjects_current_source_hash_check CHECK (((current_source_hash IS NULL) OR app_private.is_sha256(current_source_hash))),
    CONSTRAINT projection_subjects_generation_check CHECK ((generation >= 0)),
    CONSTRAINT projection_subjects_pending_count_check CHECK ((pending_count >= 0)),
    CONSTRAINT projection_subjects_source_path_check CHECK (app_private.is_safe_relative_markdown_path(source_path)),
    CONSTRAINT projection_subjects_withdrawal_generation_check CHECK ((withdrawal_generation >= 0))
);

ALTER TABLE ONLY public.projection_subjects FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_subjects OWNER TO postgres;

--
-- Name: projection_worker_principals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projection_worker_principals (
    id uuid NOT NULL,
    key extensions.citext NOT NULL,
    permission_key extensions.citext NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT projection_worker_principals_permission_key_check CHECK ((permission_key OPERATOR(extensions.=) 'memory.write.librarian'::extensions.citext))
);

ALTER TABLE ONLY public.projection_worker_principals FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projection_worker_principals OWNER TO postgres;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.projects (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    key extensions.citext NOT NULL,
    name text NOT NULL,
    description text,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.projects FORCE ROW LEVEL SECURITY;


ALTER TABLE public.projects OWNER TO postgres;

--
-- Name: request_source_bindings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.request_source_bindings (
    request_id uuid NOT NULL,
    commitment_key text NOT NULL,
    source_ref text NOT NULL,
    source_revision text NOT NULL,
    ruling_ref text NOT NULL,
    ruling_revision text NOT NULL,
    bound_by text NOT NULL,
    bound_adapter text NOT NULL,
    bound_principal text NOT NULL,
    bound_input_version integer NOT NULL,
    bound_input_hash text NOT NULL,
    source_anchor jsonb,
    binding_fingerprint text NOT NULL,
    bound_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT request_source_bindings_binding_fingerprint_check CHECK ((binding_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT request_source_bindings_bound_by_check CHECK (app_private.is_person_key(bound_by)),
    CONSTRAINT request_source_bindings_bound_input_hash_check CHECK ((bound_input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT request_source_bindings_bound_input_version_check CHECK ((bound_input_version >= 1)),
    CONSTRAINT request_source_bindings_commitment_key_check CHECK ((((length(btrim(commitment_key)) >= 8) AND (length(btrim(commitment_key)) <= 200)) AND (commitment_key ~ '^[A-Za-z0-9_.:-]+$'::text))),
    CONSTRAINT request_source_bindings_ruling_revision_check CHECK ((ruling_revision ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT request_source_bindings_source_anchor_check CHECK (((source_anchor IS NULL) OR (jsonb_typeof(source_anchor) = 'object'::text))),
    CONSTRAINT request_source_bindings_source_revision_check CHECK ((source_revision ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY public.request_source_bindings FORCE ROW LEVEL SECURITY;


ALTER TABLE public.request_source_bindings OWNER TO postgres;

--
-- Name: requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.requests (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    adapter text NOT NULL,
    requester_principal text NOT NULL,
    requested_by text NOT NULL,
    requester_role extensions.citext NOT NULL,
    idempotency_key text NOT NULL,
    client text,
    project_key extensions.citext,
    source_type text NOT NULL,
    source_id text,
    origin_ref jsonb,
    permitted_audience text[] NOT NULL,
    requested jsonb NOT NULL,
    input_version integer DEFAULT 1 NOT NULL,
    input_hash text NOT NULL,
    state text DEFAULT 'pending_approval'::text NOT NULL,
    task_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT requests_approved_has_task CHECK (((state <> 'approved'::text) OR (task_id IS NOT NULL))),
    CONSTRAINT requests_client_check CHECK (((client IS NULL) OR (((length(btrim(client)) >= 1) AND (length(btrim(client)) <= 120)) AND (client !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT requests_idempotency_key_check CHECK ((((length(btrim(idempotency_key)) >= 8) AND (length(btrim(idempotency_key)) <= 200)) AND (idempotency_key ~ '^[A-Za-z0-9_.:-]+$'::text))),
    CONSTRAINT requests_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT requests_input_version_check CHECK ((input_version >= 1)),
    CONSTRAINT requests_origin_ref_check CHECK (((origin_ref IS NULL) OR (jsonb_typeof(origin_ref) = 'object'::text))),
    CONSTRAINT requests_permitted_audience_check CHECK ((array_length(permitted_audience, 1) >= 1)),
    CONSTRAINT requests_requested_by_check CHECK (app_private.is_person_key(requested_by)),
    CONSTRAINT requests_source_id_check CHECK (((source_id IS NULL) OR (((length(btrim(source_id)) >= 1) AND (length(btrim(source_id)) <= 200)) AND (source_id !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT requests_source_type_check CHECK ((source_type = ANY (ARRAY['web_form'::text, 'call'::text, 'slack_message'::text, 'operator_note'::text]))),
    CONSTRAINT requests_state_check CHECK ((state = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'declined'::text]))),
    CONSTRAINT requests_task_only_when_approved CHECK (((task_id IS NULL) OR (state = 'approved'::text)))
);

ALTER TABLE ONLY public.requests FORCE ROW LEVEL SECURITY;


ALTER TABLE public.requests OWNER TO postgres;

--
-- Name: roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.roles (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    key extensions.citext NOT NULL,
    label text NOT NULL,
    description text,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


ALTER TABLE public.roles OWNER TO postgres;

--
-- Name: tasks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tasks (
    id uuid DEFAULT extensions.gen_random_uuid() NOT NULL,
    title text NOT NULL,
    client text,
    lane text NOT NULL,
    owner text NOT NULL,
    origin text NOT NULL,
    state text NOT NULL,
    due date,
    source_quote text,
    created_by text NOT NULL,
    declined_reason text,
    stale_flagged_at timestamp with time zone,
    receipts jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'generic'::text NOT NULL,
    sent_back_reason text,
    task_revision bigint DEFAULT 0 NOT NULL,
    due_origin text DEFAULT 'original'::text NOT NULL,
    execution_gate text DEFAULT 'ready'::text NOT NULL,
    meeting_action boolean DEFAULT false NOT NULL,
    executor text,
    next_reviewer text,
    work_status text,
    CONSTRAINT meeting_work_status CHECK (((work_status IS NULL) OR (work_status = ANY (ARRAY['todo'::text, 'needs_review'::text, 'completed'::text, 'atlas_held'::text])))),
    CONSTRAINT tasks_client_check CHECK (((client IS NULL) OR (((length(btrim(client)) >= 1) AND (length(btrim(client)) <= 120)) AND (client !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT tasks_created_by_check CHECK (app_private.is_person_key(created_by)),
    CONSTRAINT tasks_declined_has_reason CHECK (((state <> 'declined'::text) OR (declined_reason IS NOT NULL))),
    CONSTRAINT tasks_declined_reason_check CHECK (((declined_reason IS NULL) OR ((length(btrim(declined_reason)) >= 1) AND (length(btrim(declined_reason)) <= 1000)))),
    CONSTRAINT tasks_delivered_has_receipts CHECK (((state <> 'delivered'::text) OR (receipts IS NOT NULL))),
    CONSTRAINT tasks_due_origin_check CHECK ((due_origin = ANY (ARRAY['original'::text, 'owner_override'::text]))),
    CONSTRAINT tasks_execution_gate_check CHECK ((execution_gate = ANY (ARRAY['ready'::text, 'review_required'::text, 'sent_back'::text, 'declined'::text]))),
    CONSTRAINT tasks_kind_check CHECK ((kind = ANY (ARRAY['doc'::text, 'audit'::text, 'generic'::text]))),
    CONSTRAINT tasks_lane_check CHECK ((lane = ANY (ARRAY['business'::text, 'engineering'::text]))),
    CONSTRAINT tasks_origin_check CHECK ((origin = ANY (ARRAY['slack_request'::text, 'atlas_signal'::text, 'operator'::text]))),
    CONSTRAINT tasks_owner_check CHECK (app_private.is_person_key(owner)),
    CONSTRAINT tasks_reason_only_when_declined CHECK (((declined_reason IS NULL) OR (state = 'declined'::text))),
    CONSTRAINT tasks_receipts_check CHECK (((receipts IS NULL) OR (jsonb_typeof(receipts) = 'object'::text))),
    CONSTRAINT tasks_sent_back_reason_check CHECK (((sent_back_reason IS NULL) OR ((length(btrim(sent_back_reason)) >= 1) AND (length(btrim(sent_back_reason)) <= 1000)))),
    CONSTRAINT tasks_sent_back_reason_only_when_sent_back CHECK (((sent_back_reason IS NULL) OR (state = 'sent_back'::text))),
    CONSTRAINT tasks_source_quote_check CHECK (((source_quote IS NULL) OR ((length(source_quote) >= 1) AND (length(source_quote) <= 2000)))),
    CONSTRAINT tasks_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'needs_approval'::text, 'approved'::text, 'in_build'::text, 'delivered'::text, 'declined'::text, 'sent_back'::text]))),
    CONSTRAINT tasks_title_check CHECK ((((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 300)) AND (title !~ '[[:cntrl:]]'::text)))
);

ALTER TABLE ONLY public.tasks FORCE ROW LEVEL SECURITY;


ALTER TABLE public.tasks OWNER TO postgres;

--
-- Name: TABLE tasks; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.tasks IS 'Gate B1 action board. One flat card per task. Written only through task_create/task_act; read only through task_board. RLS is enabled and forced with no policies, so no role can reach a row directly.';


--
-- Name: COLUMN tasks.kind; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.kind IS 'What the task IS, so the F2 worker can choose a builder: doc | audit | generic. Rows created before gate F1 are generic because they predate the distinction.';


--
-- Name: COLUMN tasks.sent_back_reason; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.tasks.sent_back_reason IS 'Why a card was pushed back to a human, from task_act send_back or from task_fail after a failed build. Peer of declined_reason, and constrained the same way: cleared on leaving sent_back. It exists because declined_reason is pinned to state=declined and a send-back note had nowhere to live.';


--
-- Name: meeting_history meeting_history_actor_operation_id_key; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_history
    ADD CONSTRAINT meeting_history_actor_operation_id_key UNIQUE (actor, operation_id);


--
-- Name: meeting_history meeting_history_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_history
    ADD CONSTRAINT meeting_history_pkey PRIMARY KEY (id);


--
-- Name: meeting_items meeting_items_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_items
    ADD CONSTRAINT meeting_items_pkey PRIMARY KEY (request_id);


--
-- Name: meeting_items meeting_items_source_id_commitment_key_key; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_items
    ADD CONSTRAINT meeting_items_source_id_commitment_key_key UNIQUE (source_id, commitment_key);


--
-- Name: meeting_keys meeting_keys_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_keys
    ADD CONSTRAINT meeting_keys_pkey PRIMARY KEY (source_id, commitment_key);


--
-- Name: meeting_policy meeting_policy_db_role_key; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_policy
    ADD CONSTRAINT meeting_policy_db_role_key UNIQUE (db_role);


--
-- Name: meeting_policy meeting_policy_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_policy
    ADD CONSTRAINT meeting_policy_pkey PRIMARY KEY (id);


--
-- Name: meeting_reviewers meeting_reviewers_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_reviewers
    ADD CONSTRAINT meeting_reviewers_pkey PRIMARY KEY (actor);


--
-- Name: meeting_scans meeting_scans_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_scans
    ADD CONSTRAINT meeting_scans_pkey PRIMARY KEY (policy, starts_at, ends_at);


--
-- Name: meeting_scope meeting_scope_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_scope
    ADD CONSTRAINT meeting_scope_pkey PRIMARY KEY (source_id);


--
-- Name: meeting_source_people meeting_source_people_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_source_people
    ADD CONSTRAINT meeting_source_people_pkey PRIMARY KEY (source_id, actor);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (source_id);


--
-- Name: workspace_actors workspace_actors_actor_key; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.workspace_actors
    ADD CONSTRAINT workspace_actors_actor_key UNIQUE (actor);


--
-- Name: workspace_actors workspace_actors_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.workspace_actors
    ADD CONSTRAINT workspace_actors_pkey PRIMARY KEY (db_role);


--
-- Name: workspace_clients workspace_clients_pkey; Type: CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.workspace_clients
    ADD CONSTRAINT workspace_clients_pkey PRIMARY KEY (actor, client);


--
-- Name: derived_graph_metadata derived_graph_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.derived_graph_metadata
    ADD CONSTRAINT derived_graph_metadata_pkey PRIMARY KEY (feed_id, source_path);


--
-- Name: evidence_revisions evidence_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.evidence_revisions
    ADD CONSTRAINT evidence_revisions_pkey PRIMARY KEY (scope, ref);


--
-- Name: intake_source_versions intake_source_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.intake_source_versions
    ADD CONSTRAINT intake_source_versions_pkey PRIMARY KEY (source_id, revision);


--
-- Name: intake_sources intake_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.intake_sources
    ADD CONSTRAINT intake_sources_pkey PRIMARY KEY (source_id);


--
-- Name: memory_chunks memory_chunks_note_version_id_chunk_profile_ordinal_chunk_t_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_note_version_id_chunk_profile_ordinal_chunk_t_key UNIQUE (note_version_id, chunk_profile, ordinal, chunk_text_hash, embedding_profile);


--
-- Name: memory_chunks memory_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_pkey PRIMARY KEY (id);


--
-- Name: memory_note_links memory_note_links_note_version_id_target_path_target_sectio_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_links
    ADD CONSTRAINT memory_note_links_note_version_id_target_path_target_sectio_key UNIQUE NULLS NOT DISTINCT (note_version_id, target_path, target_section, edge_kind);


--
-- Name: memory_note_links memory_note_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_links
    ADD CONSTRAINT memory_note_links_pkey PRIMARY KEY (id);


--
-- Name: memory_note_versions memory_note_versions_memory_note_id_version_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_versions
    ADD CONSTRAINT memory_note_versions_memory_note_id_version_key_key UNIQUE (memory_note_id, version_key);


--
-- Name: memory_note_versions memory_note_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_versions
    ADD CONSTRAINT memory_note_versions_pkey PRIMARY KEY (id);


--
-- Name: memory_notes memory_notes_feed_id_source_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_notes
    ADD CONSTRAINT memory_notes_feed_id_source_path_key UNIQUE (feed_id, source_path);


--
-- Name: memory_notes memory_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_notes
    ADD CONSTRAINT memory_notes_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_key_key UNIQUE (key);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (user_id, project_id);


--
-- Name: projection_batches projection_batches_feed_id_journal_relative_name_journal_sh_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_batches
    ADD CONSTRAINT projection_batches_feed_id_journal_relative_name_journal_sh_key UNIQUE (feed_id, journal_relative_name, journal_sha256);


--
-- Name: projection_batches projection_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_batches
    ADD CONSTRAINT projection_batches_pkey PRIMARY KEY (id);


--
-- Name: projection_classification_decisions projection_classification_decisio_scan_run_id_decision_hash_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_classification_decisions
    ADD CONSTRAINT projection_classification_decisio_scan_run_id_decision_hash_key UNIQUE (scan_run_id, decision_hash);


--
-- Name: projection_classification_decisions projection_classification_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_classification_decisions
    ADD CONSTRAINT projection_classification_decisions_pkey PRIMARY KEY (id);


--
-- Name: projection_classification_decisions projection_classification_decisions_scan_run_id_source_path_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_classification_decisions
    ADD CONSTRAINT projection_classification_decisions_scan_run_id_source_path_key UNIQUE (scan_run_id, source_path);


--
-- Name: projection_feeds projection_feeds_logical_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_feeds
    ADD CONSTRAINT projection_feeds_logical_name_key UNIQUE (logical_name);


--
-- Name: projection_feeds projection_feeds_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_feeds
    ADD CONSTRAINT projection_feeds_pkey PRIMARY KEY (id);


--
-- Name: projection_items projection_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_items
    ADD CONSTRAINT projection_items_pkey PRIMARY KEY (id);


--
-- Name: projection_items projection_items_processing_receipt_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_items
    ADD CONSTRAINT projection_items_processing_receipt_key UNIQUE (processing_receipt);


--
-- Name: projection_scan_items projection_scan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_scan_items
    ADD CONSTRAINT projection_scan_items_pkey PRIMARY KEY (scan_run_id, source_path);


--
-- Name: projection_scan_runs projection_scan_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_scan_runs
    ADD CONSTRAINT projection_scan_runs_pkey PRIMARY KEY (id);


--
-- Name: projection_subjects projection_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_subjects
    ADD CONSTRAINT projection_subjects_pkey PRIMARY KEY (feed_id, source_path);


--
-- Name: projection_worker_principals projection_worker_principals_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_worker_principals
    ADD CONSTRAINT projection_worker_principals_key_key UNIQUE (key);


--
-- Name: projection_worker_principals projection_worker_principals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_worker_principals
    ADD CONSTRAINT projection_worker_principals_pkey PRIMARY KEY (id);


--
-- Name: projects projects_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_key_key UNIQUE (key);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: request_source_bindings request_source_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.request_source_bindings
    ADD CONSTRAINT request_source_bindings_pkey PRIMARY KEY (request_id);


--
-- Name: requests requests_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_idempotency_unique UNIQUE (adapter, idempotency_key);


--
-- Name: requests requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (id);


--
-- Name: requests requests_task_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_task_id_key UNIQUE (task_id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);


--
-- Name: roles roles_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_key_key UNIQUE (key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_permissions_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_permissions_category ON public.permissions USING btree (category);


--
-- Name: idx_project_members_added_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_project_members_added_by ON public.project_members USING btree (added_by);


--
-- Name: idx_project_members_project_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_project_members_project_id ON public.project_members USING btree (project_id);


--
-- Name: idx_projects_is_archived; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_projects_is_archived ON public.projects USING btree (is_archived) WHERE (is_archived = false);


--
-- Name: idx_role_permissions_permission_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_role_permissions_permission_id ON public.role_permissions USING btree (permission_id);


--
-- Name: idx_users_role_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_role_id ON public.users USING btree (role_id);


--
-- Name: memory_chunks_version_active_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_chunks_version_active_idx ON public.memory_chunks USING btree (note_version_id, ordinal) WHERE active;


--
-- Name: memory_note_links_target_note_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_note_links_target_note_idx ON public.memory_note_links USING btree (target_note_id) WHERE (target_note_id IS NOT NULL);


--
-- Name: memory_note_links_target_path_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_note_links_target_path_idx ON public.memory_note_links USING btree (target_path);


--
-- Name: memory_note_versions_one_current_uq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX memory_note_versions_one_current_uq ON public.memory_note_versions USING btree (memory_note_id) WHERE (publication_state = 'current'::text);


--
-- Name: memory_notes_fts_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_notes_fts_idx ON public.memory_notes USING gin (to_tsvector('english'::regconfig, ((title || '
'::text) || body))) WHERE retrieval_enabled;


--
-- Name: memory_notes_project_scope_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_notes_project_scope_idx ON public.memory_notes USING btree (project_id, scope) WHERE retrieval_enabled;


--
-- Name: memory_notes_source_hash_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX memory_notes_source_hash_idx ON public.memory_notes USING btree (feed_id, current_source_hash);


--
-- Name: projection_batches_feed_state_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX projection_batches_feed_state_idx ON public.projection_batches USING btree (feed_id, state, discovered_at);


--
-- Name: projection_batches_name_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX projection_batches_name_idx ON public.projection_batches USING btree (feed_id, journal_relative_name);


--
-- Name: projection_classification_decisions_labels_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX projection_classification_decisions_labels_idx ON public.projection_classification_decisions USING btree (scan_run_id, disposition, content_class, exposure_mode);


--
-- Name: projection_items_batch_source_uq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX projection_items_batch_source_uq ON public.projection_items USING btree (batch_id, source_path) WHERE (batch_id IS NOT NULL);


--
-- Name: projection_items_claim_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX projection_items_claim_idx ON public.projection_items USING btree (feed_id, state, next_retry_at, created_at);


--
-- Name: projection_items_scan_source_uq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX projection_items_scan_source_uq ON public.projection_items USING btree (scan_run_id, source_path) WHERE (scan_run_id IS NOT NULL);


--
-- Name: projection_scan_runs_decision_manifest_uq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX projection_scan_runs_decision_manifest_uq ON public.projection_scan_runs USING btree (feed_id, decision_manifest_sha256) WHERE (decision_manifest_sha256 IS NOT NULL);


--
-- Name: request_source_bindings_commitment_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX request_source_bindings_commitment_idx ON public.request_source_bindings USING btree (commitment_key);


--
-- Name: tasks_board_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tasks_board_idx ON public.tasks USING btree (lane, state, due, created_at DESC);


--
-- Name: tasks_client_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tasks_client_idx ON public.tasks USING btree (client) WHERE (client IS NOT NULL);


--
-- Name: tasks_owner_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tasks_owner_idx ON public.tasks USING btree (owner, state);


--
-- Name: tasks_stale_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tasks_stale_idx ON public.tasks USING btree (stale_flagged_at) WHERE (stale_flagged_at IS NOT NULL);


--
-- Name: tasks_worker_poll_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX tasks_worker_poll_idx ON public.tasks USING btree (state, kind, created_at) WHERE (state = ANY (ARRAY['approved'::text, 'in_build'::text]));


--
-- Name: meeting_history meeting_history_immutable; Type: TRIGGER; Schema: app_private; Owner: postgres
--

CREATE TRIGGER meeting_history_immutable BEFORE DELETE OR UPDATE ON app_private.meeting_history FOR EACH ROW EXECUTE FUNCTION app_private.task_history_immutable();


--
-- Name: request_source_bindings meeting_binding_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER meeting_binding_guard BEFORE INSERT OR DELETE OR UPDATE ON public.request_source_bindings FOR EACH ROW EXECUTE FUNCTION app_private.meeting_binding_guard();


--
-- Name: requests meeting_request_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER meeting_request_guard BEFORE DELETE OR UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION app_private.meeting_write_guard();


--
-- Name: tasks meeting_task_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER meeting_task_guard BEFORE DELETE OR UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION app_private.meeting_write_guard();


--
-- Name: memory_notes memory_notes_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER memory_notes_set_updated_at BEFORE UPDATE ON public.memory_notes FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: projection_feeds projection_feeds_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER projection_feeds_set_updated_at BEFORE UPDATE ON public.projection_feeds FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: projection_items projection_items_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER projection_items_set_updated_at BEFORE UPDATE ON public.projection_items FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: projection_subjects projection_subjects_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER projection_subjects_set_updated_at BEFORE UPDATE ON public.projection_subjects FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: projection_worker_principals projection_worker_principals_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER projection_worker_principals_set_updated_at BEFORE UPDATE ON public.projection_worker_principals FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: requests requests_derive_and_freeze; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER requests_derive_and_freeze BEFORE INSERT OR UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION app_private.requests_derive_and_freeze();


--
-- Name: requests requests_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER requests_set_updated_at BEFORE UPDATE ON public.requests FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: tasks tasks_enforce_entry_state; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER tasks_enforce_entry_state BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION app_private.tasks_enforce_entry_state();


--
-- Name: tasks tasks_enforce_transition; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER tasks_enforce_transition BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION app_private.tasks_enforce_transition();


--
-- Name: tasks tasks_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: permissions trg_permissions_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_permissions_updated_at BEFORE UPDATE ON public.permissions FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: projects trg_projects_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: roles trg_roles_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: users trg_users_forbid_identity_escalation; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_users_forbid_identity_escalation BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION app_private.forbid_identity_escalation();


--
-- Name: users trg_users_forbid_worker_human; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_users_forbid_worker_human BEFORE INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION app_private.forbid_worker_human();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();


--
-- Name: meeting_history meeting_history_request_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_history
    ADD CONSTRAINT meeting_history_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id);


--
-- Name: meeting_items meeting_items_request_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_items
    ADD CONSTRAINT meeting_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id);


--
-- Name: meeting_items meeting_items_source_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_items
    ADD CONSTRAINT meeting_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES app_private.meetings(source_id);


--
-- Name: meeting_keys meeting_keys_request_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_keys
    ADD CONSTRAINT meeting_keys_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id);


--
-- Name: meeting_keys meeting_keys_source_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_keys
    ADD CONSTRAINT meeting_keys_source_id_fkey FOREIGN KEY (source_id) REFERENCES app_private.meetings(source_id);


--
-- Name: meeting_policy meeting_policy_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_policy
    ADD CONSTRAINT meeting_policy_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.projects(id);


--
-- Name: meeting_reviewers meeting_reviewers_actor_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_reviewers
    ADD CONSTRAINT meeting_reviewers_actor_fkey FOREIGN KEY (actor) REFERENCES app_private.workspace_actors(actor);


--
-- Name: meeting_reviewers meeting_reviewers_rhys_actor_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_reviewers
    ADD CONSTRAINT meeting_reviewers_rhys_actor_fkey FOREIGN KEY (rhys_actor) REFERENCES app_private.workspace_actors(actor);


--
-- Name: meeting_scans meeting_scans_policy_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_scans
    ADD CONSTRAINT meeting_scans_policy_fkey FOREIGN KEY (policy) REFERENCES app_private.meeting_policy(id);


--
-- Name: meeting_scope meeting_scope_policy_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_scope
    ADD CONSTRAINT meeting_scope_policy_fkey FOREIGN KEY (policy) REFERENCES app_private.meeting_policy(id);


--
-- Name: meeting_source_people meeting_source_people_actor_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_source_people
    ADD CONSTRAINT meeting_source_people_actor_fkey FOREIGN KEY (actor) REFERENCES app_private.workspace_actors(actor);


--
-- Name: meeting_source_people meeting_source_people_source_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meeting_source_people
    ADD CONSTRAINT meeting_source_people_source_id_fkey FOREIGN KEY (source_id) REFERENCES app_private.meeting_scope(source_id);


--
-- Name: meetings meetings_policy_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.meetings
    ADD CONSTRAINT meetings_policy_fkey FOREIGN KEY (policy) REFERENCES app_private.meeting_policy(id);


--
-- Name: workspace_actors workspace_actors_workspace_id_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.workspace_actors
    ADD CONSTRAINT workspace_actors_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.projects(id);


--
-- Name: workspace_clients workspace_clients_actor_fkey; Type: FK CONSTRAINT; Schema: app_private; Owner: postgres
--

ALTER TABLE ONLY app_private.workspace_clients
    ADD CONSTRAINT workspace_clients_actor_fkey FOREIGN KEY (actor) REFERENCES app_private.workspace_actors(actor);


--
-- Name: derived_graph_metadata derived_graph_metadata_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.derived_graph_metadata
    ADD CONSTRAINT derived_graph_metadata_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.projection_classification_decisions(id);


--
-- Name: derived_graph_metadata derived_graph_metadata_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.derived_graph_metadata
    ADD CONSTRAINT derived_graph_metadata_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: intake_sources intake_sources_source_id_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.intake_sources
    ADD CONSTRAINT intake_sources_source_id_revision_fkey FOREIGN KEY (source_id, revision) REFERENCES public.intake_source_versions(source_id, revision);


--
-- Name: memory_chunks memory_chunks_note_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_chunks
    ADD CONSTRAINT memory_chunks_note_version_id_fkey FOREIGN KEY (note_version_id) REFERENCES public.memory_note_versions(id) ON DELETE CASCADE;


--
-- Name: memory_note_links memory_note_links_note_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_links
    ADD CONSTRAINT memory_note_links_note_version_id_fkey FOREIGN KEY (note_version_id) REFERENCES public.memory_note_versions(id) ON DELETE CASCADE;


--
-- Name: memory_note_links memory_note_links_target_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_links
    ADD CONSTRAINT memory_note_links_target_note_id_fkey FOREIGN KEY (target_note_id) REFERENCES public.memory_notes(id) ON DELETE SET NULL;


--
-- Name: memory_note_versions memory_note_versions_memory_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_versions
    ADD CONSTRAINT memory_note_versions_memory_note_id_fkey FOREIGN KEY (memory_note_id) REFERENCES public.memory_notes(id) ON DELETE CASCADE;


--
-- Name: memory_note_versions memory_note_versions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_note_versions
    ADD CONSTRAINT memory_note_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: memory_notes memory_notes_current_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_notes
    ADD CONSTRAINT memory_notes_current_version_fk FOREIGN KEY (current_version_id) REFERENCES public.memory_note_versions(id);


--
-- Name: memory_notes memory_notes_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_notes
    ADD CONSTRAINT memory_notes_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: memory_notes memory_notes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.memory_notes
    ADD CONSTRAINT memory_notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: project_members project_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id);


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: projection_batches projection_batches_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_batches
    ADD CONSTRAINT projection_batches_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: projection_classification_decisions projection_classification_decisions_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_classification_decisions
    ADD CONSTRAINT projection_classification_decisions_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: projection_classification_decisions projection_classification_decisions_scan_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_classification_decisions
    ADD CONSTRAINT projection_classification_decisions_scan_run_id_fkey FOREIGN KEY (scan_run_id) REFERENCES public.projection_scan_runs(id) ON DELETE CASCADE;


--
-- Name: projection_items projection_items_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_items
    ADD CONSTRAINT projection_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.projection_batches(id);


--
-- Name: projection_items projection_items_claimed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_items
    ADD CONSTRAINT projection_items_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.projection_worker_principals(id);


--
-- Name: projection_items projection_items_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_items
    ADD CONSTRAINT projection_items_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: projection_items projection_items_scan_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_items
    ADD CONSTRAINT projection_items_scan_run_id_fkey FOREIGN KEY (scan_run_id) REFERENCES public.projection_scan_runs(id);


--
-- Name: projection_scan_items projection_scan_items_projection_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_scan_items
    ADD CONSTRAINT projection_scan_items_projection_item_id_fkey FOREIGN KEY (projection_item_id) REFERENCES public.projection_items(id);


--
-- Name: projection_scan_items projection_scan_items_scan_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_scan_items
    ADD CONSTRAINT projection_scan_items_scan_run_id_fkey FOREIGN KEY (scan_run_id) REFERENCES public.projection_scan_runs(id) ON DELETE CASCADE;


--
-- Name: projection_scan_runs projection_scan_runs_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_scan_runs
    ADD CONSTRAINT projection_scan_runs_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: projection_subjects projection_subjects_claimed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_subjects
    ADD CONSTRAINT projection_subjects_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.projection_worker_principals(id);


--
-- Name: projection_subjects projection_subjects_current_note_fk; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_subjects
    ADD CONSTRAINT projection_subjects_current_note_fk FOREIGN KEY (current_note_id) REFERENCES public.memory_notes(id);


--
-- Name: projection_subjects projection_subjects_feed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.projection_subjects
    ADD CONSTRAINT projection_subjects_feed_id_fkey FOREIGN KEY (feed_id) REFERENCES public.projection_feeds(id);


--
-- Name: request_source_bindings request_source_bindings_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.request_source_bindings
    ADD CONSTRAINT request_source_bindings_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;


--
-- Name: requests requests_project_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_project_key_fkey FOREIGN KEY (project_key) REFERENCES public.projects(key);


--
-- Name: requests requests_requester_role_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_requester_role_fkey FOREIGN KEY (requester_role) REFERENCES public.roles(key);


--
-- Name: requests requests_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: users users_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: meeting_history; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_history ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_items; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_items ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_keys; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_policy; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_reviewers; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_reviewers ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_scans; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_scans ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_scope; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_scope ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_source_people; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meeting_source_people ENABLE ROW LEVEL SECURITY;

--
-- Name: meetings; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_actors; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.workspace_actors ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_clients; Type: ROW SECURITY; Schema: app_private; Owner: postgres
--

ALTER TABLE app_private.workspace_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: derived_graph_metadata; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.derived_graph_metadata ENABLE ROW LEVEL SECURITY;

--
-- Name: evidence_revisions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.evidence_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: intake_source_versions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.intake_source_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: intake_sources; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.intake_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_chunks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.memory_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_note_links; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.memory_note_links ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_note_versions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.memory_note_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_notes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.memory_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_notes memory_notes_select_scoped_v4; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY memory_notes_select_scoped_v4 ON public.memory_notes FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (exposure_mode = 'browseable'::text) AND retrieval_enabled AND (classification_state = 'classified'::text) AND (review_state = 'approved'::text) AND app_private.can_access_project(project_id) AND ((sensitivity <> 'internal_financial'::text) OR app_private.has_permission('financial.read_internal'::text)) AND ((source_class <> 'atlas_training_source'::text) OR app_private.has_permission('memory.read.training_source'::text)) AND
CASE scope
    WHEN 'strategy'::text THEN app_private.has_permission('memory.read.strategy'::text)
    WHEN 'ops'::text THEN app_private.has_permission('memory.read.ops'::text)
    WHEN 'content'::text THEN app_private.has_permission('memory.read.content'::text)
    WHEN 'monday'::text THEN app_private.has_permission('memory.read.monday'::text)
    WHEN 'client_sensitive'::text THEN app_private.has_permission('memory.read.client_sensitive'::text)
    ELSE false
END));


--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions permissions_select_scoped; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY permissions_select_scoped ON public.permissions FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (app_private.is_admin() OR (EXISTS ( SELECT 1
   FROM (public.role_permissions rp
     JOIN public.users u ON ((u.role_id = rp.role_id)))
  WHERE ((u.id = ( SELECT auth.uid() AS uid)) AND (rp.permission_id = permissions.id)))))));


--
-- Name: project_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

--
-- Name: project_members project_members_select_self; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY project_members_select_self ON public.project_members FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND ((user_id = ( SELECT auth.uid() AS uid)) OR app_private.is_admin() OR (app_private.can_access_project(project_id) AND app_private.has_permission('users.read_team'::text)))));


--
-- Name: projection_batches; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_classification_decisions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_classification_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_feeds; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_feeds ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_items ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_scan_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_scan_items ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_scan_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_scan_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_subjects; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: projection_worker_principals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projection_worker_principals ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: projects projects_select_access; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY projects_select_access ON public.projects FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND app_private.can_access_project(id)));


--
-- Name: request_source_bindings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.request_source_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions role_permissions_select_self; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY role_permissions_select_self ON public.role_permissions FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (app_private.is_admin() OR (role_id = ( SELECT u.role_id
   FROM public.users u
  WHERE (u.id = ( SELECT auth.uid() AS uid)))))));


--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: roles roles_select_self; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY roles_select_self ON public.roles FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (app_private.is_admin() OR (id = ( SELECT u.role_id
   FROM public.users u
  WHERE (u.id = ( SELECT auth.uid() AS uid)))))));


--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_select_self_or_team; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY users_select_self_or_team ON public.users FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND ((id = ( SELECT auth.uid() AS uid)) OR app_private.is_admin() OR app_private.has_permission('users.read_team'::text))));


--
-- Name: SCHEMA app_private; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA app_private TO service_role;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO atlas_retrieval;
GRANT USAGE ON SCHEMA public TO atlas_meeting_nat_web;
GRANT USAGE ON SCHEMA public TO atlas_meeting_rhys_web;
GRANT USAGE ON SCHEMA public TO atlas_meeting_astra_20260911_ingest;


--
-- Name: FUNCTION bounded_retrieve_policy(p_audience text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.bounded_retrieve_policy(p_audience text) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.bounded_retrieve_policy(p_audience text) TO service_role;


--
-- Name: FUNCTION can_access_project(project_id uuid); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.can_access_project(project_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.can_access_project(project_id uuid) TO service_role;
GRANT ALL ON FUNCTION app_private.can_access_project(project_id uuid) TO authenticated;


--
-- Name: FUNCTION can_decide_in_project(perm_key text, p_project_id uuid); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.can_decide_in_project(perm_key text, p_project_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.can_decide_in_project(perm_key text, p_project_id uuid) TO service_role;
GRANT ALL ON FUNCTION app_private.can_decide_in_project(perm_key text, p_project_id uuid) TO authenticated;


--
-- Name: FUNCTION current_projection_worker(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.current_projection_worker() FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.current_projection_worker() TO service_role;


--
-- Name: FUNCTION forbid_identity_escalation(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.forbid_identity_escalation() FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.forbid_identity_escalation() TO service_role;


--
-- Name: FUNCTION forbid_worker_human(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.forbid_worker_human() FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.forbid_worker_human() TO service_role;


--
-- Name: FUNCTION has_permission(permission_key text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.has_permission(permission_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.has_permission(permission_key text) TO service_role;
GRANT ALL ON FUNCTION app_private.has_permission(permission_key text) TO authenticated;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.is_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.is_admin() TO service_role;
GRANT ALL ON FUNCTION app_private.is_admin() TO authenticated;


--
-- Name: FUNCTION is_person_key(p_value text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.is_person_key(p_value text) FROM PUBLIC;


--
-- Name: FUNCTION is_safe_relative_markdown_path(p_value text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.is_safe_relative_markdown_path(p_value text) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.is_safe_relative_markdown_path(p_value text) TO service_role;


--
-- Name: FUNCTION is_sha256(p_value text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.is_sha256(p_value text) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.is_sha256(p_value text) TO service_role;


--
-- Name: FUNCTION meeting_actor(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.meeting_actor() FROM PUBLIC;


--
-- Name: FUNCTION meeting_add_item(sid text, candidate jsonb, creator text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.meeting_add_item(sid text, candidate jsonb, creator text) FROM PUBLIC;


--
-- Name: FUNCTION meeting_binding_guard(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.meeting_binding_guard() FROM PUBLIC;


--
-- Name: FUNCTION meeting_can_read(sid text, person text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.meeting_can_read(sid text, person text) FROM PUBLIC;


--
-- Name: FUNCTION meeting_write_guard(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.meeting_write_guard() FROM PUBLIC;


--
-- Name: FUNCTION receipts_shape_error(p_receipts jsonb); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.receipts_shape_error(p_receipts jsonb) FROM PUBLIC;


--
-- Name: FUNCTION request_canonical_input(p_requested jsonb, p_client text, p_project_key text, p_source_type text, p_source_id text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.request_canonical_input(p_requested jsonb, p_client text, p_project_key text, p_source_type text, p_source_id text) FROM PUBLIC;


--
-- Name: FUNCTION request_input_hash(p_canonical jsonb); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.request_input_hash(p_canonical jsonb) FROM PUBLIC;


--
-- Name: FUNCTION request_transition_allowed(p_from text, p_to text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.request_transition_allowed(p_from text, p_to text) FROM PUBLIC;


--
-- Name: FUNCTION requests_derive_and_freeze(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.requests_derive_and_freeze() FROM PUBLIC;


--
-- Name: FUNCTION safe_excerpt(p_text text, p_max integer); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.safe_excerpt(p_text text, p_max integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.safe_excerpt(p_text text, p_max integer) TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.set_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION app_private.set_updated_at() TO service_role;


--
-- Name: FUNCTION task_board_policy(p_audience text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.task_board_policy(p_audience text) FROM PUBLIC;


--
-- Name: FUNCTION task_history_immutable(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.task_history_immutable() FROM PUBLIC;


--
-- Name: FUNCTION task_transition_allowed(p_from text, p_to text); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.task_transition_allowed(p_from text, p_to text) FROM PUBLIC;


--
-- Name: FUNCTION tasks_enforce_entry_state(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.tasks_enforce_entry_state() FROM PUBLIC;


--
-- Name: FUNCTION tasks_enforce_transition(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.tasks_enforce_transition() FROM PUBLIC;


--
-- Name: FUNCTION workspace_actor(); Type: ACL; Schema: app_private; Owner: postgres
--

REVOKE ALL ON FUNCTION app_private.workspace_actor() FROM PUBLIC;


--
-- Name: FUNCTION apply_memory_projection(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_memory_projection(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_memory_projection(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION apply_supervised_memory_projection(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.apply_supervised_memory_projection(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_supervised_memory_projection(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION begin_supervised_classification_run(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.begin_supervised_classification_run(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.begin_supervised_classification_run(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION bounded_retrieve(query text, audience text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.bounded_retrieve(query text, audience text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bounded_retrieve(query text, audience text) TO service_role;
GRANT ALL ON FUNCTION public.bounded_retrieve(query text, audience text) TO atlas_retrieval;


--
-- Name: FUNCTION claim_projection_item(p_feed_id uuid, p_lease_seconds integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.claim_projection_item(p_feed_id uuid, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_projection_item(p_feed_id uuid, p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION complete_supervised_classification_run(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.complete_supervised_classification_run(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_supervised_classification_run(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION enqueue_projection_item(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.enqueue_projection_item(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_projection_item(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION evidence_revision_set(payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.evidence_revision_set(payload jsonb) FROM PUBLIC;


--
-- Name: FUNCTION finish_projection_item(p_item_id uuid, p_claim_token uuid, p_state text, p_safe_error_code text, p_retry_seconds integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.finish_projection_item(p_item_id uuid, p_claim_token uuid, p_state text, p_safe_error_code text, p_retry_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_projection_item(p_item_id uuid, p_claim_token uuid, p_state text, p_safe_error_code text, p_retry_seconds integer) TO service_role;


--
-- Name: FUNCTION get_supervised_projection_decision(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.get_supervised_projection_decision(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_supervised_projection_decision(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION intake_source_capture(payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.intake_source_capture(payload jsonb) FROM PUBLIC;


--
-- Name: FUNCTION intake_source_current(id text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.intake_source_current(id text) FROM PUBLIC;


--
-- Name: FUNCTION meeting_capability(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.meeting_capability() FROM PUBLIC;
GRANT ALL ON FUNCTION public.meeting_capability() TO atlas_meeting_nat_web;
GRANT ALL ON FUNCTION public.meeting_capability() TO atlas_meeting_rhys_web;


--
-- Name: FUNCTION meeting_ingest(action text, payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.meeting_ingest(action text, payload jsonb) FROM PUBLIC;


--
-- Name: FUNCTION meeting_queue(action text, payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.meeting_queue(action text, payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.meeting_queue(action text, payload jsonb) TO atlas_meeting_nat_web;
GRANT ALL ON FUNCTION public.meeting_queue(action text, payload jsonb) TO atlas_meeting_rhys_web;


--
-- Name: FUNCTION prepare_projection_item(p_item_id uuid, p_claim_token uuid, p_source_hash text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.prepare_projection_item(p_item_id uuid, p_claim_token uuid, p_source_hash text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prepare_projection_item(p_item_id uuid, p_claim_token uuid, p_source_hash text) TO service_role;


--
-- Name: FUNCTION register_projection_batch(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.register_projection_batch(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_projection_batch(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION register_supervised_decision_batch(p_payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.register_supervised_decision_batch(p_payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_supervised_decision_batch(p_payload jsonb) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION task_act(task_id uuid, action text, note text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.task_act(task_id uuid, action text, note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_act(task_id uuid, action text, note text) TO atlas_retrieval;


--
-- Name: FUNCTION task_board(audience text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.task_board(audience text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_board(audience text) TO atlas_retrieval;


--
-- Name: FUNCTION task_create(payload jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.task_create(payload jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_create(payload jsonb) TO atlas_retrieval;


--
-- Name: FUNCTION task_deliver(task_id uuid, receipts jsonb); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.task_deliver(task_id uuid, receipts jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_deliver(task_id uuid, receipts jsonb) TO atlas_retrieval;


--
-- Name: FUNCTION task_fail(task_id uuid, note text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.task_fail(task_id uuid, note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_fail(task_id uuid, note text) TO atlas_retrieval;


--
-- Name: FUNCTION task_start_build(task_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.task_start_build(task_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.task_start_build(task_id uuid) TO atlas_retrieval;


--
-- Name: TABLE memory_notes; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.memory_notes TO authenticated;


--
-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.permissions TO authenticated;
GRANT SELECT ON TABLE public.permissions TO service_role;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.role_permissions TO authenticated;
GRANT SELECT ON TABLE public.role_permissions TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.users TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO service_role;


--
-- Name: TABLE my_permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.my_permissions TO authenticated;


--
-- Name: TABLE project_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.project_members TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.project_members TO service_role;


--
-- Name: TABLE projects; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.projects TO authenticated;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.projects TO service_role;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.roles TO authenticated;
GRANT SELECT ON TABLE public.roles TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: app_private; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app_private GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict P5AjCR2gMlF4MzUCeB65s3js73NAYV3jFz1QdeOzlNExpNaIxMfXGTibHknqUOT

