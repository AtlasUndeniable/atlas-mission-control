// Pure vocabulary and presentation checks. No browser, network or database.
import test from 'node:test';import assert from 'node:assert/strict';
import {BOARD_STATUSES,BOARD_STATUS_LABEL,HELD_DRAFT_STATES,deriveBoardStatus,draftingBlock,nextAction,plainHeldReason} from '../src/lib/board/task-status.ts';
import {freshness,relativeTime,dueLabel,identifierLeaks,actorName,taskControls,refusedEditFields,customerSafeNote,IDENTIFIER_PLACEHOLDER} from '../src/lib/board/presentation.ts';
import {summariseIntake,periodWords} from '../src/lib/board/intake-summary.ts';

const NOW=Date.parse('2026-10-09T09:00:00Z');
const base={hasTask:false} as Parameters<typeof deriveBoardStatus>[0];
const task=(o:object={})=>deriveBoardStatus({hasTask:true,workStatus:'todo',...o} as Parameters<typeof deriveBoardStatus>[0]);

// ---- the seven agreed statuses -------------------------------------------
test('the vocabulary is exactly the seven agreed statuses, in flow order',()=>{
 assert.deepEqual([...BOARD_STATUSES],['proposed','accepted','drafted','in_review','changes_requested','complete','held']);
 assert.deepEqual(BOARD_STATUSES.map(s=>BOARD_STATUS_LABEL[s]),['Proposed','Accepted','Drafted','In review','Changes requested','Complete','Held']);
});
test('every status produces a non-empty plain-language reason',()=>{
 for(const s of BOARD_STATUSES){
  const r=s==='proposed'?deriveBoardStatus(base)
   :s==='accepted'?task()
   :s==='drafted'?task({draft:{available:true,status:'draft',currentVersion:1}})
   :s==='in_review'?task({workStatus:'needs_review'})
   :s==='changes_requested'?task({sharedCorrection:'Add the deadline'})
   :s==='complete'?task({workStatus:'completed'})
   :task({executor:'atlas'});
  assert.equal(r.status,s,`expected ${s}, got ${r.status}`);
  assert.ok(r.reason.length>10&&/[.!]$/.test(r.reason.trim()),`${s} reason is not a sentence: ${r.reason}`);
  assert.deepEqual(identifierLeaks(r.reason),[],`${s} reason leaks an identifier`);
 }
});
test('a proposal with no task is Proposed; parked and dismissed say why',()=>{
 assert.equal(deriveBoardStatus(base).status,'proposed');
 assert.match(deriveBoardStatus({...base,deferred:true}).reason,/Parked/);
 assert.match(deriveBoardStatus({...base,itemState:'declined'}).reason,/Decided against/);
});
test('held wins over every other status and always carries a held reason',()=>{
 const changed=task({workStatus:'completed',sourceChanged:true});
 assert.equal(changed.status,'held');
 assert.ok(changed.heldReason);
 assert.equal(task({workStatus:'needs_review',reconciliationRequired:true}).status,'held');
 assert.equal(task({executor:'atlas'}).status,'held');
});
test('drafting being unavailable blocks Start but does not hold the card',()=>{
 // A person can still do the work by hand, and a task that never used
 // drafting must not be mislabelled as blocked.
 const unavailable={available:false,reason:'credit_exhausted'};
 assert.equal(task({draft:unavailable}).status,'accepted');
 assert.equal(task({workStatus:'needs_review',draft:unavailable}).status,'in_review');
 assert.equal(task({workStatus:'completed',draft:unavailable}).status,'complete');
 const block=draftingBlock(unavailable);
 assert.ok(block,'an unavailable draft must explain itself');
 assert.match(block,/no credit/);
 assert.ok(!block.includes('credit_exhausted'),'provider token leaked into the card');
 assert.equal(draftingBlock(null),null);
 assert.equal(draftingBlock({available:true,status:'ready'}),null);
});
test('a completed Atlas task is Complete, not held',()=>{
 assert.equal(task({executor:'atlas',workStatus:'completed'}).status,'complete');
});
test('draft version drives the Drafted badge and never appears without a version',()=>{
 assert.equal(task({draft:{available:true,status:'draft',currentVersion:2}}).draftVersion,2);
 assert.equal(task({draft:{available:true,status:'ready',currentVersion:0}}).draftVersion,null);
 assert.equal(task({draft:{available:true,status:'ready',currentVersion:0}}).status,'accepted');
});
test('needs_revision and a shared correction both read as Changes requested',()=>{
 assert.equal(task({draft:{available:true,status:'needs_revision',currentVersion:1}}).status,'changes_requested');
 const shared=task({sharedCorrection:'Add the escalation owner'});
 assert.equal(shared.status,'changes_requested');
 assert.match(shared.reason,/Add the escalation owner/);
});
test('in review covers both the task reviewer and a draft with a reviewer',()=>{
 assert.equal(task({workStatus:'needs_review'}).status,'in_review');
 assert.equal(task({draft:{available:true,status:'in_review',currentVersion:1}}).status,'in_review');
});

