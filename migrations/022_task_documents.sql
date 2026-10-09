-- Preparation only. No identities, business tasks, grants or runtime configuration seeded.
begin;
do $$begin
 if md5(pg_get_functiondef('public.meeting_queue(text,jsonb)'::regprocedure))<>'940060da2e26207b0b4c0795ca2b16f2' then raise exception 'meeting_preimage_changed';end if;
 if to_regclass('app_private.task_documents')is not null then raise exception 'already_installed_inspect';end if;
end$$;
create table app_private.task_documents(
 id uuid primary key default extensions.gen_random_uuid(),task_id uuid unique not null references public.tasks(id),
 request_id uuid unique not null references public.requests(id),context_actor text not null references app_private.workspace_actors(actor),
 title text not null,workflow text not null check(workflow in('role_sop','client_action_brief')),
 owner text not null,executor text not null,reviewer text not null,source_revision text not null,request_hash text not null,
 projection_hash text not null,source_binding_hash text,task_revision bigint not null,item_revision bigint not null,
 configuration_hash text not null check(configuration_hash~'^[a-f0-9]{64}$'),runtime_role name not null,
 max_invocations integer not null check(max_invocations between 1 and 2),timeout_ms integer not null check(timeout_ms between 1 and 60000),
 decision_reference text not null check(length(decision_reference)>=10),enabled boolean not null default false,
 authorization_epoch bigint not null default 1,revision integer not null default 1,current_version integer not null default 0,
 status text not null default 'ready' check(status in('ready','building','uncertain','rejected','cancelled','draft','needs_revision','in_review','accepted')),
 handoff_version integer,missing_context jsonb not null default '[]'
);
create table app_private.task_document_grants(
 document_id uuid references app_private.task_documents(id),actor text references app_private.workspace_actors(actor),
 rights text[] not null check(rights<@array['context','build','output','revise','handoff','review']),
 epoch bigint not null default 1,active boolean not null default false,decision_reference text not null check(length(decision_reference)>=10),
 primary key(document_id,actor)
);
create function app_private.task_document_grant_epoch()returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE'then raise exception 'Retain authority history; revoke with active=false';end if;
 if new.document_id<>old.document_id or new.actor<>old.actor then raise exception 'authority_identity_immutable';end if;
 if (to_jsonb(new)-'epoch')is distinct from(to_jsonb(old)-'epoch')then new.epoch:=old.epoch+1;else new.epoch:=old.epoch;end if;return new;
end$$;
create trigger task_document_grant_epoch before update or delete on app_private.task_document_grants for each row execute function app_private.task_document_grant_epoch();
revoke all on function app_private.task_document_grant_epoch()from public,anon,authenticated,service_role;

