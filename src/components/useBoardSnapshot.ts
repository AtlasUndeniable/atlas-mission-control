'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {createBoardReader} from '@/lib/board-refresh';
class BoardReadError extends Error{status:number;constructor(message:string,status:number){super(message);this.status=status}}
export function useBoardSnapshot<T>(){
 const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[fresh,setFresh]=useState(false),[checkedAt,setCheckedAt]=useState<string|null>(null);
 const readable=useRef(false),paused=useRef(false),reader=useRef<ReturnType<typeof createBoardReader<T>>|null>(null);
 const refresh=useCallback(async()=>{await reader.current?.refresh()},[]);
 const pause=useCallback(()=>{paused.current=true;reader.current?.invalidate()},[]);
 const resume=useCallback(()=>{paused.current=false},[]);
 useEffect(()=>{
  const current=createBoardReader<T>(async signal=>{
   const r=await fetch('/api/board/meetings',{cache:'no-store',signal});
   // Middleware can return a plain-text refusal. Preserve its status without retaining response bodies.
   if(!r.ok)throw new BoardReadError(r.status===401||r.status===403?'Access changed. Sign in with permitted access before continuing.':'Board check unavailable. Saved work has not been resent.',r.status);
   return await r.json() as T;
  },value=>{setData(value);setError('');setFresh(true);readable.current=true;setCheckedAt(new Date().toISOString())},reason=>{
   setFresh(false);readable.current=false;setError(reason instanceof BoardReadError?reason.message:'Board check unavailable. Saved work has not been resent.');
   if(reason instanceof BoardReadError&&(reason.status===401||reason.status===403)){setData(null);setCheckedAt(null)}
  },setLoading);
  reader.current=current;
  const check=()=>{if(!paused.current&&document.visibilityState==='visible')void current.refresh()};
  const visibility=()=>{if(document.visibilityState==='hidden')current.invalidate();else check()};
  check();const timer=setInterval(check,30000);
  window.addEventListener('focus',check);window.addEventListener('online',check);document.addEventListener('visibilitychange',visibility);
  return()=>{clearInterval(timer);window.removeEventListener('focus',check);window.removeEventListener('online',check);document.removeEventListener('visibilitychange',visibility);current.invalidate();reader.current=null;readable.current=false};
 },[]);
 return {data,error,loading,fresh,checkedAt,refresh,pause,resume,readable};
}
