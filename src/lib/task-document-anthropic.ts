/**
 * Direct Claude API binding for task-linked drafting.
 *
 * The transport itself is NOT implemented here. The key reader, the one bounded dispatch,
 * the sanitized diagnostic and the response-block validator all come from the meeting
 * intake adapter's shared module, so the two Atlas Claude paths cannot drift apart. What
 * remains here is drafting-specific and reviewed as such: the configuration binding and
 * its own adapter hash, the adaptive-thinking / effort-medium / 8000-token request body,
 * the byte-floor cost bound, and the invocation orchestration that settles an attempt.
 *
 * Drafting differs from extraction in exactly four reviewed ways: adaptive thinking at
 * effort medium instead of between_tools at effort low, an 8000-token output bound, a
 * usage record carrying the pre-dispatch byte-floor cost bound, and schema-enforced output
 * (`output_config.format`, the document contract as JSON Schema). The codec still validates
 * every response after it returns; the schema is a first line, not the only one.
 */
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {
 ANTHROPIC_MESSAGES_ENDPOINT,ANTHROPIC_VERSION,anthropicKey,anthropicDispatch,anthropicResponseText,
} from './meetings/anthropic-extractor.ts';
import {providerDiagnostic,refusalCategory,type ProviderDiagnostic} from './meetings/provider-diagnostics.ts';
import {intakeJSON} from './meetings/intake-http.ts';
import {DOCUMENT_WIRE_SCHEMA} from './task-document-codec.ts';

export {ANTHROPIC_MESSAGES_ENDPOINT,ANTHROPIC_VERSION,refusalCategory};
export const DOCUMENT_REQUEST_PROFILE='sonnet-5-5-drafting-v1';
/** Published Claude Sonnet 5.5 rates, in micro-dollars per token, for the cost bound only. */
export const SONNET55_MICROS={input:2,output:10} as const;
/** Ceiling on the bytes read back from one generation. Enforced while streaming. */
export const DOCUMENT_RESPONSE_MAX_BYTES=1_000_000;

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
/** One diagnostic shape for both Atlas Claude paths; bounded identifiers only. */
export type DocumentDiagnostic=ProviderDiagnostic;

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
 sha256(JSON.stringify({adapter:'atlas-anthropic-drafting-v2-sonnet55-structured',schema:sha256(JSON.stringify(DOCUMENT_WIRE_SCHEMA)),config:Object.keys(c).sort().map(k=>[k,c[k as keyof AnthropicDocumentConfig]]),endpoint:anthropicDocumentEndpoint(c)}));

/**
 * The shared owner-only key reader: absolute path, 0600 regular file owned by the caller,
 * inside a 0700 directory, opened O_NOFOLLOW, read at every invocation, never cached to
 * disk, logged or echoed into a diagnostic, and never read at all once cancelled.
 */
export const anthropicDocumentKey=anthropicKey;

/**
 * Cost ceiling without a token count. Input tokens can never exceed the UTF-8 byte length
 * of the request, so bytes*inputRate + maxOutputTokens*outputRate bounds the charge. This
 * replaces the Vertex count-tokens preflight, whose quota is zero on that project.
 *
 * Kept separate from the extraction path's `requestByteFloor`, which caps total request
 * bytes at `maxPromptCharacters`. Drafting caps the prompt at `maxPromptCharacters`
 * characters and the whole body at four bytes per character, because a drafting body
 * carries a brand system prompt and retrieved sources on top of the prompt itself.
 */
export function documentCostBound(body:string,config:AnthropicDocumentConfig):DocumentCostBound{
 const requestBytes=Buffer.byteLength(body,'utf8');
 if(requestBytes>config.maxPromptCharacters*4)throw Error('request_over_prompt_byte_bound');
 return {requestBytes,maxOutputTokens:config.maxOutputTokens,micros:requestBytes*SONNET55_MICROS.input+config.maxOutputTokens*SONNET55_MICROS.output};
}

/**
 * Adaptive thinking at effort medium, with the document contract enforced by structured
 * outputs. `budget_tokens` is rejected by this model family. Structured outputs are
 * incompatible with citations and prefill; neither is used here.
 */
export const documentOutputFormat=()=>({type:'json_schema' as const,schema:DOCUMENT_WIRE_SCHEMA});
export function anthropicDocumentBody(config:AnthropicDocumentConfig,system:string,prompt:string){
 anthropicDocumentEndpoint(config);
 if(typeof system!=='string'||!system.trim()||typeof prompt!=='string'||!prompt.trim())throw Error('document_prompt_required');
 if(prompt.length>config.maxPromptCharacters)throw Error('document_prompt_over_budget');
 return JSON.stringify({
  model:config.model,max_tokens:config.maxOutputTokens,stream:false,
  ...(config.requestProfile?{thinking:{type:'adaptive'},output_config:{format:documentOutputFormat(),effort:'medium'}}:{}),
  system,messages:[{role:'user',content:prompt}],
 });
}

/**
 * Drafting records input and output tokens only. The extraction path's `validUsage` also
 * rejects cache-token fields and caps input at 1,000,000; those are extraction bounds and
 * are deliberately not imposed on what the 028 usage ledger will accept.
 */
export const validDocumentUsage=(usage:unknown,maxOutputTokens:number):usage is DocumentUsage=>{
 const u=usage as DocumentUsage|undefined;
 return !!u&&Number.isInteger(u.input_tokens)&&u.input_tokens>=0&&Number.isInteger(u.output_tokens)&&u.output_tokens>=0&&u.output_tokens<=maxOutputTokens;
};

/**
 * The shared response-block validator, bound to the drafting profile: only text plus
 * structurally valid thinking or redacted_thinking blocks, returning the single text
 * block. Thinking is never treated as document content. A thinking block without a
 * signature is malformed and makes the response incomplete.
 */
export const anthropicDocumentText=(content:unknown,config:{requestProfile?:string}={requestProfile:DOCUMENT_REQUEST_PROFILE})=>
 anthropicResponseText(config,content);

/** The shared sanitized diagnostic. Bounded identifiers only: no provider message, body, prompt, source text or key. */
export const documentDiagnostic=(response:Response,signal:AbortSignal,sensitive:string[]):Promise<DocumentDiagnostic>=>
 providerDiagnostic(response,signal,sensitive);

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
 if(anthropicDocumentEndpoint(config)!==ANTHROPIC_MESSAGES_ENDPOINT)throw Error('provider_binding_unapproved_or_invalid');
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
    response=await anthropicDispatch(auth,body,signal,transport);
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
    // Bounded before allocation, not after: response.text() materialised the whole body
    // and only then compared its length, so an oversize response was already in memory by
    // the time it was refused. intakeJSON stops reading at the cap, which is the same
    // reader the extraction path already uses.
    raw=await intakeJSON(response,DOCUMENT_RESPONSE_MAX_BYTES) as typeof raw;
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
   return JSON.parse(anthropicDocumentText(raw.content,config));
  },
 };
}