// ---- held reasons stay in plain language ---------------------------------
test('a bare category token from the provider is never printed raw',()=>{
 assert.equal(plainHeldReason('refusal','fallback.'),'The drafting assistant declined to write this one. A person needs to pick it up.');
 const unknown=plainHeldReason('some_new_category','Drafting is not available.');
 assert.match(unknown,/some new category/);
 assert.ok(!unknown.includes('some_new_category'),'underscored token leaked');
 assert.equal(plainHeldReason('A whole sentence from the product.','fallback.'),'A whole sentence from the product.');
 assert.equal(plainHeldReason('','fallback.'),'fallback.');
 assert.equal(plainHeldReason(null,'fallback.'),'fallback.');
});

// ---- the next-action sentence --------------------------------------------
test('next action names a person and says "You" for the signed-in actor',()=>{
 const i={owner:'rhys',executor:'nat',reviewer:'rhys',name:actorName};
 assert.equal(nextAction('accepted',{...i,viewer:'nat'}),'You to start the work.');
 assert.equal(nextAction('accepted',{...i,viewer:'rhys'}),'Nat to start the work.');
 assert.equal(nextAction('in_review',{...i,viewer:'rhys'}),'You to check the work and approve it.');
 assert.equal(nextAction('complete',{...i,viewer:'rhys'}),'Nothing. This one is finished.');
 assert.match(nextAction('accepted',{...i,executor:null,viewer:'rhys'}),/Choose who does this/);
});
test('a held card tells you the hold is the next action',()=>{
 assert.equal(nextAction('held',{name:actorName,heldReason:'Atlas is not switched on.'}),'Atlas is not switched on.');
});
test('every next-action sentence is identifier-free',()=>{
 for(const s of BOARD_STATUSES)assert.deepEqual(identifierLeaks(nextAction(s,{owner:'rhys',executor:'nat',reviewer:'pat',viewer:'rhys',name:actorName,heldReason:'Held for a reason.'})),[]);
});

// ---- freshness and due dates ---------------------------------------------
test('freshness names the call and how long ago it was',()=>{
 assert.equal(freshness('Weekly check-in with Collins Twins','2026-10-09T07:00:00Z',NOW),'From your call “Weekly check-in with Collins Twins”, 2 hours ago.');
 assert.equal(freshness('Weekly check-in','2026-10-09T08:59:50Z',NOW),'From your call “Weekly check-in”, just now.');
});
test('freshness never invents a call Nat is not allowed to see',()=>{
 assert.equal(freshness(null,'2026-10-09T07:00:00Z',NOW),'Recorded 2 hours ago.');
 assert.equal(freshness(null,null,NOW),'Source and timing are not recorded for this item.');
});
test('relative time is whole units and tolerates bad input',()=>{
 assert.equal(relativeTime('2026-10-08T09:00:00Z',NOW),'yesterday');
 assert.equal(relativeTime('2026-09-09T09:00:00Z',NOW),'4 weeks ago');
 assert.equal(relativeTime('not a date',NOW),'');
 assert.equal(relativeTime(null,NOW),'');
});
test('due dates read as words, including overdue',()=>{
 assert.equal(dueLabel(null,NOW),'No due date');
 assert.equal(dueLabel('2026-10-09',NOW),'Due today');
 assert.equal(dueLabel('2026-10-10',NOW),'Due tomorrow');
 assert.equal(dueLabel('2026-10-07',NOW),'Overdue by 2 days');
 assert.equal(dueLabel('2026-10-13',NOW),'Due in 4 days');
 assert.equal(dueLabel('2026-12-01',NOW),'Due 1 Dec');
});

