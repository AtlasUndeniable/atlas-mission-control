/**
 * Automatic client mapping for meeting intake (Lane N, migration 029).
 *
 * The collector gathers exact-email FACTS from three local sources and attaches them to catalog
 * rows; the hosted resolver (app_private.intake_client_decide) is authoritative and decides
 * against its own client list, which the collector never sees. decideMapping() below mirrors that
 * SQL so the rules are unit-testable here and parity-checked against the native rehearsal with the
 * shared case table verification/client-mapping-cases.json.
 *
 * Rules (PRD R1.2): a participant email alone never grants client affiliation; personal
 * providers map on the exact address only, never on domain; a company domain maps only when
 * exactly one client uses it; anything ambiguous stays explicit; internal people are never clients.
 * No transcript content is read or sent by anything in this file.
 */
import {readdir,readFile,stat}from'node:fs/promises';
import {join}from'node:path';
import type {Rpc}from'./intake-core.ts';

/** Must equal app_private.intake_personal_domains() in migrations/029_client_mapping.sql. */
export const PERSONAL_DOMAINS=['aol.com','bigpond.com','bigpond.net.au','fastmail.com','gmail.com','gmx.com','googlemail.com','hey.com','hotmail.co.uk','hotmail.com','hotmail.com.au','icloud.com','iinet.net.au','live.com','live.com.au','mac.com','mail.com','me.com','msn.com','optusnet.com.au','outlook.com','outlook.com.au','proton.me','protonmail.com','tpg.com.au','yahoo.co.uk','yahoo.com','yahoo.com.au','ymail.com','zoho.com'] as const;
const PERSONAL=new Set<string>(PERSONAL_DOMAINS);
export const RESOLVER='atlas-resolver:client-mapping-v1';
const EMAIL=/^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normalEmail=(s:string)=>s.trim().toLowerCase();
export const domainOf=(email:string)=>email.split('@')[1]??'';
export const isPersonalDomain=(domain:string)=>PERSONAL.has(domain.toLowerCase());
/** Same as app_private.intake_slug(): lower, non-alphanumerics to '-', trimmed, 40 characters. */
export const slug=(t:string|null|undefined)=>(t??'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
/** Same as the SQL initcap over the local part: words of letters/digits, first upper, rest lower. */
const initcap=(t:string)=>t.toLowerCase().replace(/[a-z0-9]+/g,w=>w[0].toUpperCase()+w.slice(1));

export type EvidenceItem={
 email:string;
 source:'ghl'|'call_notes'|'client_folder';
 /** Opaque reference: GHL contact id, prior call fireflies id, or client-work folder name. */
 ref:string;
 name?:string;company?:string;tags?:string[];
 titleTokens?:string[];
 client?:string;matchedOn?:'email'|'domain';domain?:string;
};
export type ClientEvidence={coverage:Record<string,string>;items:EvidenceItem[]};

// ---------------------------------------------------------------- decision (mirror of SQL)
export type Identity={client:string;email:string;status:'provisional'|'confirmed'};
export type CrosswalkRule={ruleId:string;client:string;matchKind:'domain'|'participant';clientEmails:string[];allowedEmails:string[];clientDomains:string[]};
export type DecideInput={
 organizer:string;participants:string[];evidence:EvidenceItem[];
 /** Active client grants of the auto-mapping rule's reviewer, minus merged provisional clients. */
 knownClients:string[];
 clientStatus?:Record<string,'provisional'|'confirmed'|'merged'>;
 identities:Identity[];crosswalk:CrosswalkRule[];
 internal:{emails:string[];domains:string[]};
 sharedDomains:string[];
};
export type Candidate={client:string;source:string;ref:string};
export type ParticipantDecision={email:string;internal:boolean;candidates?:Candidate[];resolved?:string|null;via?:'email'|'domain'|null;note?:string|null};
export type Decision={outcome:'known'|'new'|'ambiguous'|'internal_only';state:'mapped'|'held';client:string|null;confidence:'high'|'medium'|'provisional'|'none';reason:string;participants:ParticipantDecision[];newClient?:{client:string;name:string;company:string|null;emails:string[]}};
const md5=async(s:string)=>(await import('node:crypto')).createHash('md5').update(s).digest('hex');
const sorted=(a:Iterable<string>)=>[...new Set(a)].sort();

export async function decideMapping(input:DecideInput):Promise<Decision>{
 const known=new Set(input.knownClients);const status=(c:string)=>input.clientStatus?.[c]??'confirmed';
 const internalE=new Set([normalEmail(input.organizer),...input.internal.emails.map(normalEmail),
  ...input.crosswalk.filter(r=>r.matchKind==='participant').flatMap(r=>r.allowedEmails.filter(e=>!r.clientEmails.includes(e)))]);
 const internalD=new Set(input.internal.domains);const shared=new Set(input.sharedDomains);
 const items:ParticipantDecision[]=[];const resolved:string[]=[];const unres:string[]=[];let ambReason:string|null=null;let allStrong=true;let nonInternal=0;
 for(const p of sorted(input.participants.map(normalEmail))){
  const dom=domainOf(p);
  if(internalE.has(p)||internalD.has(dom)){items.push({email:p,internal:true});continue}
  nonInternal++;
  let cands:Candidate[]=[];let via:'email'|'domain'|null=null;let note:string|null=null;let strong=false;
  cands.push(...input.identities.filter(i=>i.email===p&&known.has(i.client)).sort((a,b)=>a.client.localeCompare(b.client)).map(i=>({client:i.client,source:'identity',ref:i.status})));
  cands.push(...input.crosswalk.filter(r=>r.matchKind==='participant'&&r.clientEmails.includes(p)).sort((a,b)=>a.client.localeCompare(b.client)||a.ruleId.localeCompare(b.ruleId)).map(r=>({client:r.client,source:'crosswalk',ref:r.ruleId})));
  for(const e of input.evidence.filter(x=>x&&x.email===p)){
   if(e.source==='ghl'){
    let hit=Array.isArray(e.tags)?[...known].filter(k=>e.tags!.map(t=>String(t).toLowerCase()).includes('atlas-client:'+k)).sort():[];
    if(!hit.length&&slug(e.name)&&known.has(slug(e.name)))hit=[slug(e.name)];
    cands.push(...hit.map(k=>({client:k,source:'ghl',ref:(e.ref??'').slice(0,80)})));
   }else if(e.source==='call_notes'&&Array.isArray(e.titleTokens)){
    // A title names a client only through a key of two or more words (first and last name), all present.
    const toks=new Set(e.titleTokens.map(t=>String(t).toLowerCase()));
    cands.push(...[...known].sort().filter(k=>status(k)!=='provisional'&&k.split('-').length>=2&&k.split('-').every(t=>toks.has(t))).map(k=>({client:k,source:'call_notes',ref:(e.ref??'').slice(0,80)})));
   }else if(e.source==='client_folder'&&(e.matchedOn??'email')==='email'&&e.client&&known.has(e.client)){
    cands.push({client:e.client,source:'client_folder',ref:(e.ref??'').slice(0,80)});
   }
  }
  let exact=sorted(cands.map(c=>c.client));
  if(exact.length===1){via='email';strong=cands.some(c=>c.source==='identity'||c.source==='crosswalk')||new Set(cands.map(c=>c.source)).size>=2}
  else if(exact.length>1)note='conflicting evidence: '+exact.join(', ');
  else if(isPersonalDomain(dom))note='personal email provider: matched on exact address only';
  else if(shared.has(dom))note='shared or agency domain '+dom;
  else{
   const ds=sorted([
    ...input.identities.filter(i=>domainOf(i.email)===dom&&known.has(i.client)).map(i=>i.client),
    ...input.crosswalk.filter(r=>r.clientDomains.includes(dom)||r.clientEmails.some(ce=>domainOf(ce)===dom)).map(r=>r.client),
    ...input.evidence.filter(x=>x&&x.source==='client_folder'&&x.matchedOn==='domain'&&x.domain===dom&&x.client&&known.has(x.client)).map(x=>x.client!)]);
   if(ds.length===1){exact=ds;via='domain';cands=[{client:ds[0],source:'domain',ref:dom}]}
   else if(ds.length>1)note=`domain ${dom} is used by several clients: ${ds.join(', ')}`;
  }
  if(via){resolved.push(exact[0]);allStrong=allStrong&&strong}
  else if(note&&!note.startsWith('personal email provider'))ambReason??=`${p}: ${note}`;
  else unres.push(p);
  items.push({email:p,internal:false,candidates:cands,resolved:via?exact[0]:null,via,note});
 }
 const rc=sorted(resolved);
 if(nonInternal===0)return {outcome:'internal_only',state:'held',client:null,confidence:'none',reason:'Only internal team members attended',participants:items};
 if(ambReason)return {outcome:'ambiguous',state:'held',client:null,confidence:'none',reason:'Needs a person: '+ambReason,participants:items};
 if(rc.length>1)return {outcome:'ambiguous',state:'held',client:null,confidence:'none',reason:'Participants match different clients: '+rc.join(', '),participants:items};
 if(rc.length===1){
  const client=rc[0];
  return {outcome:'known',state:'mapped',client,confidence:status(client)==='provisional'?'provisional':allStrong?'high':'medium',reason:`Matched ${client}${unres.length?`; ${unres.length} other participant(s) not affiliated`:''}`,participants:items};
 }
 const sameDomain=new Set(unres.map(domainOf)).size===1&&!isPersonalDomain(domainOf(unres[0]));
 if(unres.length!==1&&!sameDomain)return {outcome:'ambiguous',state:'held',client:null,confidence:'none',reason:'Several people with no client record; cannot tell which one is the client',participants:items};
 const primary=unres[0];
 const ghl=input.evidence.filter(x=>x&&x.source==='ghl'&&x.email===primary&&(x.name??'').trim()).sort((a,b)=>(a.ref??'').localeCompare(b.ref??''))[0];
 let name=ghl?.name?.trim()||initcap(primary.split('@')[0].split('+')[0].replace(/[._-]+/g,' ').trim());
 if(!name)name='New client';
 const company=ghl?.company?.trim()||(isPersonalDomain(domainOf(primary))?null:domainOf(primary));
 const client='new-'+(slug(name)||'client')+'-'+(await md5(primary)).slice(0,6);
 return {outcome:'new',state:'mapped',client,confidence:'provisional',reason:`No record of ${unres.join(', ')} anywhere; provisional new client`,participants:items,newClient:{client,name:name.slice(0,200),company,emails:unres}};
}

// ---------------------------------------------------------------- evidence sources (collector)
export type GhlContact={id?:string;email?:string|null;additionalEmails?:unknown;firstName?:string|null;lastName?:string|null;contactName?:string|null;companyName?:string|null;tags?:unknown};
export type EvidenceSources={
 ghl?:{byEmail:Map<string,EvidenceItem[]>;coverage:string};
 callNotes?:{byEmail:Map<string,EvidenceItem[]>;coverage:string};
 clientFolders?:{byEmail:Map<string,EvidenceItem[]>;byDomain:Map<string,EvidenceItem[]>;coverage:string};
};
const push=<T>(m:Map<string,T[]>,k:string,v:T)=>{const a=m.get(k);if(a)a.push(v);else m.set(k,[v])};
const text=(v:unknown,max=200)=>typeof v==='string'?v.trim().slice(0,max):'';

/**
 * Exact-email index over the existing ghl-bridge's /contacts response. Read only, loopback only,
 * no new credential: the bridge holds its own key. The bridge has no email query, so coverage is
 * reported as the first N contacts and an absent match is never evidence of a new client by itself.
 */
export async function ghlContactIndex(url:string,fetchImpl:typeof fetch=fetch,limit=100,timeoutMs=5000):Promise<NonNullable<EvidenceSources['ghl']>>{
 const u=new URL(url);
 if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('ghl_bridge_loopback_required');
 u.pathname='/contacts';u.search='?limit='+limit;
 const byEmail=new Map<string,EvidenceItem[]>();
 try{
  const r=await fetchImpl(u.toString(),{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)return {byEmail,coverage:'unavailable'};
  const body=await r.json() as {contacts?:GhlContact[]};
  const contacts=Array.isArray(body?.contacts)?body.contacts:[];
  for(const c of contacts){
   const emails=[c.email,...(Array.isArray(c.additionalEmails)?c.additionalEmails:[])].map(e=>typeof e==='string'?normalEmail(e):typeof e==='object'&&e&&typeof (e as {email?:unknown}).email==='string'?normalEmail((e as {email:string}).email):'').filter(e=>EMAIL.test(e));
   const name=text(c.contactName)||[text(c.firstName),text(c.lastName)].filter(Boolean).join(' ');
   const tags=Array.isArray(c.tags)?c.tags.filter((t):t is string=>typeof t==='string').map(t=>t.slice(0,80)).slice(0,20):[];
   for(const email of new Set(emails))push(byEmail,email,{email,source:'ghl',ref:text(c.id,80),...(name?{name}:{}),...(text(c.companyName)?{company:text(c.companyName)}:{}),tags});
  }
  return {byEmail,coverage:contacts.length>=limit?`first-${limit}-contacts`:'complete'};
 }catch{return {byEmail,coverage:'unavailable'}}
}

/** Front matter only (attendees, title, fireflies_id). No transcript body is read past 8 KiB. */
export async function callNotesIndex(dir:string,maxPerEmail=10):Promise<NonNullable<EvidenceSources['callNotes']>>{
 const byEmail=new Map<string,EvidenceItem[]>();
 let names:string[];
 try{names=(await readdir(dir)).filter(n=>n.endsWith('.md')).sort().reverse()}catch{return {byEmail,coverage:'unavailable'}}
 for(const n of names){
  let head:string;
  try{const fh=await import('node:fs/promises').then(f=>f.open(join(dir,n),'r'));try{const b=Buffer.alloc(8192);const {bytesRead}=await fh.read(b,0,8192,0);head=b.subarray(0,bytesRead).toString('utf8')}finally{await fh.close()}}catch{continue}
  const fm=/^---\n([\s\S]*?)\n---/.exec(head);if(!fm)continue;
  const field=(k:string)=>new RegExp(`^${k}:(.*)$`,'m').exec(fm[1])?.[1].trim()??'';
  const attendees=field('attendees').replace(/^\[|\]$/g,'').split(',').map(x=>normalEmail(x.replace(/^["']|["']$/g,''))).filter(e=>EMAIL.test(e));
  const ref=field('fireflies_id').replace(/^["']|["']$/g,'').slice(0,80);
  const titleTokens=[...new Set(field('title').toLowerCase().match(/[a-z0-9]+/g)??[])].slice(0,40);
  if(!ref||!titleTokens.length)continue;
  for(const email of new Set(attendees)){const a=byEmail.get(email);if(a&&a.length>=maxPerEmail)continue;push(byEmail,email,{email,source:'call_notes',ref,titleTokens})}
 }
 return {byEmail,coverage:`${names.length}-notes`};
}

/** client-work/<dir>/client.json: {"client":"key","emails":[...],"domains":[...]}. Nothing else is read. */
export async function clientFolderIndex(dir:string):Promise<NonNullable<EvidenceSources['clientFolders']>>{
 const byEmail=new Map<string,EvidenceItem[]>(),byDomain=new Map<string,EvidenceItem[]>();
 let dirs:string[];
 try{dirs=(await readdir(dir)).sort()}catch{return {byEmail,byDomain,coverage:'unavailable'}}
 let records=0;
 for(const d of dirs){
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(d))continue;
  const f=join(dir,d,'client.json');
  try{if(!(await stat(f)).isFile()||(await stat(f)).size>16384)continue}catch{continue}
  let rec:{client?:unknown;emails?:unknown;domains?:unknown};
  try{rec=JSON.parse(await readFile(f,'utf8'))}catch{continue}
  const client=typeof rec.client==='string'&&/^[a-z0-9][a-z0-9-]{0,119}$/.test(rec.client)?rec.client:null;if(!client)continue;records++;
  for(const e of Array.isArray(rec.emails)?rec.emails:[])if(typeof e==='string'&&EMAIL.test(normalEmail(e))){const email=normalEmail(e);push(byEmail,email,{email,source:'client_folder',ref:d,client,matchedOn:'email'})}
  for(const x of Array.isArray(rec.domains)?rec.domains:[])if(typeof x==='string'&&/^[a-z0-9.-]+\.[a-z]{2,}$/.test(x.trim().toLowerCase())&&!isPersonalDomain(x.trim().toLowerCase())){const domain=x.trim().toLowerCase();push(byDomain,domain,{email:'',source:'client_folder',ref:d,client,matchedOn:'domain',domain})}
 }
 return {byEmail,byDomain,coverage:`${records}-records`};
}

/** Facts for one catalog row. Organizer excluded; bounded; never throws. */
export function evidenceFor(row:{id?:string;organizer?:string|null;participants?:string[]},sources:EvidenceSources,maxItems=200):ClientEvidence{
 const coverage:Record<string,string>={ghl:sources.ghl?.coverage??'not_configured',callNotes:sources.callNotes?.coverage??'not_configured',clientFolders:sources.clientFolders?.coverage??'not_configured'};
 const items:EvidenceItem[]=[];
 const organizer=row.organizer?normalEmail(row.organizer):'';
 for(const p of sorted((row.participants??[]).map(normalEmail).filter(e=>EMAIL.test(e)&&e!==organizer))){
  items.push(...(sources.ghl?.byEmail.get(p)??[]));
  // A note of this same call is not prior evidence.
  items.push(...(sources.callNotes?.byEmail.get(p)??[]).filter(e=>e.ref!==row.id));
  items.push(...(sources.clientFolders?.byEmail.get(p)??[]));
  items.push(...(sources.clientFolders?.byDomain.get(domainOf(p))??[]).map(e=>({...e,email:p})));
 }
 return {coverage,items:items.slice(0,maxItems)};
}

/**
 * Wraps the collector's RPC: catalog and refresh_metadata rows gain `clientEvidence`; every other
 * action and every other field is passed through unchanged. The hosted wrapper strips the field
 * before the 026 body runs, so stored catalog rows and metadata hashes are unaffected.
 */
export function withClientEvidence(rpc:Rpc,load:()=>Promise<EvidenceSources>):Rpc{
 let cached:Promise<EvidenceSources>|undefined;
 const sources=()=>cached??=load().catch(()=>({} as EvidenceSources));
 const attach=async(row:unknown)=>{
  if(!row||typeof row!=='object'||Array.isArray(row))return row;
  const r=row as {id?:string;live?:boolean;organizer?:string|null;participants?:string[]};
  if(r.live===true||!Array.isArray(r.participants)||!r.participants.length)return row;
  try{return {...r,clientEvidence:evidenceFor(r,await sources())}}catch{return {...r,clientEvidence:{coverage:{collector:'error'},items:[]}}}
 };
 return async(action,payload)=>{
  if(action==='catalog'&&Array.isArray(payload.meetings))return rpc(action,{...payload,meetings:await Promise.all(payload.meetings.map(attach))});
  if(action==='refresh_metadata'&&payload.meeting)return rpc(action,{...payload,meeting:await attach(payload.meeting)});
  return rpc(action,payload);
 };
}

export type ClientMappingConfig={ghlUrl?:string;callsDir?:string;clientWorkDir?:string};
export function clientMappingConfig(v:unknown):ClientMappingConfig|null{
 if(v===undefined||v===null)return null;
 if(typeof v!=='object'||Array.isArray(v))throw Error('client_mapping_config_invalid');
 const c=v as Record<string,unknown>;
 for(const k of Object.keys(c))if(!['ghlUrl','callsDir','clientWorkDir'].includes(k))throw Error('client_mapping_config_invalid');
 for(const k of ['callsDir','clientWorkDir'])if(c[k]!==undefined&&(typeof c[k]!=='string'||!(c[k] as string).startsWith('/')))throw Error('client_mapping_config_invalid');
 if(c.ghlUrl!==undefined){if(typeof c.ghlUrl!=='string')throw Error('client_mapping_config_invalid');const u=new URL(c.ghlUrl);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('client_mapping_config_invalid')}
 return c as ClientMappingConfig;
}
export async function loadEvidenceSources(c:ClientMappingConfig,fetchImpl:typeof fetch=fetch):Promise<EvidenceSources>{
 const [ghl,callNotes,clientFolders]=await Promise.all([
  c.ghlUrl?ghlContactIndex(c.ghlUrl,fetchImpl):undefined,
  c.callsDir?callNotesIndex(c.callsDir):undefined,
  c.clientWorkDir?clientFolderIndex(c.clientWorkDir):undefined]);
 return {...(ghl?{ghl}:{}),...(callNotes?{callNotes}:{}),...(clientFolders?{clientFolders}:{})};
}
