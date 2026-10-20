-- 029: automatic client mapping for meeting intake. Additive over applied 025, 026 and 028.
-- No seeds, no rules, no activation, and no grant to any role that did not already hold one.
-- Nothing changes until a reviewed standing rule of match_kind='resolved' is provisioned and
-- activated for an account/organizer; until then unmatched calls are Held exactly as before.
-- Lane N2 (R11): only an exact approved identity binds automatically; every other signal is a
-- Held suggestion; incomplete evidence is a named Held state; a new client is only ever created
-- by a person; a provisional client's drafts get shared method material only.
-- Dante 2026-10-20: no automatic assignment in this release. Even an exact approved identity is a
-- Held one-click suggestion unless the reviewed resolved rule carries auto_bind_exact=true
-- (default false). Card read-outs are masked by the collector before capture; masked-span counts
-- (never digits) are recorded per source revision in app_private.intake_redaction_counts.
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
-- Exact-identity automatic binding exists but is off unless a reviewed resolved rule says otherwise.
alter table app_private.intake_scope_rules add column auto_bind_exact boolean not null default false;
alter table app_private.intake_scope_rules
 add constraint intake_scope_auto_bind_resolved_only check(not auto_bind_exact or match_kind='resolved'),
 add constraint intake_scope_match_kind check(match_kind in('domain','participant','resolved')),
 add constraint intake_scope_resolved_boundary check(match_kind<>'resolved'or(client='*resolved*'and cardinality(client_emails)=0 and cardinality(allowed_emails)=0 and cardinality(client_domains)=0 and cardinality(allowed_domains)=0 and not excluded));

-- Personal providers never map on domain, only on an exact address. Mirrored and parity-tested in
-- src/lib/meetings/client-mapping.ts (PERSONAL_DOMAINS).
create function app_private.intake_personal_domains()returns text[] language sql immutable set search_path='' as
$$select array['123mail.org','150mail.com','150ml.com','16mail.com','2-mail.com','4email.net','50mail.com','aapt.net.au','adam.com.au','aim.com','airpost.net','allmail.net','aol.com','bigpond.com','bigpond.com.au','bigpond.net.au','btinternet.com','chariot.net.au','cluemail.com','comcast.net','dodo.com.au','duck.com','elitemail.org','emailcorner.net','emailengine.net','emailengine.org','emailgroups.net','emailplus.org','emailuser.net','eml.cc','exetel.com.au','f-m.fm','fast-email.com','fast-mail.org','fastem.com','fastemailer.com','fastest.cc','fastimap.com','fastmail.cn','fastmail.co.uk','fastmail.com','fastmail.com.au','fastmail.de','fastmail.es','fastmail.fm','fastmail.fr','fastmail.im','fastmail.in','fastmail.jp','fastmail.mx','fastmail.net','fastmail.nl','fastmail.org','fastmail.se','fastmail.to','fastmail.tw','fastmail.uk','fastmail.us','fastmailbox.net','fastmessaging.com','fea.st','fmail.co.uk','fmailbox.com','fmgirl.com','fmguy.com','ftml.net','gmail.com','gmx.com','gmx.de','gmx.net','googlemail.com','h-mail.us','hailmail.net','hey.com','hotmail.co.nz','hotmail.co.uk','hotmail.com','hotmail.com.au','hushmail.com','icloud.com','iinet.net.au','imap-mail.com','imap.cc','imapmail.org','inbox.com','inoutbox.com','internet-e-mail.com','internet-mail.org','internetemails.net','internetmailing.net','internode.on.net','iprimus.com.au','jetemail.net','justemail.net','letterboxes.org','live.co.uk','live.com','live.com.au','mac.com','mail-central.com','mail-page.com','mail.com','mailandftp.com','mailas.com','mailbolt.com','mailbox.org','mailc.net','mailcan.com','mailforce.net','mailftp.com','mailhaven.com','mailingaddress.org','mailite.com','mailmight.com','mailnew.com','mailsent.net','mailservice.ms','mailup.net','mailworks.org','me.com','ml1.net','mm.st','msn.com','myfastmail.com','mymacmail.com','netspace.net.au','nospammail.net','optusnet.com.au','outlook.co.nz','outlook.com','outlook.com.au','ownmail.net','ozemail.com.au','people.net.au','petml.com','pm.me','posteo.de','postinbox.com','postpro.net','primus.com.au','proinbox.com','promessage.com','proton.me','protonmail.ch','protonmail.com','qq.com','realemail.net','reallyfast.biz','reallyfast.info','rocketmail.com','rushpost.com','sent.as','sent.at','sent.com','sky.com','speedpost.net','speedymail.org','ssl-mail.com','swift-mail.com','the-fastest.net','the-quickest.com','theinternetemail.com','tpg.com.au','tuta.io','tutanota.com','veryfast.biz','veryspeedy.net','virginmedia.com','warpmail.net','web.de','westnet.com.au','xsmail.com','xtra.co.nz','yahoo.ca','yahoo.co.nz','yahoo.co.uk','yahoo.com','yahoo.com.au','yepmail.net','ymail.com','your-mail.com','zoho.com','zohomail.com']$$;
create function app_private.intake_slug(t text)returns text language sql immutable set search_path='' as
$$select left(btrim(regexp_replace(lower(coalesce(t,'')),'[^a-z0-9]+','-','g'),'-'),40)$$;

