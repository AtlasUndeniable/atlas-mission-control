// Disposable synthetic RPC for the Lane D board. Fictional people and work
// only: never production source, credentials, client content or provider.
import http from 'node:http';
const port=Number(process.env.ATLAS_BOARD_FIXTURE_PORT||55940);
const T=n=>`00000000-0000-4000-8000-00000000000${n}`;
const SOURCE='synthetic-board-call';
let intakeMode='reporting',refuseDocument=null;
const writes=[],reads={rhys:0,pat:0,nat:0};
// Instants are relative to start-up so the fixture does not rot as the date
// moves; the meanings ("2 hours ago", "due in 7 days") stay stable.
const NOW=Date.now();
const ago=h=>new Date(NOW-h*3600000).toISOString();
const inDays=d=>new Date(NOW+d*86400000).toISOString().slice(0,10);
const state={
 1:{title:'Send the Collins Twins their onboarding pack',owner:'rhys',due:null,revision:1,state:'pending_approval',deferred:false,task:null,correction:null},
 2:{title:'Write the new client intake SOP',owner:'rhys',due:inDays(7),revision:1,state:'accepted',deferred:false,task:{executor:'nat',next_reviewer:'rhys',work_status:'todo'},correction:null},
 3:{title:'Draft the Q4 coaching offer brief',owner:'rhys',due:inDays(4),revision:1,state:'accepted',deferred:false,task:{executor:'rhys',next_reviewer:'pat',work_status:'todo'},correction:null},
 4:{title:'Prepare the weekly handoff checklist',owner:'rhys',due:inDays(1),revision:1,state:'accepted',deferred:false,task:{executor:'nat',next_reviewer:'rhys',work_status:'needs_review'},correction:null},
 5:{title:'Update the referral follow-up script',owner:'rhys',due:inDays(11),revision:1,state:'accepted',deferred:false,task:{executor:'nat',next_reviewer:'pat',work_status:'todo'},correction:'Add the escalation owner and a deadline to each step'},
 6:{title:'Confirm the May retreat venue',owner:'rhys',due:inDays(-7),revision:1,state:'accepted',deferred:false,task:{executor:'pat',next_reviewer:'rhys',work_status:'completed'},correction:null},
 7:{title:'Rebuild the ads reporting sheet',owner:'rhys',due:inDays(15),revision:1,state:'accepted',deferred:false,task:{executor:'atlas',next_reviewer:'rhys',work_status:'todo'},correction:null},
 8:{title:'Prepare the partner proposal',owner:'rhys',due:inDays(21),revision:1,state:'accepted',deferred:false,task:{executor:'rhys',next_reviewer:'rhys',work_status:'todo'},correction:null},
};
// Lane C's drafting path, as this board consumes it.
const documents={
 2:{available:true,status:'ready',revision:1,currentVersion:0,versions:[],owner:'Rhys',executor:'Nat',reviewer:'Rhys',events:[]},
 3:{available:true,status:'draft',revision:1,currentVersion:1,versions:[{version:1,hash:'a'.repeat(64),at:ago(1.5)}],owner:'Rhys',executor:'Rhys',reviewer:'Pat',events:[]},
 5:{available:true,status:'needs_revision',revision:1,currentVersion:1,versions:[{version:1,hash:'b'.repeat(64),at:ago(26)}],owner:'Rhys',executor:'Nat',reviewer:'Pat',events:[]},
 // The condition Lane A reported: the drafting account cannot spend, so the
 // board must disable Start and say why in the customer's words.
 8:{available:false,reason:'credit_exhausted'},
};
/*
 * The real captured hosted capability, not an invented one.
 *
 * Review finding R6: this fixture said Nat was `triage:false`, while Lane B1's read-only
 * capture of the live service says `triage:true`
 * (sprint-20261007/laneB1-compose/hosted-capabilities-20261009.json lines 4-16, actor
 * nat, role builder, review false, triage true). The restriction on owner, executor and
 * reviewer controls was therefore being proved against a capability no principal has, and
 * the capture's zero valid task grants hid the consequence rather than ruling it out.
 *
 * Nat's row below is now the captured shape verbatim. Rhys's row matches his captured row
 * (super_admin, triage true, review true). Pat is still synthetic and labelled as such:
 * Pat has no provisioned account in the capture, so there is nothing real to copy, and
 * `triage:false` is the conservative stand-in for an unprovisioned reviewer.
 */
