-- Additive participant identity boundary over applied023/024. No seeds, grants or activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table app_private.intake_scope_rules
 add column match_kind text not null default 'domain' check(match_kind in('domain','participant')),
 add column client_emails text[] not null default '{}',
 add column allowed_emails text[] not null default '{}';
alter table app_private.intake_metadata add column participants text[] not null default '{}';
-- Legacy domain constraints remain exactly equivalent for existing/domain rows.
alter table app_private.intake_scope_rules drop constraint intake_scope_rules_allowed_domains_check,
 drop constraint intake_scope_rules_client_domains_check,
 drop constraint intake_scope_rules_client_domains_check1,
 add constraint intake_scope_domain_boundary check(match_kind<>'domain'or(cardinality(allowed_domains)>0 and cardinality(client_domains)>0 and not(client_domains&&array['gmail.com','outlook.com','hotmail.com','yahoo.com','icloud.com']))),
 add constraint intake_scope_participant_boundary check(match_kind<>'participant'or(cardinality(client_emails)>0 and client_emails<@allowed_emails and not(organizer=any(client_emails)) and cardinality(client_domains)=0));
create function app_private.intake_emails_valid(emails text[])returns boolean language sql immutable set search_path='' as $$
 select coalesce(bool_and(e is not null and e=lower(btrim(e))and e~'^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),true)from unnest(emails)e;
$$;
alter table app_private.intake_scope_rules add constraint intake_identity_emails_valid check(app_private.intake_emails_valid(client_emails)and app_private.intake_emails_valid(allowed_emails));
alter table app_private.intake_metadata add constraint intake_metadata_emails_valid check(app_private.intake_emails_valid(participants));
-- Empty legacy participant metadata preserves the exact old fingerprint. New observed
-- participants fence old bindings/attempts; never rewrite their immutable history.
create function app_private.intake_metadata_fingerprint(md app_private.intake_metadata)returns text language sql immutable set search_path='' as $$
 select encode(extensions.digest((case when cardinality(md.participants)=0 then to_jsonb(md)-array['observed_at','participants']else to_jsonb(md)-'observed_at'end)::text,'sha256'),'hex');
$$;


create or replace function app_private.intake_rule_for(sid text,pol text)returns app_private.intake_scope_rules language plpgsql security definer set search_path='' as $$
declare o app_private.intake_operating; md app_private.intake_metadata;r app_private.intake_scope_rules;n int; mt timestamptz;
begin
 select * into o from app_private.intake_operating where policy=pol and enabled and clock_timestamp()>=operating_start and clock_timestamp()<operating_end;
 select * into md from app_private.intake_metadata where source_id=sid and policy=pol;
 select instant into mt from app_private.meetings where source_id=sid and policy=pol;
 if o.policy is null or md.source_id is null or md.account_id is distinct from o.account_id or cardinality(md.domains)=0 or not coalesce(mt>=o.operating_start and mt<o.operating_end or mt>=o.catchup_start and mt<o.catchup_end,false)or exists(select 1 from app_private.intake_exclusions where policy=pol and source_id=sid)then return null;end if;
 if exists(select 1 from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and excluded and account_id=md.account_id and organizer=md.organizer)then return null;end if;
 select count(*)into n from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and account_id=md.account_id and organizer=md.organizer and ((match_kind='domain'and md.domains<@allowed_domains and md.domains&&client_domains)or(match_kind='participant'and cardinality(md.participants)>0 and md.participants&&client_emails and not exists(select 1 from unnest(md.participants)e where not(e=any(allowed_emails))and not(split_part(e,'@',2)=any(allowed_domains)))));
 if n<>1 then return null;end if;
 if(select count(distinct client)from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and account_id=md.account_id and organizer=md.organizer and ((match_kind='participant'and md.participants&&client_emails)or(match_kind='domain'and md.domains&&client_domains)))>1 then return null;end if;
 select * into r from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and account_id=md.account_id and organizer=md.organizer and ((match_kind='domain'and md.domains<@allowed_domains and md.domains&&client_domains)or(match_kind='participant'and cardinality(md.participants)>0 and md.participants&&client_emails and not exists(select 1 from unnest(md.participants)e where not(e=any(allowed_emails))and not(split_part(e,'@',2)=any(allowed_domains)))));
 -- Standing source-reader authority is explicit in the rule, never derived from task visibility.
 if not exists(select 1 from app_private.workspace_actors a join app_private.meeting_policy p on p.workspace_id=a.workspace_id join app_private.workspace_clients c on c.actor=a.actor join app_private.meeting_reviewers v on v.actor=a.actor where p.id=pol and a.actor=r.reviewer and a.active and c.active and c.client=r.client and v.active and v.can_review)then return null;end if;
 return r;
end$$;

create or replace function app_private.intake_authority(sid text,pol text)returns text language plpgsql security definer set search_path='' as $$
declare base text;r app_private.intake_scope_rules;b app_private.intake_scope_bindings;md app_private.intake_metadata;fingerprint text;
begin
 base:=app_private.intake_authority_v023(sid,pol);
 if not exists(select 1 from app_private.intake_operating where policy=pol)then return base;end if;
 r:=app_private.intake_rule_for(sid,pol);select * into b from app_private.intake_scope_bindings where source_id=sid and policy=pol;
 select * into md from app_private.intake_metadata where source_id=sid;
 fingerprint:=app_private.intake_metadata_fingerprint(md);
 if r.rule_id is null or b.rule_id is null or b.metadata_hash<>fingerprint or b.classification<>r.classification or not exists(select 1 from app_private.meeting_source_people where source_id=sid and actor=r.reviewer and active)or not exists(select 1 from app_private.meeting_scope where source_id=sid and client=r.client and active)then raise exception 'standing_scope_changed_or_unbound'using errcode='42501';end if;
 return encode(extensions.digest(base||to_jsonb(r)::text||fingerprint,'sha256'),'hex');
end$$;

create or replace function public.meeting_intake_operational(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare p app_private.meeting_policy;c app_private.intake_controls;o app_private.intake_operating;row jsonb;md app_private.intake_metadata;r app_private.intake_scope_rules;b app_private.intake_scope_bindings;result jsonb;sid text;fp text;run app_private.intake_runs;checkrow app_private.intake_source_checks;work app_private.intake_source_work;checkstate text;checkreason text;failures int;v_lane text:=case when payload->>'catchUp'='true'then 'catchup'else 'recurring'end;
begin
 select * into p from app_private.meeting_policy where db_role=current_setting('role',true)::name and active for share;
 select * into c from app_private.intake_controls where policy=p.id and enabled for update;
 select * into o from app_private.intake_operating where policy=p.id and enabled for update;
 if p.id is null or c.policy is null or o.policy is null or clock_timestamp()<o.operating_start or clock_timestamp()>=least(c.ends_at,o.operating_end)then raise exception 'operational_intake_disabled'using errcode='42501';end if;
 if action='configuration'then return to_jsonb(c)||jsonb_build_object('accountId',o.account_id,'operatingStart',o.operating_start,'operatingEnd',o.operating_end,'catchupStart',o.catchup_start,'catchupEnd',o.catchup_end,'coalesced_source_work',true,'source_checks',true,'fresh_metadata_required',true);end if;
 if action='acquire'then
  if o.lease_until>clock_timestamp()or(v_lane='recurring'and o.next_poll>clock_timestamp())then return jsonb_build_object('acquired',false);end if;
  update app_private.intake_operating set lease=extensions.gen_random_uuid(),lease_until=clock_timestamp()+interval '10 minutes',next_poll=case when v_lane='recurring'then clock_timestamp()+make_interval(secs=>c.interval_seconds)else next_poll end where policy=p.id returning * into o;
  return jsonb_build_object('acquired',true,'lease',o.lease);
 end if;
 if o.lease::text is distinct from payload->>'lease'or o.lease_until<=clock_timestamp()then raise exception 'collector_lease_expired'using errcode='42501';end if;
 if action='release'then update app_private.intake_operating set lease=null,lease_until=null where policy=p.id;return '{}';end if;
 if action='pending_run'then
  return jsonb_build_object('run',null,'coalesced',true,'fullSweepDue',not exists(select 1 from app_private.intake_runs where policy=p.id and lane='recurring'and starts_at=o.operating_start and catalogued_at>clock_timestamp()-interval '1 day'));
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
   if payload->>'reason'not in('read_unavailable','metadata_changed','metadata_incomplete','transcript_incomplete')or(not(payload?'work_token')and(payload->>'cursor')::int<>run.cursor+1) then raise exception 'invalid_source_exception';end if;
   failures:=case when checkrow.metadata_hash=fp then coalesce(checkrow.failures,0)+1 else 1 end;
   checkstate:=case when failures>=3 then 'read_exception'else 'read_retry'end;checkreason:=payload->>'reason';
  else
   failures:=0;
   if not coalesce((public.meeting_intake('eligible',jsonb_build_object('id',sid))->>'allowed')::boolean,false)then checkstate:='scope_exception';checkreason:='Standing authority unresolved; no transcript retry';
   elsif exists(select 1 from app_private.meetings where source_id=sid and revision is not null and extraction_revision=revision)then checkstate:='resolved';checkreason:='Current revision extraction recorded; human review separate';
   elsif exists(select 1 from app_private.intake_attempts a join app_private.meetings m on m.source_id=a.source_id and m.revision=a.revision where a.source_id=sid and a.state in('reserved','dispatched','unknown','invalid','cancelled','recorded'))then checkstate:='attempt_retained';checkreason:='Reconcile durable attempt; no automatic redispatch';
   else checkstate:='extraction_pending';select coalesce(note,'Capture/extraction incomplete')into checkreason from app_private.meetings where source_id=sid;end if;
  end if;
  insert into app_private.intake_source_checks(source_id,policy,state,reason,metadata_hash,failures,next_read_at)values(sid,p.id,checkstate,checkreason,fp,failures,case when action='source_exception'and failures<3 then clock_timestamp()+make_interval(secs=>c.interval_seconds*failures)else null end)
  on conflict(source_id)do update set state=excluded.state,reason=excluded.reason,metadata_hash=excluded.metadata_hash,failures=excluded.failures,next_read_at=excluded.next_read_at,checked_at=clock_timestamp()where intake_source_checks.policy=p.id;
  if payload?'work_token'then
   update app_private.intake_source_work set claim_token=null,claim_lease=null,last_checked_at=clock_timestamp(),metadata_hash=fp,last_outcome=checkstate,
    due_at=case when checkstate='read_exception'then null when checkstate='read_retry'then clock_timestamp()+make_interval(secs=>c.interval_seconds*failures)else clock_timestamp()+make_interval(secs=>c.interval_seconds)end where source_id=sid;
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
   update app_private.meetings set note='Extraction allowance exhausted; wait for authorized daily allowance or operator decision'where source_id=payload->>'id'and policy=p.id;
   return jsonb_build_object('dispatch',false,'state','budget_exhausted');
  end if;raise;
 end;
end$$;

create or replace function public.meeting_intake_operational_coverage()returns jsonb language plpgsql security definer set search_path='' as $$
declare base jsonb:=public.meeting_intake_coverage();a app_private.workspace_actors:=app_private.meeting_actor();latest timestamptz;exceptions bigint;uncertain bigint;enabled boolean;source_exceptions bigint;read_retries bigint;expiry timestamptz;pending_windows bigint;source_details jsonb;
begin
 if base->>'visibility'<>'reviewer'then return base;end if;
 select max(e.created_at)into latest from app_private.intake_events e join app_private.intake_attempts t on t.id=e.attempt_id where e.operation='publish'and app_private.meeting_can_read(t.source_id,a.actor);
 select count(*)into exceptions from app_private.intake_metadata md join app_private.intake_controls c on c.policy=md.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors)and not exists(select 1 from app_private.intake_scope_bindings b where b.source_id=md.source_id and b.classification=(app_private.intake_rule_for(md.source_id,md.policy)).classification and b.metadata_hash=app_private.intake_metadata_fingerprint(md));
 select count(*)into uncertain from app_private.intake_attempts t where t.state in('unknown','invalid','cancelled','reserved','dispatched')and app_private.meeting_can_read(t.source_id,a.actor);
 select bool_or(o.enabled and c.enabled and clock_timestamp()>=o.operating_start and clock_timestamp()<o.operating_end)into enabled from app_private.intake_operating o join app_private.intake_controls c on c.policy=o.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors);
 select count(*)filter(where x.state<>'resolved'),count(*)filter(where x.state='read_retry')into source_exceptions,read_retries from app_private.intake_source_checks x where app_private.meeting_can_read(x.source_id,a.actor);
 select count(*)into pending_windows from app_private.intake_source_work w where (w.last_checked_at is null or w.due_at<=clock_timestamp()or w.last_outcome in('global_failure','cancelled','checking'))and app_private.meeting_can_read(w.source_id,a.actor);
 select coalesce(jsonb_agg(to_jsonb(x)),'[]')into source_details from(select m.title,c.state,c.reason,c.next_read_at as "nextReadAt",c.checked_at as "checkedAt" from app_private.intake_source_checks c join app_private.meetings m on m.source_id=c.source_id where c.state<>'resolved'and app_private.meeting_can_read(c.source_id,a.actor)order by c.checked_at desc,c.source_id limit 20)x;
 select min(o.operating_end)into expiry from app_private.intake_operating o join app_private.intake_controls c on c.policy=o.policy join app_private.meeting_policy p on p.id=c.policy where p.workspace_id=a.workspace_id and a.actor=any(c.coverage_actors);
 return (base#-'{stages,scopeHeld}')||jsonb_build_object('status',case when not coalesce(enabled,false)then 'disabled'when base->>'status'in('unverified','stale','incomplete')then base->>'status'when source_exceptions>0 or pending_windows>0 then 'incomplete'else base->>'status'end,'sourceWorkPending',pending_windows,'sourceChecks',source_details,'sourceExceptions',source_exceptions,'temporaryReadRetries',read_retries,'operatingEndsAt',expiry,'continuation','Stops at expiry; no automatic renewal')||jsonb_build_object('lastProcessedAt',latest,'scopeExceptions',exceptions,'attemptExceptions',uncertain,'operatingEnabled',coalesce(enabled,false),'nextAction',case when not coalesce(enabled,false)then 'Intake held or expired; technical operator must obtain an explicit continuation decision.'when pending_windows>0 then 'Source work remains due or interrupted. Discovery and processing are tracked separately; processing continues within its cap.'when source_exceptions>0 then 'Source exceptions remain; temporary reads retry at most three times. Discovery continues. Reconcile exhausted reads or retained attempts.'when exceptions>0 then 'Operator: resolve held scope mappings before retrieval.'when uncertain>0 then 'Operator: reconcile retained attempts; do not retry extraction blindly.'else 'Review new proposals and later evidence; existing tasks remain unchanged.'end);
end$$;

revoke all on function app_private.intake_emails_valid(text[]),app_private.intake_metadata_fingerprint(app_private.intake_metadata)from public,anon,authenticated,service_role;
commit;
