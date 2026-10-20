// Lane N2: automatic client mapping under R11's boundary. Pure and file-fixture tests only: no
// network, no database. The same case table runs against app_private.intake_client_decide in the
// native rehearsal (parity), where the hosted decision path is the authority.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PERSONAL_DOMAINS,decideMapping,coverageGap,slug,ghlContactIndex,callNotesIndex,clientFolderIndex,evidenceFor,withClientEvidence,clientMappingConfig,loadEvidenceSources,type DecideInput,type EvidenceItem} from '../src/lib/meetings/client-mapping.ts';
import {parseMappingList,mappingHeadline,clientChoices,rememberFor,newClientDefaults,singleSuggestion,validMappingRequest} from '../src/lib/board/client-mapping.ts';
import {prepareOperating} from '../scripts/meetings/prepare-operating.ts';

const root=new URL('..',import.meta.url).pathname;
const table=JSON.parse(await readFile(join(root,'verification/client-mapping-cases.json'),'utf8'));
const input=(c:Record<string,unknown>):DecideInput=>({...table.defaults,...c}) as DecideInput;

// ---- every outcome, from the shared table --------------------------------------------------
for(const c of table.cases){
 test(`case: ${c.name}`,()=>{
  const d=decideMapping(input(c));
  assert.equal(d.outcome,c.expect.outcome);assert.equal(d.state,c.expect.state);assert.equal(d.confidence,c.expect.confidence);assert.equal(d.client,c.expect.client);
  if(c.expect.suggestions)assert.deepEqual(d.suggestion.clients??[],c.expect.suggestions);
  if(c.expect.name)assert.equal(d.suggestion.newClient!.name,c.expect.name);
  if(c.expect.company)assert.equal(d.suggestion.newClient!.company,c.expect.company);
  if(c.expect.noNewClient)assert.equal(d.suggestion.newClient,undefined);
  if(c.expect.reasonIncludes)assert.ok(d.reason.includes(c.expect.reasonIncludes),d.reason);
  // Internal people are never candidates, whatever evidence exists for them.
  for(const p of d.participants.filter(p=>p.internal))assert.equal(p.approved,undefined);
  assert.ok(d.reason.length>=3&&d.reason.length<=600);
 });
}
test('Dante 2026-10-20: with the rule flag off (the default) nothing is ever mapped automatically; an approved identity is the pre-suggested client',()=>{
 for(const c of table.cases.filter((c:{autoExact?:boolean})=>!c.autoExact)){
  const d=decideMapping(input(c));assert.equal(d.state,'held',c.name);
  if(d.participants.some(p=>p.resolved))assert.deepEqual(d.suggestion.clients?.length?d.suggestion.clients.includes(d.participants.find(p=>p.resolved)!.resolved!):false,true,c.name);
 }
 const off=decideMapping(input({identities:[{client:'alpha',email:'client@gmail.com',status:'confirmed'}],participants:['owner@undeniablementoring.com','client@gmail.com']}));
 assert.equal(off.outcome,'suggested');assert.equal(off.suggestion.approvedIdentity,true);assert.deepEqual(off.suggestion.clients,['alpha']);
});
test('R11-1: nothing but an exact approved identity ever maps a call',()=>{
 for(const c of table.cases){
  const d=decideMapping(input(c));
  if(d.state==='mapped'){
   assert.equal(d.confidence,'exact');
   const nonInternal=d.participants.filter(p=>!p.internal);
   assert.ok(nonInternal.some(p=>p.resolved===d.client&&p.approved!.some(a=>a.client===d.client&&(a.source==='identity'||a.source==='crosswalk'))),c.name);
   assert.ok(nonInternal.every(p=>!p.suggestion||p.suggestion===d.client),c.name);
  }
  assert.notEqual(d.outcome,'new','the resolver never creates or infers a new client');
 }
});
test('the case table covers every automatic outcome and R11\'s reproductions',()=>{
 const outcomes=new Set(table.cases.map((c:{expect:{outcome:string}})=>c.expect.outcome));
 for(const o of ['known','suggested','ambiguous','unrecognised','evidence_incomplete','internal_only'])assert.ok(outcomes.has(o),o);
 const names=table.cases.map((c:{name:string})=>c.name).join('\n');
 for(const r of [/pm\.me/,/internode/,/shared domain holds before a CRM tag/,/two correlated weak sources/,/no coverage report/,/failed evidence load/,/first-100/,/truncated/])assert.match(names,r);
});

