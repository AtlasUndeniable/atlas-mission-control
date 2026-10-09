/**
 * Start -> v1 -> Request changes -> v2 -> Approve, plus the citation contract and version
 * immutability, driven against the in-process reference ledger in document-ledger.ts.
 *
 * All actors, clients and sources are fictional. No provider call and no database.
 * Scope limit: this executes the contract the lane depends on. It is not a run of the
 * hosted SQL, which needs its own native PostgreSQL rehearsal before installation.
 *
 * Run: node --test verification/document-flow.test.ts
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {documentPrompt,renderDocument,dispatchedPacket,DOCUMENT_CONTRACT_KEYS,type DocumentPacket,type DocumentEntry} from '../src/lib/task-document-codec.ts';
import {createLedger,LedgerRefusal,type LedgerActor,type LedgerDocument} from './document-ledger.ts';

/** The two ledger return shapes these tests read. */
type Reserved={dispatch:boolean;replay?:boolean;attempt:string;token:string;state?:string;packet:DocumentPacket;revisionNote:string|null;previous:{version:number;hash:string;markdown:string}|null};
type Read={available:boolean;status:string;currentVersion:number;revision:number;versions:{version:number;hash:string}[];rights:string[]};
import {taskAssetEntries,assetDigest,assetRelease} from '../src/lib/meetings/document-runtime.ts';
import {atlasAssetRoots} from '../src/lib/task-asset-search.ts';

const BRAIN=resolve(import.meta.dirname,'fixture-brain');
const CLIENT='Northwind Pilates';
const DECISION='fixture-asset-release-2026-10-09';
const sha256=(v:string)=>createHash('sha256').update(v).digest('hex');

const COMMITMENT:DocumentEntry={
 id:'commitment',version:'rev-1',sourceHash:sha256('commitment'),kind:'commitment',
 title:'Northwind check-in change',
 text:'Rhys agreed to write the coach role SOP covering escalation before the Northwind check-in change takes effect.',
 display:true,use:true,sourceRef:{sourceId:'fixture-source'},reviewReference:'fixture-review-2026-10-09',observedAt:'2026-10-09T00:00:00.000Z',
};

const ACTORS=(overrides:Partial<Record<string,LedgerActor>>={}):LedgerActor[]=>[
 {actor:'rhys',role:'owner',rights:['context','build','output','revise','handoff'],active:true,...overrides.rhys},
 {actor:'pat',role:'reviewer',rights:['context','output','review'],active:true,canReview:true,...overrides.pat},
];

function document(over:Partial<LedgerDocument>={}):LedgerDocument{
 return {
  id:'doc-1',taskId:randomUUID(),title:'Coach role SOP for the Northwind check-in change',workflow:'role_sop',
  owner:'rhys',executor:'atlas',reviewer:'pat',
  atlasExecutor:true,atlasExecutorDecision:'fixture-atlas-execution-2026-10-09',
  assetRelease:{decision:DECISION,sharedRoots:['playbooks','frameworks','operating-manual','lead-magnets'],clientDirectories:['northwind-pilates']},
  builderSafeRoots:['playbooks','frameworks','operating-manual','lead-magnets'],
  configurationHash:sha256('fixture-configuration'),maxInvocations:2,maxOutputTokens:8000,timeoutMs:60000,
  decisionReference:'fixture-decision-2026-10-09',enabled:true,authorizationEpoch:1,
  revision:1,currentVersion:0,status:'ready',handoffVersion:null,missingContext:[],
  ...over,
 };
}

