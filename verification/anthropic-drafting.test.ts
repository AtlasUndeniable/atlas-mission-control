/**
 * The direct Claude API drafting binding, exercised offline with a stub transport.
 *
 * No network call is made by this file. The synthetic key below is a test-only string that
 * matches the key-file format; the real key is never read, copied or asserted on here.
 *
 * Run: node --test verification/anthropic-drafting.test.ts
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
 anthropicDocumentEndpoint,anthropicDocumentConfigurationHash,anthropicDocumentKey,anthropicDocumentBody,
 anthropicDocumentText,anthropicDocumentTransport,documentCostBound,validDocumentUsage,documentDiagnostic,
 ANTHROPIC_MESSAGES_ENDPOINT,ANTHROPIC_VERSION,SONNET55_MICROS,DOCUMENT_REQUEST_PROFILE,DOCUMENT_RESPONSE_MAX_BYTES,
 type AnthropicDocumentConfig,type DocumentDiagnostic,type DocumentUsage,
} from '../src/lib/task-document-anthropic.ts';
import {readBrandRules,brandRules,brandSystemPrompt,brandSection,BRAND_KIT_SECTIONS} from '../src/lib/task-brand-rules.ts';
import {__injectAssetBoundaryForTests,BRAND_KIT_RELATIVE_PATH} from '../src/lib/task-asset-boundary.ts';

const FIXTURE_BRAIN=resolve(import.meta.dirname,'fixture-brain');

const SYNTHETIC_KEY='sk-ant-'+'synthetic0test0only0value0000000000';

async function keyFile(options:{dirMode?:number;fileMode?:number;value?:string}={}){
 const parent=await mkdtemp(join(tmpdir(),'atlas-key-'));
 const dir=join(parent,'credentials');
 await mkdir(dir);
 await chmod(dir,options.dirMode??0o700);
 const file=join(dir,'drafting.key');
 await writeFile(file,options.value??SYNTHETIC_KEY);
 await chmod(file,options.fileMode??0o600);
 return file;
}

const config=(over:Partial<AnthropicDocumentConfig>={}):AnthropicDocumentConfig=>({
 provider:'anthropic-direct',model:'claude-sonnet-5-5',
 disclosureDecision:'sprint-20261007-disclosure',budgetDecision:'sprint-20261007-budget',
 maxPromptCharacters:60000,maxOutputTokens:8000,timeoutMs:60000,
 requestProfile:DOCUMENT_REQUEST_PROFILE,keyFile:'/tmp/absent.key',
 ...over,
});

const ok=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
const reply=(usage={input_tokens:100,output_tokens:200})=>({
 usage,stop_reason:'end_turn',
 content:[{type:'thinking',thinking:'',signature:'synthetic-signature'},{type:'text',text:JSON.stringify({title:'T'})}],
});

test('the endpoint is a constant and cannot be redirected by configuration', () => {
 assert.equal(anthropicDocumentEndpoint(config()),ANTHROPIC_MESSAGES_ENDPOINT);
 assert.equal(ANTHROPIC_MESSAGES_ENDPOINT,'https://api.anthropic.com/v1/messages');
 // No endpoint, project, region or base-url field exists to override.
 assert.ok(!('endpoint' in config()));
});

test('the binding refuses a missing human decision, a bad bound or a relative key path', () => {
 assert.throws(()=>anthropicDocumentEndpoint(config({disclosureDecision:''})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({budgetDecision:'   '})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({maxOutputTokens:99})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({maxOutputTokens:12001})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({timeoutMs:0})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({timeoutMs:60001})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({keyFile:'relative.key'})),/provider_binding_unapproved_or_invalid/);
 assert.throws(()=>anthropicDocumentEndpoint(config({model:'../etc/passwd'})),/provider_binding_unapproved_or_invalid/);
});

test('the model and the drafting profile are bound together, never set alone', () => {
 assert.throws(()=>anthropicDocumentEndpoint(config({requestProfile:undefined})),/explicit_model_request_profile_required/);
 assert.throws(()=>anthropicDocumentEndpoint(config({model:'claude-sonnet-5'})),/explicit_model_request_profile_required/);
 // A different model with no profile is a valid shape but a distinct configuration hash.
 const other=anthropicDocumentConfigurationHash(config({model:'claude-sonnet-5',requestProfile:undefined}));
 assert.notEqual(other,anthropicDocumentConfigurationHash(config()));
});

test('the configuration hash changes with every bound field', () => {
 const base=anthropicDocumentConfigurationHash(config());
 for(const change of [{maxOutputTokens:4000},{maxPromptCharacters:50000},{timeoutMs:30000},{budgetDecision:'other'},{disclosureDecision:'other'},{keyFile:'/tmp/other.key'}]){
  assert.notEqual(anthropicDocumentConfigurationHash(config(change)),base,JSON.stringify(change));
 }
 assert.equal(anthropicDocumentConfigurationHash(config()),base,'and is stable for an unchanged binding');
});

test('the request body uses adaptive thinking at effort medium with max_tokens 8000', () => {
 const body=JSON.parse(anthropicDocumentBody(config(),'system rules','user prompt'));
 assert.equal(body.model,'claude-sonnet-5-5');
 assert.equal(body.max_tokens,8000);
 assert.deepEqual(body.thinking,{type:'adaptive'});
 assert.deepEqual(body.output_config,{effort:'medium'});
 assert.equal(body.stream,false);
 assert.equal(body.system,'system rules');
 assert.deepEqual(body.messages,[{role:'user',content:'user prompt'}]);
 // budget_tokens is rejected by this model family and must never be sent.
 assert.equal('budget_tokens' in body.thinking,false);
 assert.equal(body.tools,undefined,'no tools are offered to a drafting call');
 assert.equal(body.fallbacks,undefined,'no fallback model: one dispatch means one model');
 assert.equal(body.temperature,undefined);
});

test('an over-budget prompt is refused before the body is built', () => {
 assert.throws(()=>anthropicDocumentBody(config({maxPromptCharacters:1000}),'s','x'.repeat(1001)),/document_prompt_over_budget/);
 assert.throws(()=>anthropicDocumentBody(config(),'','prompt'),/document_prompt_required/);
 assert.throws(()=>anthropicDocumentBody(config(),'system',''),/document_prompt_required/);
});

test('the cost bound is the UTF-8 byte floor, with no token count required', () => {
 const body=anthropicDocumentBody(config(),'system','prompt');
 const bound=documentCostBound(body,config());
 assert.equal(bound.requestBytes,Buffer.byteLength(body,'utf8'));
 assert.equal(bound.maxOutputTokens,8000);
 assert.equal(bound.micros,bound.requestBytes*SONNET55_MICROS.input+8000*SONNET55_MICROS.output);
 // Multi-byte characters raise the byte floor, so the bound can never be under-counted.
 const wide=documentCostBound(anthropicDocumentBody(config(),'system','— — —'),config());
 assert.ok(wide.requestBytes>Buffer.from(anthropicDocumentBody(config(),'system','— — —')).length-1);
 assert.equal(SONNET55_MICROS.input,2);
 assert.equal(SONNET55_MICROS.output,10);
});

test('the key file must be an owner-only 0600 file in a 0700 directory', async () => {
 const good=await keyFile();
 assert.equal(await anthropicDocumentKey(good)(AbortSignal.timeout(1000)),SYNTHETIC_KEY);
 await assert.rejects(anthropicDocumentKey(await keyFile({fileMode:0o644}))(AbortSignal.timeout(1000)),/owner_only_provider_credentials_required/);
 await assert.rejects(anthropicDocumentKey(await keyFile({dirMode:0o755}))(AbortSignal.timeout(1000)),/owner_only_provider_credentials_required/);
 await assert.rejects(anthropicDocumentKey('relative.key')(AbortSignal.timeout(1000)),/owner_only_provider_credentials_required/);
 await assert.rejects(anthropicDocumentKey(await keyFile({value:'not-a-key'}))(AbortSignal.timeout(1000)),/explicit_api_key_credentials_required/);
});

test('a symlinked key file is refused rather than followed', async () => {
 const real=await keyFile();
 const parent=await mkdtemp(join(tmpdir(),'atlas-key-link-'));
 const dir=join(parent,'credentials');await mkdir(dir);await chmod(dir,0o700);
 const link=join(dir,'linked.key');await symlink(real,link);
 await assert.rejects(anthropicDocumentKey(link)(AbortSignal.timeout(1000)),/ELOOP|owner_only_provider_credentials_required/);
});

test('exactly one HTTP request is made, with the documented headers and no redirect', async () => {
 const file=await keyFile();
 const calls:{url:string;init:RequestInit}[]=[];
 const transport=(async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(url),init:init??{}});return ok(reply())}) as unknown as typeof fetch;
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),transport);
 await model.invoke('system','prompt','attempt-1');
 assert.equal(calls.length,1,'one dispatch per draft request');
 assert.equal(calls[0].url,ANTHROPIC_MESSAGES_ENDPOINT);
 assert.equal(calls[0].init.method,'POST');
 assert.equal(calls[0].init.redirect,'error');
 const headers=calls[0].init.headers as Record<string,string>;
 assert.equal(headers['x-api-key'],SYNTHETIC_KEY);
 assert.equal(headers['anthropic-version'],ANTHROPIC_VERSION);
 assert.equal(headers['content-type'],'application/json');
 assert.equal(Object.keys(headers).sort().join(),'anthropic-version,content-type,x-api-key');
});

test('an HTTP error is recorded as a bounded diagnostic and never retried', async () => {
 const file=await keyFile();
 for(const status of [401,429,529]){
  let calls=0;const diagnostics:DocumentDiagnostic[]=[];
  const transport=(async()=>{calls++;return ok({error:{type:status===401?'authentication_error':status===429?'rate_limit_error':'overloaded_error',message:'Your key sk-ant-leak is bad'}},status,{'request-id':'req_abc123'})}) as unknown as typeof fetch;
  const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),transport,{recordDiagnostic:async(_a,d)=>{diagnostics.push(d)}});
  await assert.rejects(model.invoke('system','prompt','attempt-1'),/provider_outcome_unresolved/);
  assert.equal(calls,1,`status ${status} must not be retried`);
  assert.equal(diagnostics.length,1);
  assert.equal(diagnostics[0].httpStatus,status);
  assert.equal(diagnostics[0].headers?.['request-id'],'req_abc123');
  assert.ok(diagnostics[0].providerErrorType);
  // No provider message, prompt or key survives into the diagnostic.
  const serialised=JSON.stringify(diagnostics[0]);
  assert.ok(!serialised.includes('sk-ant-'),serialised);
  assert.ok(!serialised.includes('Your key'));
  assert.ok(!serialised.includes('prompt'));
 }
});

test('a refusal settles the attempt by category, with usage still recorded', async () => {
 const file=await keyFile();
 const diagnostics:DocumentDiagnostic[]=[];const usages:DocumentUsage[]=[];let calls=0;
 const transport=(async()=>{calls++;return ok({usage:{input_tokens:50,output_tokens:5},stop_reason:'refusal',stop_details:{type:'refusal',category:'general_harms',explanation:'long free text'},content:[]})}) as unknown as typeof fetch;
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),transport,{
  recordDiagnostic:async(_a,d)=>{diagnostics.push(d)},recordUsage:async(_a,u)=>{usages.push(u)},
 });
 await assert.rejects(model.invoke('system','prompt','attempt-1'),/provider_response_incomplete/);
 assert.equal(calls,1,'a declined generation is not retried');
 assert.equal(diagnostics[0].category,'provider_refusal');
 assert.equal(diagnostics[0].refusalCategory,'general_harms');
 assert.ok(!JSON.stringify(diagnostics[0]).includes('long free text'));
 // A refused call is still billed, so it still enters the ledger.
 assert.deepEqual(usages,[{input_tokens:50,output_tokens:5}]);
});

test('usage is recorded before the contract is judged, and validated on the way in', async () => {
 const file=await keyFile();
 const usages:DocumentUsage[]=[];
 const transport=(async()=>ok({usage:{input_tokens:10,output_tokens:20},stop_reason:'max_tokens',content:[{type:'text',text:'{}'}]})) as unknown as typeof fetch;
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),transport,{recordUsage:async(_a,u)=>{usages.push(u)}});
 await assert.rejects(model.invoke('system','prompt','a'),/provider_response_incomplete/);
 assert.deepEqual(usages,[{input_tokens:10,output_tokens:20}]);
 assert.equal(validDocumentUsage({input_tokens:1,output_tokens:2},8000),true);
 assert.equal(validDocumentUsage({input_tokens:1,output_tokens:8001},8000),false,'an impossible output count is not recorded');
 assert.equal(validDocumentUsage({input_tokens:-1,output_tokens:2},8000),false);
 assert.equal(validDocumentUsage(undefined,8000),false);
});

test('a transport failure is unresolved, not a failure to retry', async () => {
 const file=await keyFile();
 let calls=0;const diagnostics:DocumentDiagnostic[]=[];
 const transport=(async()=>{calls++;throw new Error('socket closed')}) as unknown as typeof fetch;
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),transport,{recordDiagnostic:async(_a,d)=>{diagnostics.push(d)}});
 await assert.rejects(model.invoke('system','prompt','a'),/provider_outcome_unresolved/);
 assert.equal(calls,1);
 assert.equal(diagnostics[0].category,'transport_unresolved');
 assert.ok(!JSON.stringify(diagnostics[0]).includes('socket closed'));
});

test('the cost bound reaches the ledger before the key is used', async () => {
 const file=await keyFile();
 const order:string[]=[];
 const transport=(async()=>{order.push('dispatch');return ok(reply())}) as unknown as typeof fetch;
 const model=anthropicDocumentTransport(config({keyFile:file}),async()=>{order.push('key');return SYNTHETIC_KEY},transport,{
  beforeDispatch:async(_a,bound)=>{order.push('bound:'+bound.micros)},
 });
 await model.invoke('system','prompt','a');
 assert.equal(order.length,3);
 assert.equal(order[0],'key');
 assert.ok(order[1].startsWith('bound:'));
 assert.equal(order[2],'dispatch');
});

test('only text plus structurally valid thinking blocks are accepted as output', () => {
 assert.equal(anthropicDocumentText([{type:'text',text:'body'}]),'body');
 assert.equal(anthropicDocumentText([{type:'thinking',thinking:'',signature:'sig'},{type:'text',text:'body'}]),'body');
 // Reconciled with the extraction path: an unsigned thinking block is malformed.
 assert.throws(()=>anthropicDocumentText([{type:'thinking',thinking:''},{type:'text',text:'body'}]),/provider_response_incomplete/);
 assert.equal(anthropicDocumentText([{type:'redacted_thinking',data:'xx'},{type:'text',text:'body'}]),'body');
 assert.throws(()=>anthropicDocumentText([]),/provider_response_incomplete/);
 assert.throws(()=>anthropicDocumentText([{type:'thinking',thinking:'',signature:'sig'}]),/provider_response_incomplete/);
 assert.throws(()=>anthropicDocumentText([{type:'text',text:'a'},{type:'text',text:'b'}]),/provider_response_incomplete/);
 assert.throws(()=>anthropicDocumentText([{type:'tool_use',name:'x'}]),/provider_response_incomplete/);
 assert.throws(()=>anthropicDocumentText([{type:'redacted_thinking'}]),/provider_response_incomplete/);
 assert.throws(()=>anthropicDocumentText([{type:'text',text:'   '}]),/provider_response_incomplete/);
 // Thinking is never treated as document content.
 assert.throws(()=>anthropicDocumentText([{type:'thinking',thinking:'{"title":"from reasoning"}',signature:'sig'}]),/provider_response_incomplete/);
});

test('an unreadable response body is unresolved rather than partly used', async () => {
 const file=await keyFile();
 const diagnostics:DocumentDiagnostic[]=[];
 const transport=(async()=>new Response('not json',{status:200,headers:{'content-type':'application/json'}})) as unknown as typeof fetch;
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),transport,{recordDiagnostic:async(_a,d)=>{diagnostics.push(d)}});
 await assert.rejects(model.invoke('system','prompt','a'),/provider_outcome_unresolved/);
 assert.equal(diagnostics[0].category,'response_unreadable');
});

test('a bounded diagnostic keeps identifiers and drops everything else', async () => {
 const response=ok({error:{type:'rate_limit_error',message:'secret prompt text'}},429,{'request-id':'req_1','retry-after':'30'});
 const diagnostic=await documentDiagnostic(response,AbortSignal.timeout(1000),['secret prompt text']);
 assert.equal(diagnostic.httpStatus,429);
 assert.equal(diagnostic.providerErrorType,'rate_limit_error');
 assert.ok(!JSON.stringify(diagnostic).includes('secret prompt text'));
});

test('the brand kit sections drive the system prompt and are hashed into the binding', async () => {
 // The kit is read at its pinned path beneath the injected fixture brain; the identical
 // copy at verification/fixture-brand-kit.md is no longer a readable location, because an
 // arbitrary absolute path is exactly what review finding R5 refuses.
 __injectAssetBoundaryForTests({brainRoot:FIXTURE_BRAIN});
 const rules=await readBrandRules(join(FIXTURE_BRAIN,BRAND_KIT_RELATIVE_PATH));
 assert.deepEqual(rules.sections,[...BRAND_KIT_SECTIONS]);
 assert.ok(rules.text.includes('Direct, specific'));
 assert.ok(/^[0-9a-f]{64}$/.test(rules.kitHash));
 const system=brandSystemPrompt(rules);
 assert.ok(system.includes('Undeniable brand rules'));
 assert.ok(system.includes('Plain text only'));
 assert.ok(system.includes('quote a supplied source'));
 // A different kit is a different hash, so the voice in force is always traceable.
 const changed=brandRules(await (await import('node:fs/promises')).readFile(resolve(import.meta.dirname,'fixture-brand-kit.md'),'utf8')+'\n');
 assert.notEqual(changed.kitHash,rules.kitHash);
 assert.throws(()=>brandSection('# Nothing here','11. WRITING STYLE GUIDE'),/brand_section_absent/);
 await assert.rejects(readBrandRules('/does/not/exist.md'),/brand_kit_outside_brain/);
 await assert.rejects(readBrandRules('relative.md'),/brand_kit_path_required/);
 __injectAssetBoundaryForTests(null);
 // With no injection the pinned production path is the only readable one.
 await assert.rejects(readBrandRules(join(FIXTURE_BRAIN,BRAND_KIT_RELATIVE_PATH)),/brand_kit_outside_brain/);
});

test('the real brand kit still exposes the sections this lane extracts', async () => {
 // Guards against a kit edit silently removing the voice rules the drafting prompt needs.
 // No injection: this is the pinned production path under the canonical brain root.
 __injectAssetBoundaryForTests(null);
 const rules=await readBrandRules('/Users/atlasai/atlas-brain/brain/UNDENIABLE_BRAND_KIT.md');
 assert.deepEqual(rules.sections,[...BRAND_KIT_SECTIONS]);
 assert.ok(rules.text.includes('Direct, data-driven, specific'));
 assert.ok(rules.text.length>500&&rules.text.length<=6000);
});

/*
 * Lane F / review finding R1: finish the bounded drafting transport in its production
 * wiring. Two separate defects: the successful-response read was not actually bounded, and
 * recordDiagnostic was not connected outside injected tests.
 */
