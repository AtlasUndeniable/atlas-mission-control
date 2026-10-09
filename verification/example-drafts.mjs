/**
 * Render both recipes through the real contract on the real retrieved assets, using a
 * hand-written contract-valid response. The injected flag keeps the output labelled as an
 * integration example. No provider call: this shows the document shape and the citation
 * sections, never model-generated prose.
 *
 * Run: node verification/example-drafts.mjs
 */
import {writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {renderDocument} from '../src/lib/task-document-codec.ts';
import {taskAssetEntries,assetRelease} from '../src/lib/meetings/document-runtime.ts';
import {atlasAssetRoots} from '../src/lib/task-asset-search.ts';

const ROOT=resolve(import.meta.dirname,'..');
const BRAIN=join(ROOT,'verification/fixture-brain');
const RELEASE={decision:'laneC-fixture-release-2026-10-09-synthetic-only',sharedRoots:['playbooks','frameworks','operating-manual','lead-magnets'],clientDirectories:['northwind-pilates']};
const sha256=v=>createHash('sha256').update(v).digest('hex');

const RECIPES=[
 {key:'role-sop',workflow:'role_sop',
  title:'Coach Role SOP — Northwind Check-in Change',
  quote:'Rhys agreed to write the coach role SOP, including the escalation ladder, before the Northwind check-in change takes effect.',
  purpose:'Define the coach role that owns the Northwind check-in day change, so the change is confirmed in writing before it starts and the escalation path is unambiguous.',
  steps:[
   {action:'Confirm the new Thursday check-in day to the client in writing before it takes effect.',responsibleRole:'Coach',completion:'Written confirmation sent and logged against the client record.',exception:'If the client does not reply within one business day, escalate to the head coach.'},
   {action:'Update the check-in schedule in the delivery tracker for the current cycle.',responsibleRole:null,completion:'Tracker shows Thursday for every remaining check-in this cycle.',exception:'If the tracker cannot be edited, record the change in the handover note and flag it on Friday.'},
   {action:'Book a review for the end of the following cycle to confirm the new day is working.',responsibleRole:'Coach',completion:'Review is on the calendar with the client confirmed.',exception:'If no slot is available, raise it at the Friday delivery audit.'},
   {action:'Escalate any missed confirmation to the head coach within 48 hours.',responsibleRole:'Head coach',completion:'Escalation is recorded and an owner is named.',exception:'If unresolved after 72 hours, treat it as a systems failure and raise it with the founder.'},
  ],
  decisions:['Confirm whether the coach may change check-in cadence without founder approval.','Confirm whether a cadence change resets the renewal review date.'],
  missingFacts:['The exact effective date of the first Thursday check-in.','Who signs the written confirmation when the coach is on leave.'],
  openQuestions:['Which Thursday should the first new check-in land on?','Should the escalation ladder in this SOP match the standard tiers, or does Northwind need a shorter Tier 1 window?','Do you want the written confirmation to come from the coach or from you?'],
 },
 {key:'client-action-brief',workflow:'client_action_brief',
  title:'Client Action Brief — Northwind Pilates Check-in Day Change',
  quote:'Rhys agreed to send Northwind Pilates a brief setting out the actions and decisions needed to move weekly check-ins from Monday to Thursday.',
  purpose:'Set out the actions, decisions and open facts required to move Northwind Pilates weekly check-ins from Monday to Thursday without disrupting the current cycle.',
  steps:[
   {action:'Agree the first Thursday on which the new check-in day starts.',responsibleRole:'Client principal',completion:'A specific date is agreed in writing.',exception:'If no date is agreed this week, keep Monday check-ins running unchanged.'},
   {action:'Confirm the change in writing before the first Thursday check-in.',responsibleRole:'Coach',completion:'Client holds written confirmation of the new day.',exception:'If confirmation cannot be sent, do not move the check-in.'},
   {action:'Hold the four monthly check-ins and the monthly strategy call on the revised schedule.',responsibleRole:'Coach',completion:'All four check-ins and the strategy call are booked on the new day.',exception:'If a session cannot be rebooked, flag it before the cycle starts rather than dropping it.'},
   {action:'Review the change at the end of the following cycle, ahead of the quarter-end renewal.',responsibleRole:'Coach',completion:'Review is complete and the outcome recorded before renewal.',exception:'If the review slips past renewal, raise it at the Wednesday client risk review.'},
  ],
  decisions:['Approve the first effective Thursday for the new check-in day.','Decide whether the monthly strategy call also moves.'],
  missingFacts:['The exact quarter-end renewal date.','Whether the studio principal wants the confirmation sent to them directly.'],
  openQuestions:['Which Thursday do you want as the first new check-in?','Does the monthly strategy call move with the check-ins or stay where it is?','Do you want this brief sent to the client, or kept internal until renewal is discussed?'],
 },
];

const written=[];
for(const recipe of RECIPES){
 const commitment={id:'commitment',version:'synthetic-rev-1',sourceHash:sha256(recipe.quote),kind:'commitment',title:recipe.title,text:recipe.quote,display:true,use:true,sourceRef:{sourceId:'synthetic-fixture-source'},reviewReference:'laneC-fixture-review-2026-10-09',observedAt:'2026-10-09T00:00:00.000Z'};
 const base={fingerprint:'synthetic',workspaceId:'synthetic-workspace',taskId:randomUUID(),requestId:randomUUID(),client:'Northwind Pilates',owner:'rhys',title:recipe.title,workflow:recipe.workflow,audience:'internal_review',entries:[commitment],missingContext:[],assetRelease:RELEASE};
 const assets=await taskAssetEntries(assetRelease(base.assetRelease),base,atlasAssetRoots(BRAIN));
 const packet={...base,entries:[...base.entries,...assets.entries],missingContext:[...base.missingContext,...assets.notes]};
 // Quote real substrings of the retrieved sources, so the citation check is genuinely exercised.
 const facts=[{reference:'commitment',quote:recipe.quote}];
 for(const entry of assets.entries.slice(0,3)){
  const line=entry.text.split('\n').find(l=>l.length>50&&!l.startsWith('#'));
  if(line)facts.push({reference:entry.id,quote:line.trim()});
 }
 const raw={title:recipe.title,purpose:recipe.purpose,facts,steps:recipe.steps,decisions:recipe.decisions,missingFacts:recipe.missingFacts,openQuestions:recipe.openQuestions,sourcesUsed:facts.map(f=>f.reference),revisionChanges:[]};
 const content=renderDocument(raw,packet,null,true);
 const file=join(ROOT,`evidence/example-draft-${recipe.key}.md`);
 await writeFile(file,content);
 written.push({recipe:recipe.key,file:`evidence/example-draft-${recipe.key}.md`,characters:content.length,sha256:sha256(content),sourcesCited:raw.sourcesUsed.length});
}
await writeFile(join(ROOT,'evidence/example-drafts.json'),JSON.stringify({at:new Date().toISOString(),injected:true,note:'Rendered through the real contract on real retrieved assets with a hand-written response. Not model output.',drafts:written},null,1));
console.log(JSON.stringify(written,null,1));
