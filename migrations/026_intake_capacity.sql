-- Additive successor to025. No rows, grants, credentials or activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
-- NULL end is explicit ongoing authority, not a silently renewed commissioning term.
alter table app_private.intake_controls alter column ends_at drop not null,
 add column ongoing boolean not null default false,
 add constraint intake_controls_ongoing check((ends_at is null)=ongoing);
alter table app_private.intake_operating alter column operating_end drop not null,
 add column ongoing boolean not null default false,
 add column audit_cursor timestamptz,add column audit_target timestamptz,add column audit_finished_at timestamptz,
 add constraint intake_operating_ongoing check((operating_end is null)=ongoing);
-- Monetary units are micro-USD; immutable approved rate/budget version per policy.
create table app_private.intake_budget_policies(
 policy text primary key references app_private.intake_controls(policy),active boolean not null default false,
 decision_reference text not null check(length(decision_reference)>8),configuration_hash text not null check(configuration_hash~'^[a-f0-9]{64}$'),
 currency text not null check(currency='USD'),monthly_micros bigint not null check(monthly_micros between 1000000 and 1000000000),
 monthly_requests int not null check(monthly_requests between 1 and 1000),daily_requests int not null check(daily_requests between 1 and 100),
 input_micros_per_token int not null check(input_micros_per_token between 1 and 100),output_micros_per_token int not null check(output_micros_per_token between 1 and 100),
 max_input_tokens int not null check(max_input_tokens between 1 and 1000000),max_output_tokens int not null check(max_output_tokens between 100 and 12000)
);
create trigger intake_budget_policy_immutable before update or delete on app_private.intake_budget_policies for each row execute function app_private.intake_rule_immutable();
create trigger intake_budget_policy_epoch after insert or update or delete on app_private.intake_budget_policies for each row execute function app_private.intake_epoch_fence();
-- One ledger row per existing attempt; no second execution queue. Unknown liability survives all month boundaries.
create table app_private.intake_usage_reservations(
 attempt uuid primary key references app_private.intake_attempts(id),policy text not null references app_private.intake_budget_policies(policy),
 reserved_at timestamptz not null default clock_timestamp(),liability_micros bigint not null check(liability_micros>0),
 input_micros_per_token int not null,output_micros_per_token int not null,max_input_tokens int not null,max_output_tokens int not null
);
create table app_private.intake_usage_receipts(
 attempt uuid primary key references app_private.intake_usage_reservations(attempt),recorded_at timestamptz not null default clock_timestamp(),
 input_tokens int not null check(input_tokens>=0),output_tokens int not null check(output_tokens>=0),cost_micros bigint not null check(cost_micros>=0)
);
create trigger intake_usage_reservations_immutable before update or delete on app_private.intake_usage_reservations for each row execute function app_private.task_history_immutable();
create trigger intake_usage_receipts_immutable before update or delete on app_private.intake_usage_receipts for each row execute function app_private.task_history_immutable();
create function app_private.intake_budget_status(pol text)returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('currency',b.currency,'monthlyLimitMicros',b.monthly_micros,'monthlyRequestLimit',b.monthly_requests,'dailyRequestLimit',b.daily_requests,
 'currentMonthRequests',(select count(*)from app_private.intake_usage_reservations u where u.policy=pol and u.reserved_at>=date_trunc('month',clock_timestamp()at time zone 'UTC')at time zone 'UTC'),
 'chargedAndUnresolvedMicros',coalesce((select sum(case when r.attempt is null then u.liability_micros else r.cost_micros end)from app_private.intake_usage_reservations u left join app_private.intake_usage_receipts r on r.attempt=u.attempt where u.policy=pol and(r.attempt is null or u.reserved_at>=date_trunc('month',clock_timestamp()at time zone 'UTC')at time zone 'UTC')),0),
 'unresolvedLiabilityMicros',coalesce((select sum(u.liability_micros)from app_private.intake_usage_reservations u where u.policy=pol and not exists(select 1 from app_private.intake_usage_receipts r where r.attempt=u.attempt)),0),
 'basis','UTC calendar month; unresolved liabilities carried forward; invoice/tax separate')from app_private.intake_budget_policies b where b.policy=pol;
