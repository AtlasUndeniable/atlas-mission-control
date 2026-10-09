-- Task-linked drafting: asset release scope, Atlas execution binding and the usage ledger.
-- Additive over 022. No identities, business tasks, grants, releases or runtime configuration
-- is seeded, and no existing capability is granted to a new role.
begin;
do $$begin
 if to_regclass('app_private.task_documents')is null then raise exception 'task_documents_absent_apply_022_first';end if;
 if to_regprocedure('public.meeting_document(text,uuid,jsonb)')is null
  or to_regprocedure('public.meeting_document_runtime(text,uuid,jsonb)')is null
  or to_regprocedure('app_private.task_document_packet(uuid,text,text)')is null then raise exception 'document_preimage_absent';end if;
 if exists(select 1 from information_schema.columns where table_schema='app_private'and table_name='task_documents'and column_name='asset_release')then raise exception 'already_installed_inspect';end if;
end$$;

-- The reviewed asset roots. Must stay identical to atlasAssetRoots() in
-- src/lib/task-asset-search.ts; client-archives and calls are deliberately absent.
create function app_private.task_document_asset_roots()returns text[] language sql immutable set search_path='' as
$$select array['playbooks','frameworks','operating-manual','lead-magnets']$$;
revoke all on function app_private.task_document_asset_roots()from public,anon,authenticated,service_role;

alter table app_private.task_documents
 -- Source-owner release scope. Null means asset retrieval is not released for this task.
 add column asset_release jsonb,
 -- Shared roots that may reach a builder-role audience. Never widened by the runtime.
 add column builder_safe_roots text[] not null default array[]::text[],
 -- Canonical Atlas execution. Held by default; a separate reviewed decision turns it on.
 add column atlas_executor boolean not null default false,
 add column atlas_executor_decision text,
 -- Output ceiling for this document's generation, bounding both the request and the charge.
 add column max_output_tokens integer not null default 8000 check(max_output_tokens between 100 and 12000),
 add constraint task_documents_asset_release_shape check(
  asset_release is null or (
   jsonb_typeof(asset_release)='object'
   and length(coalesce(asset_release->>'decision',''))>=10
   and jsonb_typeof(asset_release->'sharedRoots')='array'
   and jsonb_typeof(asset_release->'clientDirectories')='array'
   and not exists(select 1 from jsonb_array_elements_text(asset_release->'sharedRoots')r where r<>all(app_private.task_document_asset_roots()))
   and not exists(select 1 from jsonb_array_elements_text(asset_release->'clientDirectories')d where d!~'^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$')
  )),
 add constraint task_documents_atlas_executor_decision check(not atlas_executor or length(coalesce(atlas_executor_decision,''))>=10),
 add constraint task_documents_builder_safe_roots check(not exists(select 1 from unnest(builder_safe_roots)r where r<>all(app_private.task_document_asset_roots())));

-- The usage ledger for drafting. One row per reserved invocation, as for intake.
alter table app_private.task_document_attempts
 -- Worst-case charge computed from the UTF-8 byte floor before the key is ever read.
 add column cost_bound_bytes integer check(cost_bound_bytes is null or cost_bound_bytes>0),
 add column cost_bound_micros bigint check(cost_bound_micros is null or cost_bound_micros>0),
 add column input_tokens integer check(input_tokens is null or input_tokens>=0),
 add column output_tokens integer check(output_tokens is null or output_tokens>=0),
 add column usage_at timestamptz,
 -- Digest of the exact released asset set supplied, beside the prompt hash.
 add column asset_digest text check(asset_digest is null or asset_digest~'^[0-9a-f]{64}$');

create function app_private.task_document_usage_immutable()returns trigger language plpgsql set search_path='' as $$begin
 -- A recorded charge is a fact. It may be written once and never revised downward.
 if old.input_tokens is not null and (new.input_tokens is distinct from old.input_tokens or new.output_tokens is distinct from old.output_tokens or new.usage_at is distinct from old.usage_at)
  then raise exception 'recorded_usage_immutable';end if;
 if old.cost_bound_micros is not null and new.cost_bound_micros is distinct from old.cost_bound_micros then raise exception 'recorded_cost_bound_immutable';end if;
 if old.asset_digest is not null and new.asset_digest is distinct from old.asset_digest then raise exception 'recorded_asset_digest_immutable';end if;
 return new;
