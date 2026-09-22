import assert from'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{rpc,sql}from'./harness.mjs';
const saved=JSON.parse(readFileSync('verification/private/recovery.json')),checks=saved.checks;const base='http://127.0.0.1:55827';
const check=(x,n)=>{assert.ok(x,n);checks.push(n);console.log('PASS',n)};
const before=await rpc('nat','meeting_document',{action:'read',task_id:saved.saved.task,payload:{}});check(before.status===200&&before.data.recoverable,'Recorded response survives database/PostgREST/app restart');
const r=await fetch(base+'/api/board/meetings/document',{method:'POST',headers:{Authorization:'Basic '+Buffer.from('nat:synthetic-nat').toString('base64'),Origin:base,'Content-Type':'application/json'},body:JSON.stringify({taskId:saved.saved.task,action:'build',operationId:crypto.randomUUID(),revision:1})});const result=await r.json();check(r.status===200,'Built route reconciles retained response after restart');
const count=(await(await fetch('http://127.0.0.1:55826/control')).json()).calls;check(count===saved.calls,'Recovery makes no second provider call');
const after=await rpc('nat','meeting_document',{action:'read',task_id:saved.saved.task,payload:{}});check(after.data.status==='draft'&&after.data.currentVersion===1,'Recovered result is a draft, not completion');
check((await rpc('nat','meeting_document',{action:'read',task_id:saved.lost.task,payload:{}})).data.status==='cancelled','Cancelled/unknown history survives restart');
// Revocation followed by restoration permanently fences the earlier version/attempt.
const did=sql(`select id from app_private.task_documents where task_id='${saved.saved.task}'`);const epoch=Number(sql(`select authorization_epoch from app_private.task_documents where id='${did}'`));
sql(`update app_private.task_document_grants set active=false where document_id='${did}'and actor='nat';update app_private.task_document_grants set active=true where document_id='${did}'and actor='nat';`);
check(Number(sql(`select authorization_epoch from app_private.task_documents where id='${did}'`))===epoch+2,'Revoke/restore increments retained authorization epochs');
check((await rpc('nat','meeting_document',{action:'artifact',task_id:saved.saved.task,payload:{version:1}})).status===409,'Regrant cannot revive output under old authority fingerprint');
writeFileSync('evidence/recovery.json',JSON.stringify({synthetic:true,realProcessRestart:true,providerResponses:'synthetic only',checks,providerCallsBeforeRestart:saved.calls,providerCallsAfterRecovery:count},null,2)+'\n');
