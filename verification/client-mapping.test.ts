// Lane N: automatic client mapping. Pure and file-fixture tests only: no network, no database.
// The same case table is run against app_private.intake_client_decide in the native rehearsal.
import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PERSONAL_DOMAINS,decideMapping,slug,ghlContactIndex,callNotesIndex,clientFolderIndex,evidenceFor,withClientEvidence,clientMappingConfig,loadEvidenceSources,type DecideInput,type EvidenceItem} from '../src/lib/meetings/client-mapping.ts';
import {parseMappingList,mappingHeadline,clientChoices,rememberFor,newClientDefaults,validMappingRequest} from '../src/lib/board/client-mapping.ts';
import {prepareOperating} from '../scripts/meetings/prepare-operating.ts';

const root=new URL('..',import.meta.url).pathname;
const table=JSON.parse(await readFile(join(root,'verification/client-mapping-cases.json'),'utf8'));
const md5=(s:string)=>createHash('md5').update(s).digest('hex');
const input=(c:Record<string,unknown>):DecideInput=>({...table.defaults,...c}) as DecideInput;

// ---- every outcome, from the shared table --------------------------------------------------
for(const c of table.cases){
 test(`case: ${c.name}`,async()=>{
  const d=await decideMapping(input(c));
  assert.equal(d.outcome,c.expect.outcome);assert.equal(d.state,c.expect.state);assert.equal(d.confidence,c.expect.confidence);
  if(c.expect.client)assert.equal(d.client,c.expect.client);
  if(c.expect.clientPrefix){
   const primary=d.newClient!.emails[0];
   assert.equal(d.client,c.expect.clientPrefix+md5(primary).slice(0,6));assert.equal(d.newClient!.client,d.client);
  }
  if(c.expect.state==='held')assert.equal(d.client,null);
  if(c.expect.name)assert.equal(d.newClient!.name,c.expect.name);
  if(c.expect.company)assert.equal(d.newClient!.company,c.expect.company);
  // Internal people are never candidates, whatever evidence exists for them.
  for(const p of d.participants.filter(p=>p.internal))assert.equal(p.candidates,undefined);
  assert.ok(d.reason.length>=3&&d.reason.length<=600);
 });
}
test('the case table covers every outcome and the privacy negatives the lane requires',()=>{
 const outcomes=new Set(table.cases.map((c:{expect:{outcome:string}})=>c.expect.outcome));
 for(const o of ['known','new','ambiguous','internal_only'])assert.ok(outcomes.has(o),o);
 const names=table.cases.map((c:{name:string})=>c.name).join('\n');
 assert.match(names,/personal domain never maps on domain/);assert.match(names,/used by two clients is ambiguous/);assert.match(names,/shared or agency domain/);
});

