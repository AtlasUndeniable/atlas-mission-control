-- 029: automatic client mapping for meeting intake. Additive over applied 025, 026 and 028.
-- No seeds, no rules, no activation, and no grant to any role that did not already hold one.
-- Nothing changes until a reviewed standing rule of match_kind='resolved' is provisioned and
-- activated for an account/organizer; until then unmatched calls are Held exactly as before.
-- Design: sprint-20261007/laneN-client-mapping/DESIGN.md.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if not exists(select 1 from information_schema.columns where table_schema='app_private'and table_name='intake_scope_rules'and column_name='match_kind')then raise exception 'apply_025_first';end if;
 if to_regclass('app_private.intake_budget_policies')is null then raise exception 'apply_026_first';end if;
 if not exists(select 1 from information_schema.columns where table_schema='app_private'and table_name='task_documents'and column_name='asset_release')then raise exception 'apply_028_first';end if;
 if to_regclass('app_private.intake_client_mappings')is not null or to_regprocedure('app_private.intake_rule_for_v026(text,text)')is not null then raise exception 'already_installed_inspect';end if;
 if to_regprocedure('public.meeting_intake_operational(text,jsonb)')is null or to_regprocedure('app_private.intake_rule_for(text,text)')is null
  or to_regprocedure('app_private.task_document_packet(uuid,text,text)')is null or to_regprocedure('app_private.intake_metadata_fingerprint(app_private.intake_metadata)')is null then raise exception 'preimage_function_absent';end if;
end$$;

-- A third rule kind: the reviewed standing decision under which an automatically mapped call is
-- bound (reviewer, classification, decision reference). It names no client and matches nobody
-- by itself; the per-call mapping below supplies the client.
do $$declare n text;begin
 select conname into n from pg_constraint where conrelid='app_private.intake_scope_rules'::regclass and contype='c'
  and pg_get_constraintdef(oid)like '%match_kind = ANY%'and pg_get_constraintdef(oid)not like '%client_emails%';
 if n is null then raise exception 'match_kind_check_absent';end if;
 execute format('alter table app_private.intake_scope_rules drop constraint %I',n);
end$$;
alter table app_private.intake_scope_rules
 add constraint intake_scope_match_kind check(match_kind in('domain','participant','resolved')),
 add constraint intake_scope_resolved_boundary check(match_kind<>'resolved'or(client='*resolved*'and cardinality(client_emails)=0 and cardinality(allowed_emails)=0 and cardinality(client_domains)=0 and cardinality(allowed_domains)=0 and not excluded));

-- Personal providers never map on domain, only on an exact address. Mirrored and parity-tested in
-- src/lib/meetings/client-mapping.ts (PERSONAL_DOMAINS).
create function app_private.intake_personal_domains()returns text[] language sql immutable set search_path='' as
$$select array['aol.com','bigpond.com','bigpond.net.au','fastmail.com','gmail.com','gmx.com','googlemail.com','hey.com','hotmail.co.uk','hotmail.com','hotmail.com.au','icloud.com','iinet.net.au','live.com','live.com.au','mac.com','mail.com','me.com','msn.com','optusnet.com.au','outlook.com','outlook.com.au','proton.me','protonmail.com','tpg.com.au','yahoo.co.uk','yahoo.com','yahoo.com.au','ymail.com','zoho.com']$$;
create function app_private.intake_slug(t text)returns text language sql immutable set search_path='' as
$$select left(btrim(regexp_replace(lower(coalesce(t,'')),'[^a-z0-9]+','-','g'),'-'),40)$$;

-- Clients created by mapping or by a person. Clients that predate 029 have no row and are confirmed.
create table app_private.intake_clients(
 policy text not null references app_private.intake_operating(policy),
 client text not null check(client~'^[a-z0-9][a-z0-9-]{0,119}$'),
 status text not null check(status in('provisional','confirmed','merged')),
 display_name text not null check(length(btrim(display_name))between 1 and 200),
 company text check(company is null or length(company)<=200),
 created_by text not null check(created_by~'^(atlas-resolver:client-mapping-v1|human:.+)$'),
 evidence jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp(),
 decided_by text check(decided_by is null or decided_by~'^human:.+$'),
 decided_at timestamptz,
 merged_into text,
 primary key(policy,client),
 check((status='provisional')=(decided_by is null)),
 check((status='merged')=(merged_into is not null))
);
create table app_private.intake_client_identities(
 id uuid primary key default extensions.gen_random_uuid(),
 policy text not null references app_private.intake_operating(policy),
 client text not null,
 email text not null check(app_private.intake_emails_valid(array[email])),
 status text not null check(status in('provisional','confirmed')),
 source text not null check(source in('resolver_new','human')),
 decided_by text not null check(decided_by~'^(atlas-resolver:client-mapping-v1|human:.+)$'),
 evidence jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp(),
 superseded_at timestamptz,
 superseded_by uuid references app_private.intake_client_identities(id)
);
create unique index intake_client_identity_current on app_private.intake_client_identities(policy,email)where superseded_at is null;
create table app_private.intake_client_mappings(
 id uuid primary key default extensions.gen_random_uuid(),
 source_id text not null,
 policy text not null references app_private.intake_operating(policy),
 organizer text not null,
 participants text[] not null check(app_private.intake_emails_valid(participants)),
 outcome text not null check(outcome in('known','new','ambiguous','internal_only')),
 state text not null check(state in('mapped','held')),
 client text,
 confidence text not null check(confidence in('high','medium','provisional','human','none')),
 reason text not null check(length(reason)between 3 and 600),
 evidence jsonb not null check(jsonb_typeof(evidence)='array'),
 coverage jsonb not null default '{}'check(jsonb_typeof(coverage)='object'),
 decided_by text not null check(decided_by~'^(atlas-resolver:client-mapping-v1|human:.+)$'),
 decided_at timestamptz not null default clock_timestamp(),
 supersedes uuid references app_private.intake_client_mappings(id),
 superseded_at timestamptz,
 superseded_by uuid references app_private.intake_client_mappings(id)deferrable initially deferred,
 check((state='mapped')=(client is not null)),
 check((state='held')=(outcome in('ambiguous','internal_only'))),
 check((confidence='none')=(state='held'))
);
create unique index intake_client_mapping_current on app_private.intake_client_mappings(policy,source_id)where superseded_at is null;
-- Provisioned lists (decision references required). Empty by default.
create table app_private.intake_internal_people(
 policy text not null references app_private.intake_operating(policy),
 kind text not null check(kind in('email','domain')),
 value text not null check(value=lower(btrim(value))and(kind='domain'and value~'^[a-z0-9.-]+\.[a-z]{2,}$'or kind='email'and app_private.intake_emails_valid(array[value]))),
 active boolean not null default true,
 decision_reference text not null check(length(decision_reference)>=9),
 decided_by text not null,
 created_at timestamptz not null default clock_timestamp(),
 primary key(policy,kind,value),
 check(kind<>'domain'or not(value=any(app_private.intake_personal_domains())))
);
create table app_private.intake_shared_domains(
 policy text not null references app_private.intake_operating(policy),
 domain text not null check(domain=lower(btrim(domain))and domain~'^[a-z0-9.-]+\.[a-z]{2,}$'),
 reason text not null check(length(reason)>=3),
 decision_reference text not null check(length(decision_reference)>=9),
 primary key(policy,domain)
);
create table app_private.intake_client_resolvers(
 policy text not null references app_private.intake_operating(policy),
 actor text not null references app_private.workspace_actors(actor),
 active boolean not null default false,
 decision_reference text not null check(length(decision_reference)>=9),
 primary key(policy,actor)
);
create table app_private.intake_client_events(
 id bigint generated always as identity primary key,
 policy text not null, source_id text, mapping_id uuid, client text,
 event text not null, actor text not null, detail jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp()
);
create trigger intake_client_events_immutable before update or delete on app_private.intake_client_events for each row execute function app_private.task_history_immutable();