/** A contract-valid response built from whatever packet the ledger actually supplied. */
function response(packet:DocumentPacket,options:{revision?:boolean;sourcesUsed?:string[];openQuestions?:string[]}={}){
 const entry=packet.entries[0];
 const quote=entry.text.slice(0,60);
 return {
  title:'Coach Role SOP — Check-in Change',
  purpose:'Define the coach role that owns the check-in change so the change can be confirmed in writing before it starts.',
  facts:[{reference:entry.id,quote}],
  steps:[
   {action:'Confirm the new check-in day in writing to the client.',responsibleRole:'Coach',completion:'Written confirmation is sent and logged.',exception:'If the client does not reply within one business day, escalate to the head coach.'},
   {action:'Update the check-in schedule in the delivery tracker.',responsibleRole:null,completion:'Tracker shows the new day for the current cycle.',exception:'If the tracker is locked, record the change in the handover note.'},
   {action:'Book a review at the end of the following cycle.',responsibleRole:'Coach',completion:'Review is on the calendar.',exception:'If no slot is available, flag it at the Friday delivery audit.'},
  ],
  decisions:['Confirm whether the coach may change check-in cadence without founder approval.'],
  missingFacts:['The exact effective date of the new check-in day.'],
  openQuestions:options.openQuestions??['Which day should the first Thursday check-in land on?'],
  sourcesUsed:options.sourcesUsed??[entry.id],
  revisionChanges:options.revision?['Added the written-confirmation step before the change takes effect.']:[],
 };
}

async function startDraft(ledger:ReturnType<typeof createLedger>,actor='rhys',options:{revision?:boolean}={}){
 const reserved=ledger.meetingDocument(actor,'begin',{operationId:randomUUID(),revision:ledger.document.revision,configurationHash:ledger.document.configurationHash}) as unknown as Reserved;
 assert.equal(reserved.dispatch,true);
 const release=assetRelease(reserved.packet.assetRelease);
 const assets=await taskAssetEntries(release,reserved.packet,atlasAssetRoots(BRAIN));
 const packet:DocumentPacket={...reserved.packet,entries:[...reserved.packet.entries,...assets.entries],missingContext:[...reserved.packet.missingContext,...assets.notes]};
 const prompt=documentPrompt(packet,reserved.revisionNote??null,reserved.previous??null);
 ledger.runtime('check',reserved.attempt,{token:reserved.token,promptHash:sha256(prompt),assetDigest:assetDigest(assets.entries),costBound:{requestBytes:Buffer.byteLength(prompt),micros:1234,maxOutputTokens:ledger.document.maxOutputTokens}});
 ledger.runtime('usage',reserved.attempt,{token:reserved.token,usage:{input_tokens:4321,output_tokens:900}});
 const raw=response(packet,{revision:options.revision});
 const content=renderDocument(raw,packet,reserved.revisionNote??null,false);
 ledger.runtime('record',reserved.attempt,{token:reserved.token,response:raw,content});
 const published=ledger.runtime('publish',reserved.attempt,{token:reserved.token}) as {version:number};
 return {packet,assets,content,version:published.version,attempt:reserved.attempt};
}

test('Start creates v1 from retrieved assets and sets the task to Drafted', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const first=await startDraft(ledger);
 assert.equal(first.version,1);
 assert.equal(ledger.document.status,'draft','Drafted');
 assert.equal(ledger.document.currentVersion,1);
 // Assets actually reached the draft, with stable identifiers.
 assert.ok(first.assets.entries.length>0,'expected retrieved assets');
 assert.ok(first.assets.entries.every(e=>e.id.startsWith('asset:')));
 assert.ok(first.packet.entries.length>1);
 const read=ledger.meetingDocument('pat','read') as unknown as Read;
 assert.equal(read.status,'draft');
 assert.deepEqual(read.versions.map(v=>v.version),[1]);
 // Status reads never generate: the invocation budget is untouched by a read.
 assert.equal(ledger.attempts().length,1);
});