// ---- the personal-domain rule ----------------------------------------------------------------
test('PERSONAL_DOMAINS is byte-for-byte the list in migration 029',async()=>{
 const sql=await readFile(join(root,'migrations/029_client_mapping.sql'),'utf8');
 const m=/intake_personal_domains\(\)returns text\[\] language sql immutable set search_path='' as\n\$\$select array\[([^\]]+)\]\$\$/.exec(sql);
 assert.ok(m,'029 personal domain function not found');
 assert.deepEqual(m![1].split(',').map(s=>s.replace(/'/g,'')),[...PERSONAL_DOMAINS]);
 assert.deepEqual([...PERSONAL_DOMAINS],[...PERSONAL_DOMAINS].sort());
});
test('a personal provider never maps a different address on the same domain, even with many clients on it',async()=>{
 const d=await decideMapping(input({identities:[{client:'alpha',email:'a1@gmail.com',status:'confirmed'},{client:'alpha',email:'a2@gmail.com',status:'confirmed'}],participants:['owner@team.example','new.person@gmail.com']}));
 assert.notEqual(d.client,'alpha');assert.equal(d.outcome,'new');
 assert.equal(d.participants.find(p=>p.email==='new.person@gmail.com')!.via,null);
});
test('a domain-only match never comes from a personal domain recorded in a client folder',async()=>{
 const sources={clientFolders:await clientFolderIndex(await folderFixture({'acme':{client:'alpha',emails:[],domains:['gmail.com','acme-fit.com']}}))};
 assert.equal(sources.clientFolders.byDomain.has('gmail.com'),false);assert.equal(sources.clientFolders.byDomain.has('acme-fit.com'),true);
});
test('slug matches app_private.intake_slug rules',()=>{
 assert.equal(slug(' Jane  O\'Neil-Smith! '),'jane-o-neil-smith');assert.equal(slug(''),'');assert.equal(slug(null),'');
 assert.equal(slug('x'.repeat(60)).length,40);assert.equal(slug('Ünïcode Name'),'n-code-name');
});

// ---- evidence sources -------------------------------------------------------------------------
async function folderFixture(records:Record<string,unknown>){const d=await mkdtemp(join(tmpdir(),'laneN-cw-'));for(const [k,v] of Object.entries(records)){await mkdir(join(d,k));await writeFile(join(d,k,'client.json'),JSON.stringify(v))}await mkdir(join(d,'no-record'));await writeFile(join(d,'no-record','notes.md'),'person@example.com');return d}
test('call notes: front matter only, exact attendees, title tokens, the same call excluded',async()=>{
 const d=await mkdtemp(join(tmpdir(),'laneN-calls-'));
 await writeFile(join(d,'2026-10-01-a.md'),'---\nfireflies_id: PRIOR1\ntitle: Alpha Person x Rhys weekly\ndate: 2026-10-01\nattendees: ["ap@gmail.com", "owner@team.example"]\n---\nTRANSCRIPT BODY ap2@gmail.com should never be read as an attendee\n');
 await writeFile(join(d,'2026-10-02-b.md'),'---\nfireflies_id: THISCALL\ntitle: Alpha Person again\nattendees: [ap@gmail.com]\n---\n');
 await writeFile(join(d,'no-frontmatter.md'),'ap@gmail.com');
 const idx=await callNotesIndex(d);
 assert.equal(idx.byEmail.get('ap2@gmail.com'),undefined);
 assert.deepEqual(idx.byEmail.get('ap@gmail.com')!.map(e=>e.ref).sort(),['PRIOR1','THISCALL']);
 assert.deepEqual(idx.byEmail.get('ap@gmail.com')!.find(e=>e.ref==='PRIOR1')!.titleTokens,['alpha','person','x','rhys','weekly']);
 const ev=evidenceFor({id:'THISCALL',organizer:'owner@team.example',participants:['owner@team.example','ap@gmail.com']},{callNotes:idx});
 assert.deepEqual(ev.items.map(e=>e.ref),['PRIOR1']);
 assert.equal(ev.items.some(e=>e.email==='owner@team.example'),false,'organizer facts are never gathered');
 assert.equal((await callNotesIndex(join(d,'missing'))).coverage,'unavailable');
});
test('GoHighLevel: loopback bridge only, exact emails, first-N coverage, failures are reported not thrown',async()=>{
 await assert.rejects(ghlContactIndex('https://example.com/contacts',fetch),/loopback/);
 let asked='';
 const fake=(contacts:unknown[],status=200)=>(async(u:string|URL|Request)=>{asked=String(u);return new Response(JSON.stringify({contacts}),{status})}) as typeof fetch;
 const idx=await ghlContactIndex('http://127.0.0.1:4003',fake([{id:'c1',email:' Lead@Gmail.com ',firstName:'Jane',lastName:'Doe',companyName:'Doe Fit',tags:['atlas-client:beta',7]},{id:'c2',email:'not-an-email'}]));
 assert.equal(asked,'http://127.0.0.1:4003/contacts?limit=100');
 assert.deepEqual(idx.byEmail.get('lead@gmail.com'),[{email:'lead@gmail.com',source:'ghl',ref:'c1',name:'Jane Doe',company:'Doe Fit',tags:['atlas-client:beta']}]);
 assert.equal(idx.byEmail.size,1);assert.equal(idx.coverage,'complete');
 assert.equal((await ghlContactIndex('http://127.0.0.1:4003',fake(Array.from({length:100},(_,i)=>({id:'x'+i,email:`p${i}@x.com`}))))).coverage,'first-100-contacts');
 assert.equal((await ghlContactIndex('http://127.0.0.1:4003',fake([],503))).coverage,'unavailable');
 assert.equal((await ghlContactIndex('http://127.0.0.1:4003',(async()=>{throw Error('down')}) as typeof fetch)).coverage,'unavailable');
});
test('client-work folders: client.json only, valid keys only, email and domain facts',async()=>{
 const d=await folderFixture({'gamma-vsl':{client:'gamma',emails:['G@Yahoo.com'],domains:['gamma-co.io']},'bad':{client:'Not A Key',emails:['x@y.com']}});
 const idx=await clientFolderIndex(d);
 assert.equal(idx.coverage,'1-records');
 assert.deepEqual(idx.byEmail.get('g@yahoo.com'),[{email:'g@yahoo.com',source:'client_folder',ref:'gamma-vsl',client:'gamma',matchedOn:'email'}]);
 assert.equal(idx.byEmail.has('x@y.com'),false);assert.equal(idx.byEmail.has('person@example.com'),false);
 const ev=evidenceFor({participants:['ops@gamma-co.io']},{clientFolders:idx});
 assert.deepEqual(ev.items,[{email:'ops@gamma-co.io',source:'client_folder',ref:'gamma-vsl',client:'gamma',matchedOn:'domain',domain:'gamma-co.io'}]);
 const d2=await decideMapping(input({participants:['owner@team.example','ops@gamma-co.io'],evidence:ev.items}));
 assert.equal(d2.client,'gamma');assert.equal(d2.confidence,'medium');
});
test('evidence carries only metadata-level fields and is bounded',()=>{
 const many:EvidenceItem[]=Array.from({length:500},(_,i)=>({email:'p@gmail.com',source:'call_notes',ref:'R'+i,titleTokens:['a']}));
 const ev=evidenceFor({participants:['p@gmail.com']},{callNotes:{byEmail:new Map([['p@gmail.com',many]]),coverage:'x'}});
 assert.equal(ev.items.length,200);
 const allowed=new Set(['email','source','ref','name','company','tags','titleTokens','client','matchedOn','domain']);
 for(const i of ev.items)for(const k of Object.keys(i))assert.ok(allowed.has(k),k);
 assert.deepEqual(Object.keys(ev.coverage).sort(),['callNotes','clientFolders','ghl']);
});

// ---- the collector wrapper -------------------------------------------------------------------
test('withClientEvidence: catalog and refresh rows gain facts; everything else is untouched',async()=>{
 const calls:{action:string;payload:Record<string,unknown>}[]=[];
 const base=async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});return {ok:true}};
 const sources={ghl:{byEmail:new Map([['c@gmail.com',[{email:'c@gmail.com',source:'ghl' as const,ref:'c1',tags:[]}]]]),coverage:'complete'}};
 let loads=0;const rpc=withClientEvidence(base,async()=>{loads++;return sources});
 const row={id:'S1',title:'t',instant:'2026-10-20T00:00:00Z',live:false,accountId:'a',organizer:'owner@team.example',participants:['c@gmail.com','owner@team.example'],domains:['gmail.com','team.example']};
 await rpc('catalog',{run:'r',meetings:[row,{...row,id:'S2',live:true},{...row,id:'S3',participants:[]}]});
 await rpc('refresh_metadata',{id:'S1',meeting:row});
 await rpc('reserve',{id:'S1',revision:'x'});
 assert.equal(loads,1,'sources are loaded once per tick');
 const cat=calls[0].payload.meetings as Record<string,unknown>[];
 assert.deepEqual((cat[0].clientEvidence as {items:unknown[]}).items.length,1);
 assert.equal('clientEvidence' in cat[1],false,'live rows untouched');assert.equal('clientEvidence' in cat[2],false,'rows without participants untouched');
 const {clientEvidence,...rest}=cat[0];assert.deepEqual(rest,row,'every original field is passed through unchanged');assert.ok(clientEvidence);
 assert.ok((calls[1].payload.meeting as Record<string,unknown>).clientEvidence);
 assert.deepEqual(calls[2],{action:'reserve',payload:{id:'S1',revision:'x'}});
});
test('withClientEvidence: a failing source never blocks intake',async()=>{
 const calls:Record<string,unknown>[]=[];
 const rpc=withClientEvidence(async(_a,p)=>{calls.push(p);return {}},async()=>{throw Error('disk gone')});
 await rpc('catalog',{run:'r',meetings:[{id:'S1',live:false,participants:['c@gmail.com']}]});
 const ev=(calls[0].meetings as {clientEvidence:{items:unknown[];coverage:Record<string,string>}}[])[0].clientEvidence;
 assert.deepEqual(ev.items,[]);assert.equal(ev.coverage.ghl,'not_configured');
});
test('collector configuration is explicit, absolute and loopback-only',async()=>{
 assert.equal(clientMappingConfig(undefined),null);
 assert.deepEqual(clientMappingConfig({callsDir:'/x/calls',ghlUrl:'http://127.0.0.1:4003'}),{callsDir:'/x/calls',ghlUrl:'http://127.0.0.1:4003'});
 for(const bad of [{callsDir:'relative'},{ghlUrl:'http://10.0.0.5:4003'},{ghlUrl:'https://services.example.com'},{other:1},[]])assert.throws(()=>clientMappingConfig(bad));
 assert.deepEqual(await loadEvidenceSources({}),{});
});