-- History is superseded, never edited: only superseded_at/by may be written, once.
create function app_private.intake_client_supersede_only()returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE'or old.superseded_at is not null or new.superseded_at is null
  or(to_jsonb(new)-array['superseded_at','superseded_by'])is distinct from(to_jsonb(old)-array['superseded_at','superseded_by'])then raise exception 'client_mapping_history_immutable';end if;
 return new;
end$$;
create trigger intake_client_mappings_supersede_only before update or delete on app_private.intake_client_mappings for each row execute function app_private.intake_client_supersede_only();
create trigger intake_client_identities_supersede_only before update or delete on app_private.intake_client_identities for each row execute function app_private.intake_client_supersede_only();
-- A provisional client moves once: to confirmed (a person may correct the name then) or merged.
create function app_private.intake_client_transition()returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE'or old.status<>'provisional'or new.status not in('confirmed','merged')or new.decided_by is null or new.decided_at is null
  or(to_jsonb(new)-array['status','decided_by','decided_at','merged_into','display_name'])is distinct from(to_jsonb(old)-array['status','decided_by','decided_at','merged_into','display_name'])
  or(new.status='merged'and new.display_name is distinct from old.display_name)then raise exception 'client_status_transition_denied';end if;
 return new;
end$$;
create trigger intake_clients_transition before update or delete on app_private.intake_clients for each row execute function app_private.intake_client_transition();

-- Known clients: the reviewer's own active client grants, minus provisional clients merged away.
create function app_private.intake_known_clients(pol text,reviewer text)returns text[] language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(distinct wc.client order by wc.client),'{}')from app_private.workspace_clients wc
 where wc.actor=reviewer and wc.active and not exists(select 1 from app_private.intake_clients ic where ic.policy=pol and ic.client=wc.client and ic.status='merged');
$$;
create function app_private.intake_client_status(pol text,c text)returns text language sql stable security definer set search_path='' as $$
 select coalesce((select status from app_private.intake_clients where policy=pol and client=c),'confirmed');
$$;
create function app_private.intake_client_static_overlap(pol text,ver text,md app_private.intake_metadata)returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from app_private.intake_scope_rules where policy=pol and version=ver and active and not excluded and account_id=md.account_id and organizer=md.organizer
  and((match_kind='participant'and md.participants&&client_emails)or(match_kind='domain'and md.domains&&client_domains)));
$$;

-- The decision. Pure over current rows plus the collector's reported facts; writes nothing.
-- Mirrored by decideMapping() in src/lib/meetings/client-mapping.ts and checked against the
-- shared case table verification/client-mapping-cases.json in the native rehearsal.
create function app_private.intake_client_decide(pol text,ver text,reviewer text,org text,parts text[],ev jsonb)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare known text[]:=app_private.intake_known_clients(pol,reviewer);personal text[]:=app_private.intake_personal_domains();
 internal_e text[];internal_d text[];p text;dom text;e jsonb;cands jsonb;exact text[];ds text[];toks text[];
 items jsonb:='[]';amb_reason text;resolved text[]:='{}';unres text[]:='{}';all_strong boolean:=true;strong boolean;via text;note text;
 nonint int:=0;rc text[];client text;conf text;primary_email text;nm text;company text;key text;same_domain boolean;