// ---- the identifier detector itself --------------------------------------
test('the identifier detector catches the shapes the customer view must not show',()=>{
 assert.equal(identifierLeaks('candidate 2699ab333ed129819f6639df22636a5e0893dfc5').length,1);
 assert.equal(identifierLeaks('task 00000000-0000-4000-8000-000000000001').length>0,true);
 assert.equal(identifierLeaks('migration 027_task_delegation_schedule').length,1);
 assert.equal(identifierLeaks('build 01a9tytU7AfWsVpKyQdp7').length,1);
 assert.equal(identifierLeaks('revision 4').length,1);
 assert.equal(identifierLeaks('source-v1').length,1);
});
test('the identifier detector does not fire on ordinary board wording',()=>{
 for(const ordinary of ['Prepare the weekly handoff checklist','From your call “Weekly check-in with Collins Twins”, 2 hours ago.','Nat to start the work.','Draft v2 is ready to read.','Overdue by 2 days','Changes asked for: add the escalation owner and deadline.'])
  assert.deepEqual(identifierLeaks(ordinary),[],`false positive on: ${ordinary}`);
});
test('actor names format without inventing access',()=>{
 assert.equal(actorName('rhys'),'Rhys');assert.equal(actorName('nat'),'Nat');assert.equal(actorName('pat'),'Pat');
 assert.equal(actorName('fixture.nat'),'Nat');assert.equal(actorName('atlas'),'Atlas');assert.equal(actorName(null),'Unassigned');
});

// ---- the intake strip ----------------------------------------------------
test('intake switched off says so and refuses to imply a healthy board',()=>{
 const s=summariseIntake({status:'disabled',message:'Recurring intake is disabled.'},NOW);
 assert.equal(s.mode,'off');
 assert.match(s.headline,/not being turned into tasks/);
 assert.equal(s.counts,null);
});
test('an operating-disabled payload is still reported as off',()=>{
 assert.equal(summariseIntake({status:'review_required',operatingEnabled:false},NOW).mode,'off');
});
test('an unreachable intake check is unknown, never silently healthy',()=>{
 for(const p of [null,{status:'unavailable'}]){
  const s=summariseIntake(p,NOW);
  assert.equal(s.mode,'unknown');
  assert.match(s.caveat,/an empty board does not mean there is nothing to do/i);
 }
});
test('counts come from the reported stages and name the period truthfully',()=>{
 const s=summariseIntake({status:'review_required',lastSuccessfulScan:'2026-10-09T06:00:00Z',sourceWorkPending:1,stages:{scopeHeld:1,captured:5,extracted:3,heldOrFailed:2,awaitingReview:4}},NOW);
 assert.deepEqual(s.counts,{processed:3,pending:3,held:3,awaitingReview:4});
 assert.equal(s.period,'today');
 assert.match(s.headline,/3 calls turned into tasks today, 3 still to do, 3 held\./);
});
test('the period is never called today without evidence',()=>{
 assert.equal(periodWords(undefined,NOW),'');
 assert.equal(periodWords('2026-10-08T06:00:00Z',NOW),'yesterday');
 assert.equal(periodWords('2026-10-01T06:00:00Z',NOW),'on 1 Oct');
});
test('held calls are listed in plain language and keep the reason given',()=>{
 const s=summariseIntake({status:'review_required',stages:{scopeHeld:0,captured:2,extracted:1,heldOrFailed:1,awaitingReview:0},sourceChecks:[{title:'Discovery call',state:'permission_denied',reason:'The recording is owned by another workspace.',checkedAt:'2026-10-09T06:00:00Z'},{title:'Done call',state:'ok',reason:'',checkedAt:'2026-10-09T06:00:00Z'}]},NOW);
 assert.equal(s.holds.length,1);
 assert.equal(s.holds[0].title,'Discovery call');
 assert.match(s.holds[0].reason,/Held because we do not have permission to read it\. The recording is owned by another workspace\./);
 assert.match(s.caveat,/not complete until they are dealt with/);
});
test('an unknown hold state still produces a sentence rather than a raw token',()=>{
 const s=summariseIntake({status:'review_required',stages:{scopeHeld:0,captured:1,extracted:0,heldOrFailed:1,awaitingReview:0},sourceChecks:[{title:'Call',state:'weird_new_state',reason:'',checkedAt:'2026-10-09T06:00:00Z'}]},NOW);
 assert.equal(s.holds[0].reason,'Held: weird new state.');
});