create table app_private.task_document_evidence(
 document_id uuid references app_private.task_documents(id),note_id uuid references public.memory_notes(id),
 version_id uuid not null references public.memory_note_versions(id),source_hash text not null,classification_hash text not null,
 kind text not null check(kind in('client_history','method','example')),client text,use_allowed boolean not null default false,display_allowed boolean not null default false,
 active boolean not null default false,decision_reference text not null,primary key(document_id,note_id)
);
create table app_private.task_document_attempts(
 id uuid primary key default extensions.gen_random_uuid(),document_id uuid not null references app_private.task_documents(id),revision integer not null,
 initiator text not null,token uuid not null default extensions.gen_random_uuid(),fingerprint text not null,configuration_hash text not null,
 state text not null check(state in('reserved','recorded','published','cancelled','invalid')),deadline timestamptz not null,
 prompt_hash text check(prompt_hash ~ '^[0-9a-f]{64}$'),dispatch_at timestamptz,
 response jsonb,response_hash text,content text,content_hash text,created_at timestamptz not null default clock_timestamp(),
 unique(document_id,revision)
);
create table app_private.task_document_versions(
 document_id uuid references app_private.task_documents(id),version integer,attempt_id uuid unique not null references app_private.task_document_attempts(id),
 fingerprint text not null,content text not null,content_hash text not null,initiator text not null,executor text not null default 'atlas_document_runtime',
 created_at timestamptz not null default clock_timestamp(),primary key(document_id,version),
 check(content_hash=encode(extensions.digest(content,'sha256'),'hex'))
);
create table app_private.task_document_events(
 id uuid primary key default extensions.gen_random_uuid(),document_id uuid not null references app_private.task_documents(id),actor text not null,
 operation text not null,operation_id uuid not null,input jsonb not null,version integer,note text not null,fingerprint text not null,
 created_at timestamptz not null default clock_timestamp(),unique(document_id,actor,operation_id)
);
create trigger task_document_versions_immutable before update or delete on app_private.task_document_versions for each row execute function app_private.task_history_immutable();
create trigger task_document_events_immutable before update or delete on app_private.task_document_events for each row execute function app_private.task_history_immutable();
create table app_private.task_document_authority_history(
 id uuid primary key default extensions.gen_random_uuid(),document_id uuid not null references app_private.task_documents(id),
 authority text not null,before_hash text,after_hash text,actor_role text not null,created_at timestamptz not null default clock_timestamp()
);
create trigger task_document_authority_immutable before update or delete on app_private.task_document_authority_history for each row execute function app_private.task_history_immutable();
create function app_private.task_document_authority_fence()returns trigger language plpgsql security definer set search_path='' as $$
declare before_value jsonb;after_value jsonb;ref jsonb;d app_private.task_documents;sid text;changed boolean;
begin
 before_value:=case when tg_op='INSERT'then null else to_jsonb(old)end;
 after_value:=case when tg_op='DELETE'then null else to_jsonb(new)end;ref:=coalesce(after_value,before_value);
 if tg_table_name='task_documents'then
  before_value:=before_value-array['revision','current_version','status','handoff_version','item_revision','task_revision','authorization_epoch'];
  after_value:=after_value-array['revision','current_version','status','handoff_version','item_revision','task_revision','authorization_epoch'];
 elsif tg_table_name='memory_notes'then
  before_value:=before_value-array['last_source_observed_at','updated_at'];after_value:=after_value-array['last_source_observed_at','updated_at'];
 elsif tg_table_name='meeting_task_grants'then
  before_value:=before_value-'item_revision';after_value:=after_value-'item_revision';
 end if;
 if before_value is not distinct from after_value then return null;end if;
 for d in select * from app_private.task_documents loop
  select i.source_id into sid from app_private.meeting_items i where i.request_id=d.request_id;
  changed:=case
   when tg_table_name='task_documents'then d.id::text=ref->>'id'
   when tg_table_name in('task_document_grants','task_document_evidence')then d.id::text=ref->>'document_id'
   when tg_table_name='meeting_task_grants'then d.request_id::text=ref->>'request_id'
   when tg_table_name in('workspace_actors','workspace_clients','meeting_reviewers')then exists(select 1 from app_private.task_document_grants g where g.document_id=d.id and g.actor=ref->>'actor')or d.context_actor=ref->>'actor'
   when tg_table_name='memory_notes'then exists(select 1 from app_private.task_document_evidence e where e.document_id=d.id and e.note_id::text=ref->>'id')
   when tg_table_name='memory_note_versions'then exists(select 1 from app_private.task_document_evidence e where e.document_id=d.id and e.version_id::text=ref->>'id')
   when tg_table_name='meeting_policy'then exists(select 1 from app_private.meeting_scope s where s.source_id=sid and s.policy=ref->>'id')
   when tg_table_name in('meeting_scope','meeting_source_people','intake_sources')then sid=ref->>'source_id'
   else false end;
  if changed then
   update app_private.task_documents set authorization_epoch=authorization_epoch+1 where id=d.id;
   insert into app_private.task_document_authority_history(document_id,authority,before_hash,after_hash,actor_role)values(d.id,tg_table_schema||'.'||tg_table_name,encode(extensions.digest(before_value::text,'sha256'),'hex'),encode(extensions.digest(after_value::text,'sha256'),'hex'),coalesce(current_setting('role',true),'operator'));
  end if;
 end loop;
 return null;