end$$;
create trigger task_document_usage_immutable before update on app_private.task_document_attempts for each row execute function app_private.task_document_usage_immutable();
revoke all on function app_private.task_document_usage_immutable()from public,anon,authenticated,service_role;

-- Release scope and Atlas-execution changes are content/authority changes, so they must
-- fence prior attempts and output exactly like a grant or classification change.
create trigger task_document_release_fence after update on app_private.task_documents for each row execute function app_private.task_document_authority_fence();

-- Replaces the 022 packet: permits a separately decided Atlas executor, returns the asset
-- release scope, and refuses a shared-root release that a builder audience may not receive.
create or replace function app_private.task_document_packet(did uuid,person text,needed text)returns jsonb
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
 or t.executor is distinct from d.executor or t.owner is distinct from d.owner or t.next_reviewer is distinct from d.reviewer
 -- Canonical Atlas execution is permitted only by its own recorded decision on this row.
 or (t.executor='atlas' and not d.atlas_executor)
 or (t.executor<>'atlas' and d.atlas_executor)
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
 -- A builder audience, Nat included, receives only shared roots separately marked safe for
 -- a builder. Her existing financial and full-source restrictions are unchanged below.
 if d.asset_release is not null and exists(select 1 from app_private.task_document_grants dg join app_private.workspace_actors wa on wa.actor=dg.actor where dg.document_id=did and dg.active and wa.role='builder')
  and exists(select 1 from jsonb_array_elements_text(d.asset_release->'sharedRoots')root where root<>all(d.builder_safe_roots))
  then raise exception 'asset_release_builder_denied'using errcode='42501';end if;
 entries:=jsonb_build_array(jsonb_build_object('id','commitment','version',g.source_revision,'sourceHash',d.projection_hash,'kind','commitment','title',g.projection->>'title','text',g.projection->'evidence'->>'quote','display',true,'use',true,'sourceRef',jsonb_build_object('sourceId',i.source_id),'reviewReference',g.review_reference,'observedAt',clock_timestamp()));
 if jsonb_array_length(entries)>12 or (select count(*)from app_private.task_document_evidence where document_id=did)>11 then raise exception 'packet_limit';end if;
 for e in select de.*,n.body,n.title,n.current_version_id,n.current_source_hash,n.project_id,n.classification_state,n.review_state,n.retrieval_enabled,n.sensitivity,n.source_class,n.content_class,n.exposure_mode,n.classification_decision_hash,n.last_source_observed_at,v.memory_note_id,v.publication_state,v.source_content_hash,v.sensitivity version_sensitivity,v.content_class version_class,v.exposure_mode version_exposure,v.classification_decision_hash version_classification from app_private.task_document_evidence de join public.memory_notes n on n.id=de.note_id join public.memory_note_versions v on v.id=de.version_id where de.document_id=did for share of de,n,v loop
  if (e.kind='client_history'and e.client is distinct from q.client)or (e.client is not null and e.client<>q.client)or not e.active or not e.use_allowed or not e.display_allowed or e.current_version_id<>e.version_id or e.memory_note_id<>e.note_id or e.current_source_hash<>e.source_hash or e.source_content_hash<>e.source_hash or e.classification_hash is distinct from e.classification_decision_hash or e.version_classification is distinct from e.classification_hash or e.classification_state<>'classified' or e.review_state<>'approved' or not e.retrieval_enabled or e.publication_state<>'current' or e.project_id<>a.workspace_id or e.exposure_mode<>'browseable' or e.version_exposure<>'browseable' or e.content_class is distinct from e.version_class or e.content_class in('deep_ip','training_source') or e.source_class='atlas_training_source' or e.last_source_observed_at<now()-interval '14 days' then raise exception 'evidence_denied_or_stale'using errcode='42501';end if;
  if (e.sensitivity='internal_financial' or e.version_sensitivity='internal_financial') and exists(select 1 from app_private.task_document_grants dg join app_private.workspace_actors wa on wa.actor=dg.actor where dg.document_id=did and dg.active and wa.role='builder')then raise exception 'financial_output_denied'using errcode='42501';end if;
  if e.sensitivity is distinct from e.version_sensitivity then raise exception 'classification_changed'using errcode='42501';end if;
  entries:=entries||jsonb_build_array(jsonb_build_object('id',e.note_id,'version',e.version_id,'sourceHash',e.source_hash,'kind',e.kind,'title',app_private.safe_excerpt(e.title,200),'text',app_private.safe_excerpt(e.body,6000),'display',true,'use',true,'sourceRef',null,'reviewReference',e.decision_reference,'observedAt',e.last_source_observed_at,'classification',e.classification_hash));
 end loop;
 select jsonb_agg(jsonb_build_array(dg.actor,dg.epoch,wa.epoch,wc.epoch,dg.rights)order by dg.actor)into epochs from app_private.task_document_grants dg join app_private.workspace_actors wa on wa.actor=dg.actor join app_private.workspace_clients wc on wc.actor=dg.actor and wc.client=q.client where dg.document_id=did and dg.active;
 -- Lifecycle-only canonical revision advances do not release new content. Content/grant,
 -- release-scope and Atlas-execution changes do.
 binding:=jsonb_build_object('task',d.task_id,'requestHash',q.input_hash,'source',d.source_revision,'projection',g.projection_hash,'authorityEpoch',d.authorization_epoch,'audience',epochs,'evidence',(select jsonb_agg(x-'observedAt')from jsonb_array_elements(entries)x),'configuration',d.configuration_hash,'decision',d.decision_reference,'assetRelease',d.asset_release,'builderSafeRoots',d.builder_safe_roots,'atlasExecutor',d.atlas_executor);
 fingerprint:=encode(extensions.digest(binding::text,'sha256'),'hex');
 return jsonb_build_object('fingerprint',fingerprint,'workspaceId',a.workspace_id,'taskId',t.id,'requestId',q.id,'client',q.client,'owner',d.owner,'title',d.title,'workflow',d.workflow,'audience','internal_review','entries',entries,'missingContext',d.missing_context,'assetRelease',d.asset_release);
