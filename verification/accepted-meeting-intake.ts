/** Ingestion only. No client-homework processor, sends, automatic task acceptance or model default. */
import {createHash} from 'node:crypto';
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
