/**
 * Direct Claude API binding for task-linked drafting.
 *
 * Same transport discipline as the Lane A meeting-intake extractor: one bounded HTTP
 * attempt per reserved invocation, no SDK, no retries, no fallback model, no tools, no
 * redirect, and an owner-only key file read at invocation and never cached or logged.
 * The endpoint is a constant, so no packet, source or config input can redirect it.
 *
 * Drafting differs from extraction in exactly three reviewed ways: adaptive thinking at
 * effort medium instead of between_tools at effort low, an 8000-token output bound, and a
 * usage record carrying the pre-dispatch byte-floor cost bound.
 */
import {createHash} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';

export const ANTHROPIC_MESSAGES_ENDPOINT='https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION='2023-06-01';
export const DOCUMENT_REQUEST_PROFILE='sonnet-5-5-drafting-v1';
/** Published Claude Sonnet 5.5 rates, in micro-dollars per token, for the cost bound only. */
export const SONNET55_MICROS={input:2,output:10} as const;

export type AnthropicDocumentConfig={
 provider:'anthropic-direct';
 model:string;
 /** Explicit human decisions. Absent or blank refuses the binding outright. */
 disclosureDecision:string;budgetDecision:string;
 maxPromptCharacters:number;maxOutputTokens:number;timeoutMs:number;
 requestProfile?:typeof DOCUMENT_REQUEST_PROFILE;
 keyFile:string;
};
export type DocumentUsage={input_tokens:number;output_tokens:number};
export type DocumentCostBound={requestBytes:number;maxOutputTokens:number;micros:number};

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Exact explicit binding. Validated before the key is read and before any dispatch. */
export function anthropicDocumentEndpoint(c:AnthropicDocumentConfig){
 if(c.provider!=='anthropic-direct'||typeof c.model!=='string'||!/^[a-zA-Z0-9_.@-]+$/.test(c.model)
  ||!c.disclosureDecision?.trim()||!c.budgetDecision?.trim()
  ||!Number.isInteger(c.maxPromptCharacters)||c.maxPromptCharacters<1000||c.maxPromptCharacters>100000
  ||!Number.isInteger(c.maxOutputTokens)||c.maxOutputTokens<100||c.maxOutputTokens>12000
  ||!Number.isInteger(c.timeoutMs)||c.timeoutMs<1||c.timeoutMs>60000
  ||typeof c.keyFile!=='string'||!isAbsolute(c.keyFile))throw Error('provider_binding_unapproved_or_invalid');
 // The drafting profile and the model are bound together; neither can be set alone.
 if((c.model==='claude-sonnet-5-5')!==(c.requestProfile===DOCUMENT_REQUEST_PROFILE)
  ||(c.requestProfile!==undefined&&c.requestProfile!==DOCUMENT_REQUEST_PROFILE))throw Error('explicit_model_request_profile_required');
 return ANTHROPIC_MESSAGES_ENDPOINT;
}

export const anthropicDocumentConfigurationHash=(c:AnthropicDocumentConfig)=>
 sha256(JSON.stringify({adapter:'atlas-anthropic-drafting-v1-sonnet55',config:Object.keys(c).sort().map(k=>[k,c[k as keyof AnthropicDocumentConfig]]),endpoint:anthropicDocumentEndpoint(c)}));

/**
 * Owner-only 0600 key file under a 0700 directory, read at invocation. Never cached to
 * disk, written to a journal, echoed into a diagnostic or returned to a caller.
 */
export function anthropicDocumentKey(file:string){
 return async(signal:AbortSignal)=>{
  // A cancelled attempt must not touch the key file at all.
  if(signal?.aborted)throw Error('cancelled_before_provider');
  if(!isAbsolute(file))throw Error('owner_only_provider_credentials_required');
  const dir=await lstat(dirname(file));
  if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o777)!==0o700)throw Error('owner_only_provider_credentials_required');
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await handle.stat();
   if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600)throw Error('owner_only_provider_credentials_required');
   const key=(await handle.readFile('utf8')).trim();
   if(!/^sk-ant-[A-Za-z0-9_-]{24,256}$/.test(key))throw Error('explicit_api_key_credentials_required');
   return key;
  }finally{await handle.close()}
 };
}

