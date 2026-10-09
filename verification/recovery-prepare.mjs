import{createHash}from'node:crypto';
import assert from'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{sql,rpc}from'./harness.mjs';import{documentTransport,documentPrompt,renderDocument}from'../src/lib/task-document-codec.ts';import{taskAssetEntries,assetDigest,assetRelease}from'../src/lib/meetings/document-runtime.ts';import{atlasAssetRoots}from'../src/lib/task-asset-search.ts';
const base='http://127.0.0.1:55827',checks=[];const check=(x,n)=>{assert.ok(x,n);checks.push(n);console.log('PASS',n)};
const seed=name=>{execFileSync('node',['verification/seed.mjs'],{env:{...process.env,SYNTHETIC_CALL:name+(process.env.FIXTURE_SUFFIX||'')},stdio:'pipe'});return JSON.parse(readFileSync('verification/private/fixture.json'))};
async function request(f,action,revision=1){const r=await fetch(base+'/api/board/meetings/document',{method:'POST',headers:{Authorization:'Basic '+Buffer.from('nat:synthetic-nat').toString('base64'),Origin:base,'Content-Type':'application/json'},body:JSON.stringify({taskId:f.task,action,revision,operationId:crypto.randomUUID()})});return{status:r.status,data:await r.json()}}
const mode=async m=>fetch('http://127.0.0.1:55826/control',{method:'POST',body:JSON.stringify({mode:m})});const count=async()=>(await(await fetch('http://127.0.0.1:55826/control')).json()).calls;
const lost=seed('synthetic-doc-lost');await mode('lost');let n=await count();check((await request(lost,'build')).status===409,'Lost provider response leaves outcome unresolved');check(await count()===n+1,'One provider dispatch occurred');
check((await request(lost,'build')).status===409&&await count()===n+1,'Retry after unknown dispatch is held without provider call');
const attempt=JSON.parse(sql(`select row_to_json(a)from app_private.task_document_attempts a join app_private.task_documents d on d.id=a.document_id where d.task_id='${lost.task}'`));
sql(`update app_private.task_document_attempts set deadline=clock_timestamp()-interval '1 second'where id='${attempt.id}'`);
const state=await rpc('nat','meeting_document',{action:'read',task_id:lost.task,payload:{}});check(state.data.status==='uncertain','Expired response window shows uncertain state');
check((await request(lost,'cancel')).status===200,'Cancellation stops publication without replenishing budget');
check((await rpc('runtime','meeting_document_runtime',{action:'record',attempt_id:attempt.id,payload:{token:attempt.token,response:{late:true},content:'Late content '.repeat(20)}})).status===409,'Late response after cancellation cannot publish');
check((await request(lost,'build')).status===409&&await count()===n+1,'Cancelled attempt never reinvokes');
await mode('normal');const saved=seed('synthetic-doc-recorded');
const reserve=(await rpc('nat','meeting_document',{action:'begin',task_id:saved.task,payload:{operationId:crypto.randomUUID(),revision:1,configurationHash:saved.configurationHash}})).data;
const transport=documentTransport(saved.config,fetch,{});
// Mirror buildTaskDocument: retrieve the released assets, hydrate the packet, and bind the
// prompt hash, the exact asset set and the worst-case charge together, as migration 028
// requires of every dispatch. Binding only the prompt hash would no longer be accepted.
const assets=await taskAssetEntries(assetRelease(reserve.packet.assetRelease),reserve.packet,atlasAssetRoots(saved.config.assetBrain));
const hydrated={...reserve.packet,entries:[...reserve.packet.entries,...assets.entries],missingContext:[...reserve.packet.missingContext,...assets.notes]};
const prompt=documentPrompt(hydrated,null,null);
check((await rpc('runtime','meeting_document_runtime',{action:'check',attempt_id:reserve.attempt,payload:{token:reserve.token,promptHash:createHash('sha256').update(prompt).digest('hex'),assetDigest:assetDigest(assets.entries),costBound:{requestBytes:Buffer.byteLength(prompt,'utf8'),micros:0,maxOutputTokens:saved.config.maxOutputTokens}}})).status===200,'Exact prompt hash bound once before dispatch');const response=await transport.invoke(prompt,reserve.attempt);const content=renderDocument(response,hydrated,null,true);
check((await rpc('runtime','meeting_document_runtime',{action:'record',attempt_id:reserve.attempt,payload:{token:reserve.token,response,content}})).status===200,'Provider response recorded before simulated lost acknowledgment/process stop');
check((await rpc('nat','meeting_document',{action:'read',task_id:saved.task,payload:{}})).data.recoverable,'Recorded response exposes recovery, not another dispatch');
const runtimeCount=await count();writeFileSync('verification/private/recovery.json',JSON.stringify({saved,lost,calls:runtimeCount,checks},null,2));writeFileSync('evidence/recovery-before-restart.json',JSON.stringify({synthetic:true,checks,recordedTask:saved.task,unknownTask:lost.task},null,2)+'\n');
