import {intakeJSON}from './intake-http.ts';
import {GlobalIntakeError,SourceReadError,type Catalog,type CatalogEntry}from './intake-core.ts';
export function sourceMetadata(raw:Record<string,any>){
 const emails=Array.isArray(raw.participants)?raw.participants:[];
 return {accountId:typeof raw.user?.user_id==='string'?raw.user.user_id:null,organizer:typeof raw.organizer_email==='string'?raw.organizer_email.toLowerCase():null,domains:emails.length&&emails.every((x:unknown)=>typeof x==='string'&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))?[...new Set(emails.map((x:string)=>x.split('@')[1].toLowerCase()))].sort():[]};
}
/** Metadata discovery only, before transcript access. Never summary/title-based permission. */
export function firefliesCatalog(key:string,signal?:AbortSignal,accountId?:string,transport:typeof fetch=fetch):Catalog{
 async function query(query:string,variables:object,sourceRead=false){try{
  const response=await transport('https://api.fireflies.ai/graphql',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if([401,403,429].includes(response.status))throw new GlobalIntakeError('Source service unauthorized or rate limited; coverage incomplete');
  if(!response.ok){if(sourceRead&&response.status>=500)throw new SourceReadError('read_unavailable');throw new GlobalIntakeError('Source service unavailable; coverage incomplete')}
  const data=await intakeJSON(response)as{errors?:unknown;data:Record<string,any>};
  // Unclassified GraphQL errors may be authority failures. Never assume a missing source.
  if(data.errors)throw new GlobalIntakeError('Source service query refused; coverage incomplete');return data.data;
 }catch(error){if(error instanceof GlobalIntakeError||error instanceof SourceReadError)throw error;if(sourceRead)throw new SourceReadError('read_unavailable');throw new GlobalIntakeError('Source account/catalog transport unavailable; coverage incomplete')}}
 async function account(){if(accountId){const d=await query('query{user{user_id}}',{});if(d.user?.user_id!==accountId)throw new GlobalIntakeError('Source account mismatch')}}
 const entry=(m:Record<string,any>):CatalogEntry=>{if(!m)throw new SourceReadError('read_unavailable');if(typeof m.is_live!=='boolean')throw new SourceReadError('metadata_incomplete');return{id:m.id,title:m.title,instant:new Date(m.date).toISOString(),live:m.is_live,...sourceMetadata(m)}};
 return {async metadata(id){await account();return entry((await query('query($id:String!){transcript(id:$id){id title date is_live organizer_email participants user{user_id}}}',{id},true)).transcript)},async page(start,end,skip){await account();const data=await query('query($from:DateTime!,$to:DateTime!,$skip:Int!,$user:String){transcripts(fromDate:$from,toDate:$to,limit:50,skip:$skip,user_id:$user){id title date is_live organizer_email participants user{user_id}}}',{from:start,to:end,skip,user:accountId});return data.transcripts.map((m:Record<string,any>):CatalogEntry=>{if(typeof m.is_live!=='boolean')throw Error('Missing completion state');return {id:m.id,title:m.title,instant:new Date(m.date).toISOString(),live:m.is_live,...sourceMetadata(m)}})},async source(id){await account();const raw=(await query('query($id:String!){transcript(id:$id){id title date is_live organizer_email participants user{user_id} sentences{speaker_name text start_time end_time} summary{action_items}}}',{id},true)).transcript;if(!raw)throw new SourceReadError('read_unavailable');return raw}};
}
