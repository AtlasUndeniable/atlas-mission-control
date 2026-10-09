'use client';
import {useCallback,useEffect,useState} from 'react';
import type {DraftState} from '@/lib/board/task-status';
/**
 * Reads the drafting path once per visible task so a card can show its draft
 * version badge and disable Start with the real reason.
 *
 * Deliberately read-only and bounded: two requests in flight at a time, one
 * pass per task identity, nothing while the board read is paused or stale, and
 * every in-flight read is abandoned when the task set, access, or cadence
 * changes. Checking a draft never generates one.
 *
 * `cadence` is the board's own last-checked stamp, so drafts re-read on the
 * same visible-page schedule as the board. Without it a reviewer would never
 * see a draft another person handed over, only their own writes.
 *
 * `refreshDrafts` bumps a generation so a write that may have changed a draft
 * abandons the reads in flight and starts a fresh pass. It deliberately keeps
 * the values already on screen while that pass runs: blanking them would drop
 * a card out of its column and back again on every save, remounting it and
 * losing the edit the person was in the middle of.
 *
 * A batch read is the obvious successor once a board carries many tasks; this
 * keeps the board correct without reaching into Lane C's route.
 */
const CONCURRENCY=2;
export function useTaskDrafts(taskIds:string[],enabled:boolean,cadence:string|null){
 const [drafts,setDrafts]=useState<Record<string,DraftState>>({});
 const [generation,setGeneration]=useState(0);
 const key=taskIds.join(',');
 const refreshDrafts=useCallback(()=>setGeneration(g=>g+1),[]);
 useEffect(()=>{
  if(!enabled){setDrafts({});return}
  const ids=key?key.split(','):[];
  if(ids.length===0){setDrafts({});return}
  let cancelled=false;
  const controller=new AbortController();
  let cursor=0;
  async function worker(){
   while(cursor<ids.length&&!cancelled){
    const id=ids[cursor++];
    try{
     const r=await fetch('/api/board/meetings/document?taskId='+encodeURIComponent(id),{cache:'no-store',signal:controller.signal});
     const d=await r.json();
     if(cancelled)return;
     // The drafting path reports a hold two ways, confirmed with Lane C:
     // HTTP 200 with {available:false, reason}, or a non-200 with {error}.
     // Both must read as "cannot draft, here is why" rather than a silent
     // load failure, and the words are always the product's own.
     setDrafts(x=>({...x,[id]:(r.ok?d:{available:false,reason:typeof d?.error==='string'?d.error:'Drafting could not be checked for this task.'}) as DraftState}));
    }catch{/* aborted or unreachable: the card simply shows no draft information */}
   }
  }
  void Promise.all(Array.from({length:Math.min(CONCURRENCY,ids.length)},worker));
  return()=>{cancelled=true;controller.abort()};
 },[key,enabled,generation,cadence]);
 return {drafts,refreshDrafts};
}