test('R1: a successful response is bounded while streaming, not after allocation', async () => {
 const file=await keyFile();
 let pulled=0;
 // A body that never ends. response.text() would read it until memory ran out and only
 // then compare its length; the capped reader must stop at the ceiling.
 const endless=new ReadableStream<Uint8Array>({pull(c){pulled++;c.enqueue(new TextEncoder().encode('x'.repeat(64*1024)))}});
 const diagnostics:DocumentDiagnostic[]=[];
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),
  async()=>new Response(endless,{status:200,headers:{'content-type':'application/json'}}),
  {recordDiagnostic:async(_a,d)=>{diagnostics.push(d)}});
 await assert.rejects(model.invoke('system','prompt','11111111-1111-1111-1111-111111111111'),/provider_outcome_unresolved/);
 // Bounded: the reader stopped within a couple of 64 KiB chunks of the ceiling instead of
 // consuming an endless body. The slack is the stream's own read-ahead, not slack in the
 // cap -- the point is that this terminates at all, which response.text() would not.
 assert.ok(pulled*65536<=DOCUMENT_RESPONSE_MAX_BYTES+3*65536,`read ${pulled*65536} bytes against the ${DOCUMENT_RESPONSE_MAX_BYTES} cap`);
 assert.ok(pulled>0);
 assert.equal(DOCUMENT_RESPONSE_MAX_BYTES,1_000_000);
 // An unreadable body is still a recorded diagnostic with no retry and no raw content.
 assert.deepEqual(diagnostics.map(d=>d.category),['response_unreadable']);
 assert.ok(!JSON.stringify(diagnostics).includes('xxxx'));
});

