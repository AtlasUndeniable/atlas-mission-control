import {constants} from 'node:fs';
import {open, lstat, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {JWT} from 'google-auth-library';

export type ServiceAccountBinding={type:'service_account';projectId:string;clientEmail:string;keyId:string};
export function validateServiceAccountBinding(binding:ServiceAccountBinding,project:string){
 if(!binding||binding.type!=='service_account'||binding.projectId!==project||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)||!binding.clientEmail?.endsWith(`@${project}.iam.gserviceaccount.com`)||!/^[a-f0-9]{40}$/.test(binding.keyId))throw Error('explicit_service_account_binding_required');
}
/** Explicit file only. No ADC discovery, impersonation, interactive login or credential writes. */
export function serviceAccountToken(file:string,binding:ServiceAccountBinding,transport:typeof fetch=fetch){
 validateServiceAccountBinding(binding,binding?.projectId);
 let cached:{fingerprint:string;token:string;expires:number}|undefined;
 return async(signal:AbortSignal)=>{
  signal.throwIfAborted();
  if(!isAbsolute(file))throw Error('absolute_private_credentials_required');
  const parent=await realpath(dirname(file)),root=resolve(import.meta.dirname,'../../..');
  if(parent===root||parent.startsWith(root+sep))throw Error('credentials_outside_repository_required');
  const dir=await lstat(parent);
  if(dir.uid!==process.getuid?.()||(dir.mode&0o077))throw Error('owner_only_credentials_directory_required');
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:string;
  try{const s=await handle.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>65536)throw Error('owner_only_provider_credentials_required');raw=await handle.readFile('utf8')}finally{await handle.close()}
  let c;try{c=JSON.parse(raw)}catch{throw Error('provider_credentials_invalid')}
  if(c.type!=='service_account'||c.project_id!==binding.projectId||c.client_email!==binding.clientEmail||c.private_key_id!==binding.keyId||c.token_uri!=='https://oauth2.googleapis.com/token'||(c.universe_domain&&c.universe_domain!=='googleapis.com')||typeof c.private_key!=='string'||c.subject)throw Error('provider_credential_binding_mismatch');
  const fingerprint=createHash('sha256').update(raw).digest('hex');
  signal.throwIfAborted();
  if(cached?.fingerprint===fingerprint&&Date.now()<cached.expires)return cached.token;
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  const client=new JWT({email:c.client_email,key:c.private_key,scopes:['https://www.googleapis.com/auth/cloud-platform']});
  let calls=0;
  client.transporter.interceptors.request.add({resolved:async options=>{
   options.retry=false;options.retryConfig={retry:0,noResponseRetries:0};options.signal=bounded;options.timeout=10000;options.maxContentLength=20000;options.maxRedirects=0;
   options.fetchImplementation=(async(url,init)=>{
    if(String(url)!=='https://oauth2.googleapis.com/token'||++calls!==1)throw Error('auth_transport_refused');
    return transport(String(url),{...init,signal:bounded,redirect:'error'} as RequestInit);
   }) as typeof options.fetchImplementation;
   return options;
  }});
  let abort:()=>void=()=>{};
  try{
   const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(Error('provider_auth_cancelled'));bounded.addEventListener('abort',abort,{once:true});if(bounded.aborted)abort()});
   const result=await Promise.race([client.authorize(),cancelled]);
   bounded.throwIfAborted();
   if(!result.access_token||!result.expiry_date||result.expiry_date<=Date.now())throw Error('invalid_token');
   cached={fingerprint,token:result.access_token,expires:result.expiry_date-120000};return cached.token;
  }catch{throw Error(bounded.aborted?'provider_auth_cancelled':'provider_auth_unavailable')}
  finally{bounded.removeEventListener('abort',abort)}
 };
}
