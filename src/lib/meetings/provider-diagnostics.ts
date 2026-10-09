import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
export type ProviderDiagnostic={category:'http_error'|'transport_unresolved'|'cancelled'|'response_unreadable'|'provider_refusal';httpStatus?:number;headers?:Record<string,string>;capturedBytes?:number;truncated?:boolean;readFailed?:boolean;bodyFormat?:string;code?:number;status?:string;reason?:string;quota?:Record<string,string>;retryDelay?:string;refusalCategory?:string;providerErrorType?:string};
/** A declined generation is recorded by documented category identifier only; the free-form explanation is never retained. */
export const refusalCategory=(value:unknown)=>typeof value==='string'&&value.length<=40&&/^[a-z][a-z0-9_]*$/.test(value)?value:undefined;
/** No free-form provider message/body, transcript, reasoning, headers or Error object is retained. */
export async function providerDiagnostic(response:Response,signal:AbortSignal,sensitive:string[]):Promise<ProviderDiagnostic>{
 const result:ProviderDiagnostic={category:'http_error',httpStatus:response.status,headers:{},capturedBytes:0,truncated:false,readFailed:false};
 const safe=(value:unknown,pattern:RegExp,max=200)=>typeof value==='string'&&value.length<=max&&pattern.test(value)&&!sensitive.some(s=>s&&value.includes(s))?value:undefined;
 for(const key of ['request-id','x-request-id','x-goog-request-id','x-cloud-trace-context','traceparent','x-guploader-uploadid']){const v=safe(response.headers.get(key),/^[a-zA-Z0-9:;=_.\/-]+$/);if(v)result.headers![key]=v}
 const retry=safe(response.headers.get('retry-after'),/^(?:[0-9]{1,8}|[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9:]{8} GMT)$/);if(retry)result.headers!['retry-after']=retry;
 const chunks:Uint8Array[]=[];const reader=response.body?.getReader();let abort:()=>void=()=>{};
 try{if(reader){const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(Error('aborted'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()});for(;;){const{done,value}=await Promise.race([reader.read(),cancelled]);if(done)break;const room=32768-result.capturedBytes!;chunks.push(value.subarray(0,room));result.capturedBytes!+=Math.min(value.length,room);if(value.length>room||result.capturedBytes===32768){result.truncated=true;break}}}}
 catch{result.readFailed=true;if(signal.aborted)result.category='cancelled'}finally{signal.removeEventListener('abort',abort);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock()}}
 let body:any;try{if(!result.truncated&&!result.readFailed)body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{}
 result.bodyFormat=result.truncated||result.readFailed?'incomplete':body?'json':'non_json';
 const error=body?.error;if(Number.isInteger(error?.code)&&error.code>=100&&error.code<=599)result.code=error.code;
 result.status=safe(error?.status,/^[A-Z_]{1,60}$/);
 // Documented bounded error identifier only (for example authentication_error, rate_limit_error, overloaded_error); never the message.
 result.providerErrorType=safe(error?.type,/^[a-z][a-z0-9_]*$/,40);
 const quota:Record<string,string>={};
 const add=(key:string,v:unknown,pattern:RegExp)=>{const x=safe(v,pattern);if(x)quota[key]=x};
 // Extract only documented quota identifiers from the common Google message; never store the text.
 if(typeof error?.message==='string'){
  const match=error.message.match(/Quota exceeded for ([a-z0-9.]+\.googleapis\.com\/[a-z0-9_]+) with base model: ([a-z0-9_.@-]+)\./);
  if(match){add('quota_metric',match[1],/^[a-z0-9.]+\.googleapis\.com\/[a-z0-9_]+$/);add('base_model',match[2],/^anthropic-[a-z0-9_.@-]+$/)}
 }
 for(const d of Array.isArray(error?.details)?error.details.slice(0,20):[]){
  if(d?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo'){
   result.reason=safe(d.reason,/^[A-Z_]{1,80}$/);
   add('service',d.metadata?.service,/^[a-z0-9.]+\.googleapis\.com$/);
   for(const key of ['quota_metric','quota_limit','quota_limit_value','quota_location','quota_id'])add(key,d.metadata?.[key],/^[A-Za-z0-9_.\/-]+$/);
  }
  if(d?.['@type']==='type.googleapis.com/google.rpc.QuotaFailure')for(const v of Array.isArray(d.violations)?d.violations.slice(0,10):[]){add('quota_metric',v.quotaMetric,/^[A-Za-z0-9_.\/-]+$/);add('quota_id',v.quotaId,/^[A-Za-z0-9_.\/-]+$/);add('quota_value',String(v.quotaValue??''),/^[0-9]+$/);add('base_model',v.quotaDimensions?.base_model,/^anthropic-[a-z0-9_.@-]+$/)}
  if(d?.['@type']==='type.googleapis.com/google.rpc.RetryInfo')result.retryDelay=safe(d.retryDelay,/^[0-9]+(?:\.[0-9]+)?s$/);
 }
 if(Object.keys(quota).length)result.quota=quota;
 return result;
}
/** Explicit owner-only local diagnostic journal; not a task store. No credentials or raw provider bodies. */
async function openPrivateJournal(file:string){
 if(!isAbsolute(file))throw Error('private_diagnostic_binding_required');
 const dir=await lstat(dirname(file));if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o077))throw Error('owner_only_diagnostics_required');
 const f=await open(file,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{const s=await f.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error('owner_only_diagnostics_required');return f}catch(e){await f.close();throw e}
}
/** Check before any collector RPC or provider authentication; append checks again against drift. */
export async function checkProviderDiagnosticPath(file:string){const f=await openPrivateJournal(file);await f.close()}
export async function appendProviderDiagnostic(file:string,attempt:string,diagnostic:ProviderDiagnostic){
 if(!/^[a-f0-9-]{36}$/.test(attempt))throw Error('private_diagnostic_binding_required');
 const f=await openPrivateJournal(file);
 try{await f.write(JSON.stringify({at:new Date().toISOString(),attempt,diagnostic})+'\n');await f.sync()}finally{await f.close()}
}
