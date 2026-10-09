-- Narrow hosted020 successor. No data replacement, ingest grants or raw-source release.
begin;
do $$begin
 if md5(pg_get_functiondef('public.meeting_queue(text,jsonb)'::regprocedure))<>'7368da7544a1a6df230de5f70fbd8b38' then raise exception '021_queue_preimage_drift';end if;
 if to_regclass('app_private.meeting_task_grants') is not null then raise exception '021_already_present_inspect_before_retry';end if;
end $$;
create table app_private.meeting_task_grants(
 id uuid primary key default extensions.gen_random_uuid(),
 actor text not null references app_private.meeting_reviewers(actor),
 request_id uuid not null references app_private.meeting_items(request_id),
 client text not null,source_id text not null,source_revision text not null,commitment_key text not null,
 item_revision bigint not null,evidence_hash text not null,
 projection jsonb not null,projection_hash text not null,reviewed_hash text not null,
 active boolean not null default true,review_reference text not null,
 unique(actor,request_id),
 check(projection_hash=encode(extensions.digest(projection::text,'sha256'),'hex'))
);
-- Only allowlisted, explicitly shared history; original canonical history stays immutable/private.
create table app_private.meeting_task_events(
 history_id uuid not null references app_private.meeting_history(id),
 grant_id uuid not null references app_private.meeting_task_grants(id),
 safe_note text not null,primary key(history_id,grant_id)
);
create trigger meeting_task_events_immutable before update or delete on app_private.meeting_task_events for each row execute function app_private.task_history_immutable();

create function app_private.meeting_task_valid(rid uuid,person text)returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from app_private.meeting_task_grants g
 join app_private.meeting_items i on i.request_id=g.request_id
 join public.requests q on q.id=i.request_id
 join app_private.meetings m on m.source_id=i.source_id
 join public.intake_sources src on src.source_id=m.source_id
 join app_private.meeting_scope s on s.source_id=m.source_id
 join app_private.meeting_policy p on p.id=s.policy
 join app_private.workspace_actors wa on wa.actor=g.actor and wa.workspace_id=p.workspace_id
 join app_private.meeting_reviewers r on r.actor=wa.actor
 join app_private.workspace_clients wc on wc.actor=wa.actor and wc.client=s.client
 where g.request_id=rid and g.actor=person and g.active and s.active and p.active and wa.active and r.active and wc.active
 and g.client=s.client and g.client=q.client and g.source_id=i.source_id and g.commitment_key=i.commitment_key
 and g.source_revision=m.revision and g.source_revision=src.revision and g.source_revision=i.reviewed_revision
 and not m.source_review_required and g.item_revision=i.revision
 and g.evidence_hash=encode(extensions.digest(i.evidence::text,'sha256'),'hex')
 and g.projection_hash=encode(extensions.digest(g.projection::text,'sha256'),'hex'))
$$;
create function app_private.meeting_item_access(rid uuid,person text)returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from app_private.meeting_items i where i.request_id=rid and
 (app_private.meeting_can_read(i.source_id,person) or app_private.meeting_task_valid(rid,person)))
$$;
-- Caller and recipient independently lock the actual authority rows, then re-evaluate.
create function app_private.meeting_item_lock(rid uuid,person text)returns void language plpgsql security definer set search_path='' as $$begin
 perform 1 from app_private.meeting_items i join app_private.meeting_scope s on s.source_id=i.source_id
 join app_private.meeting_policy p on p.id=s.policy
 join app_private.workspace_actors wa on wa.actor=person and wa.workspace_id=p.workspace_id
 join app_private.meeting_reviewers r on r.actor=wa.actor
 join app_private.workspace_clients wc on wc.actor=person and wc.client=s.client
 where i.request_id=rid for share of s,p,wa,r,wc;
 perform 1 from app_private.meeting_task_grants where request_id=rid and actor=person for share;
 perform 1 from app_private.meeting_source_people sp join app_private.meeting_items i on i.source_id=sp.source_id where i.request_id=rid and sp.actor=person for share of sp;