/**
 * Cost ceiling without a token count. Input tokens can never exceed the UTF-8 byte length
 * of the request, so bytes*inputRate + maxOutputTokens*outputRate bounds the charge. This
 * replaces the Vertex count-tokens preflight, whose quota is zero on that project.
 */
export function documentCostBound(body:string,config:AnthropicDocumentConfig):DocumentCostBound{
 const requestBytes=Buffer.byteLength(body,'utf8');
 if(requestBytes>config.maxPromptCharacters*4)throw Error('request_over_prompt_byte_bound');
 return {requestBytes,maxOutputTokens:config.maxOutputTokens,micros:requestBytes*SONNET55_MICROS.input+config.maxOutputTokens*SONNET55_MICROS.output};
}

/** Adaptive thinking at effort medium. `budget_tokens` is rejected by this model family. */
export function anthropicDocumentBody(config:AnthropicDocumentConfig,system:string,prompt:string){
 anthropicDocumentEndpoint(config);
 if(typeof system!=='string'||!system.trim()||typeof prompt!=='string'||!prompt.trim())throw Error('document_prompt_required');
 if(prompt.length>config.maxPromptCharacters)throw Error('document_prompt_over_budget');
 return JSON.stringify({
  model:config.model,max_tokens:config.maxOutputTokens,stream:false,
  ...(config.requestProfile?{thinking:{type:'adaptive'},output_config:{effort:'medium'}}:{}),
  system,messages:[{role:'user',content:prompt}],
 });
}

export const validDocumentUsage=(usage:unknown,maxOutputTokens:number):usage is DocumentUsage=>{
 const u=usage as DocumentUsage|undefined;
 return !!u&&Number.isInteger(u.input_tokens)&&u.input_tokens>=0&&Number.isInteger(u.output_tokens)&&u.output_tokens>=0&&u.output_tokens<=maxOutputTokens;
};

/**
 * Accept only text plus structurally valid thinking or redacted_thinking blocks, and return
 * the single text block. Thinking is never treated as document content, and a response
 * carrying any other block type is incomplete rather than partially usable.
 */
export function anthropicDocumentText(content:unknown){
 if(!Array.isArray(content)||!content.length)throw Error('provider_response_incomplete');
 const text:string[]=[];
 for(const block of content){
  if(!block||typeof block!=='object')throw Error('provider_response_incomplete');
  const b=block as {type?:unknown;text?:unknown;thinking?:unknown;signature?:unknown;data?:unknown};
  if(b.type==='text'){if(typeof b.text!=='string')throw Error('provider_response_incomplete');text.push(b.text);continue}
  if(b.type==='thinking'){if(typeof b.thinking!=='string')throw Error('provider_response_incomplete');continue}
  if(b.type==='redacted_thinking'){if(typeof b.data!=='string'||!b.data)throw Error('provider_response_incomplete');continue}
  throw Error('provider_response_incomplete');
 }
 if(text.length!==1||!text[0].trim())throw Error('provider_response_incomplete');
 return text[0];
}

export type DocumentDiagnostic={category:'http_error'|'transport_unresolved'|'cancelled'|'response_unreadable'|'provider_refusal';httpStatus?:number;providerErrorType?:string;refusalCategory?:string;requestId?:string};
/** Bounded identifiers only. No provider message, body, prompt, source text or key. */
export async function documentDiagnostic(response:Response,signal:AbortSignal,sensitive:string[]):Promise<DocumentDiagnostic>{
 const safe=(value:unknown,pattern:RegExp,max=200)=>typeof value==='string'&&value.length<=max&&pattern.test(value)&&!sensitive.some(s=>s&&value.includes(s))?value:undefined;
 const result:DocumentDiagnostic={category:'http_error',httpStatus:response.status};
 const requestId=safe(response.headers.get('request-id')||response.headers.get('x-request-id'),/^[a-zA-Z0-9_-]+$/);
 if(requestId)result.requestId=requestId;
 let body:unknown;
 try{
  const text=(await response.text()).slice(0,32768);
  body=JSON.parse(text);
 }catch{if(signal.aborted)result.category='cancelled';return result}
 const type=(body as {error?:{type?:unknown}}|null)?.error?.type;
 const errorType=safe(type,/^[a-z][a-z0-9_]*$/,40);
 if(errorType)result.providerErrorType=errorType;
 return result;
}

