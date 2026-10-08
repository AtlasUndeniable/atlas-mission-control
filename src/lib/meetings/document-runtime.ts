import {createHash} from 'node:crypto';
import {WorkspaceRefusal} from '../workspace-authority';
import {documentTransport,documentPrompt,decodeDocumentResponse,renderDocument,type DocumentConfig} from '../task-document-codec';
export async function documentRpc(principal:string,action:string,taskId:string,payload:object={}){
 if(process.env.ATLAS_TASK_DOCUMENTS!=='1')throw new WorkspaceRefusal(503,'Task drafting is held. Required task, context, output and operating decisions are not enabled.');
 const c=JSON.parse(process.env.ATLAS_MEETING_TRANSPORT||'{}');
 if(!c.url||!c.principals?.[principal])throw new WorkspaceRefusal(403,'Named task access is unavailable.');
 return rpc(c.url,c.apiKey,c.principals[principal],'meeting_document',{action,task_id:taskId,payload});
}
async function rpc(url:string,key:string|undefined,token:string,name:string,body:object){
 if(new URL(url).hostname.endsWith('.supabase.co')&&!key)throw new WorkspaceRefusal(503,'Hosted gateway configuration is missing.');
 const r=await fetch(url.replace(/\/$/,'')+'/rpc/'+name,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{apikey:key}:{})},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(15000)});
 const d=await r.json();if(!r.ok)throw new WorkspaceRefusal(d.code==='42501'?403:d.code==='PT409'?409:400,d.code==='42501'?'This task operation is not permitted.':d.code==='PT409'?'Task authority, context or version changed, or a prior generation outcome is unresolved. Reopen the task; do not retry generation blindly.':'Task operation was refused. No completion or send is implied.');return d;
}
export async function buildTaskDocument(principal:string,taskId:string,payload:{operationId:string;revision:number}){
 let config:DocumentConfig,transport:ReturnType<typeof documentTransport>;const runtime=JSON.parse(process.env.ATLAS_TASK_DOCUMENT_RUNTIME||'{}');
 try{config=JSON.parse(process.env.ATLAS_TASK_DOCUMENT_CONFIG||'{}');transport=documentTransport(config,fetch,process.env);if(!runtime.url||!runtime.token)throw Error();}catch{throw new WorkspaceRefusal(503,'Generation is disabled until its task-specific provider, budget and runtime decisions are recorded.');}
 const runtimeRpc=(action:string,attempt:string,payload:object={})=>rpc(runtime.url,runtime.apiKey,runtime.token,'meeting_document_runtime',{action,attempt_id:attempt,payload});
 const reserved=await documentRpc(principal,'begin',taskId,{...payload,configurationHash:transport.configurationHash});
 if(!reserved.available&&reserved.reason)throw new WorkspaceRefusal(409,reserved.reason);
 if(!reserved.dispatch){
  if(['recorded','published'].includes(reserved.state))return runtimeRpc('recover',reserved.attempt);
  throw new WorkspaceRefusal(409,'Generation outcome is uncertain or cancelled. Its invocation is retained; status checks do not call the provider again.');
 }
 const bound={token:reserved.token};
 try{
  const prompt=documentPrompt(reserved.packet,reserved.revisionNote||null,reserved.previous||null);
  if(prompt.length>config.maxPromptCharacters)throw new WorkspaceRefusal(409,'The permitted packet exceeds its prompt budget.');
  await runtimeRpc('check',reserved.attempt,{...bound,promptHash:createHash('sha256').update(prompt).digest('hex')});
  const response=await transport.invoke(prompt,reserved.attempt);
  let content:string;
  try{content=renderDocument(decodeDocumentResponse(response,config.codec),reserved.packet,reserved.revisionNote||null,config.mode==='injected');}
  catch{await runtimeRpc('invalid',reserved.attempt,{...bound,response});throw new WorkspaceRefusal(409,'The provider response did not satisfy the document contract. It is retained privately; no automatic retry.');}
  await runtimeRpc('record',reserved.attempt,{...bound,response,content});
  return await runtimeRpc('publish',reserved.attempt,bound);
 }catch(e){if(e instanceof WorkspaceRefusal)throw e;throw new WorkspaceRefusal(409,'Generation outcome is unresolved. Reopen the task to reconcile saved status. Checking status never generates again.');}
}
