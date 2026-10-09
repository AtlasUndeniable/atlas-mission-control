import {createHash} from 'node:crypto';
import {WorkspaceRefusal} from '../workspace-authority.ts';
import {documentTransport,documentPrompt,decodeDocumentResponse,renderDocument,type DocumentConfig,type DocumentEntry,type DocumentPacket} from '../task-document-codec.ts';
import {atlasAssetRoots,searchTaskAssets,readReleasedAsset,assetTerms,ASSET_LIMITS,type AssetRoot,type AssetScope} from '../task-asset-search.ts';
import {readBrandRules,brandSystemPrompt} from '../task-brand-rules.ts';
import {anthropicDocumentTransport,anthropicDocumentKey,anthropicDocumentConfigurationHash,type AnthropicDocumentConfig,type DocumentCostBound,type DocumentUsage,type DocumentDiagnostic} from '../task-document-anthropic.ts';

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

/**
 * Asset release scope, recorded on the document by the source owner and returned inside
 * the packet so it is fenced by the same authority epoch as every other binding. Shared
 * roots and client directories are both explicit: a client name never implies a directory,
 * and a root is never retrievable because it happens to exist on disk.
 */
export type AssetRelease={decision:string;sharedRoots:string[];clientDirectories:string[]};
/** Where this machine keeps the brain and the key file. Runtime placement, not authority. */
export type DocumentRuntimePaths={assetBrain:string;brandKit:string;keyFile?:string};

export function assetRelease(raw:unknown):AssetRelease{
 const p=raw as Partial<AssetRelease>|null;
 if(!p||typeof p.decision!=='string'||p.decision.trim().length<10||!Array.isArray(p.sharedRoots)||!Array.isArray(p.clientDirectories))throw Error('asset_release_decision_required');
 if([...p.sharedRoots,...p.clientDirectories].some(x=>typeof x!=='string'||!x.trim()))throw Error('asset_release_decision_required');
 return {decision:p.decision,sharedRoots:[...p.sharedRoots],clientDirectories:[...p.clientDirectories]};
}

/**
 * Retrieve and rank existing assets for one task, then hydrate the survivors into packet
 * entries. Ranking is over the task's own title, quote and client, so an asset earns its
 * place by matching the actual work rather than by being recently edited.
 *
 * Content hashes are taken at search time and re-verified at read time, so a file edited
 * mid-build fails the attempt instead of silently substituting different content.
 */
export async function taskAssetEntries(release:AssetRelease,packet:DocumentPacket,roots:AssetRoot[]){
 const scope:AssetScope={client:packet.client,directories:release.clientDirectories};
 // Only roots named by the release decision participate, and an excluded root cannot be
 // named back into scope here — searchTaskAssets refuses it regardless.
 const released=roots.filter(r=>r.kind==='client_scoped'?release.clientDirectories.length>0:release.sharedRoots.includes(r.key));
 const unknown=release.sharedRoots.filter(k=>!roots.some(r=>r.key===k&&r.kind==='shared'));
 if(unknown.length)throw Error('asset_release_root_unknown');
 const terms=assetTerms(packet.title,packet.details,packet.entries.map(e=>e.text).join(' '),packet.client);
 const found=await searchTaskAssets(released,scope,terms,ASSET_LIMITS.maxCandidates);
 const entries:DocumentEntry[]=[];
 for(const candidate of found.candidates){
  const asset=await readReleasedAsset(released,{id:candidate.id,contentHash:candidate.contentHash,clientDirectory:candidate.clientDirectory},scope);
  entries.push({
   id:asset.id,version:asset.contentHash,sourceHash:asset.contentHash,
   kind:candidate.clientDirectory?'client_asset':'method_asset',
   title:asset.title,text:asset.text,
   // Retrieval under a recorded release decision is exactly a use-and-display release.
   display:true,use:true,
   sourceRef:{rootKey:asset.rootKey,relativePath:asset.relativePath,clientDirectory:asset.clientDirectory,truncated:asset.truncated},
   reviewReference:release.decision,observedAt:new Date().toISOString(),
  });
 }
 const notes=[
  ...(found.truncated?[`Asset search matched more than ${ASSET_LIMITS.maxCandidates} sources; only the ${ASSET_LIMITS.maxCandidates} best lexical matches were supplied.`]:[]),
  ...(release.clientDirectories.length===0?['No client-specific asset directory is released for this client, so no client work informed this draft.']:[]),
  ...(entries.length===0?['Asset search returned no released source that matches this task; the draft rests on the commitment and curated evidence only.']:[]),
 ];
 return {entries,notes,searched:{scanned:found.scanned,skipped:found.skipped.length,candidates:found.candidates.map(c=>({id:c.id,score:c.score,matchedTerms:c.matchedTerms,contentHash:c.contentHash}))}};
}