end$$;
create trigger task_document_policy_fence after update on app_private.task_documents for each row execute function app_private.task_document_authority_fence();
create trigger task_document_grant_fence after insert or update or delete on app_private.task_document_grants for each row execute function app_private.task_document_authority_fence();
create trigger task_document_evidence_fence after insert or update or delete on app_private.task_document_evidence for each row execute function app_private.task_document_authority_fence();
create trigger task_document_context_fence after update or delete on app_private.meeting_task_grants for each row execute function app_private.task_document_authority_fence();
create trigger task_document_actor_fence after update or delete on app_private.workspace_actors for each row execute function app_private.task_document_authority_fence();
create trigger task_document_client_fence after update or delete on app_private.workspace_clients for each row execute function app_private.task_document_authority_fence();
create trigger task_document_reviewer_fence after update or delete on app_private.meeting_reviewers for each row execute function app_private.task_document_authority_fence();
create trigger task_document_scope_fence after update or delete on app_private.meeting_scope for each row execute function app_private.task_document_authority_fence();
create trigger task_document_people_fence after update or delete on app_private.meeting_source_people for each row execute function app_private.task_document_authority_fence();
create trigger task_document_policy_scope_fence after update or delete on app_private.meeting_policy for each row execute function app_private.task_document_authority_fence();
create trigger task_document_source_fence after update or delete on public.intake_sources for each row execute function app_private.task_document_authority_fence();
create trigger task_document_note_fence after update or delete on public.memory_notes for each row execute function app_private.task_document_authority_fence();
create trigger task_document_note_version_fence after update or delete on public.memory_note_versions for each row execute function app_private.task_document_authority_fence();
alter table app_private.task_document_authority_history enable row level security;
revoke all on app_private.task_document_authority_history from public,anon,authenticated,service_role;
revoke all on function app_private.task_document_authority_fence()from public,anon,authenticated,service_role;

-- Document operations serialize, then lock the canonical meeting row before the document and its dependencies.
create function app_private.task_document_packet(did uuid,person text,needed text)returns jsonb
language plpgsql security definer set search_path='' as $$
declare d app_private.task_documents;a app_private.workspace_actors;t public.tasks;q public.requests;i app_private.meeting_items;
 g app_private.meeting_task_grants;r record;e record;entries jsonb;fingerprint text;binding jsonb;epochs jsonb;
