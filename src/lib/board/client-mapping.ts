/**
 * Pure presentation for the client-mapping items shown above the board (Lane N2, 029).
 * No React, no fetch, no env. The hosted RPC decides who may see and resolve these; this file
 * only shapes what it returned and never invents a client or a choice it did not offer.
 *
 * Badges:
 *  - assigned:     mapped automatically by an exact approved identity; "Change client" only.
 *  - suggested:    Held; one-click "Confirm suggested client", or "Change client".
 *  - needs_client: Held; ambiguous, unrecognised or incomplete evidence, with the real reason.
 *  - new_client:   a person created it; drafting is shared-method-only until confirmed.
 */
export type MappingParticipant={email:string;resolved:string|null;suggestion:string|null;note:string|null};
export type MappingItem={mapping:string;badge:'assigned'|'suggested'|'needs_client'|'new_client';title:string;instant:string;outcome:string;client:string|null;clientName:string|null;company:string|null;confidence:string;reason:string;decidedBy:string;decidedAt:string;suggestions:string[];newClient:{name:string;company:string|null;emails:string[]}|null;participants:MappingParticipant[]};
export type MappingClient={client:string;name:string;status:string};
export type RereviewItem={request:string;title:string;recordedClient:string;currentClient:string};
export type MappingList={items:MappingItem[];clients:MappingClient[];rereview:RereviewItem[]};
export const BADGE_LABEL:Record<MappingItem['badge'],string>={assigned:'Client assigned',suggested:'Suggested client',needs_client:'Needs a client',new_client:'New client'};
export const MAPPING_ACTIONS=['choose_existing','confirm_suggested','confirm_new','mark_internal','rereview_request'] as const;
export type MappingAction=typeof MAPPING_ACTIONS[number];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY=/^[a-z0-9][a-z0-9-]{0,119}$/;
const EMAIL=/^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str=(v:unknown,max=600)=>typeof v==='string'?v.slice(0,max):'';
const nullable=(v:unknown,max=200)=>typeof v==='string'&&v?v.slice(0,max):null;
const BADGES=new Set(['assigned','suggested','needs_client','new_client']);

/** Defensive parse: anything malformed is dropped rather than shown half-formed. */
export function parseMappingList(v:unknown):MappingList{
 const o=(v&&typeof v==='object'?v:{}) as {items?:unknown;clients?:unknown;rereview?:unknown};
 const items=(Array.isArray(o.items)?o.items:[]).flatMap((x):MappingItem[]=>{
  if(!x||typeof x!=='object')return [];
  const i=x as Record<string,unknown>;
  if(typeof i.mapping!=='string'||!UUID.test(i.mapping)||!BADGES.has(i.badge as string))return [];
  const participants=(Array.isArray(i.participants)?i.participants:[]).flatMap((p):MappingParticipant[]=>{
   if(!p||typeof p!=='object'||typeof (p as {email?:unknown}).email!=='string')return [];
   const q=p as Record<string,unknown>;
   return [{email:str(q.email,320),resolved:nullable(q.resolved,120),suggestion:nullable(q.suggestion,120),note:nullable(q.note,600)}];
  });
  const suggestions=(Array.isArray(i.suggestions)?i.suggestions:[]).filter((c):c is string=>typeof c==='string'&&KEY.test(c)).slice(0,20);
  const nc=i.newClient&&typeof i.newClient==='object'?i.newClient as Record<string,unknown>:null;
  const newClient=nc&&typeof nc.name==='string'?{name:nc.name.slice(0,200),company:nullable(nc.company),emails:(Array.isArray(nc.emails)?nc.emails:[]).filter((e):e is string=>typeof e==='string'&&EMAIL.test(e)).slice(0,20)}:null;
  return [{mapping:i.mapping,badge:i.badge as MappingItem['badge'],title:str(i.title,300)||'Untitled call',instant:str(i.instant,40),outcome:str(i.outcome,40),client:nullable(i.client,120),clientName:nullable(i.clientName),company:nullable(i.company),confidence:str(i.confidence,20),reason:str(i.reason),decidedBy:str(i.decidedBy,120),decidedAt:str(i.decidedAt,40),suggestions,newClient,participants}];
 });
 const clients=(Array.isArray(o.clients)?o.clients:[]).flatMap((x):MappingClient[]=>{
  if(!x||typeof x!=='object')return [];const c=x as Record<string,unknown>;
  return typeof c.client==='string'&&c.client?[{client:c.client,name:str(c.name,200)||c.client,status:str(c.status,20)||'confirmed'}]:[];
 });
 const rereview=(Array.isArray(o.rereview)?o.rereview:[]).flatMap((x):RereviewItem[]=>{
  if(!x||typeof x!=='object')return [];const r=x as Record<string,unknown>;
  return typeof r.request==='string'&&UUID.test(r.request)?[{request:r.request,title:str(r.title,300)||'Untitled request',recordedClient:str(r.recordedClient,120),currentClient:str(r.currentClient,120)}]:[];
 });
 return {items,clients,rereview};
}

