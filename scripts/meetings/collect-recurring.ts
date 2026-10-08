import {intakeJSON}from '../../src/lib/meetings/intake-http.ts';
import {readFile,stat}from'node:fs/promises';import{pathToFileURL}from'node:url';
import {firefliesCatalog}from'../../src/lib/meetings/fireflies.ts';
import {type Rpc}from'../../src/lib/meetings/intake-core.ts';
import {intakeTick,sweep,processMeeting}from'../../src/lib/meetings/recurring-intake.ts';
import {vertexExtractor,googleToken}from'../../src/lib/meetings/vertex-extractor.ts';
export async function collect(file:string,catchUp=false,reprocess?:{sourceId:string;authorizationId:string}){
 if((await stat(file)).mode&0o077)throw Error('Owner-only configuration required');
 const config=JSON.parse(await readFile(file,'utf8'));
 if(config.enabled!==true||config.mode!=='reviewed-live'||!config.operatorDecision||!config.scopeDecision||!config.provider?.disclosureDecision||!config.provider?.budgetDecision)throw Error('Intake disabled or activation decisions missing');
 if(!Number.isInteger(config.timeoutMs)||config.timeoutMs<1000||config.timeoutMs>60000)throw Error('Bounded timeout required');
 if(!config.rpcUrl?.endsWith('/rpc/meeting_intake_operational')||new URL(config.rpcUrl).protocol!=='https:')throw Error('Scoped TLS operational RPC required');
 if((await stat(config.secretsFile)).mode&0o077)throw Error('Owner-only credentials required');
 const secrets=JSON.parse(await readFile(config.secretsFile,'utf8'));
 if(!secrets.firefliesKey||!secrets.ingestionToken||!secrets.gatewayKey||!secrets.providerCredentialsFile)throw Error('Explicit scoped credentials required');
 const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);const limit=setTimeout(stop,8*60000);
 let lease:string|undefined;
 const rpc:Rpc=async(action,payload)=>{const r=await fetch(config.rpcUrl,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+secrets.ingestionToken,apikey:secrets.gatewayKey,'Content-Type':'application/json'},body:JSON.stringify({action,payload:{...payload,lease,catchUp}}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Scoped intake refused');return await intakeJSON(r)as Record<string,unknown>};
 try{
  const policy=await rpc('configuration',{});
  if(policy.policy!==config.policy||policy.accountId!==config.accountId||Number(policy.interval_seconds)!==config.recurring.intervalSeconds||Date.parse(String(policy.operatingStart))!==Date.parse(config.recurring.startsAt)||Date.parse(String(policy.operatingEnd))!==Date.parse(config.recurring.endsAt))throw Error('Operational policy mismatch');
  const extractor=vertexExtractor(config.provider,googleToken(secrets.providerCredentialsFile),fetch,async attempt=>{await rpc('disclosure',{attempt})});
  if(extractor.configurationHash!==policy.configuration_hash)throw Error('Provider configuration not approved');
  const acquired=await rpc('acquire',{});if(acquired.acquired!==true)return {state:'not_due_or_other_collector'};lease=String(acquired.lease);
  const catalog=firefliesCatalog(secrets.firefliesKey,controller.signal,config.accountId);
  if(reprocess){const row=await rpc('source_metadata',{id:reprocess.sourceId});await processMeeting(catalog,rpc,extractor,row as never,{timeoutMs:config.timeoutMs,signal:controller.signal,refreshMetadata:true},reprocess.authorizationId);return {state:'reprocessing_checked; inspect durable attempt outcome'};}
  if(catchUp){if(config.catchUp?.enabled!==true||Date.parse(config.catchUp.startsAt)!==Date.parse(String(policy.catchupStart))||Date.parse(config.catchUp.endsAt)!==Date.parse(String(policy.catchupEnd)))throw Error('Catch-up separately unapproved');const pending=await rpc('pending_run',{});return await sweep(catalog,rpc,extractor,{enabled:true,start:config.catchUp.startsAt,end:config.catchUp.endsAt,run:pending.run?String(pending.run):undefined,maxSources:config.maxSources,maxPages:config.maxPages,timeoutMs:config.timeoutMs,signal:controller.signal});}
  return await intakeTick(catalog,rpc,extractor,{...config.recurring,maxSources:config.maxSources,maxPages:config.maxPages,timeoutMs:config.timeoutMs},controller.signal);
 }finally{if(lease)try{await rpc('release',{})}catch{/* Lease expires; no attempt is re-dispatched. */}clearTimeout(limit);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(!process.argv[2])throw Error('Provide explicit reviewed configuration');try{const index=process.argv.indexOf('--reprocess');let reprocess;if(index!==-1){const sourceId=process.argv[index+1],authorizationId=process.argv[index+2];if(!/^[A-Za-z0-9_-]{1,180}$/.test(sourceId||'')||!/^[a-f0-9-]{36}$/.test(authorizationId||''))throw Error('Exact source and one-use authorization required');reprocess={sourceId,authorizationId};}const r=await collect(process.argv[2],process.argv.includes('--catch-up'),reprocess);console.log(JSON.stringify({event:'intake_tick_finished',...r}))}catch{console.error('Intake tick held/failed; inspect permitted coverage and durable run/attempt records.');process.exitCode=1}}
