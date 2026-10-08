-- Additive, disabled by absence of policy/grants. Never seed identities or replay 019/020/021/022.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin if to_regclass('app_private.task_documents') is null or to_regprocedure('public.meeting_ingest(text,jsonb)') is null then raise exception '022 and meeting foundation required';end if;end$$;
create table app_private.intake_controls(
 policy text primary key references app_private.meeting_policy(id), enabled boolean not null default false,
 metadata_allowed boolean not null default false, coverage_actors text[] not null default '{}', version text not null, decision_reference text not null check(length(decision_reference)>8),
 starts_at timestamptz not null, ends_at timestamptz not null, interval_seconds int not null check(interval_seconds between 60 and 86400),
 max_pages int not null check(max_pages between 1 and 100), max_sources int not null check(max_sources between 1 and 500),
 max_dispatches int not null check(max_dispatches between 1 and 1000), daily_dispatches int not null check(daily_dispatches between 1 and 100),
 configuration_hash text not null check(configuration_hash ~ '^[a-f0-9]{64}$'), check(ends_at>starts_at)
);
-- Discovery is not a source release. Only explicit source scopes authorize transcript retrieval.
create table app_private.intake_runs(
 id uuid primary key default extensions.gen_random_uuid(),policy text not null references app_private.intake_controls(policy),
 starts_at timestamptz not null,ends_at timestamptz not null, state text not null check(state in('scanning','catalog_complete','incomplete','failed','cancelled','finished')),
 observed_at timestamptz not null default clock_timestamp(), finished_at timestamptz, catalogued_at timestamptz, catalog jsonb not null default '[]',
 cursor int not null default 0 check(cursor>=0), reason text, policy_version text not null, check(ends_at>starts_at)
);
create table app_private.intake_run_events(id bigint generated always as identity primary key,run_id uuid not null references app_private.intake_runs(id),state text not null,cursor int not null,reason text,created_at timestamptz not null default clock_timestamp());
create function app_private.intake_run_journal()returns trigger language plpgsql security definer set search_path='' as $$begin insert into app_private.intake_run_events(run_id,state,cursor,reason)values(new.id,new.state,new.cursor,new.reason);return null;end$$;
create trigger intake_run_journal after insert or update on app_private.intake_runs for each row execute function app_private.intake_run_journal();
create trigger intake_run_events_immutable before update or delete on app_private.intake_run_events for each row execute function app_private.task_history_immutable();
create table app_private.intake_reprocess_authorizations(
 id uuid primary key default extensions.gen_random_uuid(),source_id text not null references app_private.meetings(source_id),revision text not null,
 policy text not null references app_private.intake_controls(policy),configuration_hash text not null,active boolean not null default false,
 decision_reference text not null check(length(decision_reference)>8),expires_at timestamptz not null
);
create table app_private.intake_attempts(
 id uuid primary key default extensions.gen_random_uuid(),policy text not null references app_private.intake_controls(policy),source_id text not null references app_private.meetings(source_id),
 revision text not null, configuration_hash text not null,policy_version text not null,authority_hash text not null,
 reprocess_id uuid unique references app_private.intake_reprocess_authorizations(id),
 state text not null check(state in('reserved','dispatched','recorded','published','unknown','invalid','cancelled')),
 reserved_at timestamptz not null default clock_timestamp(), dispatched_at timestamptz, response jsonb, response_hash text,items jsonb,lease_token text
);
create unique index intake_initial_content_once on app_private.intake_attempts(source_id,revision)where reprocess_id is null;
create table app_private.intake_candidates(
 id uuid primary key default extensions.gen_random_uuid(),attempt_id uuid not null references app_private.intake_attempts(id),
 source_id text not null references app_private.meetings(source_id),revision text not null,evidence jsonb not null,
 candidate_key text not null,unique(attempt_id,candidate_key)
);
create table app_private.intake_decisions(
 candidate_id uuid primary key references app_private.intake_candidates(id),request_id uuid references public.requests(id),
 relation text not null check(relation in('new','same_obligation','changed','possibly_fulfilled','possibly_superseded','not_action')),
 actor text not null,note text not null check(length(note)>8),created_at timestamptz not null default clock_timestamp()
);
create table app_private.intake_events(id bigint generated always as identity primary key,attempt_id uuid references app_private.intake_attempts(id),operation text not null,created_at timestamptz not null default clock_timestamp());
create trigger intake_decisions_immutable before update or delete on app_private.intake_decisions for each row execute function app_private.task_history_immutable();
create trigger intake_candidates_immutable before update or delete on app_private.intake_candidates for each row execute function app_private.task_history_immutable();
create trigger intake_events_immutable before update or delete on app_private.intake_events for each row execute function app_private.task_history_immutable();
create table app_private.intake_authority_epochs(policy text primary key references app_private.intake_controls(policy),epoch bigint not null default 0);
create function app_private.intake_epoch_fence()returns trigger language plpgsql security definer set search_path='' as $$
declare pol text;begin
 pol:=case when tg_table_name='meeting_policy'then coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id')else coalesce(to_jsonb(new)->>'policy',to_jsonb(old)->>'policy')end;
 if exists(select 1 from app_private.intake_controls where policy=pol)then insert into app_private.intake_authority_epochs values(pol,1)on conflict(policy)do update set epoch=intake_authority_epochs.epoch+1;end if;
 return null;end$$;
