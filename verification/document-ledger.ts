/**
 * In-process reference implementation of the 022 + 028 document state machine.
 *
 * This is verification scaffolding, never product code. It exists so the flow assertions
 * (Start, Approve, Request changes, immutability, invocation budget, authority fencing)
 * execute somewhere in this session: the hosted SQL path needs PostgreSQL and PostgREST
 * containers, and the Docker daemon is not running on this machine. A passing test here is
 * evidence about the contract this lane depends on, NOT evidence that the SQL is correct.
 * The SQL still requires its own native run before installation.
 */
import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import type {DocumentPacket} from '../src/lib/task-document-codec.ts';

const sha256=(v:string)=>createHash('sha256').update(v).digest('hex');

export type LedgerVersion={version:number;attemptId:string;fingerprint:string;content:string;contentHash:string;initiator:string;createdAt:string};
export type LedgerAttempt={
 id:string;revision:number;initiator:string;token:string;fingerprint:string;configurationHash:string;
 state:'reserved'|'recorded'|'published'|'cancelled'|'invalid';deadline:number;
 promptHash?:string;assetDigest?:string|null;dispatchAt?:number;
 costBoundBytes?:number;costBoundMicros?:number;inputTokens?:number;outputTokens?:number;usageAt?:string;
 response?:unknown;content?:string;
};
export type LedgerDocument={
 id:string;taskId:string;title:string;workflow:'role_sop'|'client_action_brief';
 owner:string;executor:string;reviewer:string;
 atlasExecutor:boolean;atlasExecutorDecision:string|null;
 assetRelease:{decision:string;sharedRoots:string[];clientDirectories:string[]}|null;
 builderSafeRoots:string[];
 configurationHash:string;maxInvocations:number;maxOutputTokens:number;timeoutMs:number;
 decisionReference:string;enabled:boolean;authorizationEpoch:number;
 revision:number;currentVersion:number;
 status:'ready'|'building'|'uncertain'|'rejected'|'cancelled'|'draft'|'needs_revision'|'in_review'|'accepted';
 handoffVersion:number|null;missingContext:string[];
};
export type LedgerActor={actor:string;role:'owner'|'builder'|'reviewer'|'operator';rights:string[];active:boolean;canReview?:boolean};
export type CanonicalTask={workStatus:'todo'|'needs_review'|'completed';boundVersionHash:string|null};

export type RuntimePayload={
 token?:string;promptHash?:string;assetDigest?:string|null;
 costBound?:{requestBytes?:unknown;micros?:unknown;maxOutputTokens?:unknown};
 usage?:{input_tokens?:unknown;output_tokens?:unknown};
 response?:unknown;content?:unknown;
};
export class LedgerRefusal extends Error{code:string;constructor(code:string){super(code);this.code=code}}

/**
 * Mirrors migration 028: an absent release decision means this task may draft from the
 * shared Atlas method roots only, with no client material. The root list must stay
 * identical to app_private.task_document_asset_roots() and atlasAssetRoots().
 */
export const DEFAULT_ASSET_RELEASE={
 decision:'default release: shared Atlas method roots only, no client source material',
 sharedRoots:['playbooks','frameworks','operating-manual','lead-magnets'],clientDirectories:[] as string[],
};
export const DEFAULT_RELEASE_NOTE='No asset release decision is recorded for this task, so the draft uses shared Atlas method material only and no client source material.';