/** Synthetic canonical history. SYNTHETIC_DOC_HASH is a test-only 64-hex string. */
export const SYNTHETIC_DOC_HASH='4f'.repeat(32);
const HISTORY=[
 {actor:'rhys',operation:'accept',created_at:new Date(Date.now()-9e5).toISOString(),input:{note:'Agreed on the call. Nat to draft it.'}},
 {actor:'rhys',operation:'review',created_at:new Date(Date.now()-6e5).toISOString(),
  input:{note:'Atlas draft v1 submitted for required review; SHA256 '+SYNTHETIC_DOC_HASH+'; no external delivery.'}},
 {actor:'rhys',operation:'complete',created_at:new Date(Date.now()-3e5).toISOString(),
  input:{note:'Done. [Internal draft v1; SHA256 '+SYNTHETIC_DOC_HASH+'; no external delivery.]'}},
];

const CAPABILITY={
 rhys:{actor:'rhys',triage:true,review:true,rhysActor:'rhys'},
 // Synthetic: Pat is unprovisioned hosted. See the note above.
 pat:{actor:'pat',triage:false,review:true,rhysActor:'rhys'},
 // Captured: hosted-capabilities-20261009.json, actor nat.
 nat:{actor:'nat',triage:true,review:false,rhysActor:'rhys'},
};
/** What each actor may see. Rhys has the full source; Pat and Nat are task-only. */
function permitted(actor){
 if(actor==='rhys')return {limited:false,ids:[1,2,3,4,5,6,7,8]};
 if(actor==='pat')return {limited:true,ids:[3,5,6]};
 return {limited:true,ids:[2,4,5]};
}
const EVIDENCE={
 1:{key:'c1',title:'Onboarding pack',quote:'I said I would get the onboarding pack over to the Collins Twins this week.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Rhys',uncertainty:''},
 2:{key:'c2',title:'Intake SOP',quote:'We need a written intake SOP so Nat can run it without me.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Nat',uncertainty:''},
 3:{key:'c3',title:'Q4 offer brief',quote:'Let us get the Q4 offer written up properly.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Rhys',uncertainty:''},
 4:{key:'c4',title:'Handoff checklist',quote:'A weekly handoff checklist would stop things dropping.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Nat',uncertainty:''},
 5:{key:'c5',title:'Referral script',quote:'The referral follow-up script needs updating.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Nat',uncertainty:''},
 6:{key:'c6',title:'Retreat venue',quote:'Confirm the venue for the May retreat.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Pat',uncertainty:''},
 7:{key:'c7',title:'Ads reporting',quote:'Rebuild the ads reporting sheet.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Atlas',uncertainty:''},
 8:{key:'c8',title:'Partner proposal',quote:'Put together the partner proposal.',kind:'promise',provenance:'transcript',suggestedResponsibility:'Rhys',uncertainty:''},
};
/** Drafting rights follow the role on the task, as the real path does. */
function rightsFor(actor,n,doc){
 const t=state[n].task;if(!t)return [];
 const isExecutor=t.executor===actor,isReviewer=t.next_reviewer===actor;
 if(doc.status==='ready'||doc.status==='needs_revision')return isExecutor?['build']:[];
 if(doc.status==='draft')return isExecutor?['revise','handoff']:isReviewer?['revise']:[];
 if(doc.status==='in_review')return isReviewer?['review','revise']:isExecutor?['revise']:[];
 return [];
}
function item(n,limited){
 const s=state[n];
 return {id:'request-'+n,revision:s.revision,sourceRevision:'source-v1',title:s.title,due:s.due,owner:s.owner,state:s.state,deferred:s.deferred,taskOnly:limited,
  sharedCorrection:s.correction,sharedCorrectionRequired:true,reconciliationRequired:false,evidence:EVIDENCE[n],
  assignees:[{actor:'rhys',review:true},{actor:'pat',review:true},{actor:'nat',review:false}],
  task:s.task?{id:T(n),executor:s.task.executor,next_reviewer:s.task.next_reviewer,work_status:s.task.work_status,receipts:[]}:null};
}
function queue(actor){
 const {limited,ids}=permitted(actor);
 return {capability:CAPABILITY[actor],
  coverageBoundary:'Synthetic fixture coverage only; no live customer meeting.',
  coverage:limited?[]:[{start:inDays(-1),end:inDays(0),status:'fixture',observedAt:ago(3)}],
  meetings:[{id:SOURCE,title:'Weekly check-in with Collins Twins',instant:ago(2),state:'ready',
   note:'Synthetic fixture call. No client transcript.',revision:'source-v1',taskOnly:limited,sourceChanged:false,pending:null,
   assignees:[{actor:'rhys',review:true},{actor:'pat',review:true},{actor:'nat',review:false}],
   items:ids.map(n=>item(n,limited))}]};
}
const COVERAGE_REPORTING={status:'review_required',visibility:'operator',message:'Synthetic fixture coverage.',operatingEnabled:true,
 lastSuccessfulScan:ago(3),lastProcessedAt:ago(2),sourceWorkPending:1,
 stages:{scopeHeld:1,captured:5,extracted:3,heldOrFailed:1,awaitingReview:2},
 sourceChecks:[
  {title:'Prospect call — Harrow Group',state:'permission_denied',reason:'The recording sits in a workspace we were not given access to.',checkedAt:ago(3)},
  {title:'Internal planning call',state:'scope_held',reason:'Internal calls are outside the agreed scope.',checkedAt:ago(3)},
 ],runs:[]};