create trigger intake_scope_epoch after insert or update or delete on app_private.meeting_scope for each row execute function app_private.intake_epoch_fence();
create trigger intake_policy_epoch after update on app_private.meeting_policy for each row execute function app_private.intake_epoch_fence();
create trigger intake_reprocess_epoch after update or delete on app_private.intake_reprocess_authorizations for each row execute function app_private.intake_epoch_fence();
create trigger intake_control_epoch after insert or update on app_private.intake_controls for each row execute function app_private.intake_epoch_fence();
create function app_private.intake_authority(sid text,pol text)returns text language plpgsql security definer set search_path='' as $$
declare p app_private.meeting_policy;c app_private.intake_controls;s app_private.meeting_scope;
begin
 select * into p from app_private.meeting_policy where id=pol and active and db_role=current_setting('role',true)::name;
 select * into c from app_private.intake_controls where policy=pol and enabled;
 select * into s from app_private.meeting_scope where source_id=sid and policy=pol and active;
 if p.id is null or c.policy is null or s.source_id is null or clock_timestamp()>=c.ends_at then raise exception 'intake_source_denied' using errcode='42501';end if;
 return encode(extensions.digest((to_jsonb(p)||to_jsonb(c)||to_jsonb(s)||jsonb_build_object('epoch',(select epoch from app_private.intake_authority_epochs where policy=pol)))::text,'sha256'),'hex');