// ---- provisioning and board helpers ----------------------------------------------------------
const plan=(rules:unknown[],extra={})=>({policy:'synthetic',version:'v029',accountId:'synthetic-account',classificationDecision:'SYNTHETIC classify',disclosureDecision:'SYNTHETIC disclose',operatorDecision:'SYNTHETIC operator',coverageActors:['rhys'],operatingStart:'2026-10-01',operatingEnd:'2026-11-01',catchupStart:null,catchupEnd:null,maxDispatches:100,dailyDispatches:10,excludedSources:[],rules,provider:{provider:'anthropic-vertex' as const,project:'synthetic',region:'global',model:'synthetic',disclosureDecision:'SYNTHETIC disclose',budgetDecision:'SYNTHETIC budget',maxPromptCharacters:60000,maxOutputTokens:4000},...extra}) as Parameters<typeof prepareOperating>[0];
const resolved={id:'auto-map-v1',organizer:'Owner@Team.example',client:'*resolved*',allowedDomains:[],clientDomains:[],matchKind:'resolved' as const,clientEmails:[],allowedEmails:[],classification:'client_confidential',reviewer:'rhys',decisionReference:'SYNTHETIC auto-mapping decision',excluded:false};
test('prepare-operating renders a disabled resolved rule and inert 029 lists, and refuses a malformed one',()=>{
 const sql=prepareOperating(plan([resolved],{clientMapping:{decisionReference:'SYNTHETIC mapping lists',internalPeople:[{kind:'domain',value:'team.example'}],sharedDomains:[{domain:'agency-hub.com',reason:'VA agency'}],resolvers:['nat']}})).sql;
 assert.match(sql,/'\*resolved\*'/);assert.match(sql,/'resolved',array\[\]::text\[\],array\[\]::text\[\]\);/);
 assert.match(sql,/,false,'resolved'/,'rule inserted inactive');
 assert.match(sql,/intake_internal_people/);assert.match(sql,/intake_shared_domains/);assert.match(sql,/intake_client_resolvers\(policy,actor,active,decision_reference\)values\('synthetic','nat',false,/);
 assert.doesNotMatch(sql,/grant /i);
 for(const bad of [{...resolved,client:'alpha'},{...resolved,clientEmails:['a@gmail.com']},{...resolved,allowedDomains:['x.com']},{...resolved,excluded:true}])assert.throws(()=>prepareOperating(plan([bad])));
});
const listPayload={items:[
 {mapping:'11111111-1111-4111-8111-111111111111',badge:'needs_client',title:'Intro call',instant:'2026-10-20T01:00:00Z',outcome:'ambiguous',client:null,clientName:null,company:null,confidence:'none',reason:'Participants match different clients: alpha, beta',decidedBy:'atlas-resolver:client-mapping-v1',decidedAt:'2026-10-20T01:05:00Z',
  participants:[{email:'a@gmail.com',resolved:'alpha',note:null,candidates:['alpha']},{email:'b@gmail.com',resolved:'beta',note:null,candidates:['beta']},{email:'c@gmail.com',resolved:null,note:null,candidates:[]}]},
 {mapping:'22222222-2222-4222-8222-222222222222',badge:'new_client',title:'Discovery',instant:'2026-10-20T02:00:00Z',outcome:'new',client:'new-jane-doe-abc123',clientName:'Jane Doe',company:'Doe Fitness',confidence:'provisional',reason:'No record',decidedBy:'atlas-resolver:client-mapping-v1',decidedAt:'2026-10-20T02:05:00Z',participants:[{email:'jd@gmail.com',resolved:null,note:null,candidates:[]}]},
 {mapping:'not-a-uuid',badge:'needs_client'},{mapping:'33333333-3333-4333-8333-333333333333',badge:'other'}],
 clients:[{client:'beta',name:'Beta Co',status:'confirmed'},{client:'alpha',name:'Alpha Co',status:'confirmed'},{client:'zeta',name:'Zeta',status:'confirmed'},{client:'new-jane-doe-abc123',name:'Jane Doe',status:'provisional'}]};