end $$;
create function app_private.meeting_task_item(rid uuid,person text)returns jsonb language plpgsql security definer set search_path='' as $$
declare g app_private.meeting_task_grants;i app_private.meeting_items;q public.requests;t public.tasks;p jsonb;e jsonb;
begin
 if not app_private.meeting_task_valid(rid,person)then raise exception 'item_context_denied'using errcode='42501';end if;
 select * into g from app_private.meeting_task_grants where request_id=rid and actor=person;
 select * into i from app_private.meeting_items where request_id=rid;
 select * into q from public.requests where id=rid;select * into t from public.tasks where id=q.task_id;p:=g.projection;e:=p->'evidence';
 return jsonb_build_object('id',rid,'revision',i.revision,'sourceRevision',g.source_revision,'taskOnly',true,'sharedCorrectionRequired',true,'projectionHash',g.projection_hash,
 'sharedCorrection',(select ev.safe_note from app_private.meeting_task_events ev join app_private.meeting_history h on h.id=ev.history_id where ev.grant_id=g.id and h.operation='request_changes' order by h.created_at desc limit 1),
 'title',p->>'title','due',p->'due','owner',p->'owner','state',q.state,'deferred',i.deferred,'reconciliationRequired',false,
 'evidence',jsonb_build_object('key',g.commitment_key,'title',p->>'title','kind',e->>'kind','provenance','transcript','quote',e->>'quote','speaker',e->>'speaker','start',e->'start','end',e->'end','passage',e->'passage','suggestedResponsibility',e->'suggestedResponsibility','uncertainty',e->>'uncertainty'),
 'task',case when t.id is null then null else jsonb_build_object('id',t.id,'executor',t.executor,'next_reviewer',t.next_reviewer,'work_status',t.work_status,'receipts',null)end,
 'assignees',(select coalesce(jsonb_agg(jsonb_build_object('actor',wa.actor,'review',r.can_review)),'[]')from app_private.workspace_actors wa join app_private.meeting_reviewers r on r.actor=wa.actor where app_private.meeting_item_access(rid,wa.actor)));
end $$;
create function app_private.meeting_task_history(rid uuid,person text)returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('actor',h.actor,'operation',h.operation,'created_at',h.created_at,'input',jsonb_build_object('note',e.safe_note))order by h.created_at),'[]')
 from app_private.meeting_task_grants g join app_private.meeting_task_events e on e.grant_id=g.id join app_private.meeting_history h on h.id=e.history_id
 where g.request_id=rid and g.actor=person and app_private.meeting_task_valid(rid,person)