begin
 if jsonb_typeof(ev)<>'array'then ev:='[]';end if;
 select coalesce(array_agg(distinct x),'{}')into internal_e from(
  select lower(org)x
  union select e2 from app_private.intake_scope_rules r,unnest(r.allowed_emails)e2 where r.policy=pol and r.version=ver and r.active and r.match_kind='participant'and not(e2=any(r.client_emails))
  union select value from app_private.intake_internal_people where policy=pol and kind='email'and active)s;
 select coalesce(array_agg(value),'{}')into internal_d from app_private.intake_internal_people where policy=pol and kind='domain'and active;
 foreach p in array coalesce((select array_agg(x order by x collate "C")from(select distinct x from unnest(parts)x)u),'{}')loop
  dom:=split_part(p,'@',2);
  if p=any(internal_e)or dom=any(internal_d)then items:=items||jsonb_build_array(jsonb_build_object('email',p,'internal',true));continue;end if;
  nonint:=nonint+1;cands:='[]';via:=null;note:=null;strong:=false;
  -- (a1) an existing client identity, (a2) the existing crosswalk.
  cands:=cands||coalesce((select jsonb_agg(jsonb_build_object('client',i.client,'source','identity','status',i.status,'ref',i.id)order by i.client)from app_private.intake_client_identities i where i.policy=pol and i.email=p and i.superseded_at is null and i.client=any(known)),'[]');
  cands:=cands||coalesce((select jsonb_agg(jsonb_build_object('client',r.client,'source','crosswalk','ref',r.rule_id)order by r.client,r.rule_id)from app_private.intake_scope_rules r where r.policy=pol and r.version=ver and r.active and not r.excluded and r.match_kind='participant'and p=any(r.client_emails)),'[]');
  -- (b)(c)(d) facts reported by the collector, judged here against known clients only.
  for e in select x from jsonb_array_elements(ev)x where jsonb_typeof(x)='object'and x->>'email'=p loop
   if e->>'source'='ghl'then
    -- An explicit CRM tag wins; otherwise the contact's full-name slug must equal a client key.
    exact:=case when jsonb_typeof(e->'tags')='array'then array(select k from unnest(known)k where('atlas-client:'||k)in(select lower(t)from jsonb_array_elements_text(e->'tags')t)order by k)else '{}'end;
    if cardinality(exact)=0 and app_private.intake_slug(e->>'name')<>''and app_private.intake_slug(e->>'name')=any(known)then exact:=array[app_private.intake_slug(e->>'name')];end if;
    cands:=cands||coalesce((select jsonb_agg(jsonb_build_object('client',k,'source','ghl','ref',left(coalesce(e->>'ref',''),80))order by k)from unnest(exact)k),'[]');
   elsif e->>'source'='call_notes'and jsonb_typeof(e->'titleTokens')='array'then
    -- A title names a client only through a key of two or more words (first and last name), all present.
    toks:=array(select lower(t)from jsonb_array_elements_text(e->'titleTokens')t);
    cands:=cands||coalesce((select jsonb_agg(jsonb_build_object('client',k,'source','call_notes','ref',left(coalesce(e->>'ref',''),80))order by k)from unnest(known)k
     where app_private.intake_client_status(pol,k)<>'provisional'and cardinality(string_to_array(k,'-'))>=2 and not exists(select 1 from unnest(string_to_array(k,'-'))kt where not(kt=any(toks)))),'[]');
   elsif e->>'source'='client_folder'and coalesce(e->>'matchedOn','email')='email'and e->>'client'=any(known)then
    cands:=cands||jsonb_build_array(jsonb_build_object('client',e->>'client','source','client_folder','ref',left(coalesce(e->>'ref',''),80)));
   end if;
  end loop;
  exact:=array(select distinct x->>'client'from jsonb_array_elements(cands)x order by 1);
  if cardinality(exact)=1 then
   via:='email';
   strong:=exists(select 1 from jsonb_array_elements(cands)x where x->>'source'in('identity','crosswalk'))or(select count(distinct x->>'source')from jsonb_array_elements(cands)x)>=2;
  elsif cardinality(exact)>1 then
   note:='conflicting evidence: '||array_to_string(exact,', ');
  elsif dom=any(personal)then
   note:='personal email provider: matched on exact address only';
  elsif exists(select 1 from app_private.intake_shared_domains where policy=pol and domain=dom)then
   note:='shared or agency domain '||dom;
  else
   ds:=array(select distinct x from(
    select i.client x from app_private.intake_client_identities i where i.policy=pol and i.superseded_at is null and split_part(i.email,'@',2)=dom and i.client=any(known)
    union select r.client from app_private.intake_scope_rules r where r.policy=pol and r.version=ver and r.active and not r.excluded and r.match_kind in('domain','participant')
     and(dom=any(r.client_domains)or exists(select 1 from unnest(r.client_emails)ce where split_part(ce,'@',2)=dom))
    union select x2->>'client'from jsonb_array_elements(ev)x2 where jsonb_typeof(x2)='object'and x2->>'source'='client_folder'and x2->>'matchedOn'='domain'and x2->>'domain'=dom and x2->>'client'=any(known))s order by 1);
   if cardinality(ds)=1 then exact:=ds;via:='domain';cands:=jsonb_build_array(jsonb_build_object('client',ds[1],'source','domain','ref',dom));
   elsif cardinality(ds)>1 then note:='domain '||dom||' is used by several clients: '||array_to_string(ds,', ');
   end if;
  end if;
  if via is not null then resolved:=resolved||exact[1];all_strong:=all_strong and strong;
  elsif note is not null and note not like 'personal email provider%'then amb_reason:=coalesce(amb_reason,p||': '||note);
  else unres:=unres||p;end if;
  items:=items||jsonb_build_array(jsonb_build_object('email',p,'internal',false,'candidates',cands,'resolved',case when via is null then null else exact[1]end,'via',via,'note',note));
 end loop;
 rc:=array(select distinct x from unnest(resolved)x order by 1);
 if nonint=0 then
  return jsonb_build_object('outcome','internal_only','state','held','client',null,'confidence','none','reason','Only internal team members attended','participants',items);
 elsif amb_reason is not null then
  return jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Needs a person: '||amb_reason,'participants',items);
 elsif cardinality(rc)>1 then
  return jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Participants match different clients: '||array_to_string(rc,', '),'participants',items);
 elsif cardinality(rc)=1 then
  client:=rc[1];
  conf:=case when app_private.intake_client_status(pol,client)='provisional'then 'provisional'when all_strong then 'high'else 'medium'end;
  return jsonb_build_object('outcome','known','state','mapped','client',client,'confidence',conf,'reason','Matched '||client||case when cardinality(unres)>0 then '; '||cardinality(unres)||' other participant(s) not affiliated'else ''end,'participants',items);
 end if;
 -- Nobody matched anywhere.
 same_domain:=(select count(distinct split_part(x,'@',2))from unnest(unres)x)=1 and not(split_part(unres[1],'@',2)=any(personal));
 if cardinality(unres)<>1 and not same_domain then
  return jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Several people with no client record; cannot tell which one is the client','participants',items);
 end if;
 primary_email:=unres[1];
 select nullif(btrim(x->>'name'),''),nullif(btrim(x->>'company'),'')into nm,company from jsonb_array_elements(ev)x where jsonb_typeof(x)='object'and x->>'source'='ghl'and x->>'email'=primary_email and nullif(btrim(x->>'name'),'')is not null order by x->>'ref' limit 1;
 nm:=coalesce(nm,initcap(btrim(regexp_replace(split_part(split_part(primary_email,'@',1),'+',1),'[._-]+',' ','g'))));
 if nm is null or nm=''then nm:='New client';end if;
 company:=coalesce(company,case when split_part(primary_email,'@',2)=any(personal)then null else split_part(primary_email,'@',2)end);
 key:='new-'||coalesce(nullif(app_private.intake_slug(nm),''),'client')||'-'||left(md5(primary_email),6);
 return jsonb_build_object('outcome','new','state','mapped','client',key,'confidence','provisional','reason','No record of '||array_to_string(unres,', ')||' anywhere; provisional new client','participants',items,
  'newClient',jsonb_build_object('client',key,'name',left(nm,200),'company',company,'emails',to_jsonb(unres)));