export function createLedger(document:LedgerDocument,actors:LedgerActor[],packetEntries:DocumentPacket['entries'],client:string){
 const versions=new Map<number,Readonly<LedgerVersion>>();
 const attempts:LedgerAttempt[]=[];
 const events:{actor:string;operation:string;operationId:string;input:unknown;version:number;note:string;fingerprint:string}[]=[];
 const task:CanonicalTask={workStatus:'todo',boundVersionHash:null};
 const doc={...document};
 const find=(actor:string)=>actors.find(a=>a.actor===actor&&a.active);

 // The effective release, defaulted exactly as task_document_packet does, so the builder
 // fence and the binding fingerprint both see a real release instead of skipping a null.
 const release=()=>doc.assetRelease??DEFAULT_ASSET_RELEASE;
 const fingerprint=()=>sha256(JSON.stringify({
  task:doc.taskId,authorityEpoch:doc.authorizationEpoch,configuration:doc.configurationHash,
  decision:doc.decisionReference,assetRelease:release(),builderSafeRoots:doc.builderSafeRoots,
  atlasExecutor:doc.atlasExecutor,evidence:packetEntries.map(e=>[e.id,e.sourceHash]),
 }));

 const packet=(actor:string,needed:string):DocumentPacket=>{
  if(!doc.enabled)throw new LedgerRefusal('document_unavailable');
  const a=find(actor);
  if(!a)throw new LedgerRefusal('document_denied');
  if(!a.rights.includes(needed)||!a.rights.includes('context')||!a.rights.includes('output'))throw new LedgerRefusal('document_denied');
  const reviewer=find(doc.reviewer);
  if(!reviewer||!reviewer.canReview||!['context','output','review'].every(r=>reviewer.rights.includes(r)))throw new LedgerRefusal('reviewer_unavailable');
  if(doc.atlasExecutor!==(doc.executor==='atlas'))throw new LedgerRefusal('document_context_changed');
  if(doc.atlasExecutor&&(!doc.atlasExecutorDecision||doc.atlasExecutorDecision.length<10))throw new LedgerRefusal('document_context_changed');
  // A builder audience receives only shared roots separately marked builder-safe. This is
  // evaluated against the effective release, so a defaulted release is fenced too.
  if(actors.some(x=>x.active&&x.role==='builder')
   &&release().sharedRoots.some(r=>!doc.builderSafeRoots.includes(r)))throw new LedgerRefusal('asset_release_builder_denied');
  return {
   fingerprint:fingerprint(),workspaceId:'fixture-workspace',taskId:doc.taskId,requestId:'fixture-request',
   client,owner:doc.owner,title:doc.title,workflow:doc.workflow,audience:'internal_review',
   entries:packetEntries,
   missingContext:[...doc.missingContext,...(doc.assetRelease?[]:[DEFAULT_RELEASE_NOTE])],
   assetRelease:release(),
  };
 };

 const starter=()=>doc.atlasExecutor?doc.owner:doc.executor;

 const meetingDocument=(actor:string,action:string,payload:Record<string,unknown>={}):Record<string,unknown>=>{
  const needed=action==='begin'||action==='cancel'?'build':action==='read'||action==='artifact'?'output':action;
  const p=packet(actor,needed);
  if(action==='read')return {
   available:true,title:doc.title,
   status:[...versions.values()].some(v=>v.version===doc.currentVersion&&v.fingerprint!==p.fingerprint)
    ||attempts.some(x=>x.revision===doc.revision&&x.fingerprint!==p.fingerprint)?'authority_changed':doc.status,
   revision:doc.revision,currentVersion:doc.currentVersion,owner:doc.owner,executor:doc.executor,reviewer:doc.reviewer,
   packet:p,rights:find(actor)!.rights,
   versions:[...versions.values()].filter(v=>v.fingerprint===p.fingerprint).map(v=>({version:v.version,hash:v.contentHash,at:v.createdAt})),
   events:events.filter(e=>e.fingerprint===p.fingerprint).map(e=>({actor:e.actor,action:e.operation,note:e.note,version:e.version})),
  };
  if(action==='artifact'){
   const v=versions.get(Number(payload.version));
   if(!v||v.fingerprint!==p.fingerprint)throw new LedgerRefusal('version_authority_changed');
   return {version:v.version,hash:v.contentHash,content:v.content};
  }
  const operationId=String(payload.operationId||'');
  if(!operationId)throw new LedgerRefusal('operation_id_required');
  const prior=events.find(e=>e.actor===actor&&e.operationId===operationId);
  if(prior){
   if(prior.operation!==action||JSON.stringify(prior.input)!==JSON.stringify(payload))throw new LedgerRefusal('idempotency_conflict');
   if(action!=='begin')return {replay:true};
  }
  let result:Record<string,unknown>;let note:string|null=null;
  if(action==='begin'){
   if(Number(payload.revision)!==doc.revision)throw new LedgerRefusal('revision_changed');
   if(actor!==starter()||payload.configurationHash!==doc.configurationHash)throw new LedgerRefusal('generation_binding_denied');
   const existing=attempts.find(x=>x.revision===doc.revision);
   if(existing)return {replay:true,attempt:existing.id,state:existing.state,dispatch:false};
   if(!['ready','needs_revision'].includes(doc.status))throw new LedgerRefusal('revision_changed');
   if(attempts.length>=doc.maxInvocations)throw new LedgerRefusal('invocation_budget_spent');
   const attempt:LedgerAttempt={id:randomUUID(),revision:doc.revision,initiator:actor,token:randomUUID(),fingerprint:p.fingerprint,configurationHash:doc.configurationHash,state:'reserved',deadline:Date.now()+doc.timeoutMs+10000};
   attempts.push(attempt);doc.status='building';
   const previous=versions.get(doc.currentVersion);
   result={attempt:attempt.id,token:attempt.token,dispatch:true,packet:p,
    revisionNote:[...events].reverse().find(e=>e.operation==='revise')?.note??null,
    previous:previous?{version:previous.version,hash:previous.contentHash,markdown:previous.content}:null};
  }else if(action==='cancel'){
   if(actor!==starter())throw new LedgerRefusal('cancel_denied');
   const open=attempts.filter(x=>x.revision===doc.revision&&['reserved','recorded'].includes(x.state));
   if(!open.length)throw new LedgerRefusal('no_active_attempt');
   for(const x of open)x.state='cancelled';
   doc.status='cancelled';result={cancelled:true};
  }else{
   note=String(payload.note||'').trim();
   if(note.length<10||note.length>2000)throw new LedgerRefusal('substantive_safe_note_required');
   const v=versions.get(doc.currentVersion);
   if(!v||v.version!==Number(payload.version)||v.contentHash!==payload.hash||v.fingerprint!==p.fingerprint||doc.revision!==Number(payload.revision))throw new LedgerRefusal('version_changed');
   if(action==='revise'){
    if(!['draft','in_review'].includes(doc.status))throw new LedgerRefusal('revision_unavailable');
    if(doc.status==='in_review'&&actor!==doc.reviewer)throw new LedgerRefusal('required_reviewer_only');
    doc.revision+=1;doc.status='needs_revision';doc.handoffVersion=null;
   }else if(action==='handoff'){
    if(doc.atlasExecutor)throw new LedgerRefusal('atlas_execution_has_no_handoff');
    if(actor!==doc.executor||doc.status!=='draft')throw new LedgerRefusal('handoff_denied');
    doc.status='in_review';doc.handoffVersion=doc.currentVersion;task.workStatus='needs_review';
   }else if(action==='review'){
    if(actor!==doc.reviewer)throw new LedgerRefusal('review_denied');
    if(doc.atlasExecutor){
     if(doc.status!=='draft')throw new LedgerRefusal('review_denied');
     doc.handoffVersion=v.version;doc.status='accepted';task.workStatus='completed';
    }else{
     if(doc.status!=='in_review'||doc.handoffVersion!==v.version)throw new LedgerRefusal('review_denied');
     doc.status='accepted';task.workStatus='completed';
    }
    // Approve binds the exact version that was accepted.
    task.boundVersionHash=v.contentHash;
   }else throw new LedgerRefusal('unsupported_document_action');
   result={ok:true};
  }
  events.push({actor,operation:action,operationId,input:payload,version:doc.currentVersion,note:note??'Bound generation reserved; no completion or delivery.',fingerprint:p.fingerprint});
  return result;
 };

 const runtime=(action:string,attemptId:string,payload:RuntimePayload={}):Record<string,unknown>=>{
  const x=attempts.find(a=>a.id===attemptId);
  if(!x)throw new LedgerRefusal('runtime_denied');
  const p=packet(x.initiator,'build');
  if(x.fingerprint!==p.fingerprint||x.configurationHash!==doc.configurationHash||x.revision!==doc.revision||['cancelled','invalid'].includes(x.state))throw new LedgerRefusal('attempt_binding_changed');
  if(action==='recover'){if(!['recorded','published'].includes(x.state))throw new LedgerRefusal('outcome_uncertain_no_retry');}
  else if(x.token!==payload.token)throw new LedgerRefusal('attempt_token_denied');
  if(action==='check'){
   if(x.state!=='reserved'||x.dispatchAt||Date.now()>x.deadline)throw new LedgerRefusal('dispatch_held');
   if(!/^[0-9a-f]{64}$/.test(String(payload.promptHash||'')))throw new LedgerRefusal('prompt_binding_required');
   if(!/^[0-9a-f]{64}$/.test(String(payload.assetDigest||'')))throw new LedgerRefusal('asset_binding_required');
   if(!Number.isInteger(payload.costBound?.requestBytes)||!Number.isInteger(payload.costBound?.micros)
    ||payload.costBound?.maxOutputTokens!==doc.maxOutputTokens)throw new LedgerRefusal('cost_bound_required');
   x.promptHash=String(payload.promptHash);x.assetDigest=payload.assetDigest??null;
   x.costBoundBytes=payload.costBound!.requestBytes as number;x.costBoundMicros=payload.costBound!.micros as number;
   x.dispatchAt=Date.now();
   return {ok:true};
  }
  if(action==='usage'){
   if(!x.dispatchAt)throw new LedgerRefusal('usage_outside_dispatch');
   if(x.inputTokens!==undefined)return {replay:true};
   const input=payload.usage?.input_tokens,output=payload.usage?.output_tokens;
   if(!Number.isInteger(input)||!Number.isInteger(output)||(output as number)>doc.maxOutputTokens)throw new LedgerRefusal('usage_invalid');
   x.inputTokens=input as number;x.outputTokens=output as number;x.usageAt=new Date().toISOString();
   return {recorded:true};
  }
  if(action==='invalid'){
   if(x.state!=='reserved'||!x.dispatchAt||Date.now()>x.deadline)throw new LedgerRefusal('record_window_closed');
   x.state='invalid';x.response=payload.response;doc.status='rejected';return {invalid:true};
  }
  if(action==='record'){
   if(x.state==='recorded'&&x.content===payload.content)return {replay:true};
   if(x.state!=='reserved'||!x.dispatchAt||Date.now()>x.deadline)throw new LedgerRefusal('record_window_closed');
   if(typeof payload.content!=='string'||payload.content.length<100||payload.content.length>100000)throw new LedgerRefusal('response_invalid');
   x.response=payload.response;x.content=payload.content;x.state='recorded';return {recorded:true};
  }
  if(action==='publish'||action==='recover'){
   if(x.state==='published')return {replay:true};
   if(x.state!=='recorded')throw new LedgerRefusal('recorded_response_required');
   const version=doc.currentVersion+1;
   if(versions.has(version))throw new LedgerRefusal('version_immutable');
   // Frozen on insert: this is the trigger-backed immutability the migration enforces.
   versions.set(version,Object.freeze({version,attemptId:x.id,fingerprint:x.fingerprint,content:x.content!,contentHash:sha256(x.content!),initiator:x.initiator,createdAt:new Date().toISOString()}));
   x.state='published';doc.status='draft';doc.currentVersion=version;
   events.push({actor:x.initiator,operation:'generated',operationId:x.id,input:{executor:'atlas_document_runtime'},version,note:'Draft generated. Human review required; no completion or delivery.',fingerprint:x.fingerprint});
   return {version};
  }
  throw new LedgerRefusal('unsupported_runtime_action');
 };

 return {
  document:doc,task,
  meetingDocument,runtime,packet,
  versions:()=>[...versions.values()],
  version:(n:number)=>versions.get(n),
  attempts:()=>attempts,
  events:()=>events,
  /** Any content or authority change bumps the epoch and therefore the fingerprint. */
  bumpAuthority:()=>{doc.authorizationEpoch+=1},
  setEntries:(entries:DocumentPacket['entries'])=>{packetEntries=entries;doc.authorizationEpoch+=1},
 };
}