end$$;
create function public.meeting_intake(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.meeting_policy;c app_private.intake_controls;r app_private.intake_runs;a app_private.intake_attempts;m app_private.meetings;
 sid text:=payload->>'id'; auth_hash text; v jsonb; k jsonb; source jsonb;result jsonb; prior app_private.intake_attempts;permission app_private.intake_reprocess_authorizations;
begin
 select * into p from app_private.meeting_policy where db_role=current_setting('role',true)::name and active for share;
 select * into c from app_private.intake_controls where policy=p.id and enabled for update;
 if p.id is null or c.policy is null or clock_timestamp()>=c.ends_at then raise exception 'intake_disabled' using errcode='42501';end if;
 if action='configuration' then return to_jsonb(c);end if;
 if action='pending_run' then
  select * into r from app_private.intake_runs where policy=p.id and policy_version=c.version and state in('scanning','catalog_complete','incomplete','failed')order by observed_at limit 1;
  -- Failed enumeration must start a fresh fixed-window scan, not treat empty catalog as coverage.
  if r.id is not null and r.state='failed' and r.catalog='[]'::jsonb then update app_private.intake_runs set state='scanning'where id=r.id;end if;
  return jsonb_build_object('run',r.id,'fullSweepDue',not exists(select 1 from app_private.intake_runs where policy=p.id and starts_at=c.starts_at and state='finished'and finished_at>clock_timestamp()-interval '1 day'));
 end if;
 if action='start' then
  if not c.metadata_allowed or (payload->>'start')::timestamptz<c.starts_at or (payload->>'end')::timestamptz>least(c.ends_at,clock_timestamp()) or (payload->>'end')::timestamptz<=(payload->>'start')::timestamptz then raise exception 'discovery_window_denied' using errcode='42501';end if;
  insert into app_private.intake_runs(policy,starts_at,ends_at,state,policy_version)values(p.id,(payload->>'start')::timestamptz,(payload->>'end')::timestamptz,'scanning',c.version)returning * into r;return to_jsonb(r);
 end if;
 if action in('resume','catalog','checkpoint','finish','run_fail','run_cancel')then
  select * into r from app_private.intake_runs where id=(payload->>'run')::uuid and policy=p.id for update;
  if r.id is null or r.policy_version<>c.version or not c.metadata_allowed then raise exception 'run_authority_changed';end if;
  if action='resume' then if r.state='failed'and r.catalog='[]'::jsonb then update app_private.intake_runs set state='scanning'where id=r.id returning * into r;end if;return to_jsonb(r);end if;
  if r.state in('cancelled','finished')then raise exception 'run_settled';end if;
  if action='catalog' then
   if r.state<>'scanning' or jsonb_typeof(payload->'meetings')<>'array' or jsonb_array_length(payload->'meetings')>c.max_pages*50 then raise exception 'catalog_invalid';end if;
   perform public.meeting_ingest('inventory',jsonb_build_object('policy',p.id,'start',r.starts_at,'end',r.ends_at,'meetings',payload->'meetings'));
   update app_private.meetings mm set state='held',note='Explicit source scope decision required; transcript not retrieved'where mm.policy=p.id and mm.revision is null and not exists(select 1 from app_private.meeting_scope s where s.source_id=mm.source_id and s.policy=p.id and s.active);
   update app_private.intake_runs set catalog=payload->'meetings',state='catalog_complete',catalogued_at=clock_timestamp()where id=r.id;
  elsif action='checkpoint' then
   if (payload->>'cursor')::int<>r.cursor+1 or (payload->>'cursor')::int>jsonb_array_length(r.catalog)then raise exception 'checkpoint_out_of_order';end if;
   update app_private.intake_runs set cursor=(payload->>'cursor')::int where id=r.id;
  else
   update app_private.intake_runs set state=case when action='run_cancel'then 'cancelled'when action='run_fail'then 'failed'when r.cursor<jsonb_array_length(r.catalog)then 'incomplete'else 'finished'end,reason=payload->>'reason',finished_at=clock_timestamp()where id=r.id;
  end if;return jsonb_build_object('ok',true);
 end if;
 if action='eligible' then
  begin auth_hash:=app_private.intake_authority(sid,p.id);exception when insufficient_privilege then return jsonb_build_object('allowed',false);end;
  select * into m from app_private.meetings where source_id=sid and policy=p.id;
  return jsonb_build_object('allowed',m.source_id is not null and m.instant>=c.starts_at and m.instant<c.ends_at,'authority',auth_hash,'revision',m.revision);
 end if;
 if action='capture' then
  auth_hash:=app_private.intake_authority(sid,p.id);
  if auth_hash is distinct from payload->>'authority' then raise exception 'authority_changed';end if;
  select * into m from app_private.meetings where source_id=sid and policy=p.id;
  if m.instant<c.starts_at or m.instant>=c.ends_at then raise exception 'source_outside_term';end if;
  return public.meeting_ingest('capture',payload);
 end if;
 if action='reserve' then
  auth_hash:=app_private.intake_authority(sid,p.id);
  select * into m from app_private.meetings where source_id=sid and policy=p.id for update;
  if m.revision is distinct from payload->>'revision' or payload->>'configurationHash' is distinct from c.configuration_hash then raise exception 'source_or_configuration_changed';end if;
  source:=public.intake_source_current(sid)->'raw';
  if jsonb_array_length(source->'passages')=0 or (source->>'live')::boolean then raise exception 'transcript_incomplete';end if;
  select * into prior from app_private.intake_attempts where source_id=sid and revision=m.revision order by reserved_at desc limit 1;
  if prior.id is null and m.extraction_revision=m.revision and payload->>'reprocessId' is null then return jsonb_build_object('dispatch',false,'state','existing_extraction');end if;
  if prior.id is not null and payload->>'reprocessId' is null then return jsonb_build_object('dispatch',false,'attempt',prior.id,'state',prior.state);end if;
  if payload->>'reprocessId' is not null then
   select * into permission from app_private.intake_reprocess_authorizations where id=(payload->>'reprocessId')::uuid and active and policy=p.id and source_id=sid and revision=m.revision and configuration_hash=c.configuration_hash and expires_at>clock_timestamp() for update;
   if permission.id is null or exists(select 1 from app_private.intake_attempts where reprocess_id=permission.id)then raise exception 'reprocessing_not_authorized';end if;
  end if;
  if (select count(*)from app_private.intake_attempts where policy=p.id)>=c.max_dispatches or (select count(*)from app_private.intake_attempts where policy=p.id and reserved_at>=date_trunc('day',clock_timestamp()at time zone 'UTC')at time zone 'UTC')>=c.daily_dispatches then raise exception 'intake_budget_exhausted';end if;
  -- Only a valid, one-use reprocessing authorization can retire a held attempt.
  -- Retain its response and spent allowance, fence late publication, journal recovery.
  if permission.id is not null and prior.id is not null and prior.state<>'published' then
   update app_private.intake_attempts set state='cancelled'where id=prior.id;
   insert into app_private.intake_events(attempt_id,operation)values(prior.id,'explicit_reprocess_authorization_retired_attempt');
   update app_private.meetings set lease_token=null,lease_until=null where source_id=sid and lease_token::text=prior.lease_token;
  end if;
  result:=public.meeting_ingest('claim',jsonb_build_object('id',sid,'revision',m.revision));
  if result->>'token' is null then return jsonb_build_object('dispatch',false,'state','held');end if;
  insert into app_private.intake_attempts(policy,source_id,revision,configuration_hash,policy_version,authority_hash,reprocess_id,state,lease_token)values(p.id,sid,m.revision,c.configuration_hash,c.version,auth_hash,permission.id,'reserved',result->>'token')returning * into a;
  insert into app_private.intake_events(attempt_id,operation)values(a.id,'reserved_budget_spent');return jsonb_build_object('dispatch',true,'attempt',a.id);
 end if;
 select * into a from app_private.intake_attempts where id=(payload->>'attempt')::uuid and policy=p.id for update;
 if a.id is null then raise exception 'attempt_missing';end if;
 if action='status' then return jsonb_build_object('state',a.state,'attempt',a.id);end if;
 if action='cancel' then
  if a.state<>'published' then update app_private.intake_attempts set state='cancelled'where id=a.id;insert into app_private.intake_events(attempt_id,operation)values(a.id,'cancelled_publication_budget_retained');end if;return jsonb_build_object('state',case when a.state='published'then 'published'else 'cancelled'end);
 end if;
 if action in('unknown','invalid')then
  if a.state in('reserved','dispatched')then update app_private.intake_attempts set state=action where id=a.id;insert into app_private.intake_events(attempt_id,operation)values(a.id,action);end if;return '{}';
 end if;
 auth_hash:=app_private.intake_authority(a.source_id,p.id);
 if auth_hash<>a.authority_hash or a.configuration_hash<>c.configuration_hash or a.policy_version<>c.version or (select revision from public.intake_sources where source_id=a.source_id)<>a.revision then raise exception 'attempt_authority_changed' using errcode='42501';end if;
 if a.reprocess_id is not null and not exists(select 1 from app_private.intake_reprocess_authorizations where id=a.reprocess_id and active and expires_at>clock_timestamp())then raise exception 'reprocessing_revoked';end if;
 if action='dispatch' then
  if a.state<>'reserved' then raise exception 'no_redispatch';end if;
  update app_private.intake_attempts set state='dispatched',dispatched_at=clock_timestamp()where id=a.id;
 elsif action='record' then
  if a.state not in('dispatched','unknown') or a.response is not null then raise exception 'response_not_recordable';end if;
  source:=public.intake_source_current(a.source_id)->'raw';v:=payload->'response';
  if v->'coverage'->>'sourceRevision' is distinct from a.revision or v->'coverage'->>'passageCount' is distinct from jsonb_array_length(source->'passages')::text or v->'coverage'->>'completeTranscript' is distinct from 'true' or v->>'reviewedAll' is distinct from 'true' or jsonb_typeof(payload->'items')<>'array' or jsonb_array_length(payload->'items')>100 then raise exception 'invalid_extraction_receipt';end if;
  for k in select * from jsonb_array_elements(payload->'items')loop
   if k->>'sourceRevision' is distinct from a.revision or k->>'provenance'<>'transcript' or k->>'kind' not in('promise','request','suggestion') or length(coalesce(k->>'uncertainty',''))<3 or length(coalesce(k->>'quote',''))<3 or length(coalesce(k->>'title',''))<3 or k->>'key' !~ '^mc2:[a-f0-9]{32}$' or (k->>'suggestedResponsibility' is not null and not exists(select 1 from jsonb_array_elements(source->'passages')x where x->>'speaker'=k->>'suggestedResponsibility')) or (k->>'due' is not null and (k->>'due' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or k->>'dueQuote' is null or position(k->>'due' in k->>'dueQuote')=0 or position(k->>'dueQuote' in k->>'quote')=0)) or (select count(*)from jsonb_array_elements(source->'passages')x where x->>'speaker'=k->>'speaker' and position(k->>'quote' in x->>'text')>0 and x->'start'=k->'start' and x->'end'=k->'end')<>1 then raise exception 'unsupported_extraction';end if;
  end loop;
  update app_private.intake_attempts set state='recorded',response=v,response_hash=encode(extensions.digest(v::text,'sha256'),'hex'),items=payload->'items'where id=a.id;
 elsif action='publish' then
  if a.state='published'then return jsonb_build_object('state','published');end if;
  if a.state<>'recorded'then raise exception 'publication_held';end if;
  -- Keep initial candidates out of actionable requests until correspondence is reviewed.
  for k in select * from jsonb_array_elements(a.items)loop
   insert into app_private.intake_candidates(attempt_id,source_id,revision,evidence,candidate_key)values(a.id,a.source_id,a.revision,k,k->>'key');
  end loop;
  update app_private.meetings set extraction_revision=a.revision,pending=a.items,lease_token=null,lease_until=null,state=case when jsonb_array_length(a.items)=0 and not source_review_required then 'no_actions'else 'held'end,note='Full extraction recorded; correspondence and remaining obligation require human review' where source_id=a.source_id;
  update app_private.intake_attempts set state='published'where id=a.id;
 else raise exception 'unsupported_intake_action';end if;
 insert into app_private.intake_events(attempt_id,operation)values(a.id,action);return jsonb_build_object('ok',true);
end$$;
create function public.meeting_intake_review(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare principal app_private.workspace_actors;c app_private.intake_candidates;m app_private.meetings;rid uuid;old app_private.intake_decisions;result jsonb;rel text:=payload->>'relation';
begin
 principal:=app_private.meeting_actor();
 if action='list' then
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'sourceId',x.source_id,'revision',x.revision,'evidence',x.evidence,'possibleRequests',(select coalesce(jsonb_agg(jsonb_build_object('id',mi.request_id,'title',q.requested->>'title')),'[]')from app_private.meeting_items mi join public.requests q on q.id=mi.request_id join app_private.meeting_scope s on s.source_id=mi.source_id where s.client=(select client from app_private.meeting_scope where source_id=x.source_id)and app_private.meeting_can_read(mi.source_id,principal.actor)))),'[]')into result
  from app_private.intake_candidates x where app_private.meeting_can_read(x.source_id,principal.actor)and exists(select 1 from app_private.meetings mm where mm.source_id=x.source_id and mm.revision=x.revision and not mm.source_review_required)and not exists(select 1 from app_private.intake_decisions d where d.candidate_id=x.id);
  return jsonb_build_object('candidates',result,'relations',(select coalesce(jsonb_agg(jsonb_build_object('requestId',d.request_id,'title',q.requested->>'title','relation',d.relation,'note',d.note)),'[]')from app_private.intake_decisions d join app_private.intake_candidates ic on ic.id=d.candidate_id join public.requests q on q.id=d.request_id where app_private.meeting_can_read(ic.source_id,principal.actor)and app_private.meeting_item_access(d.request_id,principal.actor))); 
 end if;
 if action<>'decide' or not exists(select 1 from app_private.meeting_reviewers where actor=principal.actor and active and can_review)then raise exception 'review_denied' using errcode='42501';end if;
 select * into c from app_private.intake_candidates where id=(payload->>'candidate')::uuid;
 if c.id is null or not app_private.meeting_can_read(c.source_id,principal.actor)then raise exception 'source_denied' using errcode='42501';end if;
 select * into m from app_private.meetings where source_id=c.source_id for update;
 if m.source_review_required then raise exception 'use_existing_same_source_review' using errcode='PT409';end if;
 if m.revision<>c.revision or payload->>'revision' is distinct from c.revision then raise exception 'review_stale' using errcode='PT409';end if;
 select * into old from app_private.intake_decisions where candidate_id=c.id;
 if old.candidate_id is not null then return to_jsonb(old);end if;
 if length(coalesce(payload->>'note',''))<9 then raise exception 'review_reason_required';end if;
 if rel='new' then
  if payload->>'confirmedDistinct' is distinct from 'true' or m.source_review_required then raise exception 'correspondence_required';end if;
  rid:=app_private.meeting_add_item(c.source_id,c.evidence,principal.actor);
 elsif rel in('same_obligation','changed','possibly_fulfilled','possibly_superseded')then
  rid:=(payload->>'requestId')::uuid;
  if not exists(select 1 from app_private.meeting_items i join app_private.meeting_scope s on s.source_id=i.source_id where i.request_id=rid and i.source_id<>c.source_id and s.client=(select client from app_private.meeting_scope where source_id=c.source_id)and app_private.meeting_can_read(i.source_id,principal.actor))then raise exception 'relation_outside_permitted_client' using errcode='42501';end if;
  -- Additional evidence never replaces original binding or human task fields.
  -- Existing document authority fencing records this hold; versions/attempts remain.
  update app_private.task_documents set enabled=false where request_id=rid and enabled;
 elsif rel<>'not_action' then raise exception 'invalid_relation';end if;
 insert into app_private.intake_decisions(candidate_id,request_id,relation,actor,note)values(c.id,rid,rel,principal.actor,payload->>'note')returning to_jsonb(intake_decisions.*)into result;
 insert into app_private.meeting_history(source_id,request_id,actor,operation,operation_id,input,result)values(c.source_id,rid,principal.actor,'later_source_review',c.id,payload,result);
 return result;