end$$;

create function app_private.intake_client_record(cur uuid,sid text,pol text,org text,parts text[],outcome text,state text,client text,confidence text,reason text,evidence jsonb,coverage jsonb,who text)returns app_private.intake_client_mappings language plpgsql security definer set search_path='' as $$
declare nid uuid:=extensions.gen_random_uuid();m app_private.intake_client_mappings;
begin
 if cur is not null then
  update app_private.intake_client_mappings set superseded_at=clock_timestamp(),superseded_by=nid where id=cur and superseded_at is null;
  if not found then raise exception 'client_mapping_changed'using errcode='PT409';end if;
 end if;
 insert into app_private.intake_client_mappings(id,source_id,policy,organizer,participants,outcome,state,client,confidence,reason,evidence,coverage,decided_by,supersedes)
 values(nid,sid,pol,org,parts,outcome,state,client,confidence,left(reason,600),evidence,coalesce(coverage,'{}'),who,cur)returning * into m;
 insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(pol,sid,m.id,m.client,'mapping_'||m.outcome,who,jsonb_build_object('state',m.state,'confidence',m.confidence,'supersedes',cur));
 return m;
end$$;

-- Records the decision as the current mapping (superseding), creating a provisional client for NEW.
-- Never re-scopes automatically, never overrides a person while the participants are unchanged.
create function app_private.intake_client_resolve(sid text,pol text,t app_private.intake_scope_rules,md app_private.intake_metadata,ev jsonb,cov jsonb,force boolean default false,actor_note text default null)returns app_private.intake_client_mappings language plpgsql security definer set search_path='' as $$
declare cur app_private.intake_client_mappings;d jsonb;m app_private.intake_client_mappings;scoped text;nc jsonb;key text;n int:=1;em text;
begin
 select * into cur from app_private.intake_client_mappings where policy=pol and source_id=sid and superseded_at is null for update;
 if cur.id is not null and not force and cur.participants=md.participants and cur.organizer=md.organizer and cur.decided_by like 'human:%'and cur.state='mapped'then return cur;end if;
 d:=app_private.intake_client_decide(pol,t.version,t.reviewer,md.organizer,md.participants,ev);
 -- Automatic resolution never re-scopes a call that is already scoped to a client.
 select client into scoped from app_private.meeting_scope where source_id=sid and policy=pol;
 if scoped is not null and(d->>'state'<>'mapped'or d->>'client'is distinct from scoped)then
  d:=d||jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Evidence changed after this call was scoped to '||scoped||'; a person must confirm the client');
 end if;
 -- No churn: the same result for the same people is not re-recorded on every scan.
 if cur.id is not null and cur.participants=md.participants and cur.organizer=md.organizer and cur.state=d->>'state'and cur.client is not distinct from d->>'client'
  and(cur.state='mapped'or cur.reason=d->>'reason')then return cur;end if;
 if d->>'outcome'='new'then
  nc:=d->'newClient';key:=nc->>'client';
  while exists(select 1 from app_private.intake_clients where client=key)or exists(select 1 from app_private.workspace_clients where client=key)loop n:=n+1;key:=(nc->>'client')||'-'||n;end loop;
  d:=jsonb_set(d,'{client}',to_jsonb(key));
  insert into app_private.intake_clients(policy,client,status,display_name,company,created_by,evidence)values(pol,key,'provisional',nc->>'name',nc->>'company','atlas-resolver:client-mapping-v1',jsonb_build_object('source',sid,'emails',nc->'emails','coverage',cov));
  for em in select jsonb_array_elements_text(nc->'emails')loop
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=pol and email=em and superseded_at is null;
   insert into app_private.intake_client_identities(policy,client,email,status,source,decided_by,evidence)values(pol,key,em,'provisional','resolver_new','atlas-resolver:client-mapping-v1',jsonb_build_object('source',sid));
  end loop;
  insert into app_private.workspace_clients(actor,client,active)values(t.reviewer,key,true);
  insert into app_private.intake_client_events(policy,source_id,client,event,actor,detail)values(pol,sid,key,'provisional_client_created','atlas-resolver:client-mapping-v1',jsonb_build_object('reviewerAccess',t.reviewer));
 end if;
 m:=app_private.intake_client_record(cur.id,sid,pol,md.organizer,md.participants,d->>'outcome',d->>'state',d->>'client',d->>'confidence',coalesce(d->>'reason','')||coalesce(' ('||actor_note||')',''),d->'participants',cov,'atlas-resolver:client-mapping-v1');
 return m;
end$$;