test('the usage and cost bound are recorded against the attempt before and after dispatch', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 await startDraft(ledger);
 const [attempt]=ledger.attempts();
 assert.equal(attempt.state,'published');
 assert.ok(attempt.costBoundBytes&&attempt.costBoundBytes>0);
 assert.ok(attempt.costBoundMicros&&attempt.costBoundMicros>0);
 assert.equal(attempt.inputTokens,4321);
 assert.equal(attempt.outputTokens,900);
 assert.ok(/^[0-9a-f]{64}$/.test(attempt.assetDigest||''));
 assert.ok(/^[0-9a-f]{64}$/.test(attempt.promptHash||''));
 // Usage is written once; a second report is a replay, never an overwrite.
 assert.deepEqual(ledger.runtime('usage',attempt.id,{token:attempt.token,usage:{input_tokens:1,output_tokens:1}}),{replay:true});
 assert.equal(attempt.inputTokens,4321);
});

test('a dispatch cannot happen without the cost bound and asset binding', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const reserved=ledger.meetingDocument('rhys','begin',{operationId:randomUUID(),revision:1,configurationHash:ledger.document.configurationHash}) as unknown as Reserved;
 assert.throws(()=>ledger.runtime('check',reserved.attempt,{token:reserved.token,promptHash:sha256('p'),assetDigest:sha256('a')}),/cost_bound_required/);
 assert.throws(()=>ledger.runtime('check',reserved.attempt,{token:reserved.token,promptHash:sha256('p'),costBound:{requestBytes:10,micros:10,maxOutputTokens:8000}}),/asset_binding_required/);
 assert.throws(()=>ledger.runtime('check',reserved.attempt,{token:reserved.token,promptHash:'short',assetDigest:sha256('a'),costBound:{requestBytes:10,micros:10,maxOutputTokens:8000}}),/prompt_binding_required/);
 // A mismatched output ceiling is refused rather than accepted at the caller's word.
 assert.throws(()=>ledger.runtime('check',reserved.attempt,{token:reserved.token,promptHash:sha256('p'),assetDigest:sha256('a'),costBound:{requestBytes:10,micros:10,maxOutputTokens:12000}}),/cost_bound_required/);
});

test('Request changes produces v2 from v1 plus the note, and v1 stays immutable', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const first=await startDraft(ledger);
 const v1=ledger.version(1)!;
 const note='Add the written-confirmation step before the change takes effect, and name who confirms it.';
 ledger.meetingDocument('rhys','revise',{operationId:randomUUID(),revision:1,version:1,hash:v1.contentHash,note});
 assert.equal(ledger.document.status,'needs_revision');
 assert.equal(ledger.document.revision,2);

 const second=await startDraft(ledger,'rhys',{revision:true});
 assert.equal(second.version,2);
 assert.equal(ledger.document.status,'draft');
 // v1 is preserved byte-for-byte and is still readable alongside v2.
 const v1After=ledger.version(1)!;
 assert.equal(v1After.content,v1.content);
 assert.equal(v1After.contentHash,v1.contentHash);
 assert.deepEqual(ledger.versions().map(v=>v.version),[1,2]);
 // v2 is a different document, not a copy, and names its revision changes.
 assert.notEqual(ledger.version(2)!.contentHash,v1.contentHash);
 assert.ok(ledger.version(2)!.content.includes('## Changes in this revision'));
 assert.ok(ledger.version(2)!.content.includes('Added the written-confirmation step'));
 // The revision note reached the second build rather than being dropped.
 assert.ok(second.content.includes('Changes in this revision'));
 void first;
});

test('a stored version object rejects mutation of its content and hash', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 await startDraft(ledger);
 const v1=ledger.version(1)!;
 // Writing through a widened reference is what a mutation attempt actually looks like.
 const mutable=v1 as unknown as Record<string,string>;
 assert.throws(()=>{mutable.content='rewritten';},TypeError);
 assert.throws(()=>{mutable.contentHash=sha256('rewritten');},TypeError);
 assert.equal(ledger.version(1)!.content,v1.content);
});

