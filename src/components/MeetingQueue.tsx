'use client';
import {operationId} from '@/lib/operation-id';
import MeetingCoverage from './MeetingCoverage';
import IntakeStrip from './IntakeStrip';
import ClientMappingPanel from './ClientMappingPanel';
import {useEffect,useMemo,useRef,useState} from 'react';
import styles from './MeetingQueue.module.css';
import type {ReactNode} from 'react';
import TaskWorkingPanel from './TaskWorkingPanel';
import {useBoardSnapshot} from './useBoardSnapshot';
import {useTaskDrafts} from './useTaskDrafts';
import {BOARD_STATUSES,BOARD_STATUS_LABEL,deriveBoardStatus,draftingBlock,nextAction,type DraftState} from '@/lib/board/task-status';
import {actorName as name,dueLabel,freshness,relativeTime,taskControls,customerSafeNote} from '@/lib/board/presentation';
type Candidate={key:string;title:string;quote:string;kind:string;provenance:string;suggestedResponsibility:string|null;uncertainty:string};
type Assignee={actor:string;review:boolean};
type Item={sharedCorrection?:string|null;sharedCorrectionRequired?:boolean;taskOnly?:boolean;assignees?:Assignee[];id:string;revision:number;sourceRevision?:string;reconciliationRequired?:boolean;title:string;due:string|null;owner:string|null;state:string;deferred:boolean;evidence:Candidate;task:null|{id:string;executor:string|null;next_reviewer:string|null;work_status:string;receipts:unknown}};
type Meeting={taskOnly?:boolean;id:string;title:string;instant:string;state:string;note:string;revision:string;sourceChanged:boolean;pending:Candidate[]|null;items:Item[];assignees:{actor:string;review:boolean}[]};
type Queue={capability:{actor:string;triage:boolean;review:boolean;rhysActor:string|null};meetings:Meeting[];coverage:{start:string;end:string;status:string;observedAt:string}[];coverageBoundary:string};
type Draft={title:string;owner:string;due:string;executor:string;reviewer:string};
type ItemDraft={local:{values:Draft;revision:number}|null;note:string;sharedNote:string;confirmationStamp:string|null};
/** A confirmed write, so a card can say what was saved and who saved it. */
type Receipt={action:string;actor:string;at:number};
const label=(key:string)=>({awaiting_source:'Waiting for the recording or summary',processing:'Being read',ready:'Read, ready for you',no_actions:'Nothing to do from this call',held:'Held for review',failed:'Needs another go',todo:'To do',needs_review:'Needs review',atlas_held:'Atlas preparation · held',completed:'Completed'}[key]||key);
const NAT_KEYS=['nat','fixture.nat'];
/**
 * Desktop column layout, one line for the install to pick.
 *  'wrap'  — the seven columns wrap, 4 + 3 at 1440px, whole board on screen.
 *  'track' — all seven stay on one row as a horizontal track that snaps
 *            column by column, so late columns are scrolled to, not wrapped.
 * The phone is one stacked column either way.
 */