-- intake_rule_for, wrapped: the 026 body is unchanged and always wins. Only when it finds no rule
-- does a current, mapped, automatic-or-human client mapping bind under the reviewed 'resolved'
-- rule, with the same gating as the 026 body and the same explicit reviewer client grant.
alter function app_private.intake_rule_for(text,text)rename to intake_rule_for_v026;
create function app_private.intake_rule_for(sid text,pol text)returns app_private.intake_scope_rules language plpgsql security definer set search_path='' as $$
declare r app_private.intake_scope_rules;o app_private.intake_operating;md app_private.intake_metadata;mt timestamptz;m app_private.intake_client_mappings;n int;
begin
 r:=app_private.intake_rule_for_v026(sid,pol);
 if r.rule_id is not null then return r;end if;
 select * into o from app_private.intake_operating where policy=pol and enabled and clock_timestamp()>=operating_start and clock_timestamp()<coalesce(operating_end,'infinity'::timestamptz);
 select * into md from app_private.intake_metadata where source_id=sid and policy=pol;
 select instant into mt from app_private.meetings where source_id=sid and policy=pol;
 if o.policy is null or md.source_id is null or md.account_id is distinct from o.account_id or cardinality(md.domains)=0 or cardinality(md.participants)=0 or not coalesce(mt>=o.operating_start and mt<coalesce(o.operating_end,'infinity'::timestamptz)or mt>=o.catchup_start and mt<o.catchup_end,false)or exists(select 1 from app_private.intake_exclusions where policy=pol and source_id=sid)then return null;end if;
 if exists(select 1 from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and excluded and account_id=md.account_id and organizer=md.organizer)then return null;end if;
 if app_private.intake_client_static_overlap(pol,o.rule_version,md)then return null;end if;
 select count(*)into n from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and match_kind='resolved'and account_id=md.account_id and organizer=md.organizer;
 if n<>1 then return null;end if;
 select * into r from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and match_kind='resolved'and account_id=md.account_id and organizer=md.organizer;
 select * into m from app_private.intake_client_mappings where policy=pol and source_id=sid and superseded_at is null and state='mapped'and participants=md.participants and organizer=md.organizer;
 if m.id is null or app_private.intake_client_status(pol,m.client)='merged'then return null;end if;
 r.client:=m.client;r.decision_reference:=r.decision_reference||'; client mapping '||m.id;
 if not exists(select 1 from app_private.workspace_actors a join app_private.meeting_policy p on p.workspace_id=a.workspace_id join app_private.workspace_clients c on c.actor=a.actor join app_private.meeting_reviewers v on v.actor=a.actor where p.id=pol and a.actor=r.reviewer and a.active and c.active and c.client=r.client and v.active and v.can_review)then return null;end if;
 return r;
end$$;

-- Binds a mapped call through the same scope tables and checks as the 026 catalog loop.
create function app_private.intake_client_bind(sid text,pol text,m app_private.intake_client_mappings)returns boolean language plpgsql security definer set search_path='' as $$
declare r app_private.intake_scope_rules;md app_private.intake_metadata;b app_private.intake_scope_bindings;fp text;
begin
 r:=app_private.intake_rule_for(sid,pol);
 if r.rule_id is null or r.match_kind<>'resolved'or r.client is distinct from m.client then return false;end if;
 select * into md from app_private.intake_metadata where source_id=sid and policy=pol;
 fp:=app_private.intake_metadata_fingerprint(md);
 select * into b from app_private.intake_scope_bindings where source_id=sid;
 if(b.source_id is not null and(b.metadata_hash<>fp or b.classification<>r.classification))or exists(select 1 from app_private.meeting_scope where source_id=sid and(policy<>pol or client<>r.client or not active))or exists(select 1 from app_private.meeting_source_people where source_id=sid and actor=r.reviewer and not active)then return false;end if;
 update app_private.meetings set note='Client mapped ('||m.outcome||', '||m.confidence||' confidence); extraction and proposal review remain separate'
  where source_id=sid and policy=pol and(note like 'Scope exception:%'or note like 'Needs a client:%'or note like 'Internal meeting:%'or note like 'Client mapped%'or note like 'Client chosen%');
 if b.source_id is null then
  insert into app_private.meeting_scope(source_id,policy,client,active,review_reference)values(sid,pol,r.client,true,r.decision_reference)on conflict do nothing;
  insert into app_private.meeting_source_people(source_id,actor,active,review_reference)values(sid,r.reviewer,true,r.decision_reference)on conflict do nothing;
  insert into app_private.intake_scope_bindings(source_id,policy,version,rule_id,metadata_hash,classification)values(sid,pol,r.version,r.rule_id,fp,r.classification);
  insert into app_private.intake_scope_events(source_id,policy,event,detail)values(sid,pol,'standing_rule_bound',jsonb_build_object('version',r.version,'rule',r.rule_id,'classification',r.classification,'decision',r.decision_reference,'clientMapping',m.id,'outcome',m.outcome,'confidence',m.confidence));
 end if;
 return true;
end$$;

-- After the unchanged 026 catalog/refresh loop: resolve calls no static rule covers.
create function app_private.intake_client_after_scan(pol text,sid text,ce jsonb)returns void language plpgsql security definer set search_path='' as $$
declare o app_private.intake_operating;md app_private.intake_metadata;mt timestamptz;t app_private.intake_scope_rules;n int;m app_private.intake_client_mappings;ev jsonb;cov jsonb;
begin
 if pol is null or sid is null or not exists(select 1 from app_private.meetings where source_id=sid and policy=pol)then return;end if;
 if(app_private.intake_rule_for_v026(sid,pol)).rule_id is not null then return;end if;
 select * into o from app_private.intake_operating where policy=pol and enabled and clock_timestamp()>=operating_start and clock_timestamp()<coalesce(operating_end,'infinity'::timestamptz);
 select * into md from app_private.intake_metadata where source_id=sid and policy=pol;
 select instant into mt from app_private.meetings where source_id=sid and policy=pol;
 if o.policy is null or md.source_id is null or md.account_id is distinct from o.account_id or cardinality(md.participants)=0 or not coalesce(mt>=o.operating_start and mt<coalesce(o.operating_end,'infinity'::timestamptz)or mt>=o.catchup_start and mt<o.catchup_end,false)or exists(select 1 from app_private.intake_exclusions where policy=pol and source_id=sid)then return;end if;
 if exists(select 1 from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and excluded and account_id=md.account_id and organizer=md.organizer)then return;end if;
 if app_private.intake_client_static_overlap(pol,o.rule_version,md)then return;end if;
 select count(*)into n from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and match_kind='resolved'and account_id=md.account_id and organizer=md.organizer;
 if n<>1 then return;end if;
 select * into t from app_private.intake_scope_rules where policy=pol and version=o.rule_version and active and not excluded and match_kind='resolved'and account_id=md.account_id and organizer=md.organizer;
 ev:=case when jsonb_typeof(ce->'items')='array'and jsonb_array_length(ce->'items')<=200 then ce->'items'else '[]'end;
 cov:=case when jsonb_typeof(ce->'coverage')='object'then ce->'coverage'else jsonb_build_object('collector','no evidence reported')end;
 m:=app_private.intake_client_resolve(sid,pol,t,md,ev,cov);
 perform app_private.intake_client_apply(sid,pol,m,'atlas-resolver:client-mapping-v1');
