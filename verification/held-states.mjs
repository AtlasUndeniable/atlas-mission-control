import{execFileSync}from'node:child_process';import{readFileSync,writeFileSync}from'node:fs';import{sql,rpc,jlit}from'./harness.mjs';import{randomUUID}from'node:crypto';import assert from'node:assert/strict';
const original=readFileSync(new URL('./private/fixture.json',import.meta.url));const fixtures={};
for(const [name,kind]of[['synthetic-doc-unconfigured','held'],['synthetic-doc-unresolved','uncertain']]){
 execFileSync('node',['verification/seed.mjs'],{env:{...process.env,SYNTHETIC_CALL:name},stdio:'pipe'});const f=JSON.parse(readFileSync(new URL('./private/fixture.json',import.meta.url)));fixtures[kind]=f.task;
 if(kind==='held'){sql(`delete from app_private.task_document_grants where false;delete from app_private.task_document_evidence where false;update app_private.task_documents set enabled=false where task_id='${f.task}';`);assert.equal((await rpc('nat','meeting_document',{action:'read',task_id:f.task,payload:{}})).status,403)}else{
 const a=await rpc('nat','meeting_document',{action:'begin',task_id:f.task,payload:{operationId:randomUUID(),revision:1,configurationHash:f.configurationHash}});assert.equal(a.status,200);sql(`update app_private.task_document_attempts set deadline=clock_timestamp()-interval '1 second'where id='${a.data.attempt}';`);assert.equal((await rpc('nat','meeting_document',{action:'read',task_id:f.task,payload:{}})).data.status,'uncertain');
 }
 execFileSync('node',['verification/screenshot.mjs',f.task,'nat',kind==='held'?'11-disabled-task':'12-uncertain'],{stdio:'inherit'});
}
writeFileSync(new URL('./private/fixture.json',import.meta.url),original);writeFileSync(new URL('../evidence/held-states.json',import.meta.url),JSON.stringify({synthetic:true,fixtures,checks:['Disabled task refuses context','Expired reservation shows uncertain without dispatch'],uncertainFixture:'Reservation deadline advanced locally; no provider dispatch for screenshot'},null,2)+'\n');
