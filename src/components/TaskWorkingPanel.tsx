'use client';
import {operationId} from '@/lib/operation-id';
import {useCallback,useEffect,useRef,useState} from 'react';
import s from './TaskWorkingPanel.module.css';
type Version={version:number;hash:string;at:string};
type State={available:boolean;recoverable?:boolean;cancellable?:boolean;reason?:string;title?:string;status?:string;revision:number;currentVersion:number;owner?:string;executor?:string;reviewer?:string;rights?:string[];versions?:Version[];events?:{actor:string;action:string;note:string;version:number;at:string}[];packet?:{entries:{id:string;title:string;text:string}[];missingContext:string[]}};
const labels:Record<string,string>={authority_changed:'Authority changed · operator review required',ready:'Ready to draft',building:'Generation reserved',uncertain:'Outcome uncertain · reconciliation required',rejected:'Response rejected · review required',cancelled:'Cancelled · invocation retained',draft:'Draft ready · review required',needs_revision:'Correction recorded · ready for v2',in_review:'With reviewer',accepted:'Reviewed · internal work complete'};
export default function TaskWorkingPanel({taskId,onChanged}:{taskId:string;onChanged:()=>Promise<void>}){
 const [open,setOpen]=useState(false),[data,setData]=useState<State|null>(null),[error,setError]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[generationPending,setGenerationPending]=useState(false),[cancelPending,setCancelPending]=useState(false),[artifact,setArtifact]=useState<{version:number;content:string;hash:string}|null>(null);
 const pending=useRef({generation:false,action:false,cancel:false}),messageEpoch=useRef(0);
 const epoch=useRef(0),alive=useRef(true),authority=useRef(''),dialog=useRef<HTMLDialogElement>(null);const url='/api/board/meetings/document?taskId='+encodeURIComponent(taskId);
 const read=useCallback(async()=>{const n=++epoch.current;try{const r=await fetch(url,{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);if(alive.current&&n===epoch.current){const stamp=JSON.stringify([d.packet?.fingerprint,d.revision]);if(authority.current!==stamp)setArtifact(null);authority.current=stamp;setData(d);setError('')}}catch(e){if(alive.current&&n===epoch.current){setData(null);setArtifact(null);setError(e instanceof Error?e.message:'Status unavailable')}}},[url]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
 useEffect(()=>{if(!open)return;void read();const focus=()=>void read();window.addEventListener('focus',focus);const timer=setInterval(()=>{if(document.visibilityState==='visible')void read()},5000);return()=>{clearInterval(timer);window.removeEventListener('focus',focus)}},[open,read]);
 async function view(version:number){setArtifact(null);const n=epoch.current;try{const r=await fetch(url+'&version='+version,{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);if(alive.current&&n===epoch.current)setArtifact(d)}catch(e){setError(e instanceof Error?e.message:'Version unavailable')}}
 async function act(action:string){
  if(!data)return;
  const kind=action==='build'?'generation':action==='cancel'?'cancel':'action';
  // Synchronous guards also cover rapid clicks before React commits disabled controls.
  if(pending.current.action||pending.current.cancel||(kind!=='cancel'&&pending.current.generation)||(kind==='cancel'&&!data.cancellable))return;
  pending.current[kind]=true;
  const setPending=kind==='generation'?setGenerationPending:kind==='cancel'?setCancelPending:setBusy;
  setPending(true);const message=++messageEpoch.current;setError('');const current=data.versions?.find(v=>v.version===data.currentVersion);try{
  const r=await fetch('/api/board/meetings/document',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId,action,operationId:operationId(),revision:data.revision,...(current?{version:current.version,hash:current.hash}:{}),...(note.trim()?{note}: {})})});const d=await r.json();if(!r.ok)throw Error(d.error);if(message===messageEpoch.current){setNote('');setArtifact(null)}await read();await onChanged();
 }catch(e){await read();if(message===messageEpoch.current)setError(e instanceof Error?e.message:'Outcome unconfirmed. Check saved status before acting.')}finally{pending.current[kind]=false;setPending(false)}}
 const right=(r:string)=>!!data?.rights?.includes(r);const state=data?.status;const conflicting=busy||generationPending||cancelPending;const writable=!conflicting&&note.trim().length>=10;
 return <section data-task-id={taskId} className={s.panel} aria-label="Task working draft"><button className={s.open} onClick={()=>setOpen(x=>!x)} aria-expanded={open}>{open?'Close working draft':'Open working draft'} <span>Context · versions · review</span></button><dialog ref={dialog} className={s.dialog} onCancel={e=>{e.preventDefault();setOpen(false)}} aria-label="Working draft for this task">{open&&<div className={s.body}>
 <div className={s.heading}><h3>{data?.title||'Working draft'}</h3><button onClick={()=>setOpen(false)}>Close</button><button onClick={()=>void read()}>Check status</button></div><p className={s.muted}>One task, with preserved drafts and corrections. Status checks never generate or send a file.</p>
 {error&&<p role="alert" className={s.warning}>{error}</p>}{!data&&!error&&<p>Loading permitted task context…</p>}
 {data&&!data.available&&<p className={s.warning}>{data.reason}</p>}
 {data?.available&&<><p className={s.status}>{data.recoverable?'Response recorded · ready to reconcile':labels[state||'']||state}</p><div className={s.people}><span>Owner <b>{data.owner}</b></span><span>Executor <b>{data.executor}</b></span><span>Reviewer <b>{data.reviewer}</b></span></div>
 {(generationPending||state==='cancelled')&&<p role="status" className={s.muted}>{state==='cancelled'?'Publication cancelled; the attempt and spent invocation remain.':'Generation request pending.'} An already dispatched provider request may still finish.</p>}
 <p className={s.muted}>Atlas assists with drafting. Only the named reviewer completes this internal work. No external delivery is authorized here.</p>
 {data.packet?.missingContext.length!==0&&<div className={s.warning}>Missing context: {data.packet?.missingContext.join('; ')}</div>}
 <details><summary>Permitted context</summary>{data.packet?.entries.map(e=><blockquote key={e.id}><strong>{e.title}</strong><p>{e.text}</p></blockquote>)}</details>
 <div className={s.versions}><h4>Preserved versions</h4>{data.versions?.length===0&&<p>No draft is available under the current authority.</p>}{data.versions?.map(v=><div key={v.version}><button onClick={()=>void view(v.version)}>Read v{v.version}</button><a href={url+'&version='+v.version+'&download=1'}>Download v{v.version}</a><details><summary>Integrity details</summary><code>{v.hash}</code></details></div>)}</div>
 {artifact&&<div className={s.artifact}><h4>Version {artifact.version}</h4><div className={s.document}>{artifact.content.split('\n\n').map((block,i)=>/^#{1,3} /.test(block)?<h4 key={i}>{block.replace(/^#{1,3} /,'')}</h4>:<p key={i}>{block}</p>)}</div></div>}
 {right('build')&&['ready','needs_revision'].includes(state||'')&&<button className={s.primary} disabled={conflicting} onClick={()=>void act('build')}>{generationPending?'Working…':data.currentVersion?'Build corrected draft':'Build permitted draft'}</button>}
 {right('build')&&data.recoverable&&<button disabled={conflicting} onClick={()=>void act('build')}>Reconcile saved response · no new generation</button>}
 {right('build')&&data.cancellable&&<button disabled={busy||cancelPending} onClick={()=>void act('cancel')}>{cancelPending?'Cancelling publication…':'Cancel publication'}</button>}
 {['draft','in_review'].includes(state||'')&&<><label className={s.note}>Task-safe correction or review note<textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Describe the substantive change or why this exact version is ready. Shared with the permitted task audience."/></label><div className={s.actions}>
 {right('revise')&&<button disabled={!writable} onClick={()=>void act('revise')}>Request substantive correction</button>}
 {right('handoff')&&state==='draft'&&<button className={s.primary} disabled={!writable} onClick={()=>void act('handoff')}>Hand v{data.currentVersion} to reviewer</button>}
 {right('review')&&state==='in_review'&&<button className={s.primary} disabled={!writable} onClick={()=>void act('review')}>Accept v{data.currentVersion} & complete internal work</button>}</div></>}
 <details><summary>Draft and review history</summary>{data.events?.map((e,i)=><p key={i}><b>{e.actor} · {e.action}{e.version?' · v'+e.version:''}</b><br/>{e.note}</p>)}</details>
 </>}
 </div>}</dialog></section>
}
