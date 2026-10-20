'use client';
import {useCallback,useEffect,useState} from 'react';
import {BADGE_LABEL,PAGE_SIZE,clientChoices,listQuery,mappingHeadline,newClientDefaults,parseMappingList,rememberFor,singleSuggestion,type MappingAction,type MappingItem,type MappingList,type RereviewItem} from '@/lib/board/client-mapping';
import styles from './ClientMappingPanel.module.css';
/**
 * Calls Atlas assigned to a client (with a change-client button), calls it held for a person
 * (suggested client, needs a client) and new clients still to confirm. Shown under the calls
 * strip only to people who may see call titles; the hosted RPC decides who may resolve. Nothing
 * here extracts or sends anything: a choice re-queues the call for the normal intake path.
 */
export default function ClientMappingPanel(){
 const [list,setList]=useState<MappingList|null>(null);
 const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
 const [offset,setOffset]=useState(0);const [search,setSearch]=useState('');const [query,setQuery]=useState('');
 const read=useCallback(async()=>{
  try{const r=await fetch('/api/board/meetings/clients?'+listQuery(offset,query),{cache:'no-store'});if(!r.ok)throw Error();setList(parseMappingList(await r.json()))}catch{setList(null)}
 },[offset,query]);
 useEffect(()=>{void read();const t=setInterval(read,60000);return()=>clearInterval(t)},[read]);
 const act=async(action:MappingAction,payload:Record<string,unknown>,done:string)=>{
  setBusy(true);setMessage('');
  try{const r=await fetch('/api/board/meetings/clients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});const v=await r.json();if(!r.ok)throw Error(v.error);setMessage(done)}
  catch(e){setMessage(e instanceof Error&&e.message?e.message:'That choice was not saved.')}
  finally{setBusy(false);void read()}
 };
 if(!list||(list.items.length===0&&list.rereview.length===0&&!query&&offset===0))return null;
 return <section className={styles.panel} aria-label="Calls and clients">
  <div className={styles.heading}><strong>{mappingHeadline(list)}</strong><button type="button" disabled={busy} onClick={()=>void read()}>Check again</button></div>
  <p className={styles.caveat}>Calls wait here until someone confirms the client. Atlas suggests one when it has evidence; one click confirms it, or choose another, add a new client, or mark someone as our team. A new client gets shared method material only until it is confirmed.</p>
  <form className={styles.actions} onSubmit={e=>{e.preventDefault();setOffset(0);setQuery(search)}}><label>Find a call or client<input value={search} maxLength={100} onChange={e=>setSearch(e.target.value)}/></label><button type="submit" disabled={busy}>Search</button></form>
  {message&&<p role="status" className={styles.message}>{message}</p>}
  {list.rereview.length>0&&<ul className={styles.items}>{list.rereview.map(r=><RereviewRow key={r.request} item={r} busy={busy} act={act}/>)}</ul>}
  <ul className={styles.items}>{list.items.map(i=><MappingRow key={i.mapping} item={i} list={list} busy={busy} act={act}/>)}</ul>
  {list.total>PAGE_SIZE&&<div className={styles.actions}><button type="button" disabled={busy||offset===0} onClick={()=>setOffset(o=>Math.max(0,o-PAGE_SIZE))}>Previous</button><span>{offset+1}–{Math.min(offset+PAGE_SIZE,list.total)} of {list.total}</span><button type="button" disabled={busy||offset+PAGE_SIZE>=list.total} onClick={()=>setOffset(o=>o+PAGE_SIZE)}>Next</button></div>}
 </section>;
}
type Act=(a:MappingAction,p:Record<string,unknown>,done:string)=>Promise<void>;
function RereviewRow({item,busy,act}:{item:RereviewItem;busy:boolean;act:Act}){
 const [note,setNote]=useState('');
 return <li className={styles.item} data-badge="needs_client">
  <div className={styles.itemHead}><span className={styles.badge} data-badge="needs_client">Re-review</span><b>{item.title}</b></div>
  <p>This task was recorded for {item.recordedClient}; its call now belongs to {item.currentClient}. Drafting is paused until someone re-reviews it.</p>
  <div className={styles.actions}><label>Why this task still applies<input value={note} maxLength={500} disabled={busy} onChange={e=>setNote(e.target.value)}/></label>
   <button type="button" disabled={busy||note.trim().length<10} onClick={()=>void act('rereview_request',{request:item.request,note:note.trim()},'Task re-reviewed for the new client. The draft needs a fresh revision.')}>Re-review for {item.currentClient}</button></div>
 </li>;
}
function MappingRow({item,list,busy,act}:{item:MappingItem;list:MappingList;busy:boolean;act:Act}){
 const choices=clientChoices(item,list.clients);
 const suggestion=singleSuggestion(item);
 const [client,setClient]=useState(choices[0]?.client??'');
 const [changing,setChanging]=useState(false);
 const [naming,setNaming]=useState(false);
 const [name,setName]=useState(item.clientName??item.newClient?.name??'');
 const [people,setPeople]=useState<string[]>(newClientDefaults(item));
 const toggle=(e:string)=>setPeople(p=>p.includes(e)?p.filter(x=>x!==e):[...p,e]);
 const nameOf=(k:string)=>list.clients.find(c=>c.client===k)?.name??k;
 return <li className={styles.item} data-badge={item.badge}>
  <div className={styles.itemHead}><span className={styles.badge} data-badge={item.badge}>{BADGE_LABEL[item.badge]}</span><b>{item.title}</b>{item.instant&&<span className={styles.when}>{new Date(item.instant).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</span>}</div>
  {item.badge==='assigned'?<p>Assigned to <b>{item.clientName??nameOf(item.client??'')}</b>{item.decidedBy.startsWith('human:')?` (confirmed by ${item.decidedBy.slice(6)})`:' automatically under the reviewed rule'}. Change it here if it is wrong.</p>
   :item.badge==='new_client'?<p><b>{item.clientName??item.client}</b>{item.company?` (${item.company})`:''} was added as a new client. Drafting uses shared method material only until it is confirmed.</p>
   :<p>{item.reason}.</p>}
  <ul className={styles.people}>{item.participants.map(p=><li key={p.email}>
   {naming&&<input type="checkbox" aria-label={`Include ${p.email} in the new client`} checked={people.includes(p.email)} onChange={()=>toggle(p.email)}/>}
   <span>{p.email}</span>{p.resolved?<em> · on {nameOf(p.resolved)}&apos;s record</em>:p.suggestion?<em> · suggests {nameOf(p.suggestion)}</em>:p.note?<em> · {p.note}</em>:<em> · no record</em>}
   {item.badge!=='assigned'&&<button type="button" className={styles.link} disabled={busy} onClick={()=>void act('mark_internal',{mapping:item.mapping,emails:[p.email]},`${p.email} marked as our team. The call will be checked again.`)}>Our team</button>}
  </li>)}</ul>
  <div className={styles.actions}>
   {suggestion&&!changing&&<button type="button" disabled={busy} onClick={()=>void act('confirm_suggested',{mapping:item.mapping,client:suggestion},'Suggested client confirmed. The call is queued for processing.')}>Confirm suggested client: {nameOf(suggestion)}</button>}
   {item.badge==='new_client'&&<><label>Name<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label><button type="button" disabled={busy||name.trim().length<2} onClick={()=>void act('confirm_new',{mapping:item.mapping,name:name.trim()},'New client confirmed.')}>Confirm client</button></>}
   {choices.length>0&&(changing||item.badge==='needs_client')
    ?<><label>{item.badge==='needs_client'?'Existing client':'Change to'}<select value={client} disabled={busy} onChange={e=>setClient(e.target.value)}>{choices.map(c=><option key={c.client} value={c.client}>{c.name}</option>)}</select></label>
      <button type="button" disabled={busy||!client} onClick={()=>void act('choose_existing',{mapping:item.mapping,client,emails:rememberFor(item,client)},'Client saved. The call is queued for processing.')}>Use this client</button></>
    :choices.length>0&&<button type="button" disabled={busy} onClick={()=>setChanging(true)}>{item.badge==='suggested'?'Choose another client':'Change client'}</button>}
   {(item.badge==='needs_client'||item.badge==='suggested')&&(naming
    ?<><label>New client name<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label><button type="button" disabled={busy||name.trim().length<2||people.length===0} onClick={()=>void act('confirm_new',{mapping:item.mapping,name:name.trim(),emails:people},'New client saved. The call is queued for processing.')}>Confirm new client</button></>
    :<button type="button" disabled={busy} onClick={()=>setNaming(true)}>It is a new client</button>)}
  </div>
 </li>;
}