test('Approve binds the exact accepted version and completes the task', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 await startDraft(ledger);
 const v1=ledger.version(1)!;
 const note='This version is correct and ready; the escalation ladder matches our standard.';
 // A stale hash cannot approve: the exact version must be named.
 assert.throws(()=>ledger.meetingDocument('pat','review',{operationId:randomUUID(),revision:1,version:1,hash:sha256('other'),note}),/version_changed/);
 ledger.meetingDocument('pat','review',{operationId:randomUUID(),revision:1,version:1,hash:v1.contentHash,note});
 assert.equal(ledger.document.status,'accepted');
 assert.equal(ledger.task.workStatus,'completed');
 assert.equal(ledger.task.boundVersionHash,v1.contentHash,'the accepted bytes are what completed');
});

test('only the required reviewer can approve, and Atlas execution has no handoff step', async () => {
 // A second actor who genuinely holds the review right but is not the named required
 // reviewer, so the refusal comes from the reviewer identity and not from the rights gate.
 const actors=[...ACTORS(),{actor:'dana',role:'reviewer' as const,rights:['context','output','review'],active:true,canReview:true}];
 const ledger=createLedger(document(),actors,[COMMITMENT],CLIENT);
 await startDraft(ledger);
 const v1=ledger.version(1)!;
 const payload={operationId:randomUUID(),revision:1,version:1,hash:v1.contentHash,note:'Looks fine to me, approving this version now.'};
 // The owner holds no review right at all: denied at the rights gate, before any state.
 assert.throws(()=>ledger.meetingDocument('rhys','review',payload),/document_denied/);
 // Dana may review in general, but is not this document's required reviewer.
 assert.throws(()=>ledger.meetingDocument('dana','review',{...payload,operationId:randomUUID()}),/review_denied/);
 assert.throws(()=>ledger.meetingDocument('rhys','handoff',{...payload,operationId:randomUUID()}),/atlas_execution_has_no_handoff/);
 assert.equal(ledger.task.workStatus,'todo');
 assert.equal(ledger.task.boundVersionHash,null);
});

test('with a human executor the handoff step is still required before review', async () => {
 const actors=[...ACTORS(),{actor:'nat',role:'builder' as const,rights:['context','build','output','revise','handoff'],active:true}];
 const ledger=createLedger(document({executor:'nat',atlasExecutor:false,atlasExecutorDecision:null}),actors,[COMMITMENT],CLIENT);
 await startDraft(ledger,'nat');
 const v1=ledger.version(1)!;
 const base={revision:1,version:1,hash:v1.contentHash,note:'Handing this version to the required reviewer for acceptance.'};
 assert.throws(()=>ledger.meetingDocument('pat','review',{...base,operationId:randomUUID()}),/review_denied/);
 ledger.meetingDocument('nat','handoff',{...base,operationId:randomUUID()});
 assert.equal(ledger.document.status,'in_review');
 ledger.meetingDocument('pat','review',{...base,operationId:randomUUID(),note:'Accepting this exact version; the steps are correct.'});
 assert.equal(ledger.task.workStatus,'completed');
});

test('Nat as executor sees only task-scoped context and no builder-unsafe root', async () => {
 const actors=[...ACTORS(),{actor:'nat',role:'builder' as const,rights:['context','build','output','revise','handoff'],active:true}];
 // A shared root that is not marked builder-safe refuses the whole packet while Nat holds
 // an active grant, rather than quietly dropping that root from her view.
 const ledger=createLedger(document({executor:'nat',atlasExecutor:false,atlasExecutorDecision:null,builderSafeRoots:['playbooks']}),actors,[COMMITMENT],CLIENT);
 assert.throws(()=>ledger.packet('nat','build'),/asset_release_builder_denied/);
 const safe=createLedger(document({executor:'nat',atlasExecutor:false,atlasExecutorDecision:null,assetRelease:{decision:DECISION,sharedRoots:['playbooks'],clientDirectories:['northwind-pilates']},builderSafeRoots:['playbooks']}),actors,[COMMITMENT],CLIENT);
 const packet=safe.packet('nat','build');
 // Her packet carries the task's own commitment and nothing from another client.
 assert.equal(packet.client,CLIENT);
 const assets=await taskAssetEntries(assetRelease(packet.assetRelease),packet,atlasAssetRoots(BRAIN));
 assert.ok(!assets.entries.some(e=>JSON.stringify(e.sourceRef).includes('kestrel')));
 assert.ok(assets.entries.every(e=>e.id.startsWith('asset:playbooks:')||e.id.startsWith('asset:client-work:northwind-pilates/')));
});