/** Digest of the exact asset set supplied, recorded in the ledger beside the prompt hash. */
export const assetDigest=(entries:DocumentEntry[])=>createHash('sha256').update(JSON.stringify(entries.map(e=>[e.id,e.sourceHash]))).digest('hex');

export type DocumentModelHooks={
 beforeDispatch?:(attempt:string,bound:DocumentCostBound)=>Promise<void>;
 recordUsage?:(attempt:string,usage:DocumentUsage,bound:DocumentCostBound)=>Promise<void>;
 recordDiagnostic?:(attempt:string,diagnostic:DocumentDiagnostic)=>Promise<void>;
};
export type DocumentModel={configurationHash:string;system:string|null;costBound:((prompt:string)=>DocumentCostBound)|null;invoke:(prompt:string,attempt:string)=>Promise<unknown>};

/**
 * Select the reviewed adapter. `anthropic-direct` is the live Claude API binding: one
 * dispatch, no retries, no fallback model, key read from the owner-only key file at
 * invocation. Every other provider stays on the existing local fixture transport. There is
 * no environment default, and live mode still needs its separate reviewed execution stop.
 */
export async function documentModel(config:DocumentConfig&Partial<DocumentRuntimePaths>,transport:typeof fetch=fetch,hooks:DocumentModelHooks={}):Promise<DocumentModel>{
 if(config.provider!=='anthropic-direct'){
  const model=documentTransport(config,transport,process.env);
  return {configurationHash:model.configurationHash,system:null,costBound:null,invoke:(prompt,attempt)=>model.invoke(prompt,attempt)};
 }
 if(config.mode!=='live')throw Error('anthropic_direct_requires_live_mode');
 if(process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION!=='reviewed')throw Error('live_staff_transport_disabled');
 if(!config.brandKit)throw Error('brand_kit_path_required');
 const binding:AnthropicDocumentConfig={
  provider:'anthropic-direct',model:config.model,
  disclosureDecision:String((config as {disclosureDecision?:unknown}).disclosureDecision||''),
  budgetDecision:String((config as {budgetDecision?:unknown}).budgetDecision||''),
  maxPromptCharacters:config.maxPromptCharacters,maxOutputTokens:config.maxOutputTokens,timeoutMs:config.timeoutMs,
  requestProfile:config.model==='claude-sonnet-5-5'?'sonnet-5-5-drafting-v1':undefined,
  keyFile:String(config.keyFile||''),
 };
 const rules=await readBrandRules(config.brandKit);
 const model=anthropicDocumentTransport(binding,anthropicDocumentKey(binding.keyFile),transport,hooks);
 const system=brandSystemPrompt(rules);
 // The brand rules are part of what was dispatched, so they belong in the configuration
 // identity: changing the kit changes the binding rather than silently changing the voice.
 return {
  configurationHash:createHash('sha256').update(JSON.stringify([anthropicDocumentConfigurationHash(binding),rules.kitHash,rules.hash])).digest('hex'),
  system,costBound:(prompt:string)=>model.costBound(system,prompt),
  invoke:(prompt,attempt)=>model.invoke(system,prompt,attempt),
 };
}

/**
 * Start, revise and reconcile one task draft.
 *
 * Order matters and is deliberate: reserve the invocation, retrieve and hydrate assets,
 * bind the exact dispatched bytes and asset set to the attempt, then dispatch once. A
 * failure after the binding step leaves a spent invocation to be reconciled by a human —
 * never re-dispatched — because a billed generation is a fact whether or not it is usable.
 */