/** One plain line for the panel heading. Empty string when there is nothing to show. */
export function mappingHeadline(list:MappingList):string{
 const n=(b:MappingItem['badge'])=>list.items.filter(i=>i.badge===b).length;
 const need=n('needs_client'),sug=n('suggested'),fresh=n('new_client'),auto=n('assigned'),rr=list.rereview.length;
 return [need?`${need} ${need===1?'call needs':'calls need'} a client`:'',sug?`${sug} suggested ${sug===1?'client':'clients'} to confirm`:'',
  fresh?`${fresh} new ${fresh===1?'client':'clients'} to confirm`:'',rr?`${rr} ${rr===1?'task needs':'tasks need'} re-review after a client change`:'',
  auto?`${auto} ${auto===1?'call':'calls'} assigned automatically`:''].filter(Boolean).join(' · ');
}

/** "Change client" choices: existing clients, the call's suggestions first, never its current one or a merged one. */
export function clientChoices(item:MappingItem,clients:MappingClient[]):MappingClient[]{
 const usable=clients.filter(c=>(c.status==='confirmed'||c.status==='provisional')&&c.client!==item.client);
 const sug=new Set(item.suggestions);
 return [...usable.filter(c=>sug.has(c.client)),...usable.filter(c=>!sug.has(c.client)).sort((a,b)=>a.name.localeCompare(b.name))];
}
/** The one-click suggestion, only when the server offered exactly one. */
export function singleSuggestion(item:MappingItem):string|null{
 return item.badge==='suggested'&&item.suggestions.length===1?item.suggestions[0]:null;
}

/**
 * Which people a "change client" choice should remember as that client: those whose evidence
 * already pointed at it, and those with no evidence at all. Anyone whose evidence pointed
 * elsewhere is not silently re-affiliated; the choice still maps the call.
 */
export function rememberFor(item:MappingItem,client:string):string[]{
 return item.participants.filter(p=>p.resolved===client||p.suggestion===client||(!p.resolved&&!p.suggestion&&!p.note)).map(p=>p.email);
}
/** For "confirm new client": the proposal's people, else everyone with no record, preselected. */
export function newClientDefaults(item:MappingItem):string[]{
 return item.newClient?.emails.length?item.newClient.emails:item.participants.filter(p=>!p.resolved&&!p.suggestion).map(p=>p.email);
}

/** Validates a resolve request before it leaves the browser or the route. */
export function validMappingRequest(body:unknown):{action:MappingAction;payload:Record<string,unknown>}|null{
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const b=body as {action?:unknown;payload?:unknown};
 if(!MAPPING_ACTIONS.includes(b.action as MappingAction)||!b.payload||typeof b.payload!=='object'||Array.isArray(b.payload))return null;
 const p=b.payload as Record<string,unknown>;
 if(b.action==='rereview_request'){
  for(const k of Object.keys(p))if(!['request','note'].includes(k))return null;
  if(typeof p.request!=='string'||!UUID.test(p.request)||typeof p.note!=='string'||p.note.trim().length<10||p.note.length>500)return null;
  return {action:'rereview_request',payload:p};
 }
 for(const k of Object.keys(p))if(!['mapping','client','name','emails'].includes(k))return null;
 if(typeof p.mapping!=='string'||!UUID.test(p.mapping))return null;
 if(p.client!==undefined&&(typeof p.client!=='string'||!KEY.test(p.client)))return null;
 if(p.name!==undefined&&(typeof p.name!=='string'||p.name.length>200))return null;
 if(p.emails!==undefined&&(!Array.isArray(p.emails)||p.emails.length>20||!p.emails.every(e=>typeof e==='string'&&e.length<=320&&EMAIL.test(e))))return null;
 if((b.action==='choose_existing'||b.action==='confirm_suggested')&&!p.client)return null;
 if(b.action==='mark_internal'&&!(p.emails as string[]|undefined)?.length)return null;
 return {action:b.action as MappingAction,payload:p};
}