-- Clients created by a person on the board. Clients that predate 029 have no row and are confirmed.
create table app_private.intake_clients(
 policy text not null references app_private.intake_operating(policy),
 client text not null check(client~'^[a-z0-9][a-z0-9-]{0,119}$'),
 status text not null check(status in('provisional','confirmed','merged')),
 display_name text not null check(length(btrim(display_name))between 1 and 200),
 company text check(company is null or length(company)<=200),
 created_by text not null check(created_by~'^human:.+$'),
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
 source text not null check(source='human'),
 decided_by text not null check(decided_by~'^human:.+$'),
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
 outcome text not null check(outcome in('known','new','suggested','ambiguous','unrecognised','evidence_incomplete','internal_only')),
 state text not null check(state in('mapped','held')),
 client text,
 confidence text not null check(confidence in('exact','human','none')),
 reason text not null check(length(reason)between 3 and 600),
 evidence jsonb not null check(jsonb_typeof(evidence)='array'),
 coverage jsonb not null default '{}'check(jsonb_typeof(coverage)='object'),
 -- Suggested existing client(s) and, for an unrecognised call, a proposed name. Never authority.
 suggestion jsonb not null default '{}'check(jsonb_typeof(suggestion)='object'),
 decided_by text not null check(decided_by~'^(atlas-resolver:client-mapping-v1|human:.+)$'),
 decided_at timestamptz not null default clock_timestamp(),
 supersedes uuid references app_private.intake_client_mappings(id),
 superseded_at timestamptz,
 superseded_by uuid references app_private.intake_client_mappings(id)deferrable initially deferred,
 -- Only an exact approved identity binds automatically; everything else binds only by a person.
 check((state='mapped')=(client is not null)),
 check((state='mapped')=(outcome in('known','new'))),
 check(outcome<>'new'or decided_by like 'human:%'),
 check((confidence='none')=(state='held')),
 check(confidence<>'exact'or decided_by='atlas-resolver:client-mapping-v1'),
 check(confidence<>'human'or decided_by like 'human:%')
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
-- Card redaction accounting: masked-span counts per captured source revision. Counts only.
create table app_private.intake_redaction_counts(
 source_id text not null,
 policy text not null references app_private.intake_operating(policy),
 revision text not null check(revision~'^[0-9a-f]{64}$'),
 card integer not null check(card between 0 and 999),
 expiry integer not null check(expiry between 0 and 999),
 cvc integer not null check(cvc between 0 and 999),
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(source_id,revision)
);
create trigger intake_redaction_counts_immutable before update or delete on app_private.intake_redaction_counts for each row execute function app_private.task_history_immutable();

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

-- R11-3: the collector's coverage report goes into the decision. Absent, failed, unavailable,
-- first-N-limited or truncated evidence is a named gap; a gap never yields a new client.
create function app_private.intake_client_coverage_gap(cov jsonb)returns text language sql immutable set search_path='' as $$
 select case
  when cov is null or jsonb_typeof(cov)<>'object'or cov='{}'::jsonb then 'no evidence report from the collector'
  when cov?'collector'then 'collector evidence '||coalesce(cov->>'collector','missing')
  else nullif(concat_ws('; ',
   case when cov->>'truncated'='true'then 'evidence list truncated'end,
   case when coalesce(cov->>'ghl','')<>'complete'then 'GoHighLevel '||coalesce(nullif(cov->>'ghl',''),'not reported')end,
   case when coalesce(cov->>'callNotes','')!~'^[0-9]+-notes$'then 'call notes '||coalesce(nullif(cov->>'callNotes',''),'not reported')end,
   case when coalesce(cov->>'clientFolders','')!~'^[0-9]+-records$'then 'client folders '||coalesce(nullif(cov->>'clientFolders',''),'not reported')end),'')
 end;
$$;

-- The decision. Pure over current rows plus the collector's reported facts and coverage; writes
-- nothing. Mirrored by decideMapping() in src/lib/meetings/client-mapping.ts and checked against
-- verification/client-mapping-cases.json in the native rehearsal.
-- R11-1: only an exact approved identity (a current identity row, all of which are recorded by a
-- person, or the reviewed crosswalk) can map a call. CRM tags or names, prior-call titles, folder
-- records and company domains are SUGGESTIONS: the call is Held and a person confirms with one
-- click. Agreement between weak sources is never an upgrade.
-- R11-2: a shared/agency domain holds its participant before any suggestion is considered;
-- personal providers never produce a domain suggestion; domain-only evidence never binds.
create function app_private.intake_client_decide(pol text,ver text,reviewer text,org text,parts text[],ev jsonb,cov jsonb,auto_exact boolean)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare known text[]:=app_private.intake_known_clients(pol,reviewer);personal text[]:=app_private.intake_personal_domains();gap text:=app_private.intake_client_coverage_gap(cov);
 internal_e text[];internal_d text[];p text;dom text;e jsonb;strong jsonb;weak jsonb;sx text[];wx text[];ds text[];toks text[];
 items jsonb:='[]';amb text;s_set text[]:='{}';w_set text[]:='{}';unres text[]:='{}';res text;sug text;note text;nonint int:=0;sugg text[];
 primary_email text;nm text;company text;
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
  nonint:=nonint+1;res:=null;sug:=null;note:=null;weak:='[]';
  -- Approved identities: a current identity row (recorded by a person) or the reviewed crosswalk.
  strong:=coalesce((select jsonb_agg(jsonb_build_object('client',i.client,'source','identity','status',i.status,'ref',i.id)order by i.client)from app_private.intake_client_identities i where i.policy=pol and i.email=p and i.superseded_at is null and i.client=any(known)),'[]')
   ||coalesce((select jsonb_agg(jsonb_build_object('client',r.client,'source','crosswalk','ref',r.rule_id)order by r.client,r.rule_id)from app_private.intake_scope_rules r where r.policy=pol and r.version=ver and r.active and not r.excluded and r.match_kind='participant'and p=any(r.client_emails)),'[]');
  sx:=array(select z.c from(select distinct x->>'client'c from jsonb_array_elements(strong)x)z order by z.c collate "C");
  if cardinality(sx)=1 then res:=sx[1];
  elsif cardinality(sx)>1 then note:='conflicting approved identities: '||array_to_string(sx,', ');
  elsif exists(select 1 from app_private.intake_shared_domains where policy=pol and domain=dom)then note:='shared or agency domain '||dom;
  else
   -- Suggestions only: facts reported by the collector, judged against known clients.
   for e in select x from jsonb_array_elements(ev)x where jsonb_typeof(x)='object'and x->>'email'=p loop
    if e->>'source'='ghl'then
     wx:=case when jsonb_typeof(e->'tags')='array'then array(select k from unnest(known)k where('atlas-client:'||k)in(select lower(t)from jsonb_array_elements_text(e->'tags')t)order by k collate "C")else '{}'end;
     if cardinality(wx)=0 and app_private.intake_slug(e->>'name')<>''and app_private.intake_slug(e->>'name')=any(known)then wx:=array[app_private.intake_slug(e->>'name')];end if;
     weak:=weak||coalesce((select jsonb_agg(jsonb_build_object('client',k,'source','ghl','ref',left(coalesce(e->>'ref',''),80))order by k)from unnest(wx)k),'[]');
    elsif e->>'source'='call_notes'and jsonb_typeof(e->'titleTokens')='array'then
     -- A title names a client only through a key of two or more words, all present.
     toks:=array(select lower(t)from jsonb_array_elements_text(e->'titleTokens')t);
     weak:=weak||coalesce((select jsonb_agg(jsonb_build_object('client',k,'source','call_notes','ref',left(coalesce(e->>'ref',''),80))order by k)from unnest(known)k
      where app_private.intake_client_status(pol,k)<>'provisional'and cardinality(string_to_array(k,'-'))>=2 and not exists(select 1 from unnest(string_to_array(k,'-'))kt where not(kt=any(toks)))),'[]');
    elsif e->>'source'='client_folder'and coalesce(e->>'matchedOn','email')='email'and e->>'client'=any(known)then
     weak:=weak||jsonb_build_array(jsonb_build_object('client',e->>'client','source','client_folder','ref',left(coalesce(e->>'ref',''),80)));
    end if;
   end loop;
   -- A company domain is a suggestion only when exactly one client uses it; never a personal one.
   if not(dom=any(personal))then
    ds:=array(select z.x from(select distinct x from(
     select i.client x from app_private.intake_client_identities i where i.policy=pol and i.superseded_at is null and split_part(i.email,'@',2)=dom and i.client=any(known)
     union select r.client from app_private.intake_scope_rules r where r.policy=pol and r.version=ver and r.active and not r.excluded and r.match_kind in('domain','participant')
      and(dom=any(r.client_domains)or exists(select 1 from unnest(r.client_emails)ce where split_part(ce,'@',2)=dom))
     union select x2->>'client'from jsonb_array_elements(ev)x2 where jsonb_typeof(x2)='object'and x2->>'source'='client_folder'and x2->>'matchedOn'='domain'and x2->>'domain'=dom and x2->>'client'=any(known))s)z order by z.x collate "C");
    if cardinality(ds)=1 then weak:=weak||jsonb_build_array(jsonb_build_object('client',ds[1],'source','domain','ref',dom));
    elsif cardinality(ds)>1 then note:='domain '||dom||' is used by several clients: '||array_to_string(ds,', ');end if;
   end if;
   wx:=array(select z.c from(select distinct x->>'client'c from jsonb_array_elements(weak)x)z order by z.c collate "C");
   if note is null then
    if cardinality(wx)=1 then sug:=wx[1];elsif cardinality(wx)>1 then note:='conflicting suggestions: '||array_to_string(wx,', ');end if;
   end if;
  end if;
  if res is not null then s_set:=s_set||res;elsif sug is not null then w_set:=w_set||sug;elsif note is not null then amb:=coalesce(amb,p||': '||note);else unres:=unres||p;end if;
  items:=items||jsonb_build_array(jsonb_build_object('email',p,'internal',false,'approved',strong,'suggestions',weak,'resolved',res,'suggestion',sug,'note',note));
 end loop;
 sugg:=array(select z.c from(select distinct x c from unnest(s_set||w_set)x)z order by z.c collate "C");
 if nonint=0 then
  return jsonb_build_object('outcome','internal_only','state','held','client',null,'confidence','none','reason','Team call: only internal team members attended','participants',items,'suggestion','{}'::jsonb);
 elsif amb is not null then
  return jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Needs a person: '||amb,'participants',items,'suggestion',jsonb_build_object('clients',to_jsonb(sugg)));
 elsif cardinality(sugg)>1 then
  return jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Participants point to different clients: '||array_to_string(sugg,', '),'participants',items,'suggestion',jsonb_build_object('clients',to_jsonb(sugg)));
 elsif cardinality(s_set)>0 then
  if auto_exact and(cardinality(unres)=0 or gap is null)then
   return jsonb_build_object('outcome','known','state','mapped','client',sugg[1],'confidence','exact','reason','Matched '||sugg[1]||' by approved identity'||case when cardinality(unres)>0 then '; '||cardinality(unres)||' other participant(s) not affiliated'else ''end,'participants',items,'suggestion','{}'::jsonb);
  elsif auto_exact then
   return jsonb_build_object('outcome','evidence_incomplete','state','held','client',null,'confidence','none','reason','Matched '||sugg[1]||' by approved identity, but '||cardinality(unres)||' other participant(s) could not be checked: '||gap,'participants',items,'suggestion',jsonb_build_object('clients',to_jsonb(sugg)));
  end if;
  -- Automatic assignment off (the default): the approved identity is the pre-suggested client.
  return jsonb_build_object('outcome','suggested','state','held','client',null,'confidence','none','reason','Matched '||sugg[1]||' by approved identity; confirm to assign'
   ||case when cardinality(unres)>0 and gap is not null then '; '||cardinality(unres)||' other participant(s) could not be checked: '||gap when cardinality(unres)>0 then '; '||cardinality(unres)||' other participant(s) not affiliated'else ''end,
   'participants',items,'suggestion',jsonb_build_object('clients',to_jsonb(sugg),'approvedIdentity',true));
 elsif cardinality(w_set)>0 then
  return jsonb_build_object('outcome','suggested','state','held','client',null,'confidence','none','reason','Suggested '||sugg[1]||' from '||(select string_agg(z.src,', 'order by z.src collate "C")from(select distinct x->>'source'src from jsonb_array_elements(items)i,jsonb_array_elements(coalesce(i->'suggestions','[]'))x)z)||'; a person must confirm'||coalesce('; evidence incomplete: '||gap,''),'participants',items,'suggestion',jsonb_build_object('clients',to_jsonb(sugg)));
 elsif gap is not null then
  return jsonb_build_object('outcome','evidence_incomplete','state','held','client',null,'confidence','none','reason','Evidence incomplete ('||gap||'); no client can be suggested and no new client is inferred','participants',items,'suggestion','{}'::jsonb);
 end if;
 -- Nobody matched in complete evidence. Still Held: only a person confirms a new client.
 primary_email:=unres[1];
 select nullif(btrim(x->>'name'),''),nullif(btrim(x->>'company'),'')into nm,company from jsonb_array_elements(ev)x where jsonb_typeof(x)='object'and x->>'source'='ghl'and x->>'email'=primary_email and nullif(btrim(x->>'name'),'')is not null order by x->>'ref' limit 1;
 nm:=coalesce(nm,initcap(btrim(regexp_replace(split_part(split_part(primary_email,'@',1),'+',1),'[._-]+',' ','g'))));
 if nm is null or nm=''then nm:='New client';end if;
 company:=coalesce(company,case when split_part(primary_email,'@',2)=any(personal)then null else split_part(primary_email,'@',2)end);
 return jsonb_build_object('outcome','unrecognised','state','held','client',null,'confidence','none','reason','No record of '||array_to_string(unres,', ')||' in complete evidence; a person may confirm a new client','participants',items,
  'suggestion',jsonb_build_object('newClient',jsonb_build_object('name',left(nm,200),'company',company,'emails',to_jsonb(unres))));
end$$;

create function app_private.intake_client_record(cur uuid,sid text,pol text,org text,parts text[],outcome text,state text,client text,confidence text,reason text,evidence jsonb,coverage jsonb,suggestion jsonb,who text)returns app_private.intake_client_mappings language plpgsql security definer set search_path='' as $$
declare nid uuid:=extensions.gen_random_uuid();m app_private.intake_client_mappings;
begin
 if cur is not null then
  update app_private.intake_client_mappings set superseded_at=clock_timestamp(),superseded_by=nid where id=cur and superseded_at is null;
  if not found then raise exception 'client_mapping_changed'using errcode='PT409';end if;
 end if;
 insert into app_private.intake_client_mappings(id,source_id,policy,organizer,participants,outcome,state,client,confidence,reason,evidence,coverage,suggestion,decided_by,supersedes)
 values(nid,sid,pol,org,parts,outcome,state,client,confidence,left(reason,600),evidence,coalesce(coverage,'{}'),coalesce(suggestion,'{}'),who,cur)returning * into m;
 insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(pol,sid,m.id,m.client,'mapping_'||m.outcome,who,jsonb_build_object('state',m.state,'confidence',m.confidence,'supersedes',cur));
 return m;
end$$;

-- Records the decision as the current mapping (superseding). Never creates a client, never
-- re-scopes automatically, never overrides a person's mapping while the participants are unchanged.
create function app_private.intake_client_resolve(sid text,pol text,t app_private.intake_scope_rules,md app_private.intake_metadata,ev jsonb,cov jsonb)returns app_private.intake_client_mappings language plpgsql security definer set search_path='' as $$
declare cur app_private.intake_client_mappings;d jsonb;scoped text;
begin
 select * into cur from app_private.intake_client_mappings where policy=pol and source_id=sid and superseded_at is null for update;
 if cur.id is not null and cur.participants=md.participants and cur.organizer=md.organizer and cur.decided_by like 'human:%'and cur.state='mapped'then return cur;end if;
 d:=app_private.intake_client_decide(pol,t.version,t.reviewer,md.organizer,md.participants,ev,cov,t.auto_bind_exact);
 -- Automatic resolution never re-scopes a call that is already scoped to a client.
 select client into scoped from app_private.meeting_scope where source_id=sid and policy=pol;
 if scoped is not null and(d->>'state'<>'mapped'or d->>'client'is distinct from scoped)then
  d:=d||jsonb_build_object('outcome','ambiguous','state','held','client',null,'confidence','none','reason','Evidence changed after this call was scoped to '||scoped||'; a person must confirm the client','suggestion',jsonb_build_object('clients',jsonb_build_array(scoped)));
 end if;
 -- No churn: the same result for the same people is not re-recorded on every scan.
 if cur.id is not null and cur.participants=md.participants and cur.organizer=md.organizer and cur.state=d->>'state'and cur.client is not distinct from d->>'client'
  and cur.outcome=d->>'outcome'and(cur.state='mapped'or cur.reason=d->>'reason')then return cur;end if;
 return app_private.intake_client_record(cur.id,sid,pol,md.organizer,md.participants,d->>'outcome',d->>'state',d->>'client',d->>'confidence',d->>'reason',d->'participants',cov,d->'suggestion','atlas-resolver:client-mapping-v1');
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
 cov:=case when jsonb_typeof(ce->'coverage')='object'then ce->'coverage'else jsonb_build_object('collector','no evidence reported')end;
 ev:=case when jsonb_typeof(ce->'items')='array'and jsonb_array_length(ce->'items')<=200 then ce->'items'else '[]'end;
 if jsonb_typeof(ce->'items')='array'and jsonb_array_length(ce->'items')>200 then cov:=cov||jsonb_build_object('truncated','true');end if;
 m:=app_private.intake_client_resolve(sid,pol,t,md,ev,cov);
 perform app_private.intake_client_apply(sid,pol,m,'atlas-resolver:client-mapping-v1');
end$$;

-- Applies the current mapping: Held with a visible, true reason, or bound / re-scoped and released.
create function app_private.intake_client_apply(sid text,pol text,m app_private.intake_client_mappings,who text)returns void language plpgsql security definer set search_path='' as $$
declare read boolean;
begin
 if m.state='held'then
  -- A call already read (or already scoped) keeps that retained material; say so rather than
  -- claiming nothing was read.
  read:=exists(select 1 from app_private.meetings where source_id=sid and policy=pol and revision is not null)or exists(select 1 from app_private.meeting_scope where source_id=sid and policy=pol);
  update app_private.meetings set note=case when m.outcome='internal_only'then m.reason||'; not processed as client work'
   when read then 'Needs a client: '||m.reason||'. Choose the client on the board; material already read is retained and nothing further is extracted until then'
   else 'Needs a client: '||m.reason||'. Choose the client on the board; nothing has been read from the recording'end,state=case when revision is null then 'held'else state end
  where source_id=sid and policy=pol;
  return;
 end if;
 if exists(select 1 from app_private.meeting_scope where source_id=sid and policy=pol and client<>m.client)then
  -- A person's correction re-scopes the source. The 023 trigger bumps the intake authority epoch
  -- and the 022 scope fence bumps every derived document's authorization epoch; requests keep
  -- their recorded client and are refused for drafting until explicitly re-reviewed.
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
declare result jsonb;rws jsonb;clean jsonb;x jsonb;pol text;red jsonb;
begin
 if action='capture'and payload?'redaction'then
  red:=payload->'redaction';payload:=payload-'redaction';
  if jsonb_typeof(red)<>'object'or exists(select 1 from jsonb_object_keys(red)k where k not in('card','expiry','cvc'))
   -- All three counts required (a missing key is NULL, which must not pass), small integers only.
   or not coalesce((red->>'card')~'^[0-9]{1,3}$'and(red->>'expiry')~'^[0-9]{1,3}$'and(red->>'cvc')~'^[0-9]{1,3}$',false)then raise exception 'redaction_accounting_invalid';end if;
 end if;
 if action in('catalog','refresh_metadata')then
  rws:=case when action='catalog'then payload->'meetings'else jsonb_build_array(payload->'meeting')end;
  if jsonb_typeof(rws)='array'and exists(select 1 from jsonb_array_elements(rws)y where jsonb_typeof(y)='object'and y?'clientEvidence')then
   select jsonb_agg(case when jsonb_typeof(y)='object'then y-'clientEvidence'else y end order by i)into clean from jsonb_array_elements(rws)with ordinality s(y,i);
   payload:=case when action='catalog'then jsonb_set(payload,'{meetings}',clean)else jsonb_set(payload,'{meeting}',clean->0)end;
  end if;
 end if;
 result:=app_private.meeting_intake_operational_v026(action,payload);
 if action='capture'and red is not null then
  select id into pol from app_private.meeting_policy where db_role=current_setting('role',true)::name and active;
  insert into app_private.intake_redaction_counts(source_id,policy,revision,card,expiry,cvc)
  values(payload->>'id',pol,payload->'source'->>'revision',(red->>'card')::int,(red->>'expiry')::int,(red->>'cvc')::int)on conflict(source_id,revision)do nothing;
 end if;
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

-- Board RPC: list exceptions and recent automatic assignments; confirm a suggestion, choose or
-- change a client, confirm a new client, mark people internal, and re-review a request whose
-- source was re-scoped. Granted by provisioning, never by this migration.
create function public.meeting_client_mapping(action text,payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path='' as $$
declare a app_private.workspace_actors:=app_private.meeting_actor();cur app_private.intake_client_mappings;m app_private.intake_client_mappings;t app_private.intake_scope_rules;
 md app_private.intake_metadata;o app_private.intake_operating;who text;target text;em text;nonint text[];chosen text[];nm text;key text;n int:=1;
 q public.requests;cl text;scope_client text;mp app_private.intake_client_mappings;
begin
 who:='human:'||a.actor;
 if action='list'then
  return jsonb_build_object('items',coalesce((select jsonb_agg(x order by x->>'decidedAt'desc)from(
    select jsonb_build_object('mapping',m2.id,'badge',case when m2.state='held'and m2.outcome='suggested'then 'suggested'when m2.state='held'then 'needs_client'
      when ic.status='provisional'then 'new_client'else 'assigned'end,'title',mt.title,'instant',mt.instant,'outcome',m2.outcome,
     'client',m2.client,'clientName',ic.display_name,'company',ic.company,'confidence',m2.confidence,'reason',m2.reason,'decidedBy',m2.decided_by,'decidedAt',m2.decided_at,
     'suggestions',coalesce(m2.suggestion->'clients','[]'),'newClient',m2.suggestion->'newClient',
     'participants',(select coalesce(jsonb_agg(jsonb_build_object('email',pp->>'email','resolved',pp->>'resolved','suggestion',pp->>'suggestion','note',pp->>'note')),'[]')
      from jsonb_array_elements(m2.evidence)pp where pp->>'internal'='false'))x
    from app_private.intake_client_mappings m2 join app_private.meetings mt on mt.source_id=m2.source_id and mt.policy=m2.policy
    left join app_private.intake_clients ic on ic.policy=m2.policy and ic.client=m2.client
    where m2.superseded_at is null and app_private.intake_client_can_resolve(m2.policy,a.actor)and m2.outcome<>'internal_only'
     and(m2.state='held'or ic.status='provisional'or(m2.decided_by='atlas-resolver:client-mapping-v1'and m2.decided_at>clock_timestamp()-interval '14 days'))
    order by m2.decided_at desc limit 50)s),'[]'),
   'rereview',coalesce((select jsonb_agg(jsonb_build_object('request',rq.id,'title',rq.requested->>'title','recordedClient',rq.client,'currentClient',ms.client))
    from public.requests rq join app_private.meeting_items mi on mi.request_id=rq.id join app_private.meeting_scope ms on ms.source_id=mi.source_id and ms.active
    where rq.client is distinct from ms.client and app_private.intake_client_can_resolve(ms.policy,a.actor)),'[]'),
   'clients',coalesce((select jsonb_agg(jsonb_build_object('client',k,'name',coalesce(ic.display_name,k),'status',app_private.intake_client_status(r.policy,k))order by k)
    from app_private.intake_scope_rules r join app_private.intake_operating o2 on o2.policy=r.policy and o2.rule_version=r.version
    cross join lateral unnest(app_private.intake_known_clients(r.policy,r.reviewer))k left join app_private.intake_clients ic on ic.policy=r.policy and ic.client=k
    where r.active and r.match_kind='resolved'and app_private.intake_client_can_resolve(r.policy,a.actor)),'[]'));
 end if;
 if action='rereview_request'then
  -- R11-4 recovery: a reviewer explicitly re-reviews one request after its source was re-scoped.
  select * into q from public.requests where id=(payload->>'request')::uuid for update;
  select ms.client,ms.policy into scope_client,cl from app_private.meeting_items mi join app_private.meeting_scope ms on ms.source_id=mi.source_id and ms.active where mi.request_id=q.id;
  if q.id is null or scope_client is null or not app_private.intake_client_can_resolve(cl,a.actor)
   or not exists(select 1 from app_private.meeting_reviewers where actor=a.actor and active and can_review)then raise exception 'client_mapping_denied'using errcode='42501';end if;
  if q.client is not distinct from scope_client then raise exception 'client_mapping_unchanged';end if;
  select mm.* into mp from app_private.intake_client_mappings mm join app_private.meeting_items mi on mi.source_id=mm.source_id where mi.request_id=q.id and mm.superseded_at is null;
  if mp.id is null or mp.state<>'mapped'or mp.decided_by not like 'human:%'or mp.client<>scope_client then raise exception 'client_mapping_changed'using errcode='PT409';end if;
  if length(btrim(coalesce(payload->>'note','')))<10 then raise exception 'substantive_note_required';end if;
  perform set_config('atlas.meeting_write','authorized',true);
  update public.requests set client=scope_client,input_version=input_version+1 where id=q.id;
  update app_private.meeting_task_grants set client=scope_client,review_reference=left('client re-reviewed by '||a.actor||': '||btrim(payload->>'note'),500) where request_id=q.id;
  -- Pending drafting for the old binding is cancelled; the document returns to needs_revision
  -- under the new request hash. Nothing is regenerated here.
  update app_private.task_document_attempts x set state='cancelled' from app_private.task_documents d where d.request_id=q.id and x.document_id=d.id and x.state in('reserved','recorded');
  update app_private.task_documents set request_hash=(select input_hash from public.requests where id=q.id),revision=revision+1,
   status=case when status in('building','draft','in_review','uncertain')then 'needs_revision'else status end where request_id=q.id;
  insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(cl,mp.source_id,mp.id,scope_client,'request_rereviewed',who,jsonb_build_object('request',q.id,'from',q.client));
  return jsonb_build_object('ok',true,'request',q.id,'client',scope_client);
 end if;
 if action not in('choose_existing','confirm_suggested','confirm_new','mark_internal')then raise exception 'client_mapping_action_invalid';end if;
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
 if action='confirm_suggested'then
  -- One click: exactly the suggested client; remember the people whose evidence pointed at it.
  if cur.state<>'held'or jsonb_array_length(coalesce(cur.suggestion->'clients','[]'))<>1 or payload->>'client'is distinct from cur.suggestion->'clients'->>0 then raise exception 'client_mapping_changed'using errcode='PT409';end if;
  chosen:=array(select pp->>'email'from jsonb_array_elements(cur.evidence)pp where pp->>'internal'='false'and(pp->>'suggestion'=payload->>'client'or pp->>'resolved'=payload->>'client'));
  action:='choose_existing';
 end if;
 if action='choose_existing'then
  target:=payload->>'client';
  if target is null or not(target=any(app_private.intake_known_clients(cur.policy,t.reviewer)))or app_private.intake_client_status(cur.policy,target)not in('confirmed','provisional')then raise exception 'client_not_known'using errcode='42501';end if;
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
  m:=app_private.intake_client_record(cur.id,cur.source_id,cur.policy,cur.organizer,cur.participants,'known','mapped',target,'human','Client chosen by '||a.actor,cur.evidence,cur.coverage,cur.suggestion,who);
 elsif action='confirm_new'then
  if cur.state='mapped'and app_private.intake_client_status(cur.policy,cur.client)='provisional'then
   -- Second step: the provisional client is confirmed, which allows client-scoped material later.
   nm:=coalesce(nullif(btrim(payload->>'name'),''),(select display_name from app_private.intake_clients where policy=cur.policy and client=cur.client));
   update app_private.intake_clients set status='confirmed',display_name=left(nm,200),decided_by=who,decided_at=clock_timestamp()where policy=cur.policy and client=cur.client;
   for em in select i.email from app_private.intake_client_identities i where i.policy=cur.policy and i.client=cur.client and i.superseded_at is null and i.status='provisional'loop
    update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
    insert into app_private.intake_client_identities(policy,client,email,status,source,decided_by,evidence)values(cur.policy,cur.client,em,'confirmed','human',who,jsonb_build_object('mapping',cur.id));
   end loop;
   insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(cur.policy,cur.source_id,cur.id,cur.client,'client_confirmed',who,'{}');
   return jsonb_build_object('ok',true,'mapping',cur.id,'client',cur.client,'status','confirmed');
  end if;
  -- First step, explicit and human only: a Held call becomes a NEW provisional client (shared
  -- method material only until confirmed). Never inferred from absent evidence.
  if cur.state<>'held'or cardinality(chosen)=0 then raise exception 'client_mapping_emails_invalid';end if;
  nm:=btrim(coalesce(payload->>'name',''));
  if length(nm)<2 or length(nm)>200 or app_private.intake_slug(nm)=''then raise exception 'client_name_required';end if;
  key:=app_private.intake_slug(nm);
  if key=any(app_private.intake_known_clients(cur.policy,t.reviewer))then raise exception 'client_exists_choose_existing'using errcode='PT409';end if;
  while exists(select 1 from app_private.intake_clients where client=key)or exists(select 1 from app_private.workspace_clients where client=key)loop n:=n+1;key:=app_private.intake_slug(nm)||'-'||n;end loop;
  insert into app_private.intake_clients(policy,client,status,display_name,company,created_by,evidence)values(cur.policy,key,'provisional',nm,nullif(btrim(coalesce(payload->>'company','')),''),who,jsonb_build_object('mapping',cur.id,'emails',to_jsonb(chosen)));
  foreach em in array chosen loop
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
   insert into app_private.intake_client_identities(policy,client,email,status,source,decided_by,evidence)values(cur.policy,key,em,'provisional','human',who,jsonb_build_object('mapping',cur.id));
  end loop;
  insert into app_private.workspace_clients(actor,client,active)values(t.reviewer,key,true);
  insert into app_private.intake_client_events(policy,source_id,mapping_id,client,event,actor,detail)values(cur.policy,cur.source_id,cur.id,key,'provisional_client_created',who,jsonb_build_object('reviewerAccess',t.reviewer));
  m:=app_private.intake_client_record(cur.id,cur.source_id,cur.policy,cur.organizer,cur.participants,'new','mapped',key,'human','New client confirmed by '||a.actor,cur.evidence,cur.coverage,cur.suggestion,who);
 else
  if cardinality(chosen)=0 then raise exception 'client_mapping_emails_invalid';end if;
  foreach em in array chosen loop
   insert into app_private.intake_internal_people(policy,kind,value,active,decision_reference,decided_by)values(cur.policy,'email',em,true,'board decision by '||a.actor||' on mapping '||cur.id,who)
   on conflict(policy,kind,value)do update set active=true;
   update app_private.intake_client_identities set superseded_at=clock_timestamp()where policy=cur.policy and email=em and superseded_at is null;
  end loop;
  insert into app_private.intake_client_events(policy,source_id,mapping_id,event,actor,detail)values(cur.policy,cur.source_id,cur.id,'marked_internal',who,jsonb_build_object('emails',to_jsonb(chosen)));
  -- Held until the next scan re-resolves this call with fresh collector facts and coverage.
  m:=app_private.intake_client_record(cur.id,cur.source_id,cur.policy,cur.organizer,cur.participants,'ambiguous','held',null,'none','Re-checking after '||array_to_string(chosen,', ')||' marked internal by '||a.actor,cur.evidence,cur.coverage,'{}'::jsonb,who);
 end if;
 perform app_private.intake_client_apply(cur.source_id,cur.policy,m,who);
 -- Release: the next tick runs this call through the normal path. Nothing is extracted here.
 update app_private.intake_source_work set due_at=clock_timestamp()where source_id=cur.source_id and policy=cur.policy;
 return jsonb_build_object('ok',true,'mapping',m.id,'state',m.state,'client',m.client);
end$$;

-- Drafting privacy boundary, layer 1 (save time): a provisional or merged client can never be
-- given a client-work directory, nor client-history or client-scoped supplemental evidence.
create function app_private.intake_client_request_status(rid uuid)returns text language sql stable security definer set search_path='' as $$
 select ic.status from public.requests q join app_private.meeting_items mi on mi.request_id=q.id join app_private.meetings m on m.source_id=mi.source_id
  join app_private.intake_clients ic on ic.policy=m.policy and ic.client=q.client where q.id=rid;
$$;
create function app_private.task_document_provisional_guard()returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.asset_release is null or jsonb_typeof(new.asset_release->'clientDirectories')<>'array'or jsonb_array_length(new.asset_release->'clientDirectories')=0 then return new;end if;
 if app_private.intake_client_request_status(new.request_id)in('provisional','merged')then raise exception 'provisional_client_shared_roots_only'using errcode='42501';end if;
 return new;
end$$;
create trigger task_document_provisional_guard before insert or update of asset_release on app_private.task_documents for each row execute function app_private.task_document_provisional_guard();
create function app_private.task_document_evidence_provisional_guard()returns trigger language plpgsql security definer set search_path='' as $$
begin
 if(new.kind='client_history'or new.client is not null)and app_private.intake_client_request_status((select request_id from app_private.task_documents where id=new.document_id))in('provisional','merged')
  then raise exception 'provisional_client_shared_method_only'using errcode='42501';end if;
 return new;
end$$;
create trigger task_document_evidence_provisional_guard before insert or update on app_private.task_document_evidence for each row execute function app_private.task_document_evidence_provisional_guard();

-- Layer 2 (packet assembly): the 028 packet, wrapped. Unchanged for a confirmed, current client.
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
  -- R11-4: only the reviewed source commitment plus shared method material (method / example
  -- with no client) may reach a provisional client's draft.
  if exists(select 1 from jsonb_array_elements(coalesce(result->'entries','[]'))x where coalesce(x->>'kind','')not in('commitment','method','example')or(x->>'kind'='commitment'and x->>'id'<>'commitment'))
   or exists(select 1 from app_private.task_document_evidence e where e.document_id=did and(e.kind='client_history'or e.client is not null))
   then raise exception 'provisional_client_shared_method_only'using errcode='42501';end if;
  result:=jsonb_set(result,'{missingContext}',coalesce(result->'missingContext','[]')||jsonb_build_array('This client is new and not yet confirmed, so the draft uses shared Atlas method material only.'));
 end if;
 return result;
end$$;

do $$declare t text;f regprocedure;begin
 foreach t in array array['intake_clients','intake_client_identities','intake_client_mappings','intake_internal_people','intake_shared_domains','intake_client_resolvers','intake_client_events','intake_redaction_counts']loop
  execute format('alter table app_private.%I enable row level security',t);execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',t);
 end loop;
 foreach f in array array['app_private.intake_personal_domains()','app_private.intake_slug(text)','app_private.intake_client_supersede_only()','app_private.intake_client_transition()',
  'app_private.intake_known_clients(text,text)','app_private.intake_client_status(text,text)','app_private.intake_client_static_overlap(text,text,app_private.intake_metadata)',
  'app_private.intake_client_coverage_gap(jsonb)','app_private.intake_client_decide(text,text,text,text,text[],jsonb,jsonb,boolean)',
  'app_private.intake_client_record(uuid,text,text,text,text[],text,text,text,text,text,jsonb,jsonb,jsonb,text)',
  'app_private.intake_client_resolve(text,text,app_private.intake_scope_rules,app_private.intake_metadata,jsonb,jsonb)',
  'app_private.intake_rule_for(text,text)','app_private.intake_rule_for_v026(text,text)','app_private.intake_client_bind(text,text,app_private.intake_client_mappings)',
  'app_private.intake_client_after_scan(text,text,jsonb)','app_private.intake_client_apply(text,text,app_private.intake_client_mappings,text)',
  'app_private.meeting_intake_operational_v026(text,jsonb)','app_private.intake_client_can_resolve(text,text)','public.meeting_client_mapping(text,jsonb)',
  'app_private.intake_client_request_status(uuid)','app_private.task_document_provisional_guard()','app_private.task_document_evidence_provisional_guard()',
  'app_private.task_document_packet(uuid,text,text)','app_private.task_document_packet_v028(uuid,text,text)']::regprocedure[]loop
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