export const refusalCategory=(value:unknown)=>typeof value==='string'&&value.length<=40&&/^[a-z][a-z0-9_]*$/.test(value)?value:undefined;

export type DocumentTransport={
 configurationHash:string;
 costBound:(system:string,prompt:string)=>DocumentCostBound;
 invoke:(system:string,prompt:string,attempt:string,signal?:AbortSignal)=>Promise<unknown>;
};

/**
 * One dispatch per reserved invocation. A refusal, an HTTP error, an unreadable body and a
 * transport failure all end the attempt: the caller settles it as held or rejected and
 * never re-dispatches, because a declined or lost generation is still a spent invocation.
 */
export function anthropicDocumentTransport(
 config:AnthropicDocumentConfig,
 key:(signal:AbortSignal)=>Promise<string>,
 transport:typeof fetch=fetch,
 hooks:{beforeDispatch?:(attempt:string,bound:DocumentCostBound)=>Promise<void>;recordUsage?:(attempt:string,usage:DocumentUsage,bound:DocumentCostBound)=>Promise<void>;recordDiagnostic?:(attempt:string,diagnostic:DocumentDiagnostic)=>Promise<void>}={},
):DocumentTransport{
 const endpoint=anthropicDocumentEndpoint(config);
 return {
  configurationHash:anthropicDocumentConfigurationHash(config),
  costBound:(system,prompt)=>documentCostBound(anthropicDocumentBody(config,system,prompt),config),
  async invoke(system,prompt,attempt,outer?:AbortSignal){
   const body=anthropicDocumentBody(config,system,prompt);
   const bound=documentCostBound(body,config);
   const timeout=AbortSignal.timeout(config.timeoutMs);
   const signal=outer?AbortSignal.any([outer,timeout]):timeout;
   const auth=await key(signal);
   // The reservation records the cost bound before the key is used, so a dispatch can
   // never happen outside a ledger entry that already accounts for its worst case.
   if(hooks.beforeDispatch)await hooks.beforeDispatch(attempt,bound);
   if(signal.aborted)throw Error('cancelled_before_provider');
   let response:Response;
   try{
    response=await transport(endpoint,{method:'POST',redirect:'error',signal,headers:{'x-api-key':auth,'anthropic-version':ANTHROPIC_VERSION,'content-type':'application/json'},body});
   }catch{
    if(hooks.recordDiagnostic)await hooks.recordDiagnostic(attempt,{category:signal.aborted?'cancelled':'transport_unresolved'});
    throw Error('provider_outcome_unresolved');
   }
   if(!response.ok){
    if(hooks.recordDiagnostic)await hooks.recordDiagnostic(attempt,await documentDiagnostic(response,signal,[auth,prompt,system]));
    throw Error('provider_outcome_unresolved');
   }
   let raw:{usage?:unknown;stop_reason?:string;stop_details?:unknown;content?:unknown};
   try{
    const text=await response.text();
    if(text.length>1_000_000)throw Error('oversize');
    raw=JSON.parse(text);
   }catch{
    if(hooks.recordDiagnostic)await hooks.recordDiagnostic(attempt,{category:signal.aborted?'cancelled':'response_unreadable',httpStatus:response.status});
    throw Error('provider_outcome_unresolved');
   }
   // Usage is recorded before any contract check: a billed call counts against the ledger
   // whether or not its output turns out to be usable.
   if(hooks.recordUsage&&validDocumentUsage(raw.usage,config.maxOutputTokens))await hooks.recordUsage(attempt,{input_tokens:raw.usage.input_tokens,output_tokens:raw.usage.output_tokens},bound);
   if(raw.stop_reason==='refusal'){
    const category=refusalCategory((raw.stop_details as {category?:unknown}|null)?.category);
    if(hooks.recordDiagnostic)await hooks.recordDiagnostic(attempt,{category:'provider_refusal',httpStatus:response.status,...(category?{refusalCategory:category}:{})});
    throw Error('provider_response_incomplete');
   }
   if(raw.stop_reason!=='end_turn')throw Error('provider_response_incomplete');
   return JSON.parse(anthropicDocumentText(raw.content));
  },
 };
}