test('board: badges, headline, choices and defaults never offer a provisional client or re-affiliate silently',()=>{
 const list=parseMappingList(listPayload);
 assert.equal(list.items.length,2,'malformed items are dropped');
 assert.equal(mappingHeadline(list),'1 call needs a client · 1 new client to confirm');
 assert.equal(mappingHeadline({items:[],clients:[]}),'');
 const choices=clientChoices(list.items[0],list.clients).map(c=>c.client);
 assert.deepEqual(choices,['beta','alpha','zeta'],'the call candidates first, then the rest by name');
 assert.ok(!choices.includes('new-jane-doe-abc123'));
 assert.deepEqual(rememberFor(list.items[0],'alpha'),['a@gmail.com','c@gmail.com'],'b@ pointed at beta and is not re-affiliated');
 assert.deepEqual(newClientDefaults(list.items[0]),['c@gmail.com']);
 assert.ok(!clientChoices(list.items[1],list.clients).some(c=>c.client===list.items[1].client));
});
test('board: resolve requests are validated before they leave the route',()=>{
 const m='11111111-1111-4111-8111-111111111111';
 assert.ok(validMappingRequest({action:'choose_existing',payload:{mapping:m,client:'alpha',emails:['a@gmail.com']}}));
 assert.ok(validMappingRequest({action:'confirm_new',payload:{mapping:m,name:'Jane Doe',emails:['c@gmail.com']}}));
 assert.ok(validMappingRequest({action:'mark_internal',payload:{mapping:m,emails:['c@gmail.com']}}));
 for(const bad of [null,[],{action:'list',payload:{}},{action:'choose_existing',payload:{mapping:m}},{action:'choose_existing',payload:{mapping:m,client:'Alpha Co'}},
  {action:'mark_internal',payload:{mapping:m,emails:[]}},{action:'confirm_new',payload:{mapping:'x'}},{action:'confirm_new',payload:{mapping:m,extra:1}},{action:'confirm_new',payload:{mapping:m,emails:['nope']}}])
  assert.equal(validMappingRequest(bad),null,JSON.stringify(bad));
});