$$;
create or replace function public.meeting_queue(action text default 'list',payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare a app_private.workspace_actors;r app_private.meeting_reviewers;m app_private.meetings;i app_private.meeting_items;
 q public.requests;t public.tasks;rows jsonb:='[]';items jsonb;v jsonb;c jsonb;mapping jsonb;newq jsonb;rid uuid;
 partial boolean:=false; safe_assignment boolean:=false; grants_before uuid[]; shared_note text; hid uuid; g app_private.meeting_task_grants; safe_projection jsonb;
 prior app_private.meeting_history;opid uuid;result jsonb;target text;sid text:=payload->>'sourceId';note text:=btrim(coalesce(payload->>'note',''));
begin
 -- Same lock for source capture/publication and review: source cannot move during acceptance.
 if action<>'list' then select * into m from app_private.meetings where source_id=sid for update;end if;
 a:=app_private.meeting_actor();select * into r from app_private.meeting_reviewers where actor=a.actor and active for share;
 if action='list' then
  for m in select mm.* from app_private.meetings mm where app_private.meeting_can_read(mm.source_id,a.actor) order by instant desc,source_id for update loop
   perform 1 from app_private.meeting_scope s join app_private.meeting_policy p on p.id=s.policy join app_private.workspace_clients wc on wc.client=s.client and wc.actor=a.actor join app_private.meeting_source_people sp on sp.source_id=s.source_id and sp.actor=a.actor where s.source_id=m.source_id for share of s,p,wc,sp;
   if not app_private.meeting_can_read(m.source_id,a.actor)then continue;end if;
   if m.revision is distinct from (select revision from public.intake_sources where source_id=m.source_id)then m.state:='held';m.note:='Canonical source changed; intake reconciliation required';m.source_review_required:=true;m.pending:=null;end if;
   select coalesce(jsonb_agg(jsonb_build_object('sharedCorrectionRequired',exists(select 1 from app_private.meeting_task_grants gg where gg.request_id=mi.request_id and app_private.meeting_task_valid(mi.request_id,gg.actor)),'assignees',(select coalesce(jsonb_agg(jsonb_build_object('actor',wa.actor,'review',mr.can_review)),'[]')from app_private.workspace_actors wa join app_private.meeting_reviewers mr on mr.actor=wa.actor where app_private.meeting_item_access(mi.request_id,wa.actor)),'id',mi.request_id,'revision',mi.revision,'title',rq.requested->>'title','due',rq.requested->'due','owner',rq.requested->'owner','state',rq.state,'deferred',mi.deferred,'evidence',mi.evidence,'sourceRevision',mi.reviewed_revision,'reconciliationRequired',(rq.state<>'declined' and coalesce(tt.work_status,'todo')<>'completed' and (m.source_review_required or (mi.reviewed_revision is distinct from m.revision and mi.continuity_revision is distinct from m.revision))),'task',to_jsonb(tt)) order by rq.created_at),'[]')into items
   from app_private.meeting_items mi join public.requests rq on rq.id=mi.request_id left join public.tasks tt on tt.id=rq.task_id where mi.source_id=m.source_id;
   rows:=rows||jsonb_build_array(jsonb_build_object('id',m.source_id,'title',m.title,'instant',m.instant,'state',m.state,'note',m.note,'revision',m.revision,'sourceChanged',m.source_review_required,'pending',case when m.source_review_required then m.pending else null end,'items',items,'assignees',(select coalesce(jsonb_agg(jsonb_build_object('actor',wa.actor,'review',mr.can_review)),'[]')from app_private.workspace_actors wa join app_private.meeting_reviewers mr on mr.actor=wa.actor where app_private.meeting_can_read(m.source_id,wa.actor))));
  end loop;
  -- Task-only meetings are constructed solely from the reviewed allowlist, never from m/pending/raw.
  for m in select mm.* from app_private.meetings mm where not app_private.meeting_can_read(mm.source_id,a.actor)
    and exists(select 1 from app_private.meeting_task_grants gg where gg.source_id=mm.source_id and gg.actor=a.actor)
    order by instant desc,source_id for update loop
   items:='[]';safe_projection:=null;
   for g in select * from app_private.meeting_task_grants where source_id=m.source_id and actor=a.actor order by request_id loop
    perform app_private.meeting_item_lock(g.request_id,a.actor);
    perform 1 from public.intake_sources where source_id=m.source_id for share;
    if app_private.meeting_task_valid(g.request_id,a.actor)then
     items:=items||jsonb_build_array(app_private.meeting_task_item(g.request_id,a.actor));safe_projection:=g.projection;
    end if;
   end loop;
   if jsonb_array_length(items)>0 then rows:=rows||jsonb_build_array(jsonb_build_object('id',m.source_id,'title',safe_projection->>'meetingTitle','clientLabel',safe_projection->>'clientLabel','instant',safe_projection->'instant','state','ready','note','Limited task context from a supervised full-transcript review. Later fulfilment is unverified.','revision',m.revision,'taskOnly',true,'sourceChanged',false,'pending',null,'items',items,'assignees','[]'::jsonb));end if;
  end loop;
  return jsonb_build_object('capability',public.meeting_capability(),'meetings',rows,'coverage',
   (select coalesce(jsonb_agg(jsonb_build_object('start',s.starts_at,'end',s.ends_at,'status',s.status,'observedAt',s.observed_at,'note',s.note)),'[]')from app_private.meeting_scans s join app_private.meeting_policy p on p.id=s.policy where p.workspace_id=a.workspace_id and p.active and exists(select 1 from app_private.meetings mm where mm.policy=p.id and app_private.meeting_can_read(mm.source_id,a.actor))),
   'coverageBoundary','Fireflies recorded meetings in approved windows. Missing recordings require an independent expected-meeting roster.');
 end if;
 rid:=case when payload->>'id' is null then null else (payload->>'id')::uuid end;
 if rid is not null then perform app_private.meeting_item_lock(rid,a.actor);end if;
 partial:=not app_private.meeting_can_read(sid,a.actor);
 if m.source_id is null or (partial and (action in('source_review','retain_original') or rid is null or not exists(select 1 from app_private.meeting_items where request_id=rid and source_id=sid) or not app_private.meeting_task_valid(rid,a.actor)))then raise exception 'meeting_scope_denied'using errcode='42501';end if;
 if not partial then

 -- Lock live policy/scope/client rows so a concurrent revocation linearizes with this action.
 perform 1 from app_private.meeting_scope s join app_private.meeting_policy p on p.id=s.policy join app_private.workspace_clients wc on wc.client=s.client and wc.actor=a.actor join app_private.meeting_source_people sp on sp.source_id=s.source_id and sp.actor=a.actor where s.source_id=sid for share of s,p,wc,sp;
 if not app_private.meeting_can_read(sid,a.actor) then raise exception 'meeting_scope_denied' using errcode='42501';end if;
 end if;
 perform 1 from public.intake_sources where source_id=sid for share;
 if m.revision is distinct from (select revision from public.intake_sources where source_id=sid) then raise exception 'canonical_source_changed_reconcile_first' using errcode='PT409';end if;
 if action='context' then
  if partial then return jsonb_build_object('taskOnly',true,'label','Limited task context from a supervised full-transcript review','item',app_private.meeting_task_item(rid,a.actor),'history',app_private.meeting_task_history(rid,a.actor));end if;
  return jsonb_build_object('source',public.intake_source_current(sid)->'raw','history',(select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at),'[]')from app_private.meeting_history h where h.source_id=sid));
 end if;
 if not r.can_triage and action not in ('complete','review','request_changes') then raise exception 'triage_denied' using errcode='42501';end if;
 opid:=(payload->>'operationId')::uuid;if opid is null then raise exception 'operation_id_required';end if;
 select * into prior from app_private.meeting_history where actor=a.actor and operation_id=opid;
 if found then if prior.input is distinct from payload or prior.operation<>action then raise exception 'idempotency_conflict' using errcode='PT409';end if;if partial then if prior.request_id is distinct from rid then raise exception 'meeting_scope_denied'using errcode='42501';end if;return jsonb_build_object('ok',true,'replay',true,'item',app_private.meeting_task_item(rid,a.actor));end if;return prior.result;end if;
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
  -- Snapshot valid grants before any canonical mutation. A stale private/source revision cannot be revived.
  perform 1 from app_private.meeting_task_grants where request_id=i.request_id for update;
  select array_agg(gg.id) into grants_before from app_private.meeting_task_grants gg where gg.request_id=i.request_id and app_private.meeting_task_valid(i.request_id,gg.actor);
  if partial and action not in('edit','accept','defer','dismiss','complete')then raise exception 'item_action_denied'using errcode='42501';end if;
  if action in ('edit','accept') then
   foreach target in array array[case when action='edit' and payload?'owner' then payload->>'owner' else q.requested->>'owner' end,case when payload?'executor'then payload->>'executor'else(select executor from public.tasks where id=q.task_id)end,case when payload?'reviewer'then payload->>'reviewer'else(select next_reviewer from public.tasks where id=q.task_id)end]loop
    if target='atlas' and exists(select 1 from app_private.meeting_task_grants where request_id=i.request_id and active)then raise exception 'assignment_scope_denied'using errcode='42501';end if;
    if target is not null and target<>'atlas' then
     perform app_private.meeting_item_lock(i.request_id,target);
     perform 1 from app_private.workspace_actors wa join app_private.meeting_reviewers mr on mr.actor=wa.actor join app_private.workspace_clients wc on wc.actor=wa.actor join app_private.meeting_scope ms on ms.client=wc.client join app_private.meeting_source_people sp on sp.source_id=ms.source_id and sp.actor=wa.actor where wa.actor=target and ms.source_id=sid for share of wa,mr,wc,sp;
     if not app_private.meeting_item_access(i.request_id,target)then raise exception 'assignment_scope_denied' using errcode='42501';end if;
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
   if payload ? 'owner' then target:=payload->>'owner';if target is not null and not app_private.meeting_item_access(i.request_id,target)then raise exception 'assignment_scope_denied' using errcode='42501';end if;newq:=jsonb_set(newq,'{owner}',payload->'owner');end if;
   if q.task_id is not null and newq->>'owner' is null then raise exception 'task_owner_required';end if;
   safe_assignment:=newq->'title' is not distinct from q.requested->'title' and newq->'due' is not distinct from q.requested->'due';
   update public.requests set requested=newq,input_version=input_version+case when newq<>q.requested then 1 else 0 end where id=q.id;
   if q.task_id is not null then
    foreach target in array array[payload->>'executor',payload->>'reviewer']loop
     if target is not null and target<>'atlas' and not app_private.meeting_item_access(i.request_id,target)then raise exception 'assignment_scope_denied' using errcode='42501';end if;
    end loop;
    if exists(select 1 from app_private.meeting_task_grants where request_id=i.request_id and active) and payload?'reviewer' and payload->>'reviewer' is distinct from r.rhys_actor then raise exception 'required_reviewer_change_denied'using errcode='42501';end if;
    if t.next_reviewer is not null and payload?'reviewer' and payload->>'reviewer' is distinct from t.next_reviewer and not r.can_review then raise exception 'required_reviewer_change_denied' using errcode='42501';end if;
    if payload->>'reviewer' is not null and not exists(select 1 from app_private.meeting_reviewers where actor=payload->>'reviewer' and can_review and active)then raise exception 'reviewer_denied';end if;
    update public.tasks set title=newq->>'title',owner=newq->>'owner',due=(newq->>'due')::date,due_origin=case when payload ? 'due' then 'owner_override' else due_origin end,
     executor=case when payload?'executor' then payload->>'executor' else executor end,next_reviewer=case when payload?'reviewer' then payload->>'reviewer' else next_reviewer end,
     work_status=case when payload?'executor' and payload->>'executor' is distinct from executor then case when payload->>'executor'='atlas' then 'atlas_held' else 'todo' end else work_status end,task_revision=task_revision+1 where id=q.task_id;
   end if;
  elsif action='accept' then
   if q.task_id is not null then result:=jsonb_build_object('taskId',q.task_id,'replay',true);
   else
    target:=q.requested->>'owner';if target is null or not app_private.meeting_item_access(i.request_id,target)then raise exception 'accountable_owner_required';end if;
    if (i.evidence->>'kind'<>'promise' or i.evidence->>'uncertainty'<>'') and (payload->>'confirmed' is distinct from 'true' or payload->'confirmation'->>'itemRevision' is distinct from i.revision::text or payload->'confirmation'->>'sourceRevision' is distinct from m.revision) then raise exception 'uncertainty_confirmation_required';end if;
    insert into public.tasks(title,client,lane,owner,origin,state,due,source_quote,created_by,meeting_action,executor,work_status,execution_gate)
     values(q.requested->>'title',q.client,'business',target,'atlas_signal','queued',(q.requested->>'due')::date,i.evidence->>'quote',a.actor,true,target,'todo','review_required')returning * into t;
    if exists(select 1 from app_private.meeting_task_grants where request_id=i.request_id and active) then
     perform app_private.meeting_item_lock(i.request_id,r.rhys_actor);
     if r.rhys_actor is null or not app_private.meeting_item_access(i.request_id,r.rhys_actor) or not exists(select 1 from app_private.meeting_reviewers where actor=r.rhys_actor and can_review and active)then raise exception 'required_reviewer_unavailable'using errcode='42501';end if;
     update public.tasks set next_reviewer=r.rhys_actor where id=t.id;
    end if;
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
   if action='request_changes' and grants_before is not null then
    shared_note:=btrim(coalesce(payload->>'sharedNote',''));
    if length(shared_note) not between 3 and 2000 then raise exception 'shareable_correction_required';end if;
   end if;
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
 insert into app_private.meeting_history(source_id,request_id,actor,operation,operation_id,input,result)values(sid,i.request_id,a.actor,action,opid,payload,result) returning id into hid;
 -- Nat-authored task edits are explicitly in the shared task workspace. A private full-source edit is NOT.
 -- Nontext lifecycle changes may advance the binding; canonical receipts/history are never copied.
 if i.request_id is not null and (partial or (action='edit' and safe_assignment) or action in('accept','defer','dismiss','complete','review') or (action='request_changes' and shared_note is not null))then
  for g in select * from app_private.meeting_task_grants where id=any(grants_before)loop
   safe_projection:=g.projection;
   if action='edit' then
    if partial then
    if payload?'title'then safe_projection:=jsonb_set(safe_projection,'{title}',payload->'title');end if;
    if payload?'due'then safe_projection:=jsonb_set(safe_projection,'{due}',payload->'due');end if;
    end if;
    if payload?'owner'then safe_projection:=jsonb_set(safe_projection,'{owner}',payload->'owner');end if;
   end if;
   update app_private.meeting_task_grants set item_revision=(select revision from app_private.meeting_items where request_id=i.request_id),projection=safe_projection,projection_hash=encode(extensions.digest(safe_projection::text,'sha256'),'hex')where id=g.id;
   insert into app_private.meeting_task_events(history_id,grant_id,safe_note)values(hid,g.id,case when partial then left(note,2000)when action='request_changes'then shared_note else 'Workflow state updated; private notes are withheld.'end);
  end loop;
 end if;
 if partial then return jsonb_build_object('ok',true,'item',app_private.meeting_task_item(rid,a.actor));end if;
 return result;
exception when others then
 -- RPC errors can include user/provider text (casts, constraints). Do not expose it to any web caller.
 if sqlstate='42501'then raise exception 'Meeting permission denied.'using errcode='42501';
 elsif sqlstate='PT409'then raise exception 'Item or source changed. Refresh before continuing.'using errcode='PT409';
 else raise exception 'Review operation refused. Check the current item, assignment and required note.'using errcode='22023';end if;
end $$;



do $$declare f record;t text;begin
 foreach t in array array['meeting_task_grants','meeting_task_events']loop
 execute format('alter table app_private.%I enable row level security',t);execute format('alter table app_private.%I force row level security',t);
 execute format('revoke all on app_private.%I from public,anon,authenticated,service_role,atlas_retrieval,atlas_meeting_nat_web,atlas_meeting_rhys_web',t);
 end loop;
 for f in select oid::regprocedure sig from pg_proc where pronamespace='app_private'::regnamespace and proname in('meeting_task_valid','meeting_item_access','meeting_item_lock','meeting_task_item','meeting_task_history')loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role,atlas_retrieval,atlas_meeting_nat_web,atlas_meeting_rhys_web',f.sig);
 end loop;
end $$;
commit;