$$;
create function app_private.intake_budget_reserve()returns trigger language plpgsql security definer set search_path='' as $$
declare b app_private.intake_budget_policies;cost bigint;used bigint;begin
 -- Serialize all admissions for a policy with the existing controls lock.
 perform 1 from app_private.intake_controls where policy=new.policy for update;
 select * into b from app_private.intake_budget_policies where policy=new.policy;
 if b.policy is null then
  if exists(select 1 from app_private.intake_controls where policy=new.policy and ongoing)then raise exception 'monthly_budget_required';end if;
  return null;
 end if;
 if not b.active or b.configuration_hash<>new.configuration_hash then raise exception 'monthly_budget_unapproved';end if;
 cost:=b.max_input_tokens::bigint*b.input_micros_per_token+b.max_output_tokens::bigint*b.output_micros_per_token;
 used:=(app_private.intake_budget_status(new.policy)->>'chargedAndUnresolvedMicros')::bigint;
 if used+cost>b.monthly_micros or(select count(*)from app_private.intake_usage_reservations where policy=new.policy and reserved_at>=date_trunc('month',clock_timestamp()at time zone 'UTC')at time zone 'UTC')>=b.monthly_requests or(select count(*)from app_private.intake_usage_reservations where policy=new.policy and reserved_at>=date_trunc('day',clock_timestamp()at time zone 'UTC')at time zone 'UTC')>=b.daily_requests then raise exception 'intake_budget_exhausted';end if;
 insert into app_private.intake_usage_reservations(attempt,policy,liability_micros,input_micros_per_token,output_micros_per_token,max_input_tokens,max_output_tokens)values(new.id,new.policy,cost,b.input_micros_per_token,b.output_micros_per_token,b.max_input_tokens,b.max_output_tokens);
 return null;