begin
 perform pg_advisory_xact_lock(hashtext('atlas.meeting.queue'));
 perform 1 from app_private.meetings m join app_private.meeting_items mi on mi.source_id=m.source_id join app_private.task_documents doc on doc.request_id=mi.request_id where doc.id=did for update of m;
 select * into d from app_private.task_documents where id=did for update;
 if not found or not d.enabled then raise exception 'document_unavailable'using errcode='42501';end if;
 select * into a from app_private.workspace_actors where actor=person and active for share;
 if not found then raise exception 'document_denied'using errcode='42501';end if;
 perform 1 from app_private.task_document_grants where document_id=did for share;
 if not exists(select 1 from app_private.task_document_grants where document_id=did and actor=person and active and needed=any(rights)and 'context'=any(rights)and 'output'=any(rights))then raise exception 'document_denied'using errcode='42501';end if;
 select * into q from public.requests where id=d.request_id for share;
 select * into i from app_private.meeting_items where request_id=q.id for share;
 select * into t from public.tasks where id=d.task_id for share;
 perform app_private.meeting_item_lock(q.id,d.context_actor);
 select * into g from app_private.meeting_task_grants where request_id=q.id and actor=d.context_actor for share;
 perform 1 from public.intake_sources where source_id=i.source_id for share;
 if q.state<>'approved' or q.task_id is distinct from t.id or not t.meeting_action
 or t.executor is distinct from d.executor or t.owner is distinct from d.owner or t.next_reviewer is distinct from d.reviewer or t.executor='atlas'
 or (t.work_status='completed'and d.status<>'accepted')or t.state in('declined','sent_back','delivered')or t.execution_gate in('declined','sent_back')
 or (select encode(extensions.digest(to_jsonb(b)::text,'sha256'),'hex')from public.request_source_bindings b where b.request_id=q.id) is distinct from d.source_binding_hash
 or q.input_hash is distinct from d.request_hash or i.revision is distinct from d.item_revision or t.task_revision is distinct from d.task_revision
 or not app_private.meeting_task_valid(q.id,d.context_actor) or g.projection_hash is distinct from d.projection_hash
 or g.source_revision is distinct from d.source_revision then raise exception 'document_context_changed'using errcode='PT409';end if;
 if not exists(select 1 from app_private.task_document_grants where document_id=did and actor=d.reviewer and active and rights @> array['context','output','review'])or not exists(select 1 from app_private.meeting_reviewers where actor=d.reviewer and active and can_review)then raise exception 'reviewer_unavailable'using errcode='42501';end if;
 -- Every output audience member must retain both item and explicit document scope.
 for r in select dg.*,wa.role,wa.epoch actor_epoch from app_private.task_document_grants dg join app_private.workspace_actors wa on wa.actor=dg.actor where document_id=did and dg.active loop
  perform app_private.meeting_item_lock(q.id,r.actor);
  if not app_private.meeting_item_access(q.id,r.actor)or not exists(select 1 from app_private.workspace_actors wa join app_private.workspace_clients wc on wc.actor=wa.actor where wa.actor=r.actor and wa.active and wc.active and wc.client=q.client and wa.workspace_id=a.workspace_id)then raise exception 'audience_revoked'using errcode='42501';end if;
 end loop;
 entries:=jsonb_build_array(jsonb_build_object('id','commitment','version',g.source_revision,'sourceHash',d.projection_hash,'kind','commitment','title',g.projection->>'title','text',g.projection->'evidence'->>'quote','display',true,'use',true,'sourceRef',jsonb_build_object('sourceId',i.source_id),'reviewReference',g.review_reference,'observedAt',clock_timestamp()));
 if jsonb_array_length(entries)>12 or (select count(*)from app_private.task_document_evidence where document_id=did)>11 then raise exception 'packet_limit';end if;
 for e in select de.*,n.body,n.title,n.current_version_id,n.current_source_hash,n.project_id,n.classification_state,n.review_state,n.retrieval_enabled,n.sensitivity,n.source_class,n.content_class,n.exposure_mode,n.classification_decision_hash,n.last_source_observed_at,v.memory_note_id,v.publication_state,v.source_content_hash,v.sensitivity version_sensitivity,v.content_class version_class,v.exposure_mode version_exposure,v.classification_decision_hash version_classification from app_private.task_document_evidence de join public.memory_notes n on n.id=de.note_id join public.memory_note_versions v on v.id=de.version_id where de.document_id=did for share of de,n,v loop
  if (e.kind='client_history'and e.client is distinct from q.client)or (e.client is not null and e.client<>q.client)or not e.active or not e.use_allowed or not e.display_allowed or e.current_version_id<>e.version_id or e.memory_note_id<>e.note_id or e.current_source_hash<>e.source_hash or e.source_content_hash<>e.source_hash or e.classification_hash is distinct from e.classification_decision_hash or e.version_classification is distinct from e.classification_hash or e.classification_state<>'classified' or e.review_state<>'approved' or not e.retrieval_enabled or e.publication_state<>'current' or e.project_id<>a.workspace_id or e.exposure_mode<>'browseable' or e.version_exposure<>'browseable' or e.content_class is distinct from e.version_class or e.content_class in('deep_ip','training_source') or e.source_class='atlas_training_source' or e.last_source_observed_at<now()-interval '14 days' then raise exception 'evidence_denied_or_stale'using errcode='42501';end if;
  if (e.sensitivity='internal_financial' or e.version_sensitivity='internal_financial') and exists(select 1 from app_private.task_document_grants dg join app_private.workspace_actors wa on wa.actor=dg.actor where dg.document_id=did and dg.active and wa.role='builder')then raise exception 'financial_output_denied'using errcode='42501';end if;
  if e.sensitivity is distinct from e.version_sensitivity then raise exception 'classification_changed'using errcode='42501';end if;
  entries:=entries||jsonb_build_array(jsonb_build_object('id',e.note_id,'version',e.version_id,'sourceHash',e.source_hash,'kind',e.kind,'title',app_private.safe_excerpt(e.title,200),'text',app_private.safe_excerpt(e.body,6000),'display',true,'use',true,'sourceRef',null,'reviewReference',e.decision_reference,'observedAt',e.last_source_observed_at,'classification',e.classification_hash));
 end loop;
 select jsonb_agg(jsonb_build_array(dg.actor,dg.epoch,wa.epoch,wc.epoch,dg.rights)order by dg.actor)into epochs from app_private.task_document_grants dg join app_private.workspace_actors wa on wa.actor=dg.actor join app_private.workspace_clients wc on wc.actor=dg.actor and wc.client=q.client where dg.document_id=did and dg.active;
 -- Lifecycle-only canonical revision advances do not release new content. Content/grant changes do.
 binding:=jsonb_build_object('task',d.task_id,'requestHash',q.input_hash,'source',d.source_revision,'projection',g.projection_hash,'authorityEpoch',d.authorization_epoch,'audience',epochs,'evidence',(select jsonb_agg(x-'observedAt')from jsonb_array_elements(entries)x),'configuration',d.configuration_hash,'decision',d.decision_reference);
 fingerprint:=encode(extensions.digest(binding::text,'sha256'),'hex');
 return jsonb_build_object('fingerprint',fingerprint,'workspaceId',a.workspace_id,'taskId',t.id,'requestId',q.id,'client',q.client,'owner',d.owner,'title',d.title,'workflow',d.workflow,'audience','internal_review','entries',entries,'missingContext',d.missing_context);