end$$;
revoke all on function app_private.task_document_packet(uuid,text,text)from public,anon,authenticated,service_role;

-- Replaces the 022 runtime: binds the asset digest at the dispatch check and records the
-- bounded charge and the actual usage against this attempt.
create or replace function public.meeting_document_runtime(action text,attempt_id uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
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
  -- The asset set is bound before dispatch, so a draft can always be traced to the exact
  -- released sources it was given, independently of the prompt bytes.
  if d.asset_release is not null and coalesce(payload->>'assetDigest','')!~'^[0-9a-f]{64}$'then raise exception 'asset_binding_required';end if;
  -- The worst-case charge enters the ledger before the provider is ever contacted, so no
  -- dispatch can exist outside a reservation that already accounts for its cost.
  if (payload->'costBound'->>'requestBytes')::integer is null or (payload->'costBound'->>'micros')::bigint is null
   or (payload->'costBound'->>'maxOutputTokens')::integer is distinct from d.max_output_tokens then raise exception 'cost_bound_required';end if;
  update app_private.task_document_attempts set prompt_hash=payload->>'promptHash',asset_digest=nullif(payload->>'assetDigest',''),
   cost_bound_bytes=(payload->'costBound'->>'requestBytes')::integer,cost_bound_micros=(payload->'costBound'->>'micros')::bigint,
   dispatch_at=clock_timestamp()where id=x.id;
  return jsonb_build_object('ok',true);
 elsif action='usage' then
  -- A billed call counts whether or not its output is usable. Written once, never revised.
  if x.dispatch_at is null then raise exception 'usage_outside_dispatch'using errcode='PT409';end if;
  if x.input_tokens is not null then return jsonb_build_object('replay',true);end if;
  if (payload->'usage'->>'input_tokens')::integer is null or (payload->'usage'->>'output_tokens')::integer is null
   or (payload->'usage'->>'output_tokens')::integer>d.max_output_tokens then raise exception 'usage_invalid';end if;
  update app_private.task_document_attempts set
   input_tokens=(payload->'usage'->>'input_tokens')::integer,
   output_tokens=(payload->'usage'->>'output_tokens')::integer,
   usage_at=clock_timestamp()
   where id=x.id;
  return jsonb_build_object('recorded',true);
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
revoke all on function public.meeting_document_runtime(text,uuid,jsonb)from public,anon,authenticated,service_role;

-- Replaces the 022 document entrypoint for the Atlas-executor flow. With a human executor
-- nothing changes. With canonical Atlas execution there is no human executor to reserve a
-- generation or hand work over, so the accountable owner starts the draft and the required
-- reviewer accepts the exact version, which performs both canonical transitions at once.
create or replace function public.meeting_document(action text,task_id uuid,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare a app_private.workspace_actors;d app_private.task_documents;p jsonb;x app_private.task_document_attempts;v app_private.task_document_versions;
 prior app_private.task_document_events;op uuid;note text;result jsonb;i app_private.meeting_items;canonical text;needed text;starter text;
begin
 perform pg_advisory_xact_lock(hashtext('atlas.meeting.queue'));
 perform 1 from app_private.meetings m join app_private.meeting_items mi on mi.source_id=m.source_id join app_private.task_documents doc on doc.request_id=mi.request_id where doc.task_id=meeting_document.task_id for update of m;
 a:=app_private.meeting_actor();select * into d from app_private.task_documents where task_documents.task_id=meeting_document.task_id for update;
 if not found then return jsonb_build_object('available',false,'reason','Task-specific context, executor, output and generation decisions are not recorded.');end if;
 -- Who may reserve a generation and cancel it: the human executor, or the accountable
 -- owner when Atlas is the recorded executor. Never an unnamed caller either way.
 starter:=case when d.atlas_executor then d.owner else d.executor end;
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
  if a.actor<>starter or payload->>'configurationHash' is distinct from d.configuration_hash then raise exception 'generation_binding_denied'using errcode='42501';end if;
  select * into x from app_private.task_document_attempts where document_id=d.id and revision=d.revision for update;
  if found then return jsonb_build_object('replay',true,'attempt',x.id,'state',x.state,'dispatch',false);end if;
  if d.status not in('ready','needs_revision') or (payload->>'revision')::integer is distinct from d.revision then raise exception 'revision_changed'using errcode='PT409';end if;
  if (select count(*)from app_private.task_document_attempts where document_id=d.id)>=d.max_invocations then raise exception 'invocation_budget_spent'using errcode='PT409';end if;
  insert into app_private.task_document_attempts(document_id,revision,initiator,fingerprint,configuration_hash,state,deadline)values(d.id,d.revision,a.actor,p->>'fingerprint',d.configuration_hash,'reserved',clock_timestamp()+make_interval(secs=>d.timeout_ms/1000.0+10))returning * into x;
  update app_private.task_documents set status='building'where id=d.id;
  result:=jsonb_build_object('attempt',x.id,'token',x.token,'dispatch',true,'packet',p,'revisionNote',(select ev.note from app_private.task_document_events ev where ev.document_id=d.id and ev.operation='revise'order by ev.created_at desc limit 1),'previous',(select jsonb_build_object('version',version,'hash',content_hash,'markdown',content)from app_private.task_document_versions where document_id=d.id and version=d.current_version));
 elsif action='cancel' then
  if a.actor<>starter then raise exception 'cancel_denied'using errcode='42501';end if;
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
   -- Atlas is not a human executor and cannot hand work to a reviewer.
   if d.atlas_executor then raise exception 'atlas_execution_has_no_handoff'using errcode='PT409';end if;
   if a.actor<>d.executor or d.status<>'draft' then raise exception 'handoff_denied'using errcode='42501';end if;
   canonical:='complete';update app_private.task_documents set status='in_review',handoff_version=d.current_version where id=d.id;
  elsif action='review' then
   if a.actor<>d.reviewer then raise exception 'review_denied'using errcode='42501';end if;
   if d.atlas_executor then
    -- Approve on an Atlas-drafted task: bind this exact version, then complete and review
    -- the canonical item in one authorized step.
    if d.status<>'draft' then raise exception 'review_denied'using errcode='42501';end if;
    update app_private.task_documents set handoff_version=v.version,status='accepted'where id=d.id;
    perform app_private.meeting_queue_v21('complete',jsonb_build_object('sourceId',i.source_id,'id',i.request_id,'revision',i.revision,'operationId',extensions.gen_random_uuid(),'note','Atlas draft v'||v.version||' submitted for required review; SHA256 '||v.content_hash||'; no external delivery.','sharedNote',note));
    select * into i from app_private.meeting_items where request_id=d.request_id;
    canonical:='review';
   else
    if d.status<>'in_review'or d.handoff_version<>v.version then raise exception 'review_denied'using errcode='42501';end if;
    canonical:='review';update app_private.task_documents set status='accepted'where id=d.id;
   end if;
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
revoke all on function public.meeting_document(text,uuid,jsonb)from public,anon,authenticated,service_role;
commit;
