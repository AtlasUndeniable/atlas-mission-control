/**
 * Two real Claude API dispatches: one per in-scope recipe.
 *
 * Synthetic task, fictional client (Northwind Pilates), fictional sources from
 * verification/fixture-brain. The brand kit is the real UNDENIABLE_BRAND_KIT.md, because
 * applying Rhys's own brand voice is the point of the lane. No real client content and no
 * hosted database is touched.
 *
 * One dispatch per recipe. No retries, no fallback model, no second attempt on failure.
 * Usage and the pre-dispatch cost bound are written to an owner-only journal.
 *
 * Run: ATLAS_LIVE_DRAFTING=dispatch node verification/live-drafting.mjs
 */
import {mkdir,writeFile,open,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {documentPrompt,renderDocument} from '../src/lib/task-document-codec.ts';
import {taskAssetEntries,assetDigest,assetRelease} from '../src/lib/meetings/document-runtime.ts';
import {atlasAssetRoots} from '../src/lib/task-asset-search.ts';
import {__injectAssetBoundaryForTests} from '../src/lib/task-asset-boundary.ts';
import {readBrandRules,brandSystemPrompt} from '../src/lib/task-brand-rules.ts';
import {anthropicDocumentTransport,anthropicDocumentKey} from '../src/lib/task-document-anthropic.ts';

if(process.env.ATLAS_LIVE_DRAFTING!=='dispatch'){
 console.error('Refusing to dispatch. Set ATLAS_LIVE_DRAFTING=dispatch to spend two live invocations.');
 process.exit(2);
}

const ROOT=resolve(import.meta.dirname,'..');
const BRAIN=join(ROOT,'verification/fixture-brain');
const BRAND_KIT='/Users/atlasai/atlas-brain/brain/UNDENIABLE_BRAND_KIT.md';
const KEY_FILE='/Users/atlasai/.config/atlas/credentials/anthropic-intake.key';
// This fixture deliberately pairs the synthetic brain with Rhys's real brand kit, because
// applying his own voice is the point of the lane. Both are named here through the explicit
// test injection; neither is reachable from ATLAS_TASK_DOCUMENT_CONFIG.
__injectAssetBoundaryForTests({brainRoot:BRAIN,brandKit:BRAND_KIT});
const JOURNAL_DIR=join(ROOT,'verification/private-live');
const sha256=v=>createHash('sha256').update(v).digest('hex');

const CONFIG={
 provider:'anthropic-direct',model:'claude-sonnet-5-5',
 disclosureDecision:'sprint-20261007-laneC-synthetic-fixture-only',
 budgetDecision:'sprint-20261007-budget-US$50-month-100-requests',
 maxPromptCharacters:60000,maxOutputTokens:8000,timeoutMs:60000,
 requestProfile:'sonnet-5-5-drafting-v1',keyFile:KEY_FILE,
};
const RELEASE={
 decision:'laneC-fixture-release-2026-10-09-synthetic-only',
 sharedRoots:['playbooks','frameworks','operating-manual','lead-magnets'],
 clientDirectories:['northwind-pilates'],
};

/** Two synthetic tasks, one per in-scope recipe, with a fictional commitment quote. */
const RECIPES=[
 {
  key:'role-sop',workflow:'role_sop',
  title:'Write the coach role SOP covering escalation for the Northwind check-in change',
  quote:'Rhys agreed to write the coach role SOP, including the escalation ladder, before the Northwind check-in change takes effect.',
 },
 {
  key:'client-action-brief',workflow:'client_action_brief',
  title:'Client action brief for the Northwind Pilates check-in day change',
  quote:'Rhys agreed to send Northwind Pilates a brief setting out the actions and decisions needed to move weekly check-ins from Monday to Thursday.',
 },
];

async function journal(entry){
 await mkdir(JOURNAL_DIR,{recursive:true});
 await chmod(JOURNAL_DIR,0o700);
 const file=join(JOURNAL_DIR,'live-drafting.jsonl');
 const handle=await open(file,'a',0o600);
 try{await handle.write(JSON.stringify({at:new Date().toISOString(),...entry})+'\n');await handle.sync()}finally{await handle.close()}
}

const results=[];
for(const recipe of RECIPES){
 const commitment={
  id:'commitment',version:'synthetic-rev-1',sourceHash:sha256(recipe.quote),kind:'commitment',
  title:recipe.title,text:recipe.quote,display:true,use:true,
  sourceRef:{sourceId:'synthetic-fixture-source'},reviewReference:'laneC-fixture-review-2026-10-09',
  observedAt:new Date().toISOString(),
 };
 const base={
  fingerprint:'synthetic',workspaceId:'synthetic-workspace',taskId:randomUUID(),requestId:randomUUID(),
  client:'Northwind Pilates',owner:'rhys',title:recipe.title,workflow:recipe.workflow,audience:'internal_review',
  entries:[commitment],missingContext:[],assetRelease:RELEASE,
 };
 const assets=await taskAssetEntries(assetRelease(base.assetRelease),base,atlasAssetRoots(BRAIN));
 const packet={...base,entries:[...base.entries,...assets.entries],missingContext:[...base.missingContext,...assets.notes]};
 const prompt=documentPrompt(packet,null,null);
 const rules=await readBrandRules(BRAND_KIT);
 const system=brandSystemPrompt(rules);

 const attempt=randomUUID();
 const usage=[];const diagnostics=[];let bound=null;
 const model=anthropicDocumentTransport(CONFIG,anthropicDocumentKey(KEY_FILE),fetch,{
  beforeDispatch:async(_a,b)=>{bound=b;await journal({attempt,recipe:recipe.key,event:'cost_bound',bound:b,promptHash:sha256(system+'\n'+prompt),assetDigest:assetDigest(assets.entries)})},
  recordUsage:async(_a,u)=>{usage.push(u);await journal({attempt,recipe:recipe.key,event:'usage',usage:u})},
  recordDiagnostic:async(_a,d)=>{diagnostics.push(d);await journal({attempt,recipe:recipe.key,event:'diagnostic',diagnostic:d})},
 });

 let raw=null,content=null,error=null;
 try{
  raw=await model.invoke(system,prompt,attempt);
  // The real contract decides whether the output is usable. No leniency for a live call.
  content=renderDocument(raw,packet,null,false);
 }catch(e){error=e instanceof Error?e.message:String(e)}

 const cost=usage[0]?(usage[0].input_tokens*2+usage[0].output_tokens*10)/1_000_000:null;
 results.push({recipe:recipe.key,workflow:recipe.workflow,attempt,
  assetsSupplied:assets.entries.map(e=>({id:e.id,hash:e.sourceHash.slice(0,12)})),
  assetCandidates:assets.searched.candidates.length,assetsScanned:assets.searched.scanned,
  promptCharacters:prompt.length,systemCharacters:system.length,
  costBound:bound,usage:usage[0]??null,costUSD:cost,
  contractAccepted:!!content,error,diagnostics,
  contentHash:content?sha256(content):null,contentCharacters:content?content.length:null});
 await journal({attempt,recipe:recipe.key,event:'outcome',contractAccepted:!!content,error,costUSD:cost});

 if(content)await writeFile(join(ROOT,`evidence/live-draft-${recipe.key}.md`),content);
 if(raw)await writeFile(join(ROOT,`evidence/live-draft-${recipe.key}.response.json`),JSON.stringify(raw,null,1));
}

const total=results.reduce((sum,r)=>sum+(r.costUSD??0),0);
const summary={
 at:new Date().toISOString(),model:CONFIG.model,thinking:'adaptive',effort:'medium',maxOutputTokens:CONFIG.maxOutputTokens,
 dispatches:results.length,brandKit:BRAND_KIT,brandKitHash:(await readBrandRules(BRAND_KIT)).kitHash,
 results,totalCostUSD:Number(total.toFixed(6)),
 note:'Synthetic task and fictional client content. Real provider dispatch. Not a client asset and not a delivery.',
};
await writeFile(join(ROOT,'evidence/live-drafting.json'),JSON.stringify(summary,null,1));
console.log(JSON.stringify(summary,null,1));
process.exit(results.every(r=>r.contractAccepted)?0:1);
