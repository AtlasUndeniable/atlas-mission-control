import assert from'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{sql,rpc,jlit}from'./harness.mjs';
const f=JSON.parse(readFileSync(new URL('./private/fixture.json',import.meta.url))),checks=[];
const check=(v,n)=>{assert.ok(v,n);checks.push(n)};
const did=sql(`select id from app_private.task_documents where task_id='${f.task}'`);
const read=`select public.meeting_document('read','${f.task}','{}');`;
function denied(setup,expected,query=read,role='atlas_meeting_nat_web'){
 let e;try{sql(`begin;${setup};set local role ${role};${query};rollback;`)}catch(x){e=x}assert.ok(e,'Expected refusal');assert.match(String(e.stderr||e.message),expected);checks.push('Denied: '+expected.source);
}
const d=await rpc('nat','meeting_document',{action:'read',task_id:f.task,payload:{}});check(d.status===200&&d.data.available,'Explicitly granted limited context works');check(!JSON.stringify(d).includes('FINANCIAL_'),'No raw financial source/title/history leaks');
check((await rpc('outsider','meeting_document',{action:'read',task_id:f.task,payload:{}})).status===403,'Another actor cannot read same task document');
check((await rpc('nat','meeting_queue',{action:'context',payload:{sourceId:f.sourceId}})).status===403,'Nat full source remains refused');
denied(`update app_private.task_document_grants set active=false where document_id='${did}'and actor='nat'`,/document_denied/);
denied(`update app_private.task_document_grants set rights=array['context']where document_id='${did}'and actor='nat'`,/document_denied/);
denied(`update app_private.task_documents set enabled=false where id='${did}'`,/document_unavailable/);
denied(`update app_private.meeting_task_grants set active=false where request_id='${f.rid}'`,/document_context_changed/);
denied(`update app_private.workspace_clients set active=false where actor='nat'`,/document_context_changed/);
denied(`insert into public.intake_source_versions(source_id,revision,raw)select source_id,'changed-source',raw from public.intake_source_versions where source_id='${f.sourceId}'limit 1;update public.intake_sources set revision='changed-source'where source_id='${f.sourceId}'`,/document_context_changed/);
denied(`update app_private.meeting_items set revision=revision+1 where request_id='${f.rid}'`,/document_context_changed/);
denied(`update app_private.meeting_reviewers set can_review=false where actor='rhys'`,/reviewer_unavailable/);
denied(`update app_private.workspace_actors set active=false where actor='nat'`,/workspace_access_denied|document_denied/);
denied('',/permission denied/,`update public.tasks set title='Bypass'where id='${f.task}';`);
denied('',/permission denied/,`select app_private.meeting_queue_v21('list','{}');`);
check((await rpc('nat','meeting_queue',{action:'complete',payload:{id:f.rid,sourceId:f.sourceId,revision:999,operationId:crypto.randomUUID(),note:'Generic completion bypass'}})).status===409,'Generic completion cannot bypass exact document handoff');
denied('',/permission denied/,`select public.meeting_document_runtime('check','${crypto.randomUUID()}','{}');`);
// Every supplemental source is a current classified, displayable, explicitly released version.
const sourceSetup=`
do $$declare feed uuid;note uuid;ver uuid;begin
 insert into public.projection_feeds(id,logical_name,adapter_version,policy_version,vault_root_fingerprint,journal_root_fingerprint)values(extensions.gen_random_uuid(),'synthetic-extra','fixture','fixture',repeat('a',64),repeat('b',64))returning id into feed;
 insert into public.memory_notes(feed_id,source_path,current_source_hash,title,body,project_id,scope,sensitivity,source_class,classification_state,review_state,parser_profile,classification_profile,chunk_profile,embedding_profile,classification_decision_hash)values(feed,'Synthetic.md',repeat('c',64),'Synthetic permitted history','A safe onboarding method.','10000000-0000-4000-8000-000000000001','ops','standard','workspace_knowledge','classified','approved','fixture','fixture','fixture','fixture',repeat('d',64))returning id into note;
 insert into public.memory_note_versions(memory_note_id,version_key,source_content_hash,parser_profile,classification_profile,chunk_profile,embedding_profile,project_id,scope,sensitivity,source_class,review_evidence_version,publication_state,classification_decision_hash)values(note,repeat('e',64),repeat('c',64),'fixture','fixture','fixture','fixture','10000000-0000-4000-8000-000000000001','ops','standard','workspace_knowledge','fixture','current',repeat('d',64))returning id into ver;
 update public.memory_notes set current_version_id=ver,retrieval_enabled=true where id=note;
 insert into app_private.task_document_evidence(document_id,note_id,version_id,source_hash,classification_hash,kind,client,use_allowed,display_allowed,active,decision_reference)values('${did}',note,ver,repeat('c',64),repeat('d',64),'client_history','fixture-alpha',true,true,true,'Synthetic source-specific review');end$$;`;
const good=sql(`begin;${sourceSetup}set local role atlas_meeting_nat_web;${read}rollback;`);check(good.includes('A safe onboarding method.'),'Supplemental permitted history is usable');
for(const [change,error]of[
 ["update public.memory_notes set sensitivity='internal_financial'",/financial_output_denied/],
 ["update public.memory_notes set retrieval_enabled=false,exposure_mode='usable_not_visible'",/evidence_denied_or_stale/],
 ["update public.memory_notes set content_class='deep_ip'",/evidence_denied_or_stale/],
 ["update public.memory_notes set classification_decision_hash=repeat('f',64)",/evidence_denied_or_stale/],
 ["update public.memory_note_versions set publication_state='withdrawn'",/evidence_denied_or_stale/],
 ["update public.memory_notes set last_source_observed_at=now()-interval '15 days'",/evidence_denied_or_stale/],
 ["update app_private.task_document_evidence set client='other-client'",/evidence_denied_or_stale/],
 ["update app_private.task_document_evidence set display_allowed=false",/evidence_denied_or_stale/]
])denied(sourceSetup+change,error);
writeFileSync(new URL('../evidence/permissions.json',import.meta.url),JSON.stringify({synthetic:true,checks},null,2)+'\n');console.log(JSON.stringify({checks:checks.length}));