end$$;
-- Preserve the exact v21 implementation behind a private entrypoint. No new generic write flag.
alter function public.meeting_queue(text,jsonb)set schema app_private;
alter function app_private.meeting_queue(text,jsonb)rename to meeting_queue_v21;
revoke all on function app_private.meeting_queue_v21(text,jsonb)from public,anon,authenticated,service_role,atlas_meeting_nat_web,atlas_meeting_rhys_web;
create function public.meeting_queue(action text default 'list',payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$begin
 if action in('complete','review','request_changes')and exists(select 1 from app_private.task_documents where request_id=(payload->>'id')::uuid)then raise exception 'Use the task document version review.'using errcode='PT409';end if;
 return app_private.meeting_queue_v21(action,payload);
end$$;
create function public.meeting_document(action text,task_id uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare a app_private.workspace_actors;d app_private.task_documents;p jsonb;x app_private.task_document_attempts;v app_private.task_document_versions;
 prior app_private.task_document_events;op uuid;note text;result jsonb;i app_private.meeting_items;canonical text;needed text;
begin
 perform pg_advisory_xact_lock(hashtext('atlas.meeting.queue'));
 perform 1 from app_private.meetings m join app_private.meeting_items mi on mi.source_id=m.source_id join app_private.task_documents doc on doc.request_id=mi.request_id where doc.task_id=meeting_document.task_id for update of m;
 a:=app_private.meeting_actor();select * into d from app_private.task_documents where task_documents.task_id=meeting_document.task_id for update;
 if not found then return jsonb_build_object('available',false,'reason','Task-specific context, executor, output and generation decisions are not recorded.');end if;
 needed:=case action when 'begin' then 'build' when 'cancel' then 'build' when 'revise' then 'revise' when 'handoff' then 'handoff' when 'review' then 'review' else 'output'end;
 p:=app_private.task_document_packet(d.id,a.actor,needed);
 if action='read' then
  return jsonb_build_object('available',true,'title',d.title,'status',case when exists(select 1 from app_private.task_document_versions where document_id=d.id and version=d.current_version and fingerprint<>p->>'fingerprint')or exists(select 1 from app_private.task_document_attempts where document_id=d.id and revision=d.revision and fingerprint<>p->>'fingerprint')then 'authority_changed' when d.status='building' and exists(select 1 from app_private.task_document_attempts where document_id=d.id and state='reserved' and deadline<clock_timestamp())then 'uncertain'else d.status end,'recoverable',exists(select 1 from app_private.task_document_attempts where document_id=d.id and revision=d.revision and state='recorded' and fingerprint=p->>'fingerprint'),'cancellable',exists(select 1 from app_private.task_document_attempts where document_id=d.id and revision=d.revision and state in('reserved','recorded')),'revision',d.revision,'currentVersion',d.current_version,'owner',d.owner,'executor',d.executor,'reviewer',d.reviewer,'packet',p,'rights',(select rights from app_private.task_document_grants where document_id=d.id and actor=a.actor),'versions',(select coalesce(jsonb_agg(jsonb_build_object('version',version,'hash',content_hash,'at',created_at)order by version),'[]')from app_private.task_document_versions where document_id=d.id and fingerprint=p->>'fingerprint'),'events',(select coalesce(jsonb_agg(jsonb_build_object('actor',ev.actor,'action',ev.operation,'note',ev.note,'version',ev.version,'at',ev.created_at)order by ev.created_at),'[]')from app_private.task_document_events ev where ev.document_id=d.id and ev.fingerprint=p->>'fingerprint'));
 end if;
 if action='artifact' then
  select * into v from app_private.task_document_versions where document_id=d.id and version=(payload->>'version')::integer;
  if not found or v.fingerprint<>p->>'fingerprint' then raise exception 'version_authority_changed'using errcode='PT409';end if;
  return jsonb_build_object('version',v.version,'hash',v.content_hash,'content',v.content);
 end if;
 if action not in('begin','cancel','revise','handoff','review')then raise exception 'unsupported_document_action';end if;
 if jsonb_typeof(payload)<>'object'or exists(select 1 from jsonb_object_keys(payload)k where k not in('operationId','revision','version','hash','note','configurationHash'))then raise exception 'unsupported_fields';end if;
 op:=(payload->>'operationId')::uuid;if op is null then raise exception 'operation_id_required';end if;
 select * into prior from app_private.task_document_events where document_id=d.id and actor=a.actor and operation_id=op;
 if found then
  if prior.operation<>action or prior.input<>payload then raise exception 'idempotency_conflict'using errcode='PT409';end if;
  if action<>'begin'then return jsonb_build_object('replay',true);end if;
 end if;
 if action='begin' then
  if exists(select 1 from app_private.task_document_versions where document_id=d.id and version=d.current_version and fingerprint<>p->>'fingerprint')then raise exception 'prior_version_authority_changed'using errcode='PT409';end if;
  if (payload->>'revision')::integer is distinct from d.revision then raise exception 'revision_changed'using errcode='PT409';end if;
  if a.actor<>d.executor or payload->>'configurationHash' is distinct from d.configuration_hash then raise exception 'generation_binding_denied'using errcode='42501';end if;
  select * into x from app_private.task_document_attempts where document_id=d.id and revision=d.revision for update;
  if found then return jsonb_build_object('replay',true,'attempt',x.id,'state',x.state,'dispatch',false);end if;
  if d.status not in('ready','needs_revision') or (payload->>'revision')::integer is distinct from d.revision then raise exception 'revision_changed'using errcode='PT409';end if;
  if (select count(*)from app_private.task_document_attempts where document_id=d.id)>=d.max_invocations then raise exception 'invocation_budget_spent'using errcode='PT409';end if;
  insert into app_private.task_document_attempts(document_id,revision,initiator,fingerprint,configuration_hash,state,deadline)values(d.id,d.revision,a.actor,p->>'fingerprint',d.configuration_hash,'reserved',clock_timestamp()+make_interval(secs=>d.timeout_ms/1000.0+10))returning * into x;
  update app_private.task_documents set status='building'where id=d.id;
  result:=jsonb_build_object('attempt',x.id,'token',x.token,'dispatch',true,'packet',p,'revisionNote',(select ev.note from app_private.task_document_events ev where ev.document_id=d.id and ev.operation='revise'order by ev.created_at desc limit 1),'previous',(select jsonb_build_object('version',version,'hash',content_hash,'markdown',content)from app_private.task_document_versions where document_id=d.id and version=d.current_version));
 elsif action='cancel' then
  if a.actor<>d.executor then raise exception 'cancel_denied'using errcode='42501';end if;
  update app_private.task_document_attempts set state='cancelled'where document_id=d.id and revision=d.revision and state in('reserved','recorded');
  if not found then raise exception 'no_active_attempt'using errcode='PT409';end if;
  update app_private.task_documents set status='cancelled'where id=d.id;
  result:=jsonb_build_object('cancelled',true,'notice','Publication cancelled; an already dispatched provider request may still finish. No automatic retry.');
 else
  note:=btrim(coalesce(payload->>'note',''));if length(note)not between 10 and 2000 then raise exception 'substantive_safe_note_required';end if;
  select * into v from app_private.task_document_versions where document_id=d.id and version=d.current_version;
  if not found or v.version is distinct from (payload->>'version')::integer or v.content_hash is distinct from payload->>'hash' or v.fingerprint<>p->>'fingerprint' or d.revision is distinct from(payload->>'revision')::integer then raise exception 'version_changed'using errcode='PT409';end if;
  select * into i from app_private.meeting_items where request_id=d.request_id;
  if action='revise' then
   if d.status not in('draft','in_review')then raise exception 'revision_unavailable'using errcode='PT409';end if;
   if d.status='in_review' then
    if a.actor<>d.reviewer then raise exception 'required_reviewer_only'using errcode='42501';end if;
    canonical:='request_changes';
   end if;
   update app_private.task_documents set revision=revision+1,status='needs_revision',handoff_version=null where id=d.id;
  elsif action='handoff' then
   if a.actor<>d.executor or d.status<>'draft' then raise exception 'handoff_denied'using errcode='42501';end if;
   canonical:='complete';update app_private.task_documents set status='in_review',handoff_version=d.current_version where id=d.id;
  elsif action='review' then
   if a.actor<>d.reviewer or d.status<>'in_review'or d.handoff_version<>v.version then raise exception 'review_denied'using errcode='42501';end if;
   canonical:='review';update app_private.task_documents set status='accepted'where id=d.id;
  end if;
  if canonical is not null then
   perform app_private.meeting_queue_v21(canonical,jsonb_build_object('sourceId',i.source_id,'id',i.request_id,'revision',i.revision,'operationId',op,'note',note||' [Internal draft v'||v.version||'; SHA256 '||v.content_hash||'; no external delivery.]','sharedNote',note));
   update app_private.task_documents set item_revision=(select revision from app_private.meeting_items where request_id=d.request_id),task_revision=(select task_revision from public.tasks where id=d.task_id)where id=d.id;
  end if;
  result:=jsonb_build_object('ok',true);
 end if;
 insert into app_private.task_document_events(document_id,actor,operation,operation_id,input,version,note,fingerprint)values(d.id,a.actor,action,op,payload,d.current_version,coalesce(note,case action when 'begin'then 'Bound generation reserved; no completion or delivery.'else 'Cancelled; invocation budget retained.'end),p->>'fingerprint');
 return result;
end$$;
-- Server-only runtime capability: no default grant, no actor chosen by runtime payload.
create function public.meeting_document_runtime(action text,attempt_id uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare d app_private.task_documents;x app_private.task_document_attempts;p jsonb;v integer;
begin
 perform pg_advisory_xact_lock(hashtext('atlas.meeting.queue'));
 perform 1 from app_private.meetings m join app_private.meeting_items mi on mi.source_id=m.source_id join app_private.task_documents doc on doc.request_id=mi.request_id join app_private.task_document_attempts at on at.document_id=doc.id where at.id=attempt_id for update of m;
 select doc.* into d from app_private.task_documents doc join app_private.task_document_attempts at on at.document_id=doc.id where at.id=attempt_id for update of doc;
 if not found or current_setting('role',true)::name is distinct from d.runtime_role then raise exception 'runtime_denied'using errcode='42501';end if;
 select * into x from app_private.task_document_attempts where id=attempt_id for update;
 p:=app_private.task_document_packet(d.id,x.initiator,'build');
 if x.fingerprint<>p->>'fingerprint' or x.configuration_hash<>d.configuration_hash or x.revision<>d.revision or x.state in('cancelled','invalid')then raise exception 'attempt_binding_changed'using errcode='PT409';end if;
 if action='recover' then
  -- Recorded response can publish after restart. Reserved/unknown can never dispatch again.
  if x.state not in('recorded','published')then raise exception 'outcome_uncertain_no_retry'using errcode='PT409';end if;
 elsif x.token is distinct from(payload->>'token')::uuid then raise exception 'attempt_token_denied'using errcode='42501';end if;
 if action='invalid' then
  if x.state<>'reserved' or x.dispatch_at is null or clock_timestamp()>x.deadline or payload->'response' is null or length((payload->'response')::text)>128000 then raise exception 'record_window_closed'using errcode='PT409';end if;
  update app_private.task_document_attempts set state='invalid',response=payload->'response',response_hash=encode(extensions.digest((payload->'response')::text,'sha256'),'hex')where id=x.id;
  update app_private.task_documents set status='rejected'where id=d.id;return jsonb_build_object('invalid',true);
 elsif action='check' then
  if x.state<>'reserved' or x.dispatch_at is not null or clock_timestamp()>x.deadline then raise exception 'dispatch_held'using errcode='PT409';end if;
  if coalesce(payload->>'promptHash','')!~'^[0-9a-f]{64}$'then raise exception 'prompt_binding_required';end if;
  update app_private.task_document_attempts set prompt_hash=payload->>'promptHash',dispatch_at=clock_timestamp()where id=x.id;
  return jsonb_build_object('ok',true);
 elsif action='record' then
  if x.state='recorded' and x.response=payload->'response'and x.content=payload->>'content'then return jsonb_build_object('replay',true);end if;
  if x.state<>'reserved'or x.dispatch_at is null or clock_timestamp()>x.deadline then raise exception 'record_window_closed'using errcode='PT409';end if;
  if payload->'response' is null or payload->>'content' is null or length((payload->'response')::text)not between 2 and 128000 or length(payload->>'content')not between 100 and 100000 then raise exception 'response_invalid';end if;
  update app_private.task_document_attempts set response=payload->'response',response_hash=encode(extensions.digest((payload->'response')::text,'sha256'),'hex'),content=payload->>'content',content_hash=encode(extensions.digest(payload->>'content','sha256'),'hex'),state='recorded'where id=x.id;
  return jsonb_build_object('recorded',true);
 elsif action in('publish','recover')then
  if x.state='published'then return jsonb_build_object('replay',true);end if;
  if x.state<>'recorded'then raise exception 'recorded_response_required'using errcode='PT409';end if;
  v:=d.current_version+1;
  insert into app_private.task_document_versions(document_id,version,attempt_id,fingerprint,content,content_hash,initiator)values(d.id,v,x.id,x.fingerprint,x.content,x.content_hash,x.initiator);
  update app_private.task_document_attempts set state='published'where id=x.id;
  update app_private.task_documents set status='draft',current_version=v where id=d.id;
  insert into app_private.task_document_events(document_id,actor,operation,operation_id,input,version,note,fingerprint)values(d.id,x.initiator,'generated',x.id,jsonb_build_object('executor','atlas_document_runtime'),v,'Draft generated. Human review required; no completion or delivery.',x.fingerprint);
  return jsonb_build_object('version',v);
 end if;
 raise exception 'unsupported_runtime_action';
end$$;
do $$declare n text;begin
 foreach n in array array['task_documents','task_document_grants','task_document_evidence','task_document_attempts','task_document_versions','task_document_events']loop
 execute format('alter table app_private.%I enable row level security',n);
 execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',n);
 end loop;
end$$;
revoke all on function app_private.task_document_packet(uuid,text,text)from public,anon,authenticated,service_role;
revoke all on function public.meeting_document(text,uuid,jsonb),public.meeting_document_runtime(text,uuid,jsonb),public.meeting_queue(text,jsonb)from public,anon,authenticated,service_role;
-- Existing queue capabilities retained; new document/runtime capabilities require separate reviewed binding.
grant execute on function public.meeting_queue(text,jsonb)to atlas_meeting_nat_web,atlas_meeting_rhys_web;
commit;
