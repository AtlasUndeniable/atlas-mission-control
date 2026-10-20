'use client';
import {useCallback,useEffect,useState} from 'react';
import {BADGE_LABEL,clientChoices,mappingHeadline,newClientDefaults,parseMappingList,rememberFor,type MappingAction,type MappingItem,type MappingList} from '@/lib/board/client-mapping';
import styles from './ClientMappingPanel.module.css';
/**
 * The few calls Atlas could not map to a client by itself, and the new clients it created.
 * Shown under the calls strip only to people who may see call titles; the hosted RPC decides
 * who may actually resolve. Nothing here extracts or sends anything: a choice re-queues the call
 * for the normal intake path.
 */
export default function ClientMappingPanel(){
 const [list,setList]=useState<MappingList|null>(null);
 const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
 const read=useCallback(async()=>{
  try{const r=await fetch('/api/board/meetings/clients',{cache:'no-store'});if(!r.ok)throw Error();setList(parseMappingList(await r.json()))}catch{setList(null)}
 },[]);
 useEffect(()=>{void read();const t=setInterval(read,60000);return()=>clearInterval(t)},[read]);
 const act=async(action:MappingAction,payload:Record<string,unknown>,done:string)=>{
  setBusy(true);setMessage('');
  try{const r=await fetch('/api/board/meetings/clients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});const v=await r.json();if(!r.ok)throw Error(v.error);setMessage(done)}
  catch(e){setMessage(e instanceof Error&&e.message?e.message:'That choice was not saved.')}
  finally{setBusy(false);void read()}
 };
 if(!list||list.items.length===0)return null;
 return <section className={styles.panel} aria-label="Calls that need a client">
  <div className={styles.heading}><strong>{mappingHeadline(list)}</strong><button type="button" disabled={busy} onClick={()=>void read()}>Check again</button></div>
  <p className={styles.caveat}>Atlas maps calls to clients on its own. These are the ones it would not guess. A new client only gets shared method material until someone confirms it.</p>
  {message&&<p role="status" className={styles.message}>{message}</p>}
  <ul className={styles.items}>{list.items.map(i=><MappingRow key={i.mapping} item={i} list={list} busy={busy} act={act}/>)}</ul>
 </section>;
}
function MappingRow({item,list,busy,act}:{item:MappingItem;list:MappingList;busy:boolean;act:(a:MappingAction,p:Record<string,unknown>,done:string)=>Promise<void>}){
 const choices=clientChoices(item,list.clients);
 const [client,setClient]=useState(choices[0]?.client??'');
 const [naming,setNaming]=useState(false);
 const [name,setName]=useState(item.clientName??'');
 const [people,setPeople]=useState<string[]>(newClientDefaults(item));
 const toggle=(e:string)=>setPeople(p=>p.includes(e)?p.filter(x=>x!==e):[...p,e]);
 return <li className={styles.item} data-badge={item.badge}>
  <div className={styles.itemHead}><span className={styles.badge} data-badge={item.badge}>{BADGE_LABEL[item.badge]}</span><b>{item.title}</b>{item.instant&&<span className={styles.when}>{new Date(item.instant).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</span>}</div>
  {item.badge==='new_client'
   ?<p>Atlas created <b>{item.clientName??item.client}</b>{item.company?` (${item.company})`:''} from this call and processed it. Drafting uses shared method material only until it is confirmed.</p>
   :<p>{item.reason}.</p>}
  <ul className={styles.people}>{item.participants.map(p=><li key={p.email}>
   {naming&&item.badge==='needs_client'&&<input type="checkbox" aria-label={`Include ${p.email} in the new client`} checked={people.includes(p.email)} onChange={()=>toggle(p.email)}/>}
   <span>{p.email}</span>{p.resolved?<em> · matches {p.resolved}</em>:p.note?<em> · {p.note}</em>:<em> · no record</em>}
   <button type="button" className={styles.link} disabled={busy} onClick={()=>void act('mark_internal',{mapping:item.mapping,emails:[p.email]},`${p.email} marked as our team. The call will be checked again.`)}>Our team</button>
  </li>)}</ul>
  <div className={styles.actions}>
   {choices.length>0&&<label>Existing client<select value={client} disabled={busy} onChange={e=>setClient(e.target.value)}>{choices.map(c=><option key={c.client} value={c.client}>{c.name}</option>)}</select></label>}
   {choices.length>0&&<button type="button" disabled={busy||!client} onClick={()=>void act('choose_existing',{mapping:item.mapping,client,emails:rememberFor(item,client)},'Client saved. The call is queued for processing.')}>Use this client</button>}
   {item.badge==='new_client'
    ?<><label>Name<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label><button type="button" disabled={busy||name.trim().length<2} onClick={()=>void act('confirm_new',{mapping:item.mapping,name:name.trim()},'New client confirmed.')}>Confirm new client</button></>
    :naming
     ?<><label>New client name<input value={name} maxLength={200} disabled={busy} onChange={e=>setName(e.target.value)}/></label><button type="button" disabled={busy||name.trim().length<2||people.length===0} onClick={()=>void act('confirm_new',{mapping:item.mapping,name:name.trim(),emails:people},'New client saved. The call is queued for processing.')}>Save new client</button></>
     :<button type="button" disabled={busy} onClick={()=>setNaming(true)}>It is a new client</button>}
  </div>
 </li>;
}
