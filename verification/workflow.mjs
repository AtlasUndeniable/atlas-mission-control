import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{readFileSync,writeFileSync}from'node:fs';import{rpc,sql,jlit}from'./harness.mjs';import{randomUUID,createHash}from'node:crypto';
const f=JSON.parse(readFileSync(new URL('./private/fixture.json',import.meta.url))),base='http://127.0.0.1:55827',checks=[];
const check=(x,n)=>{assert.ok(x,n);checks.push(n);console.log('PASS',n)};
async function request(actor,path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(actor+':synthetic-'+actor).toString('base64'),...(body?{'Content-Type':'application/json',Origin:base}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();return{status:r.status,data}}
const shot=(name,actor='nat',version='0',mobile='0')=>{if(process.env.SCREENSHOTS==='1')execFileSync('node',['verification/screenshot.mjs',f.task,actor,name,version,mobile],{stdio:'inherit'})};
const url='/api/board/meetings/document?taskId='+f.task;let state=(await request('nat',url)).data;
check(state.available&&state.status==='ready','Accepted canonical task opens explicit working context');shot('01-ready');
const build={taskId:f.task,action:'build',revision:state.revision,operationId:randomUUID()};let r=await request('nat','/api/board/meetings/document',build);check(r.status===200,'Built app generates v1 with synthetic provider');
state=(await request('nat',url)).data;check(state.status==='draft'&&state.currentVersion===1,'Generation produces draft, not canonical completion');
let v1=(await request('nat',url+'&version=1')).data;check(createHash('sha256').update(v1.content).digest('hex')===v1.hash,'v1 exact bytes/hash verified');shot('02-v1','nat','1');check(!v1.content.includes('FINANCIAL_'),'Generated permitted content excludes private financial source');
const count=async()=>(await(await fetch('http://127.0.0.1:55826/control')).json()).calls;
const calls=await count();await request('nat','/api/board/meetings/document',build);check(await count()===calls,'Duplicate build reuses publication without provider reinvocation');
check(sql(`select work_status from public.tasks where id='${f.task}'`)==='todo','Generated draft leaves canonical task todo');
async function action(actor,action,note){const s=(await request(actor,url)).data;const version=s.versions.find(v=>v.version===s.currentVersion);const body={taskId:f.task,action,revision:s.revision,version:version.version,hash:version.hash,note,operationId:randomUUID()};return{body,...await request(actor,'/api/board/meetings/document',body)}}
r=await action('nat','handoff','Synthetic v1 is ready for the named reviewer to inspect.');check(r.status===200,'Exact v1 handed to required reviewer');check(sql(`select work_status from public.tasks where id='${f.task}'`)==='needs_review','Canonical meeting task reflects reviewer handoff');
let bad=await action('nat','review','Synthetic attempt to bypass Rhys required review.');check(bad.status===403,'Nat cannot accept her own handed-off work');
r=await action('rhys','revise','Replace step two with weekly escalation of unassigned steps and explicit reviewer confirmation.');check(r.status===200,'Reviewer substantive correction recorded');
state=(await request('nat',url)).data;check(state.status==='needs_revision'&&state.currentVersion===1&&state.revision===2,'v1 retained while correction opens generation revision2');shot('03-correction','nat','1');
check(sql(`select work_status from public.tasks where id='${f.task}'`)==='todo','Canonical correction returns task to executor');
r=await request('nat','/api/board/meetings/document',{taskId:f.task,action:'build',revision:2,operationId:randomUUID()});check(r.status===200,'Corrected v2 generated');
const v2=(await request('nat',url+'&version=2')).data;check(v2.content.includes('At the weekly review, escalate')&&v2.hash!==v1.hash,'Substantive correction changes the procedure, not just a feedback appendix');shot('04-v2','nat','2');shot('05-v2-mobile','nat','2','1');
check((await request('nat',url+'&version=1')).data.content===v1.content,'v1 bytes remain intact after v2');
check(sql(`select count(*)from app_private.task_document_attempts a join app_private.task_documents d on d.id=a.document_id where d.task_id='${f.task}'`)==='2','Exactly two invocation reservations for v1/v2');
const did=sql(`select id from app_private.task_documents where task_id='${f.task}'`);
let refused=false;try{sql(`begin;update app_private.task_document_versions set content='Tampered'where document_id='${did}';rollback;`)}catch(e){refused=String(e.stderr).includes('immutable_task_history')}check(refused,'Version mutation rejected by immutable trigger');
// Output revocation blocks download, even previously successful exact version.
let revoked=false;try{sql(`begin;update app_private.task_document_grants set active=false where document_id='${did}'and actor='nat';set local role atlas_meeting_nat_web;select public.meeting_document('artifact','${f.task}','{"version":1}');rollback;`)}catch(e){revoked=String(e.stderr).includes('document_denied')}check(revoked,'Revocation blocks old-version output (transaction rolled back after test)');
r=await action('nat','handoff','Synthetic corrected v2 is ready with an observable escalation step.');check(r.status===200,'v2 exact reviewer handoff works');shot('06-reviewer-handoff','rhys','2');
const saved=r.body;check((await request('nat','/api/board/meetings/document',saved)).status===200,'Lost handoff response can replay without a second canonical transition');
r=await action('rhys','review','Synthetic acceptance: the revised procedure now has an explicit weekly escalation and completion check.');check(r.status===200,'Required reviewer accepts exact v2');
state=(await request('nat',url)).data;check(state.status==='accepted'&&sql(`select work_status from public.tasks where id='${f.task}'`)==='completed','Truthful internal completion follows reviewer decision only');
check(sql(`select state from public.tasks where id='${f.task}'`)==='queued','Internal completion never fabricates external delivered state');
check(await count()===calls+1,'Status, revision, handoff and acceptance never resend or reinvoke generation');
check(state.versions.length===2,'Both immutable versions remain accessible to current permitted audience');shot('07-accepted','nat','2');
writeFileSync(new URL('../evidence/workflow.json',import.meta.url),JSON.stringify({synthetic:true,provider:'loopback fixture only',task:f.task,checks,v1Hash:v1.hash,v2Hash:v2.hash,liveUsefulnessProven:false},null,2)+'\n');