end$$;
create trigger intake_budget_reserve after insert on app_private.intake_attempts for each row execute function app_private.intake_budget_reserve();
create function app_private.intake_usage_record(aid uuid,pol text,u jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
declare r app_private.intake_usage_reservations;old app_private.intake_usage_receipts;i int;o int;begin
 select * into r from app_private.intake_usage_reservations where attempt=aid and policy=pol for update;
 if r.attempt is null or not exists(select 1 from app_private.intake_attempts where id=aid and dispatched_at is not null)then raise exception 'usage_attempt_missing';end if;
 if jsonb_typeof(u->'input_tokens')is distinct from 'number'or jsonb_typeof(u->'output_tokens')is distinct from 'number'or(u->>'input_tokens')!~'^[0-9]+$'or(u->>'output_tokens')!~'^[0-9]+$'or coalesce((u->>'cache_creation_input_tokens')::bigint,0)<>0 or coalesce((u->>'cache_read_input_tokens')::bigint,0)<>0 then raise exception 'usage_invalid';end if;
 i:=(u->>'input_tokens')::int;o:=(u->>'output_tokens')::int;
 if i>r.max_input_tokens or o>r.max_output_tokens then raise exception 'usage_exceeds_reservation';end if;
 select * into old from app_private.intake_usage_receipts where attempt=aid;
 if old.attempt is not null then
  if old.input_tokens<>i or old.output_tokens<>o then raise exception 'usage_receipt_conflict';end if;return jsonb_build_object('recorded',true);
 end if;
 insert into app_private.intake_usage_receipts(attempt,input_tokens,output_tokens,cost_micros)values(aid,i,o,i::bigint*r.input_micros_per_token+o::bigint*r.output_micros_per_token);
 insert into app_private.intake_events(attempt_id,operation)values(aid,'transport_usage_recorded_no_execution_authority');
 return jsonb_build_object('recorded',true);
end$$;
create or replace function app_private.intake_authority_v023(sid text,pol text)returns text language plpgsql security definer set search_path='' as $$
declare p app_private.meeting_policy;c app_private.intake_controls;s app_private.meeting_scope;
begin
 select * into p from app_private.meeting_policy where id=pol and active and db_role=current_setting('role',true)::name;
 select * into c from app_private.intake_controls where policy=pol and enabled;
 select * into s from app_private.meeting_scope where source_id=sid and policy=pol and active;
 if p.id is null or c.policy is null or s.source_id is null or clock_timestamp()>=coalesce(c.ends_at,'infinity'::timestamptz) then raise exception 'intake_source_denied' using errcode='42501';end if;
 return encode(extensions.digest((to_jsonb(p)||to_jsonb(c)||to_jsonb(s)||jsonb_build_object('epoch',(select epoch from app_private.intake_authority_epochs where policy=pol)))::text,'sha256'),'hex');
end$$;

create or replace function public.meeting_intake(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.meeting_policy;c app_private.intake_controls;r app_private.intake_runs;a app_private.intake_attempts;m app_private.meetings;
 sid text:=payload->>'id'; auth_hash text; v jsonb; k jsonb; source jsonb;result jsonb; prior app_private.intake_attempts;permission app_private.intake_reprocess_authorizations;
begin
 select * into p from app_private.meeting_policy where db_role=current_setting('role',true)::name and active for share;
 select * into c from app_private.intake_controls where policy=p.id and enabled for update;
 if p.id is null or c.policy is null or clock_timestamp()>=coalesce(c.ends_at,'infinity'::timestamptz) then raise exception 'intake_disabled' using errcode='42501';end if;
 if action='usage'then return app_private.intake_usage_record((payload->>'attempt')::uuid,p.id,payload->'usage');end if;
 if action='budget_status'then return app_private.intake_budget_status(p.id);end if;
 if action='configuration' then return to_jsonb(c);end if;
 if action='pending_run' then
  select * into r from app_private.intake_runs where policy=p.id and policy_version=c.version and state in('scanning','catalog_complete','incomplete','failed')order by observed_at limit 1;
  -- Failed enumeration must start a fresh fixed-window scan, not treat empty catalog as coverage.
  if r.id is not null and r.state='failed' and r.catalog='[]'::jsonb then update app_private.intake_runs set state='scanning'where id=r.id;end if;
  return jsonb_build_object('run',r.id,'fullSweepDue',not exists(select 1 from app_private.intake_runs where policy=p.id and starts_at=c.starts_at and state='finished'and finished_at>clock_timestamp()-interval '1 day'));
 end if;
 if action='start' then
  if not c.metadata_allowed or (payload->>'start')::timestamptz<c.starts_at or (payload->>'end')::timestamptz>least(coalesce(c.ends_at,'infinity'::timestamptz),clock_timestamp()) or (payload->>'end')::timestamptz<=(payload->>'start')::timestamptz then raise exception 'discovery_window_denied' using errcode='42501';end if;
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
  return jsonb_build_object('allowed',m.source_id is not null and m.instant>=c.starts_at and m.instant<coalesce(c.ends_at,'infinity'::timestamptz),'authority',auth_hash,'revision',m.revision);
 end if;
 if action='capture' then
  auth_hash:=app_private.intake_authority(sid,p.id);
  if auth_hash is distinct from payload->>'authority' then raise exception 'authority_changed';end if;
  select * into m from app_private.meetings where source_id=sid and policy=p.id;
  if m.instant<c.starts_at or m.instant>=coalesce(c.ends_at,'infinity'::timestamptz) then raise exception 'source_outside_term';end if;
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
  if not exists(select 1 from app_private.intake_budget_policies where policy=p.id)and((select count(*)from app_private.intake_attempts where policy=p.id)>=c.max_dispatches or(select count(*)from app_private.intake_attempts where policy=p.id and reserved_at>=date_trunc('day',clock_timestamp()at time zone 'UTC')at time zone 'UTC')>=c.daily_dispatches)then raise exception 'intake_budget_exhausted';end if;
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
  if exists(select 1 from app_private.intake_budget_policies where policy=p.id)and not exists(select 1 from app_private.intake_usage_reservations where attempt=a.id)then raise exception 'attempt_has_no_monthly_reservation';end if;
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

create or replace function app_private.intake_rule_for(sid text,pol text)returns app_private.intake_scope_rules language plpgsql security definer set search_path='' as $$
declare o app_private.intake_operating; md app_private.intake_metadata;r app_private.intake_scope_rules;n int; mt timestamptz;
begin
 select * into o from app_private.intake_operating where policy=pol and enabled and clock_timestamp()>=operating_start and clock_timestamp()<coalesce(operating_end,'infinity'::timestamptz);
 select * into md from app_private.intake_metadata where source_id=sid and policy=pol;
 select instant into mt from app_private.meetings where source_id=sid and policy=pol;
 if o.policy is null or md.source_id is null or md.account_id is distinct from o.account_id or cardinality(md.domains)=0 or not coalesce(mt>=o.operating_start and mt<coalesce(o.operating_end,'infinity'::timestamptz) or mt>=o.catchup_start and mt<o.catchup_end,false)or exists(select 1 from app_private.intake_exclusions where policy=pol and source_id=sid)then return null;end if;
 if exists(select 1 from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and excluded and account_id=md.account_id and organizer=md.organizer)then return null;end if;
 select count(*)into n from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and account_id=md.account_id and organizer=md.organizer and ((match_kind='domain'and md.domains<@allowed_domains and md.domains&&client_domains)or(match_kind='participant'and cardinality(md.participants)>0 and md.participants&&client_emails and not exists(select 1 from unnest(md.participants)e where not(e=any(allowed_emails))and not(split_part(e,'@',2)=any(allowed_domains)))));
 if n<>1 then return null;end if;
 if(select count(distinct client)from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and account_id=md.account_id and organizer=md.organizer and ((match_kind='participant'and md.participants&&client_emails)or(match_kind='domain'and md.domains&&client_domains)))>1 then return null;end if;
 select * into r from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and account_id=md.account_id and organizer=md.organizer and ((match_kind='domain'and md.domains<@allowed_domains and md.domains&&client_domains)or(match_kind='participant'and cardinality(md.participants)>0 and md.participants&&client_emails and not exists(select 1 from unnest(md.participants)e where not(e=any(allowed_emails))and not(split_part(e,'@',2)=any(allowed_domains)))));
 -- Standing source-reader authority is explicit in the rule, never derived from task visibility.
 if not exists(select 1 from app_private.workspace_actors a join app_private.meeting_policy p on p.workspace_id=a.workspace_id join app_private.workspace_clients c on c.actor=a.actor join app_private.meeting_reviewers v on v.actor=a.actor where p.id=pol and a.actor=r.reviewer and a.active and c.active and c.client=r.client and v.active and v.can_review)then return null;end if;
 return r;
end$$;

create or replace function app_private.intake_operating_epoch()returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_op='INSERT'or(to_jsonb(new)-array['lease','lease_until','next_poll','audit_cursor','audit_target','audit_finished_at'])is distinct from(to_jsonb(old)-array['lease','lease_until','next_poll','audit_cursor','audit_target','audit_finished_at'])then
 insert into app_private.intake_authority_epochs values(new.policy,1)on conflict(policy)do update set epoch=intake_authority_epochs.epoch+1;end if;return null;end$$;

create or replace function public.meeting_intake_operational(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.meeting_policy;c app_private.intake_controls;o app_private.intake_operating;row jsonb;md app_private.intake_metadata;r app_private.intake_scope_rules;b app_private.intake_scope_bindings;result jsonb;sid text;fp text;run app_private.intake_runs;checkrow app_private.intake_source_checks;work app_private.intake_source_work;checkstate text;checkreason text;failures int;v_lane text:=case when payload->>'catchUp'='true'then 'catchup'else 'recurring'end;
begin
 select * into p from app_private.meeting_policy where db_role=current_setting('role',true)::name and active for share;
 select * into c from app_private.intake_controls where policy=p.id and enabled for update;
 select * into o from app_private.intake_operating where policy=p.id and enabled for update;
 if p.id is null or c.policy is null or o.policy is null or clock_timestamp()<o.operating_start or clock_timestamp()>=least(coalesce(c.ends_at,'infinity'::timestamptz),coalesce(o.operating_end,'infinity'::timestamptz))then raise exception 'operational_intake_disabled'using errcode='42501';end if;
 if action='configuration'then return to_jsonb(c)||jsonb_build_object('monthlyBudgetRequired',exists(select 1 from app_private.intake_budget_policies where policy=p.id and active and configuration_hash=c.configuration_hash),'accountId',o.account_id,'operatingStart',o.operating_start,'operatingEnd',o.operating_end,'catchupStart',o.catchup_start,'catchupEnd',o.catchup_end,'coalesced_source_work',true,'source_checks',true,'fresh_metadata_required',true);end if;
 if action='acquire'then
  if o.lease_until>clock_timestamp()or(v_lane='recurring'and o.next_poll>clock_timestamp())then return jsonb_build_object('acquired',false);end if;
  update app_private.intake_operating set lease=extensions.gen_random_uuid(),lease_until=clock_timestamp()+interval '10 minutes',next_poll=case when v_lane='recurring'then clock_timestamp()+make_interval(secs=>c.interval_seconds)else next_poll end where policy=p.id returning * into o;
  return jsonb_build_object('acquired',true,'lease',o.lease);
 end if;
 if o.lease::text is distinct from payload->>'lease'or o.lease_until<=clock_timestamp()then raise exception 'collector_lease_expired'using errcode='42501';end if;
 if action='release'then update app_private.intake_operating set lease=null,lease_until=null where policy=p.id;return '{}';end if;
 if action='pending_run'then
  -- A bounded audit traverses seven-day slices of the authorized period. It never replaces hot discovery.
  if v_lane='recurring'and(o.audit_target is null or o.audit_cursor>=o.audit_target and o.audit_finished_at<clock_timestamp()-interval '1 day')then
   update app_private.intake_operating set audit_cursor=operating_start,audit_target=least(clock_timestamp(),coalesce(operating_end,'infinity'::timestamptz)) where policy=p.id returning * into o;
  end if;
  return jsonb_build_object('run',null,'coalesced',true,'auditStart',case when o.audit_cursor<o.audit_target then o.audit_cursor end,'auditEnd',case when o.audit_cursor<o.audit_target then least(o.audit_cursor+interval '7 days',o.audit_target)end);
 end if;
 if action='start'then
  if v_lane='catchup'then
   if o.catchup_start is null or(payload->>'start')::timestamptz<>o.catchup_start or(payload->>'end')::timestamptz<>o.catchup_end then raise exception 'catchup_not_authorized';end if;
  elsif(payload->>'start')::timestamptz<o.operating_start then raise exception 'recurring_window_denied';end if;
  result:=public.meeting_intake(action,payload);update app_private.intake_runs set lane=v_lane,work_mode='coalesced' where id=(result->>'id')::uuid;return result;
 end if;
 if action='metadata_check'then
  if not c.metadata_allowed or not exists(select 1 from app_private.meetings where source_id=payload->>'id'and policy=p.id)then raise exception 'metadata_discovery_denied'using errcode='42501';end if;return '{}';
 end if;
 if action in('catalog','refresh_metadata')then
  if action='catalog'then result:=public.meeting_intake(action,payload);
  else
   if not c.metadata_allowed or payload->'meeting'->>'id'is distinct from payload->>'id'or not exists(select 1 from app_private.meetings where source_id=payload->>'id'and policy=p.id)then raise exception 'metadata_discovery_denied'using errcode='42501';end if;
   if coalesce((payload->'meeting'->>'live')::boolean,true)or not exists(select 1 from app_private.meetings where source_id=payload->>'id'and instant=(payload->'meeting'->>'instant')::timestamptz)then return jsonb_build_object('held',true);end if;
   payload:=payload||jsonb_build_object('meetings',jsonb_build_array(payload->'meeting'));result:='{}';
  end if;
  for row in select * from jsonb_array_elements(payload->'meetings')loop
   if row->>'live'='true'then continue;end if;
   sid:=row->>'id';
   insert into app_private.intake_metadata(source_id,policy,account_id,organizer,domains,participants)values(sid,p.id,row->>'accountId',lower(row->>'organizer'),array(select distinct lower(value)from jsonb_array_elements_text(coalesce(row->'domains','[]')) order by lower(value)),array(select distinct lower(btrim(value))from jsonb_array_elements_text(coalesce(row->'participants','[]'))order by lower(btrim(value))))
   on conflict(source_id)do update set account_id=excluded.account_id,organizer=excluded.organizer,domains=excluded.domains,participants=excluded.participants,observed_at=clock_timestamp() where intake_metadata.policy=p.id;
   r:=app_private.intake_rule_for(sid,p.id);select * into md from app_private.intake_metadata where source_id=sid and policy=p.id;
   fp:=app_private.intake_metadata_fingerprint(md);
   if action='catalog'and exists(select 1 from app_private.meetings where source_id=sid and policy=p.id)then
    insert into app_private.intake_source_work(source_id,policy,lane,catalog_row,metadata_hash,last_scan,due_at)
    values(sid,p.id,v_lane,row,fp,(payload->>'run')::uuid,clock_timestamp())
    on conflict(source_id)do update set catalog_row=excluded.catalog_row,last_scan=excluded.last_scan,
     due_at=case when intake_source_work.metadata_hash<>excluded.metadata_hash then least(coalesce(intake_source_work.due_at,clock_timestamp()),clock_timestamp())else intake_source_work.due_at end,
     metadata_hash=excluded.metadata_hash where intake_source_work.policy=p.id and intake_source_work.lane=v_lane;
   end if;
   select * into b from app_private.intake_scope_bindings where source_id=sid;
   if r.rule_id is null or(b.source_id is not null and(b.metadata_hash<>fp or b.classification<>r.classification))or exists(select 1 from app_private.meeting_scope where source_id=sid and(policy<>p.id or client<>r.client or not active))or exists(select 1 from app_private.meeting_source_people where source_id=sid and actor=r.reviewer and not active)then
    update app_private.meetings set note='Scope exception: operator must resolve mapping or exclusion; no transcript/provider retry',state=case when revision is null then 'held'else state end where source_id=sid and policy=p.id;
    insert into app_private.intake_scope_events(source_id,policy,event,detail)values(sid,p.id,'held',jsonb_build_object('reason','unknown, ambiguous, excluded, revoked or changed mapping'));continue;
   end if;
   update app_private.meetings set note='Standing scope verified; extraction and proposal review remain separate'where source_id=sid and note like 'Scope exception:%';
   if b.source_id is null then
    insert into app_private.meeting_scope(source_id,policy,client,active,review_reference)values(sid,p.id,r.client,true,r.decision_reference)on conflict do nothing;
    insert into app_private.meeting_source_people(source_id,actor,active,review_reference)values(sid,r.reviewer,true,r.decision_reference)on conflict do nothing;
    insert into app_private.intake_scope_bindings(source_id,policy,version,rule_id,metadata_hash,classification)values(sid,p.id,r.version,r.rule_id,fp,r.classification);
    insert into app_private.intake_scope_events(source_id,policy,event,detail)values(sid,p.id,'standing_rule_bound',jsonb_build_object('version',r.version,'rule',r.rule_id,'classification',r.classification,'decision',r.decision_reference));
   end if;
  end loop;
  if action='catalog'then
   select * into run from app_private.intake_runs where id=(payload->>'run')::uuid and policy=p.id;
   if run.lane='recurring'and run.starts_at=o.audit_cursor and run.ends_at=least(o.audit_cursor+interval '7 days',o.audit_target)then
    update app_private.intake_operating set audit_cursor=run.ends_at,audit_finished_at=case when run.ends_at>=audit_target then clock_timestamp()else audit_finished_at end where policy=p.id;
   end if;
   -- Finished means discovery snapshot complete, not source extraction/review complete.
   update app_private.intake_runs set state='finished',finished_at=clock_timestamp(),reason='Catalog complete; source work coalesced separately'where id=(payload->>'run')::uuid and policy=p.id;
  end if;return result;
 end if;
 if action='work_next'then
  if not c.metadata_allowed then raise exception 'metadata_discovery_denied'using errcode='42501';end if;
  select * into work from app_private.intake_source_work where policy=p.id and lane=v_lane and due_at<=clock_timestamp()and(claim_lease is null or claim_lease is distinct from o.lease)order by due_at,source_id limit 1 for update;
  if work.source_id is null then return jsonb_build_object('row',null);end if;
  update app_private.intake_source_work set claim_token=extensions.gen_random_uuid(),claim_lease=o.lease,last_outcome='checking'where source_id=work.source_id returning * into work;
  insert into app_private.intake_work_events(source_id,policy,operation,token)values(work.source_id,p.id,'claimed',work.claim_token);
  return jsonb_build_object('row',work.catalog_row,'token',work.claim_token);
 end if;
 if action='work_release'then
  select * into work from app_private.intake_source_work where source_id=payload->>'id'and policy=p.id and lane=v_lane for update;
  if work.claim_token is null or work.claim_token::text is distinct from payload->>'work_token'or work.claim_lease is distinct from o.lease or payload->>'reason'not in('global_failure','cancelled')then raise exception 'work_claim_changed'using errcode='42501';end if;
  insert into app_private.intake_work_events(source_id,policy,operation,token)values(work.source_id,p.id,payload->>'reason',work.claim_token);
  update app_private.intake_source_work set claim_token=null,claim_lease=null,due_at=clock_timestamp()+make_interval(secs=>c.interval_seconds),last_outcome=payload->>'reason'where source_id=work.source_id;
  return '{}';
 end if;
 if action in('source_check','source_result','source_exception')then
  sid:=payload->>'id';
  if payload?'work_token'then
   select * into work from app_private.intake_source_work where source_id=sid and policy=p.id and lane=v_lane for update;
   if work.claim_token is null or work.claim_token::text is distinct from payload->>'work_token'or work.claim_lease is distinct from o.lease or not c.metadata_allowed then raise exception 'work_claim_changed'using errcode='42501';end if;
  else
   select * into run from app_private.intake_runs where id=(payload->>'run')::uuid and policy=p.id and lane=v_lane for update;
   if run.id is null or run.policy_version<>c.version or not c.metadata_allowed or run.state in('cancelled','finished')or run.catalog->run.cursor->>'id'is distinct from sid then raise exception 'source_checkpoint_changed'using errcode='42501';end if;
  end if;
  select * into md from app_private.intake_metadata where source_id=sid and policy=p.id;
  fp:=app_private.intake_metadata_fingerprint(md);
  select * into checkrow from app_private.intake_source_checks where source_id=sid and policy=p.id for update;
  if action='source_check'then
   return jsonb_build_object('read',not coalesce(checkrow.metadata_hash=fp and checkrow.state in('read_retry','read_exception')and(checkrow.failures>=3 or checkrow.next_read_at>clock_timestamp()),false),'state',checkrow.state);
  end if;
  if action='source_exception'then
   if payload->>'reason'not in('read_unavailable','metadata_changed','metadata_incomplete','transcript_incomplete','extraction_input_incomplete')or(not(payload?'work_token')and(payload->>'cursor')::int<>run.cursor+1) then raise exception 'invalid_source_exception';end if;
   failures:=case when checkrow.metadata_hash=fp then coalesce(checkrow.failures,0)+1 else 1 end;
   checkstate:=case when payload->>'reason'='extraction_input_incomplete'then 'input_incomplete'when failures>=3 then 'read_exception'else 'read_retry'end;checkreason:=case when checkstate='input_incomplete'then 'Complete transcript exceeds the approved request limit; no extraction dispatched or text omitted. Operator must review the size exception.'else payload->>'reason'end;
  else
   failures:=0;
   if not coalesce((public.meeting_intake('eligible',jsonb_build_object('id',sid))->>'allowed')::boolean,false)then checkstate:='scope_exception';checkreason:='Standing authority unresolved; no transcript retry';
   elsif exists(select 1 from app_private.meetings where source_id=sid and revision is not null and extraction_revision=revision)then checkstate:='resolved';checkreason:='Current revision extraction recorded; human review separate';
   elsif exists(select 1 from app_private.intake_attempts a join app_private.meetings m on m.source_id=a.source_id and m.revision=a.revision where a.source_id=sid and a.state in('reserved','dispatched','unknown','invalid','cancelled','recorded'))then checkstate:='attempt_retained';checkreason:='Reconcile durable attempt; no automatic redispatch';
   else checkstate:='extraction_pending';select coalesce(note,'Capture/extraction incomplete')into checkreason from app_private.meetings where source_id=sid;end if;
  end if;
  insert into app_private.intake_source_checks(source_id,policy,state,reason,metadata_hash,failures,next_read_at)values(sid,p.id,checkstate,checkreason,fp,failures,case when checkstate='read_retry' then clock_timestamp()+make_interval(secs=>c.interval_seconds*failures)else null end)
  on conflict(source_id)do update set state=excluded.state,reason=excluded.reason,metadata_hash=excluded.metadata_hash,failures=excluded.failures,next_read_at=excluded.next_read_at,checked_at=clock_timestamp()where intake_source_checks.policy=p.id;
  if payload?'work_token'then
   update app_private.intake_source_work set claim_token=null,claim_lease=null,last_checked_at=clock_timestamp(),metadata_hash=fp,last_outcome=checkstate,
    due_at=case when checkstate='read_exception'then null when checkstate='input_incomplete'then clock_timestamp()+interval '1 day' when checkstate='read_retry'then clock_timestamp()+make_interval(secs=>c.interval_seconds*failures)when checkstate in('resolved','scope_exception','attempt_retained')then clock_timestamp()+interval '1 day'else clock_timestamp()+make_interval(secs=>c.interval_seconds)end where source_id=sid;
   insert into app_private.intake_work_events(source_id,policy,operation,token,detail)values(sid,p.id,checkstate,work.claim_token,jsonb_build_object('failures',failures));
  elsif action='source_exception'then perform public.meeting_intake('checkpoint',jsonb_build_object('run',run.id,'cursor',run.cursor+1));end if;
  return jsonb_build_object('state',checkstate);
 end if;
 if action='source_metadata'then
  sid:=payload->>'id';perform app_private.intake_authority(sid,p.id);
  select * into md from app_private.intake_metadata where source_id=sid and policy=p.id;
  return jsonb_build_object('id',sid,'title','Authorized source reprocessing','instant',(select instant from app_private.meetings where source_id=sid),'live',false,'accountId',md.account_id,'organizer',md.organizer,'domains',md.domains,'participants',md.participants);
 end if;
 if action='reserve'and payload->>'reprocessId'is null then
  sid:=payload->>'id';perform app_private.intake_authority(sid,p.id);
  if exists(select 1 from app_private.meetings m join public.intake_source_versions old on old.source_id=m.source_id and old.revision=m.extraction_revision join public.intake_source_versions fresh on fresh.source_id=m.source_id and fresh.revision=m.revision where m.source_id=sid and m.policy=p.id and m.extraction_revision<>m.revision and old.raw->'passages'=fresh.raw->'passages')then
   update app_private.meetings set state='held',note='Transcript unchanged; metadata-only revision needs review, not another automatic extraction'where source_id=sid;
   return jsonb_build_object('dispatch',false,'state','same_transcript_review_required');
  end if;
 end if;
 if action='disclosure'then
  select source_id into sid from app_private.intake_attempts where id=(payload->>'attempt')::uuid and policy=p.id and state='dispatched';
  if sid is null or not exists(select 1 from app_private.intake_attempts where id=(payload->>'attempt')::uuid and authority_hash=app_private.intake_authority(sid,p.id) and revision=(select revision from app_private.meetings where source_id=sid))then raise exception 'disclosure_authority_changed'using errcode='42501';end if;
  return jsonb_build_object('allowed',true);
 end if;
 begin return public.meeting_intake(action,payload);
 exception when others then
  if action='reserve'and sqlerrm='intake_budget_exhausted'then
   update app_private.meetings set note='Extraction allowance exhausted; daily/monthly limit or retained uncertain liability. No automatic re-dispatch.'where source_id=payload->>'id'and policy=p.id;
   return jsonb_build_object('dispatch',false,'state','budget_exhausted');
  end if;raise;
 end;
end$$;

create or replace function public.meeting_intake_operational_coverage()returns jsonb language plpgsql security definer set search_path='' as $$
declare base jsonb:=public.meeting_intake_coverage();a app_private.workspace_actors:=app_private.meeting_actor();latest timestamptz;exceptions bigint;uncertain bigint;enabled boolean;source_exceptions bigint;read_retries bigint;expiry timestamptz;pending_windows bigint;source_details jsonb;audit_pending boolean;audit_cursor timestamptz;audit_target timestamptz;audit_last timestamptz;
begin
 if base->>'visibility'<>'reviewer'then return base;end if;
 select max(e.created_at)into latest from app_private.intake_events e join app_private.intake_attempts t on t.id=e.attempt_id where e.operation='publish'and app_private.meeting_can_read(t.source_id,a.actor);
 select count(*)into exceptions from app_private.intake_metadata md join app_private.intake_controls c on c.policy=md.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors)and not exists(select 1 from app_private.intake_scope_bindings b where b.source_id=md.source_id and b.classification=(app_private.intake_rule_for(md.source_id,md.policy)).classification and b.metadata_hash=app_private.intake_metadata_fingerprint(md));
 select count(*)into uncertain from app_private.intake_attempts t where t.state in('unknown','invalid','cancelled','reserved','dispatched')and app_private.meeting_can_read(t.source_id,a.actor);
 select bool_or(o.enabled and c.enabled and clock_timestamp()>=o.operating_start and clock_timestamp()<coalesce(o.operating_end,'infinity'::timestamptz))into enabled from app_private.intake_operating o join app_private.intake_controls c on c.policy=o.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors);
 select count(*)filter(where x.state<>'resolved'),count(*)filter(where x.state='read_retry')into source_exceptions,read_retries from app_private.intake_source_checks x where app_private.meeting_can_read(x.source_id,a.actor);
 select count(*)into pending_windows from app_private.intake_source_work w where (w.last_checked_at is null or w.due_at<=clock_timestamp()or w.last_outcome in('global_failure','cancelled','checking'))and app_private.meeting_can_read(w.source_id,a.actor);
 select coalesce(jsonb_agg(to_jsonb(x)),'[]')into source_details from(select m.title,c.state,c.reason,c.next_read_at as "nextReadAt",c.checked_at as "checkedAt" from app_private.intake_source_checks c join app_private.meetings m on m.source_id=c.source_id where c.state<>'resolved'and app_private.meeting_can_read(c.source_id,a.actor)order by c.checked_at desc,c.source_id limit 20)x;
 select min(o.operating_end)into expiry from app_private.intake_operating o join app_private.intake_controls c on c.policy=o.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors);
 select bool_or(o.audit_target is null or o.audit_cursor<o.audit_target),min(o.audit_cursor),max(o.audit_target),min(o.audit_finished_at)into audit_pending,audit_cursor,audit_target,audit_last from app_private.intake_operating o join app_private.intake_controls c on c.policy=o.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors);
 return (base#-'{stages,scopeHeld}')||jsonb_build_object('status',case when not coalesce(enabled,false)then 'disabled'when base->>'status'in('unverified','stale','incomplete')then base->>'status'when audit_pending or source_exceptions>0 or pending_windows>0 then 'incomplete'else base->>'status'end,'auditPending',coalesce(audit_pending,false),'auditCursor',audit_cursor,'auditTarget',audit_target,'auditLastCompletedAt',audit_last,'sourceWorkPending',pending_windows,'sourceChecks',source_details,'sourceExceptions',source_exceptions,'temporaryReadRetries',read_retries,'operatingEndsAt',expiry,'continuation',case when expiry is null then 'Ongoing while explicitly enabled and funded; disable or revoke to stop. Monthly limits do not authorize new scope.'else 'Stops at expiry; no automatic renewal'end)||jsonb_build_object('lastProcessedAt',latest,'scopeExceptions',exceptions,'attemptExceptions',uncertain,'operatingEnabled',coalesce(enabled,false),'nextAction',case when not coalesce(enabled,false)then 'Intake disabled, held or expired. Operator must check authority and funding; no automatic activation.'when audit_pending then 'Authorized-period catalog audit remains incomplete; fresh-arrival discovery continues separately.'when pending_windows>0 then 'Source work remains due or interrupted. Discovery and processing are tracked separately; processing continues within its cap.'when source_exceptions>0 then 'Source exceptions remain; temporary reads retry at most three times. Discovery continues. Reconcile exhausted reads or retained attempts.'when exceptions>0 then 'Operator: resolve held scope mappings before retrieval.'when uncertain>0 then 'Operator: reconcile retained attempts; do not retry extraction blindly.'else 'Review new proposals and later evidence; existing tasks remain unchanged.'end);
end$$;
create function app_private.intake_ongoing_guard()returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_table_name='intake_budget_policies'then
  if new.active and exists(select 1 from app_private.intake_attempts a where a.policy=new.policy and not exists(select 1 from app_private.intake_usage_reservations u where u.attempt=a.id))then raise exception 'legacy_usage_requires_reviewed_carry_forward';end if;return new;
 end if;
 if new.ongoing and new.enabled and not exists(select 1 from app_private.intake_budget_policies where policy=new.policy and active)then raise exception 'ongoing_monthly_budget_required';end if;
 if tg_op='UPDATE'and exists(select 1 from app_private.intake_runs where policy=new.policy)and(case when tg_table_name='intake_controls'then to_jsonb(new)->'starts_at'else to_jsonb(new)->'operating_start'end)is distinct from(case when tg_table_name='intake_controls'then to_jsonb(old)->'starts_at'else to_jsonb(old)->'operating_start'end)then raise exception 'activation_cutoff_immutable_after_scan';end if;
 return new;
end$$;
create trigger intake_budget_history_guard before insert or update on app_private.intake_budget_policies for each row execute function app_private.intake_ongoing_guard();
create trigger intake_ongoing_guard before insert or update on app_private.intake_controls for each row execute function app_private.intake_ongoing_guard();
create trigger intake_ongoing_guard before insert or update on app_private.intake_operating for each row execute function app_private.intake_ongoing_guard();
do $$declare t text;f regprocedure;begin
 foreach t in array array['intake_budget_policies','intake_usage_reservations','intake_usage_receipts']loop execute format('alter table app_private.%I enable row level security',t);execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',t);end loop;
 foreach f in array array['app_private.intake_budget_status(text)'::regprocedure,'app_private.intake_budget_reserve()'::regprocedure,'app_private.intake_usage_record(uuid,text,jsonb)'::regprocedure,'app_private.intake_ongoing_guard()'::regprocedure]loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);end loop;
end$$;
commit;
