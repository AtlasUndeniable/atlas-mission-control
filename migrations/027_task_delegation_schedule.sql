-- Proposed delegation policy only. No seeds, grants, repair of stale bindings or data replay.
-- Independent of uninstalled025/026; requires the preserved022 queue implementation.
begin;
set local lock_timeout='3s';
set local statement_timeout='15s';
do $migration$
declare definition text; original text;
begin
 select prosrc into original from pg_proc where oid='app_private.meeting_queue_v21(text,jsonb)'::regprocedure;
 if md5(original)<>'4e60f1b86e1a69ab8ef5acd7978a53a6' then raise exception '027_queue_preimage_drift';end if;
 definition:=pg_get_functiondef('app_private.meeting_queue_v21(text,jsonb)'::regprocedure);
 definition:=replace(definition,$old$safe_assignment:=newq->'title' is not distinct from q.requested->'title' and newq->'due' is not distinct from q.requested->'due';$old$,$new$-- Routine schedule/assignment changes may carry ONLY grants valid before this edit.
   if partial and newq->'title' is distinct from q.requested->'title' then raise exception 'instruction_change_requires_context_review' using errcode='42501';end if;
   safe_assignment:=newq->'title' is not distinct from q.requested->'title';$new$);
 definition:=replace(definition,$old$    if payload?'due'then safe_projection:=jsonb_set(safe_projection,'{due}',payload->'due');end if;
    end if;$old$,$new$    end if;
    -- Due is shared scheduling data, never a private instruction or permission grant.
    if payload?'due'then safe_projection:=jsonb_set(safe_projection,'{due}',payload->'due');end if;$new$);
 execute definition;
end $migration$;
commit;