export async function buildTaskDocument(principal:string,taskId:string,payload:{operationId:string;revision:number}){
 let config:DocumentConfig&Partial<DocumentRuntimePaths>;const runtime=JSON.parse(process.env.ATLAS_TASK_DOCUMENT_RUNTIME||'{}');
 const runtimeRpc=(action:string,attempt:string,body:object={})=>rpc(runtime.url,runtime.apiKey,runtime.token,'meeting_document_runtime',{action,attempt_id:attempt,payload:body});
 let model:DocumentModel;
 // The attempt token only exists after the reservation, so the usage hook reads it from
 // this holder rather than closing over a value that is not known yet.
 const ledger:{token:string|null}={token:null};
 try{
  config=JSON.parse(process.env.ATLAS_TASK_DOCUMENT_CONFIG||'{}');
  if(!runtime.url||!runtime.token)throw Error('runtime_binding_required');
  model=await documentModel(config,fetch,{
   recordUsage:async(attempt,usage)=>{if(ledger.token)await runtimeRpc('usage',attempt,{token:ledger.token,usage});},
  });
 }catch{throw new WorkspaceRefusal(503,'Generation is disabled until its task-specific provider, budget and runtime decisions are recorded.');}
 const reserved=await documentRpc(principal,'begin',taskId,{...payload,configurationHash:model.configurationHash});
 if(!reserved.available&&reserved.reason)throw new WorkspaceRefusal(409,reserved.reason);
 if(!reserved.dispatch){
  if(['recorded','published'].includes(reserved.state))return runtimeRpc('recover',reserved.attempt);
  throw new WorkspaceRefusal(409,'Generation outcome is uncertain or cancelled. Its invocation is retained; status checks do not call the provider again.');
 }
 const bound={token:reserved.token};ledger.token=reserved.token;
 let packet:DocumentPacket=reserved.packet,digest='';
 try{
  const release=assetRelease(reserved.packet?.assetRelease);
  if(!config.assetBrain)throw Error('asset_brain_path_required');
  const assets=await taskAssetEntries(release,reserved.packet,atlasAssetRoots(config.assetBrain));
  packet={...reserved.packet,entries:[...reserved.packet.entries,...assets.entries],missingContext:[...reserved.packet.missingContext,...assets.notes]};
  digest=assetDigest(assets.entries);
 }catch{
  // An unresolvable source boundary is a held state, not something to draft around.
  throw new WorkspaceRefusal(409,'Released source retrieval failed or a source changed since release. The reserved invocation is retained; no generation was dispatched. Reopen the task after the source owner confirms the release.');
 }
 try{
  const prompt=documentPrompt(packet,reserved.revisionNote||null,reserved.previous||null);
  if(prompt.length>config.maxPromptCharacters)throw new WorkspaceRefusal(409,'The permitted packet exceeds its prompt budget.');
  // Bind the exact dispatched bytes, the exact released asset set and the worst-case
  // charge, all before the provider is contacted.
  await runtimeRpc('check',reserved.attempt,{...bound,promptHash:createHash('sha256').update((model.system||'')+'\n'+prompt).digest('hex'),assetDigest:digest,...(model.costBound?{costBound:model.costBound(prompt)}:{})});
  const response=await model.invoke(prompt,reserved.attempt);
  let content:string;
  try{content=renderDocument(decodeDocumentResponse(response,config.codec),packet,reserved.revisionNote||null,config.mode==='injected');}
  catch{await runtimeRpc('invalid',reserved.attempt,{...bound,response});throw new WorkspaceRefusal(409,'The provider response did not satisfy the document contract. It is retained privately; no automatic retry.');}
  await runtimeRpc('record',reserved.attempt,{...bound,response,content});
  return await runtimeRpc('publish',reserved.attempt,bound);
 }catch(e){if(e instanceof WorkspaceRefusal)throw e;throw new WorkspaceRefusal(409,'Generation outcome is unresolved. Reopen the task to reconcile saved status. Checking status never generates again.');}
}