end$$;

-- Applies the current mapping: Held with a visible reason, or bound / re-scoped and released.
create function app_private.intake_client_apply(sid text,pol text,m app_private.intake_client_mappings,who text)returns void language plpgsql security definer set search_path='' as $$
begin
 if m.state='held'then
  update app_private.meetings set note=case when m.outcome='internal_only'then 'Internal meeting: '||m.reason||'; not processed as client work'
   else 'Needs a client: '||m.reason||'. Choose the client on the board; nothing has been read from the recording'end,state=case when revision is null then 'held'else state end
  where source_id=sid and policy=pol;
  return;
 end if;
 if exists(select 1 from app_private.meeting_scope where source_id=sid and policy=pol and client<>m.client)then
  -- A person's correction re-scopes the source. The 023 trigger bumps the intake authority epoch
  -- and the 022 scope fence fences document attempts; requests keep their recorded client and
  -- task_document_packet refuses drafting for them until re-reviewed.
  if m.decided_by not like 'human:%'then return;end if;
  update app_private.meeting_scope set client=m.client,review_reference='client mapping '||m.id||' by '||m.decided_by where source_id=sid and policy=pol;
  insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(pol,sid,m.id,m.client,'source_rescoped',who,'{}');
 end if;
 perform app_private.intake_client_bind(sid,pol,m);
end$$;

-- meeting_intake_operational, wrapped: the 026 body runs unchanged on the rows with the collector's
-- clientEvidence removed (so catalog rows, journals and metadata hashes are byte-identical), then
-- unmatched in-window calls are resolved.
alter function public.meeting_intake_operational(text,jsonb)rename to meeting_intake_operational_v026;
alter function public.meeting_intake_operational_v026(text,jsonb)set schema app_private;
create function public.meeting_intake_operational(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;rws jsonb;clean jsonb;x jsonb;pol text;
begin
 if action in('catalog','refresh_metadata')then
  rws:=case when action='catalog'then payload->'meetings'else jsonb_build_array(payload->'meeting')end;
  if jsonb_typeof(rws)='array'and exists(select 1 from jsonb_array_elements(rws)y where jsonb_typeof(y)='object'and y?'clientEvidence')then
   select jsonb_agg(case when jsonb_typeof(y)='object'then y-'clientEvidence'else y end order by i)into clean from jsonb_array_elements(rws)with ordinality s(y,i);
   payload:=case when action='catalog'then jsonb_set(payload,'{meetings}',clean)else jsonb_set(payload,'{meeting}',clean->0)end;
  end if;
 end if;
 result:=app_private.meeting_intake_operational_v026(action,payload);
 if action in('catalog','refresh_metadata')and jsonb_typeof(rws)='array'and coalesce(result->>'held','false')<>'true'then
  select id into pol from app_private.meeting_policy where db_role=current_setting('role',true)::name and active;
  for x in select y from jsonb_array_elements(rws)y loop
   if jsonb_typeof(x)<>'object'or x->>'live'='true'then continue;end if;
   perform app_private.intake_client_after_scan(pol,x->>'id',x->'clientEvidence');
  end loop;
 end if;
 return result;
end$$;

-- Who may resolve: the reviewer named by an active resolved rule, or a provisioned resolver.
create function app_private.intake_client_can_resolve(pol text,person text)returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from app_private.intake_scope_rules r join app_private.intake_operating o on o.policy=r.policy and o.rule_version=r.version where r.policy=pol and r.active and r.match_kind='resolved'and r.reviewer=person)
  or exists(select 1 from app_private.intake_client_resolvers where policy=pol and actor=person and active);
$$;

