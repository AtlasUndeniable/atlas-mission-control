/**
 * Pure presentation for the client-mapping exceptions shown above the board (Lane N, 029).
 * No React, no fetch, no env. The hosted RPC decides who may see and resolve these; this file
 * only shapes what it returned and never invents a client or a choice it did not offer.
 */
export type MappingParticipant={email:string;resolved:string|null;note:string|null;candidates:string[]};
export type MappingItem={mapping:string;badge:'needs_client'|'new_client';title:string;instant:string;outcome:string;client:string|null;clientName:string|null;company:string|null;confidence:string;reason:string;decidedBy:string;decidedAt:string;participants:MappingParticipant[]};
export type MappingClient={client:string;name:string;status:string};
export type MappingList={items:MappingItem[];clients:MappingClient[]};
export const BADGE_LABEL:Record<MappingItem['badge'],string>={needs_client:'Needs a client',new_client:'New client'};
export const MAPPING_ACTIONS=['choose_existing','confirm_new','mark_internal'] as const;
export type MappingAction=typeof MAPPING_ACTIONS[number];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const str=(v:unknown,max=600)=>typeof v==='string'?v.slice(0,max):'';
const nullable=(v:unknown,max=200)=>typeof v==='string'&&v?v.slice(0,max):null;

/** Defensive parse: anything malformed is dropped rather than shown half-formed. */
export function parseMappingList(v:unknown):MappingList{
 const o=(v&&typeof v==='object'?v:{}) as {items?:unknown;clients?:unknown};
 const items=(Array.isArray(o.items)?o.items:[]).flatMap((x):MappingItem[]=>{
  if(!x||typeof x!=='object')return [];
  const i=x as Record<string,unknown>;
  if(typeof i.mapping!=='string'||!UUID.test(i.mapping)||(i.badge!=='needs_client'&&i.badge!=='new_client'))return [];
  const participants=(Array.isArray(i.participants)?i.participants:[]).flatMap((p):MappingParticipant[]=>{
   if(!p||typeof p!=='object'||typeof (p as {email?:unknown}).email!=='string')return [];
   const q=p as Record<string,unknown>;
   return [{email:str(q.email,320),resolved:nullable(q.resolved,120),note:nullable(q.note,600),candidates:(Array.isArray(q.candidates)?q.candidates:[]).filter((c):c is string=>typeof c==='string').slice(0,20)}];
  });
  return [{mapping:i.mapping,badge:i.badge,title:str(i.title,300)||'Untitled call',instant:str(i.instant,40),outcome:str(i.outcome,40),client:nullable(i.client,120),clientName:nullable(i.clientName),company:nullable(i.company),confidence:str(i.confidence,20),reason:str(i.reason),decidedBy:str(i.decidedBy,120),decidedAt:str(i.decidedAt,40),participants}];
 });
 const clients=(Array.isArray(o.clients)?o.clients:[]).flatMap((x):MappingClient[]=>{
  if(!x||typeof x!=='object')return [];const c=x as Record<string,unknown>;
  return typeof c.client==='string'&&c.client?[{client:c.client,name:str(c.name,200)||c.client,status:str(c.status,20)||'confirmed'}]:[];
 });
 return {items,clients};
}

/** One plain line for the panel heading. Empty string when there is nothing to do. */
export function mappingHeadline(list:MappingList):string{
 const need=list.items.filter(i=>i.badge==='needs_client').length,fresh=list.items.filter(i=>i.badge==='new_client').length;
 const parts=[need?`${need} ${need===1?'call needs':'calls need'} a client`:'',fresh?`${fresh} new ${fresh===1?'client':'clients'} to confirm`:''].filter(Boolean);
 return parts.join(' · ');
}

/** Existing, confirmed clients only; the call's own candidates first. Never a provisional one. */
export function clientChoices(item:MappingItem,clients:MappingClient[]):MappingClient[]{
 const confirmed=clients.filter(c=>c.status==='confirmed'&&c.client!==item.client);
 const cand=new Set(item.participants.flatMap(p=>p.candidates));
 return [...confirmed.filter(c=>cand.has(c.client)),...confirmed.filter(c=>!cand.has(c.client)).sort((a,b)=>a.name.localeCompare(b.name))];
}

/**
 * Which people a "use this client" choice should remember as that client: those who already
 * pointed at it, and those with no evidence at all. Anyone whose evidence pointed elsewhere is
 * not silently re-affiliated; the choice still maps the call.
 */
export function rememberFor(item:MappingItem,client:string):string[]{
 return item.participants.filter(p=>p.candidates.includes(client)||(!p.candidates.length&&!p.resolved)).map(p=>p.email);
}
/** For "this is a new client": the people with no record, preselected. */
export function newClientDefaults(item:MappingItem):string[]{
 return item.participants.filter(p=>!p.candidates.length&&!p.resolved).map(p=>p.email);
}

/** Validates a resolve request before it leaves the browser or the route. */
export function validMappingRequest(body:unknown):{action:MappingAction;payload:{mapping:string;client?:string;name?:string;emails?:string[]}}|null{
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const b=body as {action?:unknown;payload?:unknown};
 if(!MAPPING_ACTIONS.includes(b.action as MappingAction)||!b.payload||typeof b.payload!=='object'||Array.isArray(b.payload))return null;
 const p=b.payload as Record<string,unknown>;
 for(const k of Object.keys(p))if(!['mapping','client','name','emails'].includes(k))return null;
 if(typeof p.mapping!=='string'||!UUID.test(p.mapping))return null;
 if(p.client!==undefined&&(typeof p.client!=='string'||!/^[a-z0-9][a-z0-9-]{0,119}$/.test(p.client)))return null;
 if(p.name!==undefined&&(typeof p.name!=='string'||p.name.length>200))return null;
 if(p.emails!==undefined&&(!Array.isArray(p.emails)||p.emails.length>20||!p.emails.every(e=>typeof e==='string'&&e.length<=320&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))))return null;
 if(b.action==='choose_existing'&&!p.client)return null;
 if(b.action==='mark_internal'&&!(p.emails as string[]|undefined)?.length)return null;
 return {action:b.action as MappingAction,payload:p as {mapping:string;client?:string;name?:string;emails?:string[]}};
}
