/** Ingestion only. No client-homework processor, sends, automatic task acceptance or model default. */
import {createHash} from 'node:crypto';
import {passageCommitmentKey} from '../commitments/key.ts';
export const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export type Passage={speaker:string;text:string;start:number|null;end:number|null};
export type MeetingSource={id:string;title:string;instant:string;live:boolean;passages:Passage[];summary:string;revision:string};
export type Proposal={key:string;title:string;kind:'promise'|'request'|'suggestion';quote:string;speaker:string;start:number|null;end:number|null;provenance:'transcript'|'provider_summary';suggestedResponsibility:string|null;due:string|null;dueQuote:string|null;uncertainty:string;sourceRevision:string};
export function normalize(raw:Record<string,unknown>):MeetingSource{
 if(typeof raw.id!=='string'||! /^[A-Za-z0-9_-]{1,180}$/.test(raw.id))throw Error('Invalid stable provider id');
 const instant=new Date(typeof raw.date==='number'?raw.date:String(raw.date)).toISOString();
 if(typeof raw.title!=='string'||typeof raw.is_live!=='boolean')throw Error('Missing title/completed status');
 const rows=raw.sentences;
 if(rows!=null&&!Array.isArray(rows))throw Error('Malformed transcript');
 const passages=(rows||[]).map((u:Record<string,unknown>)=>{
  if(typeof u.speaker_name!=='string'||typeof u.text!=='string')throw Error('Partial transcript cannot be accepted');
  const start=typeof u.start_time==='number'&&Number.isFinite(u.start_time)?u.start_time:null;
  const end=typeof u.end_time==='number'&&Number.isFinite(u.end_time)?u.end_time:null;
  return {speaker:u.speaker_name,text:u.text,start,end};
 });
 const summary=String((raw.summary as Record<string,unknown>|null)?.action_items||'');
 const content={id:raw.id,title:raw.title,instant,live:raw.is_live,passages,summary};
 return {...content,revision:hash(content)};
}
/** Strict output boundary for a separately authorized extractor. No model-selected person keys. */
export function validateExtraction(source:MeetingSource,raw:unknown):Proposal[]{
 const result=raw as {reviewedAll?:boolean;coverage?:{sourceRevision?:string;passageCount?:number;completeTranscript?:boolean};items?:Proposal[]};
 if(source.live||!source.passages.length||result?.coverage?.completeTranscript!==true||result.coverage.sourceRevision!==source.revision||result.coverage.passageCount!==source.passages.length)throw Error('Complete transcript and matching source coverage receipt required');
 if(result?.reviewedAll!==true||!Array.isArray(result.items)||result.items.length>100)throw Error('Full-source extraction receipt required');
 const seen=new Set<string>();
 return result.items.map(p=>{
  if(!p||typeof p.speaker!=='string'||(p.suggestedResponsibility!==null&&typeof p.suggestedResponsibility!=='string')||(p.due!==null&&typeof p.due!=='string')||(p.dueQuote!==null&&typeof p.dueQuote!=='string')||!['promise','request','suggestion'].includes(p.kind)||!['transcript','provider_summary'].includes(p.provenance)||typeof p.title!=='string'||!p.title.trim()||p.title.length>300||typeof p.quote!=='string'||!p.quote.trim()||p.quote.length>2000||typeof p.uncertainty!=='string')throw Error('Invalid proposal');
  if(p.provenance==='transcript'){
   const match=source.passages.filter(u=>u.speaker===p.speaker&&u.text.includes(p.quote)&&u.start===p.start&&u.end===p.end);
   if(match.length!==1)throw Error('Unambiguous actual source passage required');
  }else if(!source.summary.includes(p.quote)||p.kind!=='suggestion'||p.start!==null||p.end!==null)throw Error('Summary provenance cannot assert a transcript promise');
  if(p.due!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(p.due)||new Date(p.due).toISOString().slice(0,10)!==p.due||!p.dueQuote||!p.quote.includes(p.dueQuote)||!p.dueQuote.includes(p.due)))throw Error('A supported exact civil date or null is required');
  const key=passageCommitmentKey({provider:p.provenance==='transcript'?'fireflies':'fireflies-summary',sourceId:source.id,speakerKey:p.speaker,passageText:p.quote});
  if(seen.has(key))throw Error('Duplicate passage in extraction');seen.add(key);
  return {key,title:p.title,kind:p.kind,quote:p.quote,speaker:p.speaker,start:p.start,end:p.end,provenance:p.provenance,uncertainty:p.uncertainty,due:p.due,dueQuote:p.dueQuote,sourceRevision:source.revision,suggestedResponsibility:p.suggestedResponsibility||null};
 });
}
export type Rpc=(action:string,payload:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export type CatalogEntry={id:string;title:string;instant:string;live:boolean;accountId?:string|null;organizer?:string|null;domains?:unknown[];participants?:string[]};
export class SourceReadError extends Error { reason:string;constructor(reason:string){super(reason);this.reason=reason} }
export class GlobalIntakeError extends Error {}
export interface Catalog {metadata?(id:string):Promise<CatalogEntry>;page(start:string,end:string,skip:number):Promise<CatalogEntry[]>;source(id:string):Promise<Record<string,unknown>>}
/** Offset APIs have no snapshot token. Repeat the entire fixed window and require a stable ID set. */
export async function enumerate(catalog:Catalog,start:string,end:string,maxPages=100,signal?:AbortSignal):Promise<CatalogEntry[]>{
 const starts=Date.parse(start),ends=Date.parse(end);if(!Number.isFinite(starts)||!Number.isFinite(ends)||ends<=starts)throw Error('Invalid catalog window');
 async function scan(){const ids=new Map<string,CatalogEntry>();for(let page=0;page<maxPages;page++){
  if(signal?.aborted)throw Error('Catalog cancelled');const rows=await catalog.page(start,end,page*50);if(rows.length>50)throw Error('Invalid page size');
  for(const m of rows){if(ids.has(m.id))throw Error('Catalog shifted during pagination');const instant=Date.parse(m.instant);if(!Number.isFinite(instant))throw Error('Invalid catalog timestamp');if(instant>=starts&&instant<ends)ids.set(m.id,m)}
  if(rows.length<50)return [...ids.values()].sort((a,b)=>a.id.localeCompare(b.id));
 }throw Error('Catalog page cap reached; coverage incomplete')}
 const a=await scan(),b=await scan();if(hash(a)!==hash(b))throw Error('Catalog changed; rescan whole window');return b;
}