-- Board RPC: list exceptions, choose an existing client, confirm a new client, mark internal.
create function public.meeting_client_mapping(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare a app_private.workspace_actors:=app_private.meeting_actor();cur app_private.intake_client_mappings;m app_private.intake_client_mappings;t app_private.intake_scope_rules;
 md app_private.intake_metadata;o app_private.intake_operating;who text;target text;st text;em text;nonint text[];chosen text[];nm text;key text;n int:=1;
begin
 who:='human:'||a.actor;
 if action='list'then
  return jsonb_build_object('items',coalesce((select jsonb_agg(x order by x->>'decidedAt'desc)from(
    select jsonb_build_object('mapping',m2.id,'badge',case when m2.state='held'then 'needs_client'else 'new_client'end,'title',mt.title,'instant',mt.instant,'outcome',m2.outcome,
     'client',m2.client,'clientName',ic.display_name,'company',ic.company,'confidence',m2.confidence,'reason',m2.reason,'decidedBy',m2.decided_by,'decidedAt',m2.decided_at,
     'participants',(select coalesce(jsonb_agg(jsonb_build_object('email',pp->>'email','resolved',pp->>'resolved','note',pp->>'note','candidates',(select coalesce(jsonb_agg(distinct cc->>'client'),'[]')from jsonb_array_elements(coalesce(pp->'candidates','[]'))cc))),'[]')
      from jsonb_array_elements(m2.evidence)pp where pp->>'internal'='false'))x
    from app_private.intake_client_mappings m2 join app_private.meetings mt on mt.source_id=m2.source_id and mt.policy=m2.policy
    left join app_private.intake_clients ic on ic.policy=m2.policy and ic.client=m2.client
    where m2.superseded_at is null and app_private.intake_client_can_resolve(m2.policy,a.actor)
     and((m2.state='held'and m2.outcome='ambiguous')or(m2.state='mapped'and ic.status='provisional'))
    order by m2.decided_at desc limit 50)s),'[]'),
   'clients',coalesce((select jsonb_agg(jsonb_build_object('client',k,'name',coalesce(ic.display_name,k),'status',app_private.intake_client_status(r.policy,k))order by k)
    from app_private.intake_scope_rules r join app_private.intake_operating o2 on o2.policy=r.policy and o2.rule_version=r.version
    cross join lateral unnest(app_private.intake_known_clients(r.policy,r.reviewer))k left join app_private.intake_clients ic on ic.policy=r.policy and ic.client=k
    where r.active and r.match_kind='resolved'and app_private.intake_client_can_resolve(r.policy,a.actor)),'[]'));
 end if;
 if action not in('choose_existing','confirm_new','mark_internal')then raise exception 'client_mapping_action_invalid';end if;
 select * into cur from app_private.intake_client_mappings where id=(payload->>'mapping')::uuid for update;
 if cur.id is null or not app_private.intake_client_can_resolve(cur.policy,a.actor)then raise exception 'client_mapping_denied'using errcode='42501';end if;
 if cur.superseded_at is not null then raise exception 'client_mapping_changed'using errcode='PT409';end if;
 select * into o from app_private.intake_operating where policy=cur.policy;
 select * into md from app_private.intake_metadata where source_id=cur.source_id and policy=cur.policy;
 select * into t from app_private.intake_scope_rules where policy=cur.policy and version=o.rule_version and active and match_kind='resolved'and account_id=md.account_id and organizer=md.organizer;
 if t.rule_id is null or md.participants is distinct from cur.participants then raise exception 'client_mapping_changed'using errcode='PT409';end if;
 nonint:=array(select pp->>'email'from jsonb_array_elements(cur.evidence)pp where pp->>'internal'='false');
 if jsonb_typeof(coalesce(payload->'emails','[]'))<>'array'then raise exception 'client_mapping_emails_invalid';end if;
 chosen:=array(select distinct lower(btrim(e))from jsonb_array_elements_text(coalesce(payload->'emails','[]'))e);
 if not chosen<@nonint then raise exception 'client_mapping_emails_invalid';end if;
 if action='choose_existing'then
  target:=payload->>'client';
  if target is null or not(target=any(app_private.intake_known_clients(cur.policy,t.reviewer)))or app_private.intake_client_status(cur.policy,target)<>'confirmed'then raise exception 'client_not_known'using errcode='42501';end if;
  if cur.state='mapped'and cur.client=target then raise exception 'client_mapping_unchanged';end if;
  foreach em in array chosen loop
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
   insert into app_private.intake_client_identities(policy,client,email,status,source,decided_by,evidence)values(cur.policy,target,em,'confirmed','human',who,jsonb_build_object('mapping',cur.id));
  end loop;
  if cur.state='mapped'and app_private.intake_client_status(cur.policy,cur.client)='provisional'then
   update app_private.intake_clients set status='merged',merged_into=target,decided_by=who,decided_at=clock_timestamp()where policy=cur.policy and client=cur.client;
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and client=cur.client and superseded_at is null;
   update app_private.workspace_clients set active=false where client=cur.client and active;
   insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(cur.policy,cur.source_id,cur.id,cur.client,'provisional_client_merged',who,jsonb_build_object('into',target));
  end if;
  m:=app_private.intake_client_record(cur.id,cur.source_id,cur.policy,cur.organizer,cur.participants,'known','mapped',target,'human','Client chosen by '||a.actor,cur.evidence,cur.coverage,who);
 elsif action='confirm_new'then
  if cur.state='mapped'and app_private.intake_client_status(cur.policy,cur.client)='provisional'then
   nm:=coalesce(nullif(btrim(payload->>'name'),''),(select display_name from app_private.intake_clients where policy=cur.policy and client=cur.client));
   update app_private.intake_clients set status='confirmed',display_name=left(nm,200),decided_by=who,decided_at=clock_timestamp()where policy=cur.policy and client=cur.client;
   for em in select i.email from app_private.intake_client_identities i where i.policy=cur.policy and i.client=cur.client and i.superseded_at is null and i.status='provisional'loop
    update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
    insert into app_private.intake_client_identities(policy,client,email,status,source,decided_by,evidence)values(cur.policy,cur.client,em,'confirmed','human',who,jsonb_build_object('mapping',cur.id));
   end loop;
   insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(cur.policy,cur.source_id,cur.id,cur.client,'client_confirmed',who,'{}');
   return jsonb_build_object('ok',true,'mapping',cur.id,'client',cur.client,'status','confirmed');
  end if;
  if cur.state<>'held'or cardinality(chosen)=0 then raise exception 'client_mapping_emails_invalid';end if;
  nm:=btrim(coalesce(payload->>'name',''));
  if length(nm)<2 or length(nm)>200 or app_private.intake_slug(nm)=''then raise exception 'client_name_required';end if;
  key:=app_private.intake_slug(nm);
  if key=any(app_private.intake_known_clients(cur.policy,t.reviewer))then raise exception 'client_exists_choose_existing'using errcode='PT409';end if;
  while exists(select 1 from app_private.intake_clients where client=key)or exists(select 1 from app_private.workspace_clients where client=key)loop n:=n+1;key:=app_private.intake_slug(nm)||'-'||n;end loop;
  insert into app_private.intake_clients(policy,client,status,display_name,company,created_by,evidence,decided_by,decided_at)values(cur.policy,key,'confirmed',nm,nullif(btrim(coalesce(payload->>'company','')),''),who,jsonb_build_object('mapping',cur.id,'emails',to_jsonb(chosen)),who,clock_timestamp());
  foreach em in array chosen loop
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
   insert into app_private.intake_client_identities(policy,client,email,status,source,decided_by,evidence)values(cur.policy,key,em,'confirmed','human',who,jsonb_build_object('mapping',cur.id));
  end loop;
  insert into app_private.workspace_clients(actor,client,active)values(t.reviewer,key,true);
  m:=app_private.intake_client_record(cur.id,cur.source_id,cur.policy,cur.organizer,cur.participants,'new','mapped',key,'human','New client confirmed by '||a.actor,cur.evidence,cur.coverage,who);
 else
  if cardinality(chosen)=0 then raise exception 'client_mapping_emails_invalid';end if;
  foreach em in array chosen loop
   insert into app_private.intake_internal_people(policy,kind,value,active,decision_reference,decided_by)values(cur.policy,'email',em,true,'board decision by '||a.actor||' on mapping '||cur.id,who)
   on conflict(policy,kind,value)do update set active=true;
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
  end loop;
  insert into app_private.intake_client_events(policy,source_id,mapping_id,event,actor,detail)values(cur.policy,cur.source_id,cur.id,'marked_internal',who,jsonb_build_object('emails',to_jsonb(chosen)));
  -- Held until the next scan re-resolves this call with the collector's fresh facts and the people
  -- now known to be internal. A held human decision is not sticky; a mapped one is.
  m:=app_private.intake_client_record(cur.id,cur.source_id,cur.policy,cur.organizer,cur.participants,'ambiguous','held',null,'none','Re-checking after '||array_to_string(chosen,', ')||' marked internal by '||a.actor,cur.evidence,cur.coverage,who);
 end if;
 perform app_private.intake_client_apply(cur.source_id,cur.policy,m,who);
 -- Release: the next tick runs this call through the normal path. Nothing is extracted here.
 update app_private.intake_source_work set due_at=clock_timestamp()where source_id=cur.source_id and policy=cur.policy;
 return jsonb_build_object('ok',true,'mapping',m.id,'state',m.state,'client',m.client);
end$$;

-- Drafting privacy boundary, layer 1: a provisional or merged client can never be given a
-- client-work directory.
create function app_private.task_document_provisional_guard()returns trigger language plpgsql security definer set search_path='' as $$
declare st text;
begin
 if new.asset_release is null or jsonb_typeof(new.asset_release->'clientDirectories')<>'array'or jsonb_array_length(new.asset_release->'clientDirectories')=0 then return new;end if;
 select ic.status into st from public.requests q join app_private.meeting_items mi on mi.request_id=q.id join app_private.meetings m on m.source_id=mi.source_id
  join app_private.intake_clients ic on ic.policy=m.policy and ic.client=q.client where q.id=new.request_id;
 if st in('provisional','merged')then raise exception 'provisional_client_shared_roots_only'using errcode='42501';end if;
 return new;
end$$;
create trigger task_document_provisional_guard before insert or update of asset_release on app_private.task_documents for each row execute function app_private.task_document_provisional_guard();

-- Layer 2: the 028 packet, wrapped. Unchanged when the client is confirmed and still current.
alter function app_private.task_document_packet(uuid,text,text)rename to task_document_packet_v028;
create function app_private.task_document_packet(did uuid,person text,needed text)returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;cur text;pol text;st text;
begin
 result:=app_private.task_document_packet_v028(did,person,needed);
 select ms.client,m.policy into cur,pol from app_private.task_documents d join app_private.meeting_items mi on mi.request_id=d.request_id
  join app_private.meetings m on m.source_id=mi.source_id left join app_private.meeting_scope ms on ms.source_id=mi.source_id and ms.active where d.id=did;
 if cur is distinct from result->>'client'then raise exception 'client_mapping_changed'using errcode='PT409';end if;
 st:=app_private.intake_client_status(pol,cur);
 if st='merged'then raise exception 'client_mapping_changed'using errcode='PT409';end if;
 if st='provisional'then
  if jsonb_typeof(result->'assetRelease'->'clientDirectories')<>'array'or jsonb_array_length(result->'assetRelease'->'clientDirectories')>0 then raise exception 'provisional_client_shared_roots_only'using errcode='42501';end if;
  result:=jsonb_set(result,'{missingContext}',coalesce(result->'missingContext','[]')||jsonb_build_array('This client is new and not yet confirmed, so the draft uses shared Atlas method material only.'));
 end if;
 return result;
end$$;

do $$declare t text;f regprocedure;begin
 foreach t in array array['intake_clients','intake_client_identities','intake_client_mappings','intake_internal_people','intake_shared_domains','intake_client_resolvers','intake_client_events']loop
  execute format('alter table app_private.%I enable row level security',t);execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach f in array array['app_private.intake_personal_domains()','app_private.intake_slug(text)','app_private.intake_client_supersede_only()','app_private.intake_client_transition()',
  'app_private.intake_known_clients(text,text)','app_private.intake_client_status(text,text)','app_private.intake_client_static_overlap(text,text,app_private.intake_metadata)',
  'app_private.intake_client_decide(text,text,text,text,text[],jsonb)','app_private.intake_client_record(uuid,text,text,text,text[],text,text,text,text,text,jsonb,jsonb,text)','app_private.intake_client_resolve(text,text,app_private.intake_scope_rules,app_private.intake_metadata,jsonb,jsonb,boolean,text)',
  'app_private.intake_rule_for(text,text)','app_private.intake_rule_for_v026(text,text)','app_private.intake_client_bind(text,text,app_private.intake_client_mappings)',
  'app_private.intake_client_after_scan(text,text,jsonb)','app_private.intake_client_apply(text,text,app_private.intake_client_mappings,text)',
  'app_private.meeting_intake_operational_v026(text,jsonb)','app_private.intake_client_can_resolve(text,text)','public.meeting_client_mapping(text,jsonb)',
  'app_private.task_document_provisional_guard()','app_private.task_document_packet(uuid,text,text)','app_private.task_document_packet_v028(uuid,text,text)']::regprocedure[]loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
 -- The wrapper: PUBLIC and the API roles hold nothing; only the copied collector grant below.
 revoke all on function public.meeting_intake_operational(text,jsonb)from public,anon,authenticated,service_role;
end$$;
-- Carry the collector's existing EXECUTE grant to the wrapper; the renamed body keeps none.
do $$declare g record;begin
 for g in select r.rolname from pg_proc p cross join lateral aclexplode(p.proacl)x join pg_roles r on r.oid=x.grantee
  where p.oid='app_private.meeting_intake_operational_v026(text,jsonb)'::regprocedure and x.privilege_type='EXECUTE'and x.grantee<>p.proowner loop
  execute format('grant execute on function public.meeting_intake_operational(text,jsonb) to %I',g.rolname);
  execute format('revoke execute on function app_private.meeting_intake_operational_v026(text,jsonb) from %I',g.rolname);
 end loop;
end$$;
commit;