// ---- draft states that must stop the card (confirmed with Lane C) --------
test('a reserved or unresolved generation holds the card instead of offering Start again',()=>{
 for(const state of ['building','uncertain','rejected','cancelled','authority_changed']){
  const r=task({draft:{available:true,status:state,currentVersion:0,rights:['build']}});
  assert.equal(r.status,'held',`${state} should hold the card`);
  assert.equal(r.heldReason,HELD_DRAFT_STATES[state]);
  assert.deepEqual(identifierLeaks(r.reason),[],`${state} reason leaks an identifier`);
  if(state.includes('_'))assert.ok(!r.reason.includes(state),`${state} printed its raw state token`);
  assert.ok(/[.!]$/.test(r.reason.trim()),`${state} reason is not a sentence`);
 }
});
test('a held draft state does not override finished work',()=>{
 assert.equal(task({workStatus:'completed',draft:{available:true,status:'cancelled'}}).status,'complete');
});
test('ready is Accepted, not held',()=>{
 assert.equal(task({draft:{available:true,status:'ready',currentVersion:0,rights:['build']}}).status,'accepted');
});
test('an Atlas task is held only while drafting offers it nothing',()=>{
 assert.equal(task({executor:'atlas'}).status,'held');
 assert.equal(task({executor:'atlas',draft:{available:false,reason:'Task drafting is held.'}}).status,'held');
 assert.equal(task({executor:'atlas',draft:{available:true,status:'ready',currentVersion:0,rights:[]}}).status,'held');
 // Once the drafting path offers the owner something, the card rejoins the flow.
 assert.equal(task({executor:'atlas',draft:{available:true,status:'ready',currentVersion:0,rights:['build']}}).status,'accepted');
 assert.equal(task({executor:'atlas',draft:{available:true,status:'draft',currentVersion:1,rights:['review']}}).status,'drafted');
});
test('a refusal from the drafting path reads as a reason, not a blank card',()=>{
 const block=draftingBlock({available:false,reason:'This task operation is not permitted.'});
 assert.equal(block,'This task operation is not permitted.');
});

/*
 * Lane F / review findings R6 and R7, as pure unit cases over the same derivations the
 * board and the route both use.
 */
test('R6: ownership controls come from the accountable principal, not from can_triage', () => {
 // The captured hosted capability, verbatim: nat is a builder with triage true.
 const nat={actor:'nat',triage:true,review:false,rhysActor:'rhys'};
 const rhys={actor:'rhys',triage:true,review:true,rhysActor:'rhys'};
 const pat={actor:'pat',triage:false,review:true,rhysActor:'rhys'};
 const hers={executor:'nat',next_reviewer:'rhys'};
 const his={executor:'rhys',next_reviewer:'pat'};

 const natOnHers=taskControls(nat,hers);
 assert.equal(natOnHers.manageOwnership,false,'triage alone is not an ownership right');
 assert.equal(natOnHers.setReviewer,false);
 assert.equal(natOnHers.schedule,true,'the person doing the work keeps its timing');
 assert.match(natOnHers.withheldReason,/change the timing of this and report your work/);

 const natOnHis=taskControls(nat,his);
 assert.equal(natOnHis.manageOwnership,false);
 assert.equal(natOnHis.schedule,false,'and only of work she is actually doing');

 const rhysControls=taskControls(rhys,hers);
 assert.deepEqual(
  {o:rhysControls.manageOwnership,r:rhysControls.setReviewer,s:rhysControls.schedule,w:rhysControls.withheldReason},
  {o:true,r:true,s:true,w:''});

 // A reviewer with no triage right writes nothing, which is what the RPC also says.
 const patControls=taskControls(pat,his);
 assert.deepEqual([patControls.manageOwnership,patControls.setReviewer,patControls.schedule],[false,false,false]);

 // An accountable principal who cannot review may still name a first reviewer, but not
 // displace one — the same rule as required_reviewer_change_denied.
 const anchorNoReview={actor:'rhys',triage:true,review:false,rhysActor:'rhys'};
 assert.equal(taskControls(anchorNoReview,{executor:'nat',next_reviewer:null}).setReviewer,true);
 assert.equal(taskControls(anchorNoReview,{executor:'nat',next_reviewer:'pat'}).setReviewer,false);

 // A capability with no recorded accountable principal grants nothing.
 assert.equal(taskControls({actor:'nat',triage:true,review:true,rhysActor:null},hers).manageOwnership,false);
 assert.equal(taskControls(null,hers).manageOwnership,false);
});