const COVERAGE_DISABLED={status:'disabled',message:'Recurring intake is disabled. Existing proposals do not establish current meeting coverage.'};

// Screenshots are taken from the untouched board, after the flow checks have
// mutated it, so the images show every column populated.
const INITIAL=structuredClone({state,documents});
function reset(){
 for(const k of Object.keys(state))state[k]=structuredClone(INITIAL.state[k]);
 for(const k of Object.keys(documents))documents[k]=structuredClone(INITIAL.documents[k]);
 writes.length=0;
}

const server=http.createServer(async(req,res)=>{
 let body='';for await(const b of req)body+=b;
 const d=body?JSON.parse(body):{};
 const actor=(req.headers.authorization||'').replace('Bearer synthetic-','');
 res.setHeader('Content-Type','application/json');
 if(req.url==='/control'){
  if(req.method==='POST'&&'intake' in d)intakeMode=d.intake;
  if(req.method==='POST'&&d.reset)reset();
  if(req.method==='POST'&&d.docStatus)documents[d.docStatus.task].status=d.docStatus.status;
  if(req.method==='POST'&&d.docRefuse!==undefined)refuseDocument=d.docRefuse;
  return res.end(JSON.stringify({intakeMode,writes,reads,state,documents}));
 }
 if(!CAPABILITY[actor]){res.statusCode=403;return res.end(JSON.stringify({code:'42501',message:'Synthetic access refused'}))}
 if(req.url==='/rpc/meeting_capability')return res.end(JSON.stringify(CAPABILITY[actor]));
 if(req.url==='/rpc/meeting_intake_operational_coverage')
  return res.end(JSON.stringify(intakeMode==='disabled'?COVERAGE_DISABLED:COVERAGE_REPORTING));
 if(req.url==='/rpc/meeting_intake_review')return res.end(JSON.stringify({candidates:[],relations:[]}));
 if(req.url==='/rpc/meeting_document'){
  const n=Number(String(d.task_id||'').slice(-1));
  // The second held shape: a non-200 refusal carrying only a message.
  if(refuseDocument===n){res.statusCode=403;return res.end(JSON.stringify({code:'42501',message:'Refused'}))}
  if(!permitted(actor).ids.includes(n)){res.statusCode=403;return res.end(JSON.stringify({code:'42501',message:'Not permitted'}))}
  const doc=documents[n];
  if(!doc)return res.end(JSON.stringify({available:false,reason:'This task has no drafting set up.'}));
  if(d.action==='read')return res.end(JSON.stringify({...doc,...(doc.available===false?{}:{rights:rightsFor(actor,n,doc)})}));
  if(doc.available===false){res.statusCode=409;return res.end(JSON.stringify({code:'PT409',message:'Unavailable'}))}
  writes.push({actor,action:d.action,task:n});
  if(d.action==='handoff'){doc.status='in_review';doc.rights=['review'];doc.revision++}
  else if(d.action==='review'){doc.status='accepted';doc.rights=[];doc.revision++;state[n].task.work_status='completed';state[n].revision++}
  else if(d.action==='revise'){doc.status='needs_revision';doc.rights=['build'];doc.revision++}
  return res.end(JSON.stringify(doc));
 }
 if(req.url!=='/rpc/meeting_queue'){res.statusCode=404;return res.end(JSON.stringify({message:'no route'}))}
 if(d.action==='list'){reads[actor]++;return res.end(JSON.stringify(queue(actor)))}
 if(d.action==='context')return res.end(JSON.stringify({label:actor==='rhys'?'Permitted source context':'Permitted task-only context',
  item:{evidence:{speaker:'Synthetic speaker',start:0,end:1,passage:1,quote:'Task-safe context only',uncertainty:''}},
  /*
   * Review finding R7: canonical review history is exactly where a document hash lands.
   * Migration 028's review path writes 'Atlas draft v<n> submitted for required review;
   * SHA256 <64 hex>; no external delivery.' into app_private.meeting_history via
   * meeting_queue_v21, and full-source context returns that history verbatim. The note
   * below is that shape, so the customer view can be proved to withhold it rather than
   * asserted clean against a resting fixture that never contained one.
   */
  history:HISTORY}));
 const n=Number(String(d.payload?.id||'').replace('request-',''));
 const s=state[n];
 if(!s||!permitted(actor).ids.includes(n)){res.statusCode=403;return res.end(JSON.stringify({code:'42501',message:'Synthetic action refused'}))}
 if(d.payload.revision!==s.revision){res.statusCode=409;return res.end(JSON.stringify({code:'PT409',message:'This changed somewhere else. Reload before saving.'}))}
 const triage=CAPABILITY[actor].triage,review=CAPABILITY[actor].review;
 if(d.action==='accept'&&triage){s.task={executor:s.owner,next_reviewer:'rhys',work_status:'todo'};s.state='accepted'}
 else if(d.action==='edit'&&triage){if('due' in d.payload)s.due=d.payload.due;if(d.payload.executor!==undefined&&s.task)s.task.executor=d.payload.executor;if(d.payload.owner!==undefined)s.owner=d.payload.owner;if(d.payload.title)s.title=d.payload.title}
 else if(d.action==='complete'&&s.task&&[s.owner,s.task.executor].includes(actor))s.task.work_status=s.task.next_reviewer?'needs_review':'completed';
 else if(d.action==='review'&&review&&s.task?.next_reviewer===actor){s.task.work_status='completed';s.correction=null}
 else if(d.action==='request_changes'&&review&&s.task?.next_reviewer===actor){s.task.work_status='todo';s.correction=d.payload.sharedNote||d.payload.note}
 else if(d.action==='defer'&&triage)s.deferred=!s.deferred;
 else if(d.action==='dismiss'&&triage)s.state='declined';
 else {res.statusCode=403;return res.end(JSON.stringify({code:'42501',message:'Synthetic action refused'}))}
 s.revision++;
 writes.push({actor,action:d.action,id:d.payload.id,operationId:d.payload.operationId});
 res.end(JSON.stringify({saved:true}));
});
server.listen(port,'127.0.0.1',()=>console.log('Synthetic board RPC '+port));