end$$;
create function public.meeting_intake_coverage()returns jsonb language plpgsql security definer set search_path='' as $$
declare principal app_private.workspace_actors;result jsonb;
begin
 principal:=app_private.meeting_actor();
 -- Full reviewers get policy-level coverage only for their workspace. Task-only actors
 -- receive a boundary statement, never global counts/titles/times from restricted sources.
 if not exists(select 1 from app_private.meeting_reviewers r where r.actor=principal.actor and r.active and r.can_review) or not exists(select 1 from app_private.intake_controls c join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=principal.workspace_id and principal.actor=any(c.coverage_actors))then
  return jsonb_build_object('visibility','task_only','status','unverified','message','Limited task context. Overall meeting coverage is not available to this account.');end if;
 select jsonb_build_object('visibility','reviewer','status',case when max(r.observed_at) is null then 'unverified'when max(r.catalogued_at) is null then 'incomplete'when max(r.catalogued_at)<clock_timestamp()-make_interval(secs=>2*coalesce(max(c.interval_seconds),900))then 'stale'when bool_or(r.state in('failed','incomplete','cancelled','scanning'))then 'incomplete'else 'review_required'end,
 'lastSuccessfulScan',max(r.catalogued_at),'lastScan',max(r.observed_at),'runs',coalesce(jsonb_agg(jsonb_build_object('id',r.id,'start',r.starts_at,'end',r.ends_at,'state',r.state,'cursor',r.cursor,'discovered',jsonb_array_length(r.catalog),'observedAt',r.observed_at)order by r.observed_at desc)filter(where r.id is not null),'[]'),
 'stages',jsonb_build_object('scopeHeld',(select count(*)from app_private.meetings m join app_private.meeting_policy mp on mp.id=m.policy where mp.workspace_id=principal.workspace_id and not exists(select 1 from app_private.meeting_scope s where s.source_id=m.source_id and s.active)),'captured',(select count(*)from app_private.meetings m where m.revision is not null and app_private.meeting_can_read(m.source_id,principal.actor)),
 'extracted',(select count(*)from app_private.meetings m where m.extraction_revision=m.revision and app_private.meeting_can_read(m.source_id,principal.actor)),
 'heldOrFailed',(select count(*)from app_private.meetings m where m.state in('held','failed','awaiting_source','processing')and app_private.meeting_can_read(m.source_id,principal.actor)),
 'awaitingReview',(select count(*)from app_private.intake_candidates k where app_private.meeting_can_read(k.source_id,principal.actor)and not exists(select 1 from app_private.intake_decisions d where d.candidate_id=k.id))),
 'message','Catalog coverage is not extraction or review completion. Counts include only permitted sources.')into result
 from app_private.intake_controls c join app_private.meeting_policy p on p.id=c.policy left join lateral(select distinct on(x.starts_at,x.ends_at) * from app_private.intake_runs x where x.policy=c.policy order by x.starts_at,x.ends_at,x.observed_at desc,x.finished_at desc nulls last)r on true where p.workspace_id=principal.workspace_id and principal.actor=any(c.coverage_actors);
 return result;
end$$;
-- No PUBLIC/default grants, no role creation, no activation or seed data.
do $$declare t text;f regprocedure;begin
 foreach t in array array['intake_controls','intake_runs','intake_reprocess_authorizations','intake_attempts','intake_candidates','intake_decisions','intake_events','intake_authority_epochs','intake_run_events']loop
 execute format('alter table app_private.%I enable row level security',t);execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',t);end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='app_private'and p.proname in('intake_authority','intake_epoch_fence','intake_run_journal'))or(n.nspname='public'and p.proname in('meeting_intake','meeting_intake_review','meeting_intake_coverage'))loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);end loop;
end$$;
commit;