test('CITATION: the draft lists the sources it used and cannot cite outside the packet', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const reserved=ledger.meetingDocument('rhys','begin',{operationId:randomUUID(),revision:1,configurationHash:ledger.document.configurationHash}) as unknown as Reserved;
 const assets=await taskAssetEntries(assetRelease(reserved.packet.assetRelease),reserved.packet,atlasAssetRoots(BRAIN));
 const packet:DocumentPacket={...reserved.packet,entries:[...reserved.packet.entries,...assets.entries],missingContext:[]};
 const asset=assets.entries[0];

 // Every cited source appears in the rendered Sources used section, by identifier.
 const cited=renderDocument({...response(packet),facts:[{reference:'commitment',quote:COMMITMENT.text.slice(0,40)},{reference:asset.id,quote:asset.text.slice(0,40)}],sourcesUsed:['commitment',asset.id]},packet,null,false);
 assert.ok(cited.includes('## Sources used'));
 assert.ok(cited.includes(`[${asset.id}]`),'the asset identifier must be visible in the draft');
 assert.ok(cited.includes('[commitment]'));
 assert.ok(cited.includes('## Open questions for Rhys'));

 // A source that was quoted but omitted from sourcesUsed is refused.
 assert.throws(()=>renderDocument({...response(packet),facts:[{reference:'commitment',quote:COMMITMENT.text.slice(0,40)},{reference:asset.id,quote:asset.text.slice(0,40)}],sourcesUsed:['commitment']},packet,null,false),/uncited_document_source/);
 // A source outside the packet is refused even if nothing was quoted from it.
 assert.throws(()=>renderDocument(response(packet,{sourcesUsed:['commitment','asset:client-work:kestrel-strength/kestrel-notes.md']}),packet,null,false),/unsupported_document_source/);
 // A fabricated quote against a real source is refused.
 assert.throws(()=>renderDocument({...response(packet),facts:[{reference:asset.id,quote:'Undeniable guarantees a 40% retention lift.'}],sourcesUsed:[asset.id]},packet,null,false),/unsupported_document_fact/);
 // An empty source list is refused: a draft must say what it used.
 assert.throws(()=>renderDocument(response(packet,{sourcesUsed:[]}),packet,null,false),/document_contract_invalid/);
 // Duplicates are refused rather than inflating the apparent source count.
 assert.throws(()=>renderDocument(response(packet,{sourcesUsed:['commitment','commitment']}),packet,null,false),/document_contract_invalid/);
});

test('the contract requires open questions and refuses an unknown or missing key', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const packet=ledger.packet('rhys','build');
 assert.throws(()=>renderDocument(response(packet,{openQuestions:[]}),packet,null,false),/document_contract_invalid/);
 const missing=Object.fromEntries(Object.entries(response(packet)).filter(([k])=>k!=='openQuestions'));
 assert.throws(()=>renderDocument(missing,packet,null,false),/document_contract_invalid/);
 assert.throws(()=>renderDocument({...response(packet),extra:1},packet,null,false),/document_contract_invalid/);
 assert.deepEqual([...DOCUMENT_CONTRACT_KEYS].sort(),Object.keys(response(packet)).sort());
});