const DESKTOP_COLUMNS:'wrap'|'track'='wrap';
export default function MeetingQueue({engineering=false}:{engineering?:boolean}){
 const {data,error:syncError,loading,fresh,checkedAt,refresh,pause,resume,readable}=useBoardSnapshot<Queue>();
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState('all'),[actorFilter,setActorFilter]=useState('all'),[context,setContext]=useState<Record<string,string>>({}),[saved,setSaved]=useState('');
 const draftCache=useRef(new Map<string,ItemDraft>());
 const receipts=useRef(new Map<string,Receipt>());
 const alive=useRef(true),epoch=useRef(0),mutation=useRef(false),previous=useRef('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++}},[]);
 useEffect(()=>{
  const stamp=JSON.stringify(data);
  if(previous.current!==stamp||!fresh){epoch.current++;setContext({});previous.current=stamp}
  const permitted=new Set(data?.meetings.flatMap(m=>m.items.map(i=>`${data.capability.actor}:${i.id}:${m.taskOnly?'limited':'full'}`))??[]);
  for(const key of draftCache.current.keys())if(!permitted.has(key))draftCache.current.delete(key);
  for(const key of receipts.current.keys())if(!permitted.has(key))receipts.current.delete(key);
 },[data,fresh]);
 const blocked=busy||!fresh;
 const taskIds=useMemo(()=>Array.from(new Set(data?.meetings.flatMap(m=>m.items.map(i=>i.task?.id)).filter((x):x is string=>!!x)??[])).sort(),[data]);
 // Draft state is read only while the board itself is readable, so a paused or
 // access-lost board never leaves stale draft badges on screen.
 const {drafts,refreshDrafts}=useTaskDrafts(taskIds,fresh&&readable.current,checkedAt);
 async function act(action:string,payload:Record<string,unknown>){const r=await fetch('/api/board/meetings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload:{...payload,operationId:operationId()}})});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
 /** One canonical write at a time. `receiptKey` records who saved what. */
 async function operate(action:string,payload:Record<string,unknown>,receiptKey?:string){
  if(mutation.current||!readable.current)return false;
  mutation.current=true;pause();epoch.current++;setBusy(true);setError('');
  try{
   await act(action,payload);
   setSaved('Saved');
   if(receiptKey&&data)receipts.current.set(receiptKey,{action,actor:data.capability.actor,at:Date.now()});
   refreshDrafts();await refresh();return true;
  }catch(e){await refresh();setError(e instanceof Error?e.message:'That did not save. Check the card before trying again.');return false}
  finally{mutation.current=false;resume();setBusy(false)}
 }
 /** Lane C's drafting path. Reads are separate; this is the only write into it. */
 async function draftAction(taskId:string,action:'build'|'revise'|'handoff'|'review',draft:DraftState,note?:string,receiptKey?:string){
  if(mutation.current||!readable.current)return false;
  mutation.current=true;pause();epoch.current++;setBusy(true);setError('');
  try{
   const current=draft.versions?.find(v=>v.version===draft.currentVersion);
   const r=await fetch('/api/board/meetings/document',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId,action,operationId:operationId(),revision:draft.revision??0,...(current&&current.hash?{version:current.version,hash:current.hash}:{}),...(note?.trim()?{note}:{})})});
   const d=await r.json();if(!r.ok)throw Error(d.error);
   setSaved('Saved');
   if(receiptKey&&data)receipts.current.set(receiptKey,{action,actor:data.capability.actor,at:Date.now()});
   refreshDrafts();await refresh();return true;
  }catch(e){refreshDrafts();await refresh();setError(e instanceof Error?e.message:'That did not save. Check the card before trying again.');return false}
  finally{mutation.current=false;resume();setBusy(false)}
 }
 function visible(i:Item){
  const actors=[i.owner,i.task?.executor,i.task?.next_reviewer];
  const match=actorFilter==='all'||(actorFilter==='rhys'?!!data?.capability.rhysActor&&actors.includes(data.capability.rhysActor):actors.some(a=>a&&name(a).toLowerCase()===actorFilter));
  if(!match)return false;
  if(filter==='deferred')return i.deferred&&i.state==='pending_approval';
  if(filter==='dismissed')return i.state==='declined';
  if(filter==='review')return i.reconciliationRequired||i.task?.work_status==='needs_review'||(!i.task&&i.state==='pending_approval'&&!i.deferred);
  return !i.deferred&&i.state!=='declined';
 }
 const statusOf=(i:Item,m:Meeting)=>deriveBoardStatus({hasTask:!!i.task,workStatus:i.task?.work_status,executor:i.task?.executor,itemState:i.state,deferred:i.deferred,sourceChanged:m.sourceChanged,reconciliationRequired:i.reconciliationRequired,sharedCorrection:i.sharedCorrection,draft:i.task?drafts[i.task.id]??null:null});
 async function showContext(id:string,itemId?:string){if(!readable.current||mutation.current)return;const n=epoch.current;try{const r=await fetch('/api/board/meetings?sourceId='+encodeURIComponent(id)+(itemId?'&itemId='+encodeURIComponent(itemId):''),{cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error);if(!alive.current||n!==epoch.current)return;setContext(x=>({...x,[itemId||id]:[d.label,d.item?`${d.item.evidence.speaker} · ${d.item.evidence.start}–${d.item.evidence.end}s · passage ${d.item.evidence.passage}\n${d.item.evidence.quote}\n${d.item.evidence.uncertainty}`:'',d.source?.title, ...((d.source?.passages||[]).map((p:{speaker:string;text:string})=>p.speaker+': '+p.text)), d.source?.summary?'Provider summary: '+d.source.summary:'', 'Review history',...((d.history||[]).map((h:{actor:string;operation:string;created_at:string;input:{note?:string}})=>`${name(h.actor)} · ${h.operation} · ${new Date(h.created_at).toLocaleString()} · ${engineering?h.input.note||'':customerSafeNote(h.input.note)}`))].join('\n\n')}))}catch(e){if(alive.current&&n===epoch.current)setError(String(e))}}
 const entries=data?.meetings.flatMap(m=>m.items.filter(visible).map(i=>({m,i,s:statusOf(i,m)})))??[];
 /* Who the work can sit with, taken from the work itself rather than a fixed
    list, so a named person on this board always has a filter of their own. */
 const actorFilters=useMemo(()=>{
  const seen=new Map<string,string>();
  for(const m of data?.meetings??[])for(const i of m.items)for(const a of [i.owner,i.task?.executor,i.task?.next_reviewer])
   if(a)seen.set(name(a).toLowerCase(),name(a));
  const viewer=data?.capability.actor?name(data.capability.actor).toLowerCase():null;
  const keys=[...seen.keys()].sort((a,b)=>a===viewer?-1:b===viewer?1:a.localeCompare(b));
  return [['all','Everyone'] as const,...keys.map(k=>[k,seen.get(k)!] as const)];
 },[data]);
 const held=entries.filter(e=>e.s.status==='held');
 // Only an actor the queue trusts with triage sees call titles and recordings.
 const canSeeSources=!!data?.capability.triage&&!data.meetings.some(m=>m.taskOnly);
 return <main className={styles.page} data-view={engineering?'engineering':'team'}><header className={styles.header}><div className={styles.brand}><p className={styles.eyebrow}>UNDENIABLE</p><h1>{engineering?'Action Board · engineering detail':'Action Board'}</h1></div><div>{data&&<span>Signed in as {name(data.capability.actor)}</span>}<button disabled={busy||loading} onClick={()=>void refresh()}>{loading&&data?'Checking…':'Check for updates'}</button></div></header>
 <div className={styles.filterBar}><nav className={styles.tabs} aria-label="Who the work sits with">{actorFilters.map(([k,l])=><button key={k} aria-pressed={actorFilter===k} onClick={()=>{setActorFilter(k)}}>{l}</button>)}</nav><label className={styles.viewFilter}>Show<select value={filter} onChange={e=>{setFilter(e.target.value)}}><option value="all">Everything live</option><option value="review">Waiting on a person</option><option value="deferred">Parked</option><option value="dismissed">Decided against</option></select></label></div>
 {(error||syncError)&&<div role="alert" className={styles.error}><strong>{syncError?(data?'We could not check the board · actions are paused':'Board unavailable'):'That action was not confirmed'}</strong><p>{syncError||error}</p><button disabled={loading||busy} onClick={()=>void refresh()}>Try again</button></div>}<p role="status" className={styles.status}>{busy?'Saving…':fresh?saved:''}</p><p className={styles.sync} role="status">{fresh?`Checked ${checkedAt?new Date(checkedAt).toLocaleTimeString():''} · ${loading?'Checking…':'Updates on its own.'}`:checkedAt?`Last checked ${new Date(checkedAt).toLocaleTimeString()}. What you see may be out of date, so actions are paused.`:syncError?'Not checked yet. Try again when you have access.':'Checking what you are allowed to see…'}</p>
 {engineering?<MeetingCoverage/>:<IntakeStrip canSeeSources={canSeeSources}/>}
 {!engineering&&canSeeSources&&<ClientMappingPanel/>}
 {!data?(loading?<p role="status" className={styles.empty}>Loading your work…</p>:null):<>
 {engineering&&<details className={styles.coverage}><summary>Recent calls & coverage · {data.meetings.length} permitted entries</summary><p>{data.coverageBoundary}</p>{data.coverage.map(c=><p key={c.start+c.end}>{c.start.slice(0,10)} → {c.end.slice(0,10)} · {c.status} · checked {new Date(c.observedAt).toLocaleString()}</p>)}<p>Missing source is never “no actions”. Task-only access does not include the full recording.</p>
 {data.meetings.map(m=><section key={m.id} className={styles.meeting}><h2>{m.title}</h2><p>{new Date(m.instant).toLocaleString()} · {label(m.state)} · revision {m.revision}</p><p>{m.note}</p>{!m.taskOnly&&<button disabled={blocked} onClick={()=>void showContext(m.id)}>Full source & history</button>}{context[m.id]&&<pre className={styles.context}>{context[m.id]}</pre>}</section>)}
 </details>}
 {data.meetings.filter(m=>m.sourceChanged&&m.pending&&data.capability.triage).map(m=><details id={`source-review-${m.id}`} className={styles.revision} key={m.id+m.revision}><summary>The call this came from changed · {m.title}</summary><SourceReview meeting={m} busy={blocked} onSave={p=>operate('source_review',p)}/></details>)}
 {held.length>0&&<p className={styles.heldStrip} role="status"><b>{held.length} {held.length===1?'card is':'cards are'} held.</b> {held.length===1?'It cannot move until someone clears the reason on it.':'They cannot move until someone clears the reasons on them.'}</p>}
 {entries.length===0&&<p className={styles.empty}>Nothing matches this view. Change the filters above, or read the calls strip — an empty board is not the same as nothing to do.</p>}
 <div className={styles.board} data-layout={DESKTOP_COLUMNS}>{BOARD_STATUSES.map(key=>{const rows=entries.filter(({s})=>s.status===key);return <section className={styles.column} key={key} data-stage={key}><div className={styles.columnHeading}><h2>{BOARD_STATUS_LABEL[key]}</h2><span>{rows.length}</span></div>{rows.length===0&&<p className={styles.columnEmpty}>Nothing here</p>}{rows.map(({m,i,s})=><div key={`${data.capability.actor}:${i.id}:${m.taskOnly?'limited':'full'}`}>
 <ActionItem draftCache={draftCache.current} receipts={receipts.current} status={s} draft={i.task?drafts[i.task.id]??null:null} engineering={engineering} item={i} meeting={m} actor={data.capability.actor} triage={data.capability.triage} canReview={data.capability.review} controls={taskControls(data.capability,i.task)} busy={blocked} pauseReason={busy?'Wait for the current save to finish.':!fresh?'Check the board before continuing.':''} operate={operate} draftAction={draftAction} reviewSource={()=>{const el=document.getElementById(`source-review-${m.id}`) as HTMLDetailsElement|null;if(el){el.open=true;el.scrollIntoView({block:'center'});el.querySelector('select')?.focus()}}} sourceHistory={<><button disabled={blocked} onClick={()=>void showContext(m.id,m.taskOnly?i.id:undefined)}>Show what I am allowed to see</button>{context[m.taskOnly?i.id:m.id]&&<pre className={styles.context}>{context[m.taskOnly?i.id:m.id]}</pre>}</>}/>
 {i.task&&fresh&&engineering&&<TaskWorkingPanel taskId={i.task.id} onChanged={refresh}/>}
 </div>)}</section>})}</div>
 </>}
 <footer className={styles.footer}>Atlas is not switched on to do work by itself. Finishing a card does not send anything to anyone.{!engineering&&data?.capability.triage?' Hashes, versions and build details are on the engineering board.':''}</footer>
 </main>;
}
function ActionItem({draftCache,receipts,status:s,draft,engineering,item:i,meeting:m,actor,triage,canReview,controls,busy,pauseReason,sourceHistory,reviewSource,operate,draftAction}:{draftCache?:Map<string,ItemDraft>;receipts:Map<string,Receipt>;status:ReturnType<typeof deriveBoardStatus>;draft:DraftState|null;engineering:boolean;item:Item;meeting:Meeting;actor:string;triage:boolean;canReview:boolean;controls:ReturnType<typeof taskControls>;busy:boolean;pauseReason:string;sourceHistory:ReactNode;reviewSource:()=>void;operate:(a:string,p:Record<string,unknown>,k?:string)=>Promise<boolean>;draftAction:(t:string,a:'build'|'revise'|'handoff'|'review',d:DraftState,n?:string,k?:string)=>Promise<boolean>}){
 const cacheKey=`${actor}:${i.id}:${m.taskOnly?'limited':'full'}`;
 const [local,setLocal]=useState<{values:Draft;revision:number}|null>(()=>draftCache?.get(cacheKey)?.local??null),[note,setNote]=useState(()=>draftCache?.get(cacheKey)?.note??''),[sharedNote,setSharedNote]=useState(()=>draftCache?.get(cacheKey)?.sharedNote??''),[confirmationStamp,setConfirmationStamp]=useState<string|null>(()=>draftCache?.get(cacheKey)?.confirmationStamp??null);
 useEffect(()=>{draftCache?.set(cacheKey,{local,note,sharedNote,confirmationStamp})},[draftCache,cacheKey,local,note,sharedNote,confirmationStamp]);
 const historyRef=useRef<HTMLDetailsElement>(null);
 const [saveNotice,setSaveNotice]=useState('');
 const assignees=i.assignees??m.assignees;
 const ownerEligible=!!i.owner&&assignees.some(a=>a.actor===i.owner);
 const natActor=assignees.find(a=>NAT_KEYS.includes(a.actor))?.actor??null;
 const natEligible=!!natActor;
 function openHistory(){if(historyRef.current){historyRef.current.open=true;historyRef.current.scrollIntoView({block:'nearest'});historyRef.current.querySelector('summary')?.focus()}}
 const evidenceStamp=JSON.stringify([i.id,i.revision,i.sourceRevision,m.revision,i.evidence]);const confirmed=confirmationStamp===evidenceStamp;
 const dirty=local!==null;const draftValues=local?.values??{title:i.title,owner:i.owner||'',due:i.due||'',executor:i.task?.executor||'',reviewer:i.task?.next_reviewer||''};
 const base={sourceId:m.id,id:i.id,revision:local?.revision??i.revision};const terminal=i.state==='declined'||i.task?.work_status==='completed';const uncertain=i.evidence.kind!=='promise'||!!i.evidence.uncertainty;
 function field(k:keyof Draft,v:string){setSaveNotice('');setLocal({values:{...draftValues,[k]:v},revision:local?.revision??i.revision});}
 // Never replace unsaved edits on refresh. Version conflict is resolved by explicit reload.
 const stale=dirty&&local.revision!==i.revision;
 const completeReason=busy?pauseReason:dirty?'Save or discard your changes first.':i.task?.executor==='atlas'?'Atlas is not switched on to do work.':note.trim().length<3?'Say what was done.':'';
 const reviewReason=busy?pauseReason:dirty?'Save or discard your changes first.':note.trim().length<3?'Add a short review note.':'';
 const correctionReason=busy?pauseReason:dirty?'Save or discard your changes first.':(i.sharedCorrectionRequired?sharedNote:note).trim().length<3?'Say what needs to change.':'';
 const confirmationBlocked=busy||dirty||m.sourceChanged||!!i.reconciliationRequired||!ownerEligible;
 const reconfirm=confirmationStamp!==null&&!confirmed;
 const acceptReasons=[busy?pauseReason:'',m.sourceChanged?'The call this came from was updated. Check it still means the same thing before accepting.':'',i.reconciliationRequired?'Confirm whether this is still needed.':'',dirty?(stale?'This changed while you were editing. Your unsaved changes are kept; discard them to load the saved version.':'Save your changes first, then accept the saved task.'):'',!i.owner?'Choose who owns this, then save.':!ownerEligible?'The saved owner no longer has access to this version. Choose someone else and save, or have the task context reviewed.':'',uncertain&&!confirmed?(reconfirm?'This changed since you confirmed it. Confirm the current version again.':'Tick the box below to confirm this is still needed.'):''].filter(Boolean);
 /**
  * Saving must clear the retained copy as well as local state: a card that
  * changes column is unmounted and remounted, and would otherwise read the
  * already-saved edit back out of the cache and show it as unsaved again.
  */
 async function saveEdits(){
  // Only the fields this actor may write are sent. The RPC leaves an omitted field at its
  // recorded value, so a legitimate timing edit no longer carries an owner or executor it
  // is not entitled to set, and the route's refusal of a withheld field cannot be tripped
  // by an ordinary save (review finding R6).
  const edits={
   ...(controls.manageOwnership?{title:draftValues.title,owner:draftValues.owner||null}:{}),
   ...(controls.schedule?{due:draftValues.due||null}:{}),
   ...(i.task&&controls.manageOwnership?{executor:draftValues.executor||null}:{}),
   ...(i.task&&controls.setReviewer?{reviewer:draftValues.reviewer||null}:{}),
  };
  const ok=await operate('edit',{...base,...edits,note},cacheKey);
  if(ok){setLocal(null);draftCache?.set(cacheKey,{local:null,note,sharedNote,confirmationStamp});setSaveNotice('Saved.')}
 }
 const receipt=receipts.get(cacheKey);
 const RECEIPT_WORDS:Record<string,string>={accept:'Accepted',edit:'Changes saved',complete:'Marked done',review:'Approved',request_changes:'Changes requested',defer:'Parked',dismiss:'Decided against',retain_original:'Kept as still needed',build:'Draft started',revise:'Changes requested on the draft',handoff:'Sent to the reviewer'};
 // --- Card actions -------------------------------------------------------
 const taskId=i.task?.id??null;
 const can=(r:string)=>!!draft?.rights?.includes(r);
 const blocked=draftingBlock(draft);
 const draftUnavailable=!!blocked;
 // Start is only offered where starting is the thing to do. On work already in
 // review, finished, or held for another reason it is noise, not an option.
 const startRelevant=!!taskId&&!terminal&&['accepted','changes_requested'].includes(s.status);
 const startShown=startRelevant&&(draftUnavailable||!s.draftVersion);
 const startReason=!startShown?'':busy?pauseReason:dirty?'Save or discard your changes first.':!draft?'Checking whether drafting is available…':blocked?blocked:!can('build')?'You are not the person set up to start this one.':draft.currentVersion?'A draft already exists.':'';
 const canStart=startRelevant&&!!draft&&draft.available!==false&&can('build')&&!draft.currentVersion&&!busy&&!dirty;
 // Lane C: an Atlas-drafted task has no handoff step — it goes draft -> accepted
 // in one move — so Approve follows the review right, not the draft's stage.
 const approveDraft=!!taskId&&!!draft&&draft.available!==false&&['draft','in_review'].includes(draft.status||'')&&can('review');
 const handoffDraft=!!taskId&&!!draft&&draft.available!==false&&draft.status==='draft'&&can('handoff');
 const reviseDraft=!!taskId&&!!draft&&draft.available!==false&&['draft','in_review'].includes(draft.status||'')&&can('revise');
 const reviewing=!!canReview&&i.task?.next_reviewer===actor&&i.task.work_status==='needs_review';
 const canSubmit=!!i.task&&i.task.work_status!=='needs_review'&&[i.owner,i.task.executor].includes(actor)&&!terminal;
 const submitReason=!canSubmit?'':busy?pauseReason:dirty?'Save or discard your changes first.':i.task?.executor==='atlas'?'Atlas is not switched on to do work.':note.trim().length<3?'Say what was done under “More options” before marking it off.':'';
 /* Only ask for a note when an action in front of this person needs one. */
 const noteNeeded=reviewing||canSubmit||approveDraft||reviseDraft||handoffDraft;
 /* The note is folded away to keep a card at rest short, so a button still
    waiting on one says where to write it rather than sitting inert. Sending a
    draft on is the one note-bearing action that does not itself need one. */
 const noteWanted=reviewing||canSubmit||approveDraft||reviseDraft;
 const noteReason=!terminal&&noteWanted&&note.trim().length<(approveDraft||reviseDraft?10:3)?'Write the note under “More options” first.':'';
 // Delegating is an executor assignment, so it follows the ownership right rather than
 // triage (review finding R6). Nat holds triage but is not the accountable principal, so
 // she is no longer offered a button to hand her own task to herself.
 const canDelegate=controls.manageOwnership&&!!i.task&&!terminal&&natEligible&&draftValues.executor!==natActor;
 const delegateReason=!controls.manageOwnership||!i.task||terminal?'':busy?pauseReason:!natEligible?'Nat cannot be given this yet: she needs the task context reviewed first. Assigning it would not grant her access.':draftValues.executor===natActor?'Already with Nat.':'';
 return <article className={styles.item} data-tone={s.tone} data-status={s.status}>
 <div className={styles.cardTop}><span className={styles.chip} data-tone={s.tone}>{s.label}</span>{s.draftVersion&&<span className={styles.version}>Draft v{s.draftVersion}</span>}</div>
 <h3>{i.title}</h3>
 <p className={styles.reason}>{s.reason}</p>
 <div className={styles.people}><span>Owner <b>{name(i.owner)}</b></span>{i.task&&<span>Doing it <b>{name(i.task.executor)}</b></span>}<span>{dueLabel(i.due)}</span></div>
 <p className={styles.nextStep}><b>Next:</b> {nextAction(s.status,{owner:i.owner,executor:i.task?.executor,reviewer:i.task?.next_reviewer,viewer:actor,name,heldReason:s.heldReason})}</p>
 <p className={styles.freshness}>{freshness(m.taskOnly?null:m.title,m.instant)}</p>
 {dirty&&<p className={styles.unsaved} role="status"><b>Not saved yet.</b> {stale?'This card also changed somewhere else. Your changes are still here and have not overwritten it.':'Your changes are only on this screen until you save them.'} <button onClick={()=>setLocal(null)}>Undo my changes</button></p>}
 {!dirty&&receipt&&<p className={styles.savedBy} role="status">Saved · {RECEIPT_WORDS[receipt.action]||receipt.action} by {receipt.actor===actor?'you':name(receipt.actor)} {relativeTime(new Date(receipt.at).toISOString())}.</p>}
 {!terminal&&<div className={styles.quickActions}>
  {triage&&!i.task&&<button className={styles.primary} disabled={busy||dirty||m.sourceChanged||i.reconciliationRequired||!ownerEligible||(uncertain&&!confirmed)} onClick={()=>void operate('accept',{...base,confirmed,confirmation:confirmed?{itemRevision:i.revision,sourceRevision:m.revision}:null,note},cacheKey)}>Accept</button>}
  {startShown&&!draftUnavailable&&<button disabled={!canStart} onClick={()=>{if(taskId&&draft)void draftAction(taskId,'build',draft,undefined,cacheKey)}}>Start</button>}
  {startShown&&draftUnavailable&&<button disabled title={startReason}>Start</button>}
  {handoffDraft&&<button className={styles.primary} disabled={busy||dirty} onClick={()=>{if(taskId&&draft)void draftAction(taskId,'handoff',draft,note,cacheKey)}}>Send v{draft?.currentVersion} to the reviewer</button>}
  {approveDraft&&<button className={styles.primary} disabled={busy||dirty||note.trim().length<10} onClick={()=>{if(taskId&&draft)void draftAction(taskId,'review',draft,note,cacheKey)}}>Approve v{draft?.currentVersion}</button>}
  {!draft?.currentVersion&&canReview&&i.task?.next_reviewer===actor&&i.task.work_status==='needs_review'&&<button className={styles.primary} disabled={busy||dirty||note.trim().length<3} onClick={()=>void operate('review',{...base,note},cacheKey)}>Approve the work</button>}
  {reviseDraft&&<button disabled={busy||dirty||note.trim().length<10} onClick={()=>{if(taskId&&draft)void draftAction(taskId,'revise',draft,note,cacheKey)}}>Request changes</button>}
  {!draft?.currentVersion&&canReview&&i.task?.next_reviewer===actor&&i.task.work_status==='needs_review'&&<button disabled={busy||dirty||(i.sharedCorrectionRequired?sharedNote:note).trim().length<3} onClick={()=>void operate('request_changes',{...base,note:note||sharedNote,...(i.sharedCorrectionRequired?{sharedNote}:{})},cacheKey)}>Request changes</button>}
  {canSubmit&&<button className={i.task?.executor===actor?styles.primary:undefined} disabled={busy||dirty||note.trim().length<3} onClick={()=>void operate('complete',{...base,note},cacheKey)}>{i.task?.next_reviewer?'Send for review':'Mark as done'}</button>}
  {canDelegate&&<button onClick={()=>field('executor',natActor!)}>Delegate to Nat</button>}
  {i.task&&!canDelegate&&controls.manageOwnership&&delegateReason&&<button disabled title={delegateReason}>Delegate to Nat</button>}
 </div>}
 {/* A blocked action explains itself quietly. Amber is kept for things a
     person actually has to act on, per the September 18 direction. */}
 {!terminal&&(startReason||delegateReason||submitReason||noteReason)&&<p className={styles.blockedReason}>{[startReason,delegateReason,submitReason,noteReason].filter(Boolean)[0]}</p>}
 {dirty&&<div className={styles.actions}><button className={styles.primary} disabled={busy||stale||m.sourceChanged||i.reconciliationRequired} onClick={()=>void saveEdits()}>Save changes</button></div>}
 <details className={styles.cardDetails}><summary>{terminal?'View details':i.task?'More options':'All details & accept'}</summary>
 {!terminal&&noteNeeded&&<label className={styles.cardNote}>{canReview?'Private note for the record':'Note about this work'}<input value={note} onChange={e=>setNote(e.target.value)} placeholder={reviewing?'What should change, or why this is right':'What was done'}/></label>}
 {controls.manageOwnership&&<label>Next step<input value={draftValues.title} disabled={busy||terminal||!!i.taskOnly} onChange={e=>field('title',e.target.value)}/></label>}
 <p className={styles.note}>Only people already allowed to see this item are listed. Giving someone a job does not give them access.</p>{!natEligible&&<p className={styles.warning}>Nat cannot take this version: she needs the task context reviewed first. Being on the client alone is not enough.</p>}{i.taskOnly&&<p className={styles.note}>To change these instructions, ask the owner to review the task context. You can change timing and report your work.</p>}<div className={styles.fields}>{/* Review finding R6: a withheld control is absent, not rendered disabled, and the card says who does hold it. */}
 {controls.manageOwnership?<label>Owner<select value={draftValues.owner} disabled={busy||terminal} onChange={e=>field('owner',e.target.value)}><option value="">Unassigned</option>{draftValues.owner&&!assignees.some(a=>a.actor===draftValues.owner)&&<option value={draftValues.owner} disabled>{name(draftValues.owner)} · no access</option>}{assignees.map(a=><option key={a.actor} value={a.actor}>{name(a.actor)}</option>)}</select></label>:<p className={styles.note}>Owner · {name(draftValues.owner)}</p>}
 {controls.schedule&&<label>Due date<input type="date" value={draftValues.due} disabled={busy||terminal} onChange={e=>field('due',e.target.value)}/></label>}
 {i.task&&<>{controls.manageOwnership?<label>Who is doing it<select value={draftValues.executor} disabled={busy||terminal} onChange={e=>field('executor',e.target.value)}><option value="">Unassigned</option>{draftValues.executor&&!assignees.some(a=>a.actor===draftValues.executor)&&draftValues.executor!=='atlas'&&<option value={draftValues.executor} disabled>{name(draftValues.executor)} · no access</option>}{assignees.map(a=><option key={a.actor} value={a.actor}>{name(a.actor)}</option>)}{!i.taskOnly&&!i.sharedCorrectionRequired&&<option value="atlas">Atlas · held</option>}</select>{!natEligible&&<span className={styles.warning}>Nat cannot do this version yet. Ask whoever reviews the call to review a task-only context; changing the owner does not grant access.</span>}<span className={styles.note}>The person doing it can differ from the owner.</span></label>:<p className={styles.note}>Who is doing it · {name(draftValues.executor)}</p>}
 {controls.setReviewer?<label>Who reviews it<select value={draftValues.reviewer} disabled={busy||terminal} onChange={e=>field('reviewer',e.target.value)}><option value="">No review needed</option>{assignees.filter(a=>a.review).map(a=><option key={a.actor} value={a.actor}>{name(a.actor)}</option>)}</select></label>:draftValues.reviewer?<p className={styles.note}>Who reviews it · {name(draftValues.reviewer)}</p>:null}</>}
 {controls.withheldReason&&<p className={styles.note}>{controls.withheldReason}</p>}</div>
 {dirty&&i.sharedCorrectionRequired&&draftValues.title===i.title&&draftValues.due!==(i.due||'')&&<p className={styles.note}>Saving shares the new due date with people who already have access to this task. It does not restore access anyone has lost.</p>}{!dirty&&<p role="status" className={styles.note}>{saveNotice||'Showing what is saved.'}</p>}{dirty&&i.sharedCorrectionRequired&&!i.taskOnly&&draftValues.title!==i.title&&<p className={styles.warning}>Changing the instructions requires a new task-context review before the existing limited access can be used for this version.</p>}
 {!terminal&&<>{canReview&&i.sharedCorrectionRequired&&i.task?.next_reviewer===actor&&i.task.work_status==='needs_review'&&<label>What to tell the person doing it<input value={sharedNote} onChange={e=>setSharedNote(e.target.value)} placeholder="Only task-safe instructions. They will see this."/></label>}<div className={styles.actions}>
 {triage&&i.reconciliationRequired&&!m.sourceChanged&&<div><p>The newest version of the call did not repeat this. Check the original evidence and the updated call before keeping it.</p><button disabled={busy||note.trim().length<3} onClick={()=>void operate('retain_original',{...base,sourceRevision:m.revision,note},cacheKey)}>Keep it — still needed</button>{note.trim().length<3&&<p className={styles.warning}>Say why it is still needed.</p>}</div>}
 {triage&&<>{dirty&&<button disabled={busy||stale||m.sourceChanged||i.reconciliationRequired} onClick={()=>void saveEdits()}>Save changes</button>}
 {!i.task&&<>{acceptReasons.length>0&&<p role="status" className={styles.warning}>{acceptReasons[0]}</p>}{m.sourceChanged&&(m.pending?<button disabled={busy} onClick={reviewSource}>Check the updated call</button>:<p className={styles.warning}>The updated call is not ready to check yet. Try again shortly.</p>)}{uncertain&&<><button disabled={busy} onClick={openHistory}>Read what was said</button><label className={styles.confirm}><input type="checkbox" disabled={confirmationBlocked} checked={confirmed} onChange={e=>setConfirmationStamp(e.target.checked?evidenceStamp:null)}/>Confirm this is still needed.</label></>}<button className={styles.primary} disabled={busy||dirty||m.sourceChanged||i.reconciliationRequired||!ownerEligible||(uncertain&&!confirmed)} onClick={()=>void operate('accept',{...base,confirmed,confirmation:confirmed?{itemRevision:i.revision,sourceRevision:m.revision}:null,note},cacheKey)}>Accept</button><button disabled={busy} onClick={()=>void operate('defer',base,cacheKey)}>{i.deferred?'Put back':'Park it'}</button><button disabled={busy||note.trim().length<3} onClick={()=>void operate('dismiss',{...base,note},cacheKey)}>Decide against it</button></>}</>}
 {i.task&&i.task.work_status!=='needs_review'&&[i.owner,i.task.executor].includes(actor)&&<div><button className={styles.primary} disabled={busy||dirty||i.task.executor==='atlas'||note.trim().length<3} onClick={()=>void operate('complete',{...base,note},cacheKey)}>{i.task.next_reviewer?'Send for review':'Mark as done'}</button>{completeReason&&<p className={styles.warning}>{completeReason}</p>}</div>}
 {canReview&&i.task?.next_reviewer===actor&&i.task.work_status==='needs_review'&&<><button disabled={busy||dirty||(i.sharedCorrectionRequired?sharedNote:note).trim().length<3} onClick={()=>void operate('request_changes',{...base,note:note||sharedNote,...(i.sharedCorrectionRequired?{sharedNote}:{})},cacheKey)}>Request changes</button>{correctionReason&&<p className={styles.warning}>{correctionReason}</p>}<button className={styles.primary} disabled={busy||dirty||note.trim().length<3} onClick={()=>void operate('review',{...base,note},cacheKey)}>Approve the work</button>{reviewReason&&<p className={styles.warning}>{reviewReason}</p>}</>}
 </div></>}
 </details>
 <details ref={historyRef} className={styles.history}><summary>Where this came from</summary><p>{i.evidence.kind} · {i.evidence.provenance==='provider_summary'?'From an automatic summary · not checked against the recording':'From the recording'}</p><blockquote>{i.evidence.quote}</blockquote><p>{i.evidence.uncertainty}</p>{!i.taskOnly&&<a href={`https://app.fireflies.ai/view/${encodeURIComponent(m.id)}`} target="_blank" rel="noreferrer">Open the recording</a>}{i.taskOnly&&<p>Limited task context from a reviewed full-transcript read. The recording itself is not shared.</p>}{sourceHistory}</details>
 {engineering&&<details className={styles.engineering}><summary>Engineering detail</summary><dl><dt>Request</dt><dd>{i.id}</dd><dt>Item revision</dt><dd>{i.revision}</dd><dt>Source revision</dt><dd>{i.sourceRevision||m.revision}</dd><dt>Source</dt><dd>{m.id}</dd>{i.task&&<><dt>Task</dt><dd>{i.task.id}</dd><dt>Work status</dt><dd>{i.task.work_status}</dd></>}{draft&&<><dt>Draft state</dt><dd>{draft.status||'—'}</dd><dt>Draft revision</dt><dd>{draft.revision??'—'}</dd>{draft.versions?.map(v=><span key={v.version}><dt>v{v.version} hash</dt><dd>{v.hash||'—'}</dd></span>)}</>}</dl></details>}
 </article>;
}
function SourceReview({meeting:m,busy,onSave}:{meeting:Meeting;busy:boolean;onSave:(p:Record<string,unknown>)=>Promise<boolean>}){
 const [mapping,setMapping]=useState<Record<string,string>>({}),[note,setNote]=useState('');
 return <fieldset className={styles.revision}><legend>Check the updated call</legend><p>For each thing the updated call says, point it at the commitment it matches, or mark it as new. Things already finished or decided against stay closed; your edits stay as they are.</p>{m.pending!.map(c=><label key={c.key}>{c.title}<blockquote>{c.quote}</blockquote><select value={mapping[c.key]??''} onChange={e=>setMapping(x=>({...x,[c.key]:e.target.value}))}><option value="">Choose what it matches</option><option value="new">Something new</option>{m.items.map(i=><option key={i.id} value={i.id}>{i.title} · {i.state}</option>)}</select></label>)}<label>Why these matches are right<input value={note} onChange={e=>setNote(e.target.value)}/></label><button disabled={busy||note.length<3||m.pending!.some(c=>!mapping[c.key])} onClick={()=>void onSave({sourceId:m.id,revision:m.revision,note,mapping:m.pending!.map(c=>({key:c.key,requestId:mapping[c.key]==='new'?null:mapping[c.key]}))})}>Confirm</button></fieldset>;
}
