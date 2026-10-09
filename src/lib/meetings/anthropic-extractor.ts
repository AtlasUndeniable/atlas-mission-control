import {providerDiagnostic,refusalCategory,type ProviderDiagnostic}from'./provider-diagnostics.ts';
import {open,lstat}from'node:fs/promises';
import {constants}from'node:fs';
import {dirname,isAbsolute}from'node:path';
import {hash,type MeetingSource}from'./intake-core.ts';
import {intakeJSON}from'./intake-http.ts';
import type {Extractor}from'./recurring-intake.ts';
import {extractionContent,extractionSystem,requestByteFloor,validUsage,vertexResponseText,type VertexUsage}from'./vertex-extractor.ts';
export const ANTHROPIC_MESSAGES_ENDPOINT='https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION='2023-06-01';
export type AnthropicConfig={provider:'anthropic-direct';model:string;disclosureDecision:string;budgetDecision:string;maxPromptCharacters:number;maxOutputTokens:number;requestProfile?:'sonnet-5-5-extraction-v1';keyFile:string};
/** Exact explicit binding. The endpoint is a constant; no project, region or source input can redirect it. */
export function anthropicEndpoint(c:AnthropicConfig){
 if(c.provider!=='anthropic-direct'||typeof c.model!=='string'||!/^[a-zA-Z0-9_.@-]+$/.test(c.model)||!c.disclosureDecision||!c.budgetDecision||!Number.isInteger(c.maxPromptCharacters)||c.maxPromptCharacters<1000||c.maxPromptCharacters>100000||!Number.isInteger(c.maxOutputTokens)||c.maxOutputTokens<100||c.maxOutputTokens>12000||typeof c.keyFile!=='string'||!isAbsolute(c.keyFile))throw Error('provider_binding_unapproved_or_invalid');
 if((c.model==='claude-sonnet-5-5')!==(c.requestProfile==='sonnet-5-5-extraction-v1')||(c.requestProfile!==undefined&&c.requestProfile!=='sonnet-5-5-extraction-v1'))throw Error('explicit_model_request_profile_required');
 return ANTHROPIC_MESSAGES_ENDPOINT;
}
export const anthropicConfigurationHash=(c:AnthropicConfig)=>hash({adapter:'atlas-anthropic-extraction-v1-sonnet55',...c,endpoint:anthropicEndpoint(c)});
/** Explicit owner-only 0600 key file under a 0700 directory, read at invocation. Never cached to disk, logged or returned in a diagnostic. */
export function anthropicKey(file:string){return async(signal?:AbortSignal)=>{
 // A cancelled attempt must not touch the key file at all.
 if(signal?.aborted)throw Error('cancelled_before_provider');
 if(!isAbsolute(file))throw Error('owner_only_provider_credentials_required');
 const dir=await lstat(dirname(file));
 if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o777)!==0o700)throw Error('owner_only_provider_credentials_required');
 const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=await f.stat();
  if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600)throw Error('owner_only_provider_credentials_required');
  const key=(await f.readFile('utf8')).trim();
  if(!/^sk-ant-[A-Za-z0-9_-]{24,256}$/.test(key))throw Error('explicit_api_key_credentials_required');
  return key;
 }finally{await f.close()}
}}
/**
 * The one bounded Claude dispatch for every Atlas adapter. Constant endpoint, exactly the
 * three documented headers, no bearer token, no redirect, no SDK, no tools, no cache
 * control, no fallback model and exactly one attempt. Callers validate their own binding
 * first and settle their own outcome; nothing here retries.
 */
export function anthropicDispatch(key:string,body:string,signal:AbortSignal,transport:typeof fetch=fetch){
 return transport(ANTHROPIC_MESSAGES_ENDPOINT,{method:'POST',redirect:'error',signal,headers:{'x-api-key':key,'anthropic-version':ANTHROPIC_VERSION,'content-type':'application/json'},body});
}
/** One bounded HTTP invocation. No SDK, retries, fallback model, tools, cache or source-controlled endpoint. */
export function anthropicExtractor(config:AnthropicConfig,key:(signal:AbortSignal)=>Promise<string>,transport:typeof fetch=fetch,beforeDisclosure?:(attempt:string)=>Promise<void>,recordUsage?:(attempt:string,usage:VertexUsage)=>Promise<void>,recordDiagnostic?:(attempt:string,diagnostic:ProviderDiagnostic)=>Promise<void>):Extractor{
 if(anthropicEndpoint(config)!==ANTHROPIC_MESSAGES_ENDPOINT)throw Error('provider_binding_unapproved_or_invalid');
 return {configurationHash:anthropicConfigurationHash(config),preflight(source){anthropicBody(config,source)},requestBytes(source){return requestByteFloor(anthropicBody(config,source),config.maxPromptCharacters)},async invoke(source:MeetingSource,_attempt:string,signal:AbortSignal){
  const body=anthropicBody(config,source);
  const auth=await key(signal);if(beforeDisclosure)await beforeDisclosure(_attempt);if(signal.aborted)throw Error('cancelled_before_provider');
  let r:Response;
  try{r=await anthropicDispatch(auth,body,signal,transport)}
  catch{if(recordDiagnostic)await recordDiagnostic(_attempt,{category:signal.aborted?'cancelled':'transport_unresolved'});throw Error('provider_outcome_unresolved')}
  if(!r.ok){const diagnostic=await providerDiagnostic(r,signal,[auth,...source.passages.map(p=>p.text)]);if(recordDiagnostic)await recordDiagnostic(_attempt,diagnostic);throw Error('provider_outcome_unresolved');}
  let raw:{usage?:VertexUsage;stop_reason?:string;stop_details?:unknown;content?:unknown};
  try{raw=await intakeJSON(r,1_000_000)as typeof raw}catch{if(recordDiagnostic)await recordDiagnostic(_attempt,{category:signal.aborted?'cancelled':'response_unreadable',httpStatus:r.status});throw Error('provider_outcome_unresolved')}
  if(recordUsage&&validUsage(raw.usage,config.maxOutputTokens))await recordUsage(_attempt,{input_tokens:raw.usage.input_tokens,output_tokens:raw.usage.output_tokens});
  // A declined generation is billed and must settle as Held. No retry, fallback model or second request follows.
  if(raw.stop_reason==='refusal'){
   const category=refusalCategory((raw.stop_details as {category?:unknown}|null)?.category);
   if(recordDiagnostic)await recordDiagnostic(_attempt,{category:'provider_refusal',httpStatus:r.status,...(category?{refusalCategory:category}:{})});
   throw Error('provider_response_incomplete');
  }
  if(raw.stop_reason!=='end_turn')throw Error('provider_response_incomplete');
  return JSON.parse(anthropicResponseText(config,raw.content));
 }};
}
/** One response validator for every adapter: only text plus structurally valid thinking or redacted_thinking blocks. */
export const anthropicResponseText=(config:{requestProfile?:string},content:unknown)=>vertexResponseText(config,content);
/** Identical to the Vertex request body apart from the removed anthropic_version field and the explicit model. */
export function anthropicBody(config:AnthropicConfig,source:MeetingSource){
 anthropicEndpoint(config);
 const content=extractionContent(source);
 const body=JSON.stringify({model:config.model,max_tokens:config.maxOutputTokens,stream:false,...(config.requestProfile?{thinking:{type:'between_tools'},output_config:{effort:'low'}}:{}),system:extractionSystem,messages:[{role:'user',content}]});
 requestByteFloor(body,config.maxPromptCharacters);
 return body;
}