test('R6: the mutation boundary refuses exactly the fields the board withholds', () => {
 const nat={actor:'nat',triage:true,review:false,rhysActor:'rhys'};
 const rhys={actor:'rhys',triage:true,review:true,rhysActor:'rhys'};
 const hers={executor:'nat',next_reviewer:'rhys'};
 assert.deepEqual(refusedEditFields(nat,{owner:'nat'},hers),['owner']);
 assert.deepEqual(refusedEditFields(nat,{executor:'rhys'},hers),['executor']);
 assert.deepEqual(refusedEditFields(nat,{title:'Something else'},hers),['title']);
 assert.deepEqual(refusedEditFields(nat,{reviewer:'nat'},hers),['reviewer']);
 // A null value is still a write of that field.
 assert.deepEqual(refusedEditFields(nat,{owner:null},hers),['owner']);
 assert.deepEqual(refusedEditFields(nat,{owner:'nat',executor:'nat',due:'2026-12-01'},hers),['owner','executor']);
 // Her retained right, and a note, are permitted.
 assert.deepEqual(refusedEditFields(nat,{due:'2026-12-01',note:'done'},hers),[]);
 assert.deepEqual(refusedEditFields(nat,{due:'2026-12-01'},{executor:'rhys',next_reviewer:'pat'}),['due']);
 // The accountable principal is refused nothing.
 assert.deepEqual(refusedEditFields(rhys,{owner:'nat',executor:'nat',reviewer:'pat',title:'t',due:'2026-12-01'},hers),[]);
});

test('R7: a canonical note with a SHA256 is withheld from the customer view', () => {
 const hash='4f'.repeat(32);
 assert.equal(hash.length,64);
 const note=`Atlas draft v1 submitted for required review; SHA256 ${hash}; no external delivery.`;
 const safe=customerSafeNote(note);
 assert.ok(!safe.includes(hash),safe);
 assert.ok(safe.includes(IDENTIFIER_PLACEHOLDER),safe);
 assert.ok(safe.startsWith('Atlas draft v1 submitted for required review;'),safe);
 assert.ok(safe.endsWith('no external delivery.'),safe);
 // The detector itself finds nothing left behind.
 assert.deepEqual(identifierLeaks(safe),[]);
 // The bracketed form migration 028's complete path writes.
 const bracketed=customerSafeNote(`Done. [Internal draft v1; SHA256 ${hash}; no external delivery.]`);
 assert.ok(!bracketed.includes(hash));
 assert.deepEqual(identifierLeaks(bracketed),[]);
 // Ordinary prose is untouched.
 assert.equal(customerSafeNote('Agreed on the call. Nat to draft it.'),'Agreed on the call. Nat to draft it.');
 assert.equal(customerSafeNote(''),'');
 assert.equal(customerSafeNote(null),'');
 // A uuid, a build identifier and a migration name are withheld too.
 for(const value of ['11111111-2222-4333-8444-555555555555','0V3SfxrwOoyczRGh4wn0f','028_task_document_assets_and_usage'])
  assert.deepEqual(identifierLeaks(customerSafeNote('Bound to '+value+' as recorded.')),[],value);
 // Directly adjacent withholdings collapse into one marker rather than reading as a run.
 assert.equal((customerSafeNote(`${hash}; ${hash}`).match(/\[engineering detail\]/g)||[]).length,1);
 // Two withholdings with real prose between them stay two: the prose is not swallowed.
 assert.equal(customerSafeNote(`SHA256 ${hash} and ${hash}`),'SHA256 [engineering detail] and [engineering detail]');
});
