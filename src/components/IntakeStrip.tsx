'use client';
import {useEffect,useState} from 'react';
import {summariseIntake,type IntakePayload} from '@/lib/board/intake-summary';
import styles from './IntakeStrip.module.css';
/**
 * The strip above the board. It exists so an empty board is never read as a
 * healthy one: when call processing is off, unknown, or holding calls back, it
 * says so before the columns do.
 *
 * `canSeeSources` is the caller's permission to read call titles. Without it
 * the strip shows counts and reasons but no call names — an actor filter or a
 * task assignment never grants source access.
 */
export default function IntakeStrip({canSeeSources}:{canSeeSources:boolean}){
 const [payload,setPayload]=useState<IntakePayload|null>({status:'checking'});
 const [epoch,setEpoch]=useState(0);
 useEffect(()=>{
  let alive=true,sequence=0;let controller:AbortController|undefined;
  const read=async()=>{
   if(document.visibilityState==='hidden')return;
   const id=++sequence;controller?.abort();controller=new AbortController();
   try{
    const r=await fetch('/api/board/meetings/intake',{cache:'no-store',signal:controller.signal});
    if(!r.ok)throw Error();
    const v=await r.json();
    if(alive&&id===sequence)setPayload(v);
   }catch{if(alive&&id===sequence)setPayload({status:'unavailable'})}
  };
  void read();
  const timer=setInterval(read,60000);
  window.addEventListener('focus',read);document.addEventListener('visibilitychange',read);
  return()=>{alive=false;sequence++;controller?.abort();clearInterval(timer);window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',read)};
 },[epoch]);
 const summary=summariseIntake(payload);
 return <aside className={styles.strip} data-intake-mode={summary.mode} aria-label="Calls coming in">
  <div className={styles.headline}>
   <strong>{summary.headline}</strong>
   <button type="button" onClick={()=>setEpoch(e=>e+1)}>Check again</button>
  </div>
  {summary.counts&&<ul className={styles.counts}>
   <li><b>{summary.counts.processed}</b> <span>turned into tasks</span></li>
   <li><b>{summary.counts.pending}</b> <span>still to process</span></li>
   <li data-held={summary.counts.held>0?'true':'false'}><b>{summary.counts.held}</b> <span>held</span></li>
   <li><b>{summary.counts.awaitingReview}</b> <span>waiting on a person</span></li>
  </ul>}
  <p className={styles.caveat}>{summary.caveat}</p>
  {summary.holds.length>0&&(canSeeSources
   ? <ul className={styles.holds}>{summary.holds.map((h,i)=><li key={h.title+i}><b>{h.title}</b> — {h.reason}</li>)}</ul>
   : <p className={styles.holds}>{summary.holds.length} {summary.holds.length===1?'call is':'calls are'} held. Which calls, and why, is only shown to the people who review call recordings.</p>)}
 </aside>;
}