test('R1: an oversize but finite response is refused without being parsed', async () => {
 const file=await keyFile();
 const big=JSON.stringify({usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn',content:[{type:'text',text:'y'.repeat(DOCUMENT_RESPONSE_MAX_BYTES+10)}]});
 const model=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),
  async()=>new Response(big,{status:200,headers:{'content-type':'application/json'}}));
 await assert.rejects(model.invoke('system','prompt','11111111-1111-1111-1111-111111111111'),/provider_outcome_unresolved/);
 // A body inside the cap still parses, so the cap is a ceiling and not a regression.
 const fine=anthropicDocumentTransport(config({keyFile:file}),anthropicDocumentKey(file),async()=>ok(reply()));
 assert.ok(await fine.invoke('system','prompt','11111111-1111-1111-1111-111111111111'));
});

test('R1: the production wrapper persists 401, 429, 529 and refusal diagnostics', async () => {
 const {documentModel,documentRuntimeHooks}=await import('../src/lib/meetings/document-runtime.ts');
 const file=await keyFile();
 const journalDir=await mkdtemp(join(tmpdir(),'atlas-diag-'));
 await chmod(journalDir,0o700);
 const journal=join(journalDir,'drafting-diagnostics.jsonl');
 const live={
  enabled:true,mode:'live' as const,provider:'anthropic-direct',model:'claude-sonnet-5-5',
  codec:'atlas-document-json-v1',endpoint:ANTHROPIC_MESSAGES_ENDPOINT,timeoutMs:60000,
  maxOutputTokens:8000,maxPromptCharacters:60000,headerEnvironment:{},
  disclosureDecision:'sprint-20261007-disclosure',budgetDecision:'sprint-20261007-budget',
  keyFile:file,assetBrain:'/Users/atlasai/atlas-brain',
  brandKit:'/Users/atlasai/atlas-brain/brain/UNDENIABLE_BRAND_KIT.md',
  providerDiagnosticsFile:journal,
 };
 const previous=process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION;
 process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION='reviewed';
 try{
  // The hooks the real buildTaskDocument builds, not hooks invented by this test.
  const rpcCalls:string[]=[];
  const ledger={token:'synthetic-token'};
  const hooks=documentRuntimeHooks(live,async(action)=>{rpcCalls.push(action);return {}},ledger);
  const cases:[string,Response][]=[
   ['authentication_error',ok({error:{type:'authentication_error',message:'invalid x-api-key'}},401)],
   ['rate_limit_error',ok({error:{type:'rate_limit_error',message:'slow down, secret prompt text'}},429,{'retry-after':'30'})],
   ['overloaded_error',ok({error:{type:'overloaded_error',message:'overloaded'}},529)],
   ['refusal',ok({usage:{input_tokens:10,output_tokens:20},stop_reason:'refusal',stop_details:{category:'policy_refusal',explanation:'free-form text that must not be retained'}},200)],
  ];
  for(const [,response] of cases){
   // documentModel() binds the brand system prompt itself, so invoke takes (prompt,attempt).
   const model=await documentModel(live,async()=>response,hooks);
   assert.ok(model.system&&model.system.includes('Undeniable brand rules'));
   await assert.rejects(model.invoke('secret prompt text','11111111-1111-1111-1111-111111111111'));
  }
  const lines=(await (await import('node:fs/promises')).readFile(journal,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(lines.length,4,'one persisted diagnostic per case');
  assert.deepEqual(lines.map(l=>l.diagnostic.httpStatus),[401,429,529,200]);
  assert.deepEqual(lines.map(l=>l.diagnostic.providerErrorType??l.diagnostic.category),
   ['authentication_error','rate_limit_error','overloaded_error','provider_refusal']);
  assert.equal(lines[3].diagnostic.refusalCategory,'policy_refusal');
  assert.ok(lines.every(l=>l.attempt==='11111111-1111-1111-1111-111111111111'));
  // Nothing raw reaches the journal: not the key, the prompt, the system prompt, the
  // provider message or the refusal explanation.
  const text=JSON.stringify(lines);
  for(const forbidden of [SYNTHETIC_KEY,'secret prompt text','invalid x-api-key','free-form text that must not be retained','slow down','Undeniable brand rules'])
   assert.ok(!text.includes(forbidden),`journal leaked: ${forbidden}`);
  // Usage still precedes the refusal, and it is the ledger RPC that records it.
  assert.ok(rpcCalls.includes('usage'),JSON.stringify(rpcCalls));
  // The journal is owner-only 0600.
  const stat=await (await import('node:fs/promises')).lstat(journal);
  assert.equal(stat.mode&0o777,0o600);
 }finally{
  if(previous===undefined)delete process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION;
  else process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION=previous;
 }
});

test('R1: a live binding with no diagnostics journal is refused before any dispatch', async () => {
 const {documentModel}=await import('../src/lib/meetings/document-runtime.ts');
 const file=await keyFile();
 const base={
  enabled:true,mode:'live' as const,provider:'anthropic-direct',model:'claude-sonnet-5-5',
  codec:'atlas-document-json-v1',endpoint:ANTHROPIC_MESSAGES_ENDPOINT,timeoutMs:60000,
  maxOutputTokens:8000,maxPromptCharacters:60000,headerEnvironment:{},
  disclosureDecision:'d',budgetDecision:'b',keyFile:file,
  assetBrain:'/Users/atlasai/atlas-brain',
  brandKit:'/Users/atlasai/atlas-brain/brain/UNDENIABLE_BRAND_KIT.md',
 };
 const previous=process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION;
 process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION='reviewed';
 let dispatches=0;
 try{
  await assert.rejects(documentModel(base as never,async()=>{dispatches++;return ok(reply())},{}),/provider_diagnostics_path_required/);
  await assert.rejects(documentModel({...base,providerDiagnosticsFile:'relative.jsonl'},async()=>{dispatches++;return ok(reply())},{}),/private_diagnostic_binding_required/);
  // A world-readable directory is refused too, so a diagnostic cannot land somewhere shared.
  const open=await mkdtemp(join(tmpdir(),'atlas-diag-open-'));
  await chmod(open,0o755);
  await assert.rejects(documentModel({...base,providerDiagnosticsFile:join(open,'d.jsonl')},async()=>{dispatches++;return ok(reply())},{}),/owner_only_diagnostics_required/);
  assert.equal(dispatches,0);
 }finally{
  if(previous===undefined)delete process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION;
  else process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION=previous;
 }
});