// ---- personal providers ----------------------------------------------------------------------
test('PERSONAL_DOMAINS is byte-for-byte the list in migration 029, sorted, and covers R11\'s named gaps',async()=>{
 const sql=await readFile(join(root,'migrations/029_client_mapping.sql'),'utf8');
 const m=/intake_personal_domains\(\)returns text\[\] language sql immutable set search_path='' as\n\$\$select array\[([^\]]+)\]\$\$/.exec(sql);
 assert.ok(m,'029 personal domain function not found');
 assert.deepEqual(m![1].split(',').map(s=>s.replace(/'/g,'')),[...PERSONAL_DOMAINS]);
 assert.deepEqual([...PERSONAL_DOMAINS],[...PERSONAL_DOMAINS].sort());
 for(const d of ['foobox.com','foobox.net','immerbox.com','immermail.com','mailzone.com','pobox.com','siemprebox.com','siempremail.com','veribox.net','pm.me','protonmail.ch','proton.me','fastmail.fm','fastmail.com','sent.com','internode.on.net','westnet.com.au','iinet.net.au','bigpond.net.au','bigpond.com','optusnet.com.au','tpg.com.au','dodo.com.au','aapt.net.au','ozemail.com.au'])
  assert.ok((PERSONAL_DOMAINS as readonly string[]).includes(d),d);
});
test('a personal provider never yields a domain suggestion, however many clients use it',()=>{
 const d=decideMapping(input({identities:[{client:'alpha',email:'a1@gmail.com',status:'confirmed'},{client:'alpha',email:'a2@gmail.com',status:'confirmed'}],participants:['owner@undeniablementoring.com','new.person@gmail.com']}));
 assert.equal(d.outcome,'unrecognised');assert.deepEqual(d.suggestion.clients??[],[]);
});
test('a folder record never offers a personal domain',async()=>{
 const sources={clientFolders:await clientFolderIndex(await folderFixture({'acme':{client:'alpha',emails:[],domains:['gmail.com','pm.me','acme-fit.com']}}))};
 assert.equal(sources.clientFolders.byDomain.has('gmail.com'),false);assert.equal(sources.clientFolders.byDomain.has('pm.me'),false);assert.equal(sources.clientFolders.byDomain.has('acme-fit.com'),true);
});
test('slug matches app_private.intake_slug rules',()=>{
 assert.equal(slug(' Jane  O\'Neil-Smith! '),'jane-o-neil-smith');assert.equal(slug(''),'');assert.equal(slug(null),'');
 assert.equal(slug('x'.repeat(60)).length,40);assert.equal(slug('Ünïcode Name'),'n-code-name');
});

// ---- coverage --------------------------------------------------------------------------------
test('coverage gaps name the real reason; only complete coverage has none',()=>{
 assert.equal(coverageGap({ghl:'complete',callNotes:'3-notes',clientFolders:'0-records'}),null);
 assert.equal(coverageGap(null),'no evidence report from the collector');
 assert.equal(coverageGap({}),'no evidence report from the collector');
 assert.equal(coverageGap({collector:'failed to load evidence sources'}),'collector evidence failed to load evidence sources');
 assert.match(coverageGap({ghl:'first-100-contacts',callNotes:'unavailable',clientFolders:'not_configured',truncated:'true'})!,/truncated; GoHighLevel first-100-contacts; call notes unavailable; client folders not_configured/);
});

// ---- evidence sources -------------------------------------------------------------------------
async function folderFixture(records:Record<string,unknown>){const d=await mkdtemp(join(tmpdir(),'laneN-cw-'));for(const [k,v] of Object.entries(records)){await mkdir(join(d,k));await writeFile(join(d,k,'client.json'),JSON.stringify(v))}await mkdir(join(d,'no-record'));await writeFile(join(d,'no-record','notes.md'),'person@example.com');return d}
test('call notes: front matter only, exact attendees, title tokens, the same call excluded',async()=>{
 const d=await mkdtemp(join(tmpdir(),'laneN-calls-'));
 await writeFile(join(d,'2026-10-01-a.md'),'---\nfireflies_id: PRIOR1\ntitle: Alpha Person x Rhys weekly\ndate: 2026-10-01\nattendees: ["ap@gmail.com", "owner@undeniablementoring.com"]\n---\nTRANSCRIPT BODY ap2@gmail.com should never be read as an attendee\n');
 await writeFile(join(d,'2026-10-02-b.md'),'---\nfireflies_id: THISCALL\ntitle: Alpha Person again\nattendees: [ap@gmail.com]\n---\n');
 await writeFile(join(d,'no-frontmatter.md'),'ap@gmail.com');
 const idx=await callNotesIndex(d);
 assert.equal(idx.byEmail.get('ap2@gmail.com'),undefined);
 assert.deepEqual(idx.byEmail.get('ap@gmail.com')!.map(e=>e.ref).sort(),['PRIOR1','THISCALL']);
 assert.deepEqual(idx.byEmail.get('ap@gmail.com')!.find(e=>e.ref==='PRIOR1')!.titleTokens,['alpha','person','x','rhys','weekly']);
 const ev=evidenceFor({id:'THISCALL',organizer:'owner@undeniablementoring.com',participants:['owner@undeniablementoring.com','ap@gmail.com']},{callNotes:idx});
 assert.deepEqual(ev.items.map(e=>e.ref),['PRIOR1']);
 assert.equal(ev.items.some(e=>e.email==='owner@undeniablementoring.com'),false,'organizer facts are never gathered');
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
test('client-work folders: client.json only, valid keys only; a folder fact is only a suggestion',async()=>{
 const d=await folderFixture({'gamma-vsl':{client:'gamma',emails:['G@Yahoo.com'],domains:['gamma-co.io']},'bad':{client:'Not A Key',emails:['x@y.com']}});
 const idx=await clientFolderIndex(d);
 assert.equal(idx.coverage,'1-records');
 assert.deepEqual(idx.byEmail.get('g@yahoo.com'),[{email:'g@yahoo.com',source:'client_folder',ref:'gamma-vsl',client:'gamma',matchedOn:'email'}]);
 assert.equal(idx.byEmail.has('x@y.com'),false);assert.equal(idx.byEmail.has('person@example.com'),false);
 const ev=evidenceFor({participants:['ops@gamma-co.io']},{clientFolders:idx});
 assert.deepEqual(ev.items,[{email:'ops@gamma-co.io',source:'client_folder',ref:'gamma-vsl',client:'gamma',matchedOn:'domain',domain:'gamma-co.io'}]);
 const d2=decideMapping(input({participants:['owner@undeniablementoring.com','ops@gamma-co.io'],evidence:ev.items}));
 assert.equal(d2.state,'held');assert.equal(d2.outcome,'suggested');assert.deepEqual(d2.suggestion.clients,['gamma']);
});
test('evidence carries only metadata-level fields; truncation is reported in coverage',()=>{
 const many:EvidenceItem[]=Array.from({length:500},(_,i)=>({email:'p@gmail.com',source:'call_notes',ref:'R'+i,titleTokens:['a']}));
 const ev=evidenceFor({participants:['p@gmail.com']},{callNotes:{byEmail:new Map([['p@gmail.com',many]]),coverage:'x'}});
 assert.equal(ev.items.length,200);assert.equal(ev.coverage.truncated,'true');
 const allowed=new Set(['email','source','ref','name','company','tags','titleTokens','client','matchedOn','domain']);
 for(const i of ev.items)for(const k of Object.keys(i))assert.ok(allowed.has(k),k);
 assert.deepEqual(Object.keys(evidenceFor({participants:['q@gmail.com']},{}).coverage).sort(),['callNotes','clientFolders','ghl']);
 assert.notEqual(coverageGap(evidenceFor({participants:['q@gmail.com']},{}).coverage),null,'nothing configured is a gap');
});

// ---- the collector wrapper -------------------------------------------------------------------
test('withClientEvidence: catalog and refresh rows gain facts; everything else is untouched',async()=>{
 const calls:{action:string;payload:Record<string,unknown>}[]=[];
 const base=async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});return {ok:true}};
 const sources={ghl:{byEmail:new Map([['c@gmail.com',[{email:'c@gmail.com',source:'ghl' as const,ref:'c1',tags:[]}]]]),coverage:'complete'}};
 let loads=0;const rpc=withClientEvidence(base,async()=>{loads++;return sources});
 const row={id:'S1',title:'t',instant:'2026-10-20T00:00:00Z',live:false,accountId:'a',organizer:'owner@undeniablementoring.com',participants:['c@gmail.com','owner@undeniablementoring.com'],domains:['gmail.com','undeniablementoring.com']};
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
test('R11-3: a failing source load is reported as a failure (never as not configured) and never blocks intake',async()=>{
 const calls:Record<string,unknown>[]=[];
 const rpc=withClientEvidence(async(_a,p)=>{calls.push(p);return {}},async()=>{throw Error('disk gone')});
 await rpc('catalog',{run:'r',meetings:[{id:'S1',live:false,participants:['c@gmail.com']}]});
 const ev=(calls[0].meetings as {clientEvidence:{items:unknown[];coverage:Record<string,string>}}[])[0].clientEvidence;
 assert.deepEqual(ev.items,[]);assert.deepEqual(ev.coverage,{collector:'failed to load evidence sources'});
 const d=decideMapping(input({participants:['owner@undeniablementoring.com','c@gmail.com'],coverage:ev.coverage}));
 assert.equal(d.outcome,'evidence_incomplete');assert.equal(d.suggestion.newClient,undefined);
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
 const sql=prepareOperating(plan([resolved],{clientMapping:{decisionReference:'SYNTHETIC mapping lists',internalPeople:[{kind:'domain',value:'undeniablementoring.com'}],sharedDomains:[{domain:'agency-hub.com',reason:'VA agency'}],resolvers:['nat']}})).sql;
 assert.match(sql,/'\*resolved\*'/);assert.match(sql,/allowed_emails,auto_bind_exact\)values\(.*'resolved',array\[\]::text\[\],array\[\]::text\[\],false\);/,'automatic binding stated, and off by default');
 assert.match(prepareOperating(plan([{...resolved,autoBindExact:true}])).sql,/,true\);/);assert.throws(()=>prepareOperating(plan([{...resolved,autoBindExact:'yes' as never}])));
 assert.match(sql,/,false,'resolved'/,'rule inserted inactive');
 assert.match(sql,/'domain','undeniablementoring.com'/);assert.match(sql,/intake_shared_domains/);assert.match(sql,/intake_client_resolvers\(policy,actor,active,decision_reference\)values\('synthetic','nat',false,/);
 assert.doesNotMatch(sql,/grant /i);
 for(const bad of [{...resolved,client:'alpha'},{...resolved,clientEmails:['a@gmail.com']},{...resolved,allowedDomains:['x.com']},{...resolved,excluded:true}])assert.throws(()=>prepareOperating(plan([bad])));
});
const M=(n:number)=>`${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`;
const listPayload={items:[
 {mapping:M(1),badge:'needs_client',title:'Intro call',instant:'2026-10-20T01:00:00Z',outcome:'ambiguous',client:null,confidence:'none',reason:'Participants point to different clients: alpha, beta',suggestions:['alpha','beta'],newClient:null,
  participants:[{email:'a@gmail.com',resolved:'alpha',suggestion:null,note:null},{email:'b@gmail.com',resolved:null,suggestion:'beta',note:null},{email:'c@gmail.com',resolved:null,suggestion:null,note:null}]},
 {mapping:M(2),badge:'suggested',title:'Discovery',instant:'2026-10-20T02:00:00Z',outcome:'suggested',client:null,confidence:'none',reason:'Suggested beta from ghl; a person must confirm',suggestions:['beta'],newClient:null,participants:[{email:'jd@gmail.com',resolved:null,suggestion:'beta',note:null}]},
 {mapping:M(3),badge:'assigned',title:'Weekly',outcome:'known',client:'alpha',clientName:'Alpha Co',confidence:'exact',reason:'Matched alpha by approved identity',suggestions:[],participants:[{email:'a@gmail.com',resolved:'alpha',suggestion:null,note:null}]},
 {mapping:M(4),badge:'needs_client',title:'Unknown',outcome:'unrecognised',client:null,confidence:'none',reason:'No record',suggestions:[],newClient:{name:'Jane Doe',company:null,emails:['jd2@gmail.com']},participants:[{email:'jd2@gmail.com',resolved:null,suggestion:null,note:null}]},
 {mapping:'not-a-uuid',badge:'needs_client'},{mapping:M(5),badge:'other'}],
 clients:[{client:'beta',name:'Beta Co',status:'confirmed'},{client:'alpha',name:'Alpha Co',status:'confirmed'},{client:'zeta',name:'Zeta',status:'confirmed'},{client:'old',name:'Old',status:'merged'},{client:'pat-new',name:'Pat New',status:'provisional'}],
 rereview:[{request:M(6),title:'Prepare SOP',recordedClient:'pat-new',currentClient:'alpha'},{request:'bad'}]};
test('board: badges, headline, one-click suggestion, change-client choices, defaults',()=>{
 const list=parseMappingList(listPayload);
 assert.equal(list.items.length,4,'malformed items are dropped');assert.equal(list.rereview.length,1);
 assert.equal(mappingHeadline(list),'2 calls need a client · 1 suggested client to confirm · 1 task needs re-review after a client change · 1 assigned call you can change');
 assert.equal(mappingHeadline({items:[],clients:[],rereview:[],total:0,offset:0,limit:20,search:null}),'');
 assert.equal(singleSuggestion(list.items[1]),'beta');assert.equal(singleSuggestion(list.items[0]),null,'two suggestions are never one click');
 assert.deepEqual(clientChoices(list.items[0],list.clients).map(c=>c.client),['beta','alpha','pat-new','zeta'],'the call suggestions first, then the rest by name; never merged');
 assert.ok(!clientChoices(list.items[2],list.clients).some(c=>c.client==='alpha'),'change client never offers the current one');
 assert.deepEqual(rememberFor(list.items[0],'alpha'),['a@gmail.com','c@gmail.com'],'b@ pointed at beta and is not re-affiliated');
 assert.deepEqual(newClientDefaults(list.items[3]),['jd2@gmail.com']);assert.deepEqual(newClientDefaults(list.items[0]),['c@gmail.com']);
});
test('board: resolve requests are validated before they leave the route',()=>{
 const m=M(1);
 assert.ok(validMappingRequest({action:'choose_existing',payload:{mapping:m,client:'alpha',emails:['a@gmail.com']}}));
 assert.ok(validMappingRequest({action:'confirm_suggested',payload:{mapping:m,client:'beta'}}));
 assert.ok(validMappingRequest({action:'confirm_new',payload:{mapping:m,name:'Jane Doe',emails:['c@gmail.com']}}));
 assert.ok(validMappingRequest({action:'mark_internal',payload:{mapping:m,emails:['c@gmail.com']}}));
 assert.ok(validMappingRequest({action:'rereview_request',payload:{request:M(6),note:'Still owed under the new client'}}));
 for(const bad of [null,[],{action:'list',payload:{}},{action:'choose_existing',payload:{mapping:m}},{action:'confirm_suggested',payload:{mapping:m}},{action:'choose_existing',payload:{mapping:m,client:'Alpha Co'}},
  {action:'mark_internal',payload:{mapping:m,emails:[]}},{action:'confirm_new',payload:{mapping:'x'}},{action:'confirm_new',payload:{mapping:m,extra:1}},{action:'confirm_new',payload:{mapping:m,emails:['nope']}},
  {action:'rereview_request',payload:{request:M(6),note:'short'}},{action:'rereview_request',payload:{request:M(6),note:'long enough note',mapping:m}}])
  assert.equal(validMappingRequest(bad),null,JSON.stringify(bad));
});

// ---- Lane N3 (R11b-3): the correction view keeps human-confirmed assignments reachable ----------
import {listQuery,listPayload as routeListPayload,PAGE_SIZE} from '../src/lib/board/client-mapping.ts';
test('R11b-3: the correction view is bounded, paginated and searchable; a human-confirmed assignment parses as "assigned"',()=>{
 assert.equal(listQuery(0,''),`limit=${PAGE_SIZE}&offset=0`);
 assert.equal(listQuery(40,'  Nora  '),`limit=${PAGE_SIZE}&offset=40&search=Nora`);
 assert.equal(listQuery(-5,'x'.repeat(300)).length<140,true);
 assert.deepEqual(routeListPayload(new URLSearchParams('limit=500&offset=-1&search=')),{limit:PAGE_SIZE,offset:0});
 assert.deepEqual(routeListPayload(new URLSearchParams('limit=10&offset=30&search=Acme')),{limit:10,offset:30,search:'Acme'});
 const l=parseMappingList({items:[{mapping:M(7),badge:'assigned',title:'Confirmed call',outcome:'known',client:'beta',clientName:'Beta Co',confidence:'human',reason:'Client chosen by rhys',decidedBy:'human:rhys',decidedAt:'2026-10-20T03:00:00Z',suggestions:[],participants:[]}],clients:[{client:'beta',name:'Beta Co',status:'confirmed'},{client:'alpha',name:'Alpha Co',status:'confirmed'}],total:41,offset:20,limit:20,search:'call'});
 assert.equal(l.items[0].badge,'assigned');assert.equal(l.total,41);assert.equal(l.offset,20);assert.equal(l.search,'call');
 assert.deepEqual(clientChoices(l.items[0],l.clients).map(c=>c.client),['alpha'],'change client offers the others');
 assert.match(mappingHeadline(l),/1 assigned call you can change/);
});