test('the dispatched packet carries released content but not the release decision', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const packet=ledger.packet('rhys','build');
 assert.ok(packet.assetRelease,'the ledger supplies the release scope');
 assert.equal((dispatchedPacket(packet) as Record<string,unknown>).assetRelease,undefined);
 const prompt=documentPrompt(packet,null,null);
 assert.ok(!prompt.includes('northwind-pilates'),'directory names are authority, not prompt content');
 assert.ok(!prompt.includes(DECISION));
});

test('a revision instruction echoed back as the change is refused', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const packet=ledger.packet('rhys','build');
 const note='Add the written-confirmation step before the change takes effect.';
 assert.throws(()=>renderDocument({...response(packet),revisionChanges:[note]},packet,note,false),/revision_instruction_is_not_a_change/);
 // And a revision that reports no change at all is refused.
 assert.throws(()=>renderDocument({...response(packet),revisionChanges:[]},packet,note,false),/document_contract_invalid/);
});

test('an authority change fences the existing version and the reserved attempt', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 await startDraft(ledger);
 const before=ledger.meetingDocument('pat','read') as unknown as Read;
 assert.equal(before.status,'draft');
 ledger.bumpAuthority();
 const after=ledger.meetingDocument('pat','read') as unknown as Read;
 assert.equal(after.status,'authority_changed');
 // The revoked draft is retained but cannot be approved or fed into a new correction.
 assert.deepEqual(after.versions,[]);
 const v1=ledger.version(1)!;
 assert.throws(()=>ledger.meetingDocument('pat','review',{operationId:randomUUID(),revision:1,version:1,hash:v1.contentHash,note:'Approving this version after the authority change.'}),/version_changed/);
});

test('the invocation budget is spent, never replenished by a revision loop', async () => {
 const ledger=createLedger(document({maxInvocations:2}),ACTORS(),[COMMITMENT],CLIENT);
 await startDraft(ledger);
 const v1=ledger.version(1)!;
 ledger.meetingDocument('rhys','revise',{operationId:randomUUID(),revision:1,version:1,hash:v1.contentHash,note:'Needs the confirmation step named explicitly before it starts.'});
 await startDraft(ledger,'rhys',{revision:true});
 const v2=ledger.version(2)!;
 ledger.meetingDocument('rhys','revise',{operationId:randomUUID(),revision:2,version:2,hash:v2.contentHash,note:'One more correction: name the escalation owner for a missed confirmation.'});
 assert.throws(()=>ledger.meetingDocument('rhys','begin',{operationId:randomUUID(),revision:3,configurationHash:ledger.document.configurationHash}),/invocation_budget_spent/);
 assert.equal(ledger.versions().length,2,'both prior versions are preserved');
});

test('a duplicate Start is a replay, not a second dispatch', async () => {
 const ledger=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 const operationId=randomUUID();
 const payload={operationId,revision:1,configurationHash:ledger.document.configurationHash};
 const first=ledger.meetingDocument('rhys','begin',payload) as unknown as Reserved;
 const second=ledger.meetingDocument('rhys','begin',payload) as unknown as Reserved;
 assert.equal(first.dispatch,true);
 assert.equal(second.dispatch,false);
 assert.equal(second.replay,true);
 assert.equal(ledger.attempts().length,1);
});

test('a held or disabled document refuses before any retrieval or dispatch', () => {
 const held=createLedger(document({enabled:false}),ACTORS(),[COMMITMENT],CLIENT);
 assert.throws(()=>held.meetingDocument('rhys','read'),/document_unavailable/);
 const unnamed=createLedger(document(),ACTORS(),[COMMITMENT],CLIENT);
 assert.throws(()=>unnamed.meetingDocument('mallory','read'),/document_denied/);
 // A recorded Atlas executor without its own decision reference cannot proceed.
 const undecided=createLedger(document({atlasExecutorDecision:null}),ACTORS(),[COMMITMENT],CLIENT);
 assert.throws(()=>undecided.meetingDocument('rhys','read'),/document_context_changed/);
 assert.ok(LedgerRefusal);
});
