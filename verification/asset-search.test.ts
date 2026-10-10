/**
 * Asset retrieval and the source boundary.
 *
 * All content is the fictional fixture brain under verification/fixture-brain. No real
 * client archive, no real brain path and no provider call is involved.
 *
 * Run: node --test verification/asset-search.test.ts
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,realpath,rename,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {
 atlasAssetRoots,searchTaskAssets,readReleasedAsset,assetTerms,assetIdentifier,parseAssetIdentifier,
 assetPlainText,assetScore,ASSET_LIMITS,
} from '../src/lib/task-asset-search.ts';
import {
 __injectAssetBoundaryForTests,__setBoundaryTraversalHookForTests,PRODUCTION_BRAIN_ROOT,
 BRAND_KIT_RELATIVE_PATH,brainRoot,containedPath,readContainedFile,
} from '../src/lib/task-asset-boundary.ts';
import {readBrandRules} from '../src/lib/task-brand-rules.ts';

const BRAIN=resolve(import.meta.dirname,'fixture-brain');
// The fixture brain is reached through the explicit test injection, never by handing a
// path to the product: atlasAssetRoots() now refuses any root but the canonical one.
__injectAssetBoundaryForTests({brainRoot:BRAIN});
/** Run one case against a synthetic brain, then restore the fixture brain. */
async function withBrain<T>(root:string,fn:()=>Promise<T>){
 __injectAssetBoundaryForTests({brainRoot:root});
 try{return await fn()}finally{__injectAssetBoundaryForTests({brainRoot:BRAIN})}
}
/**
 * A scratch brain must be a *resolved* path. An injected root is now held to the same trust
 * rules as the production constant — it has to resolve to itself — and on macOS
 * `os.tmpdir()` is reached through the `/var` → `/private/var` link, so an unresolved
 * mkdtemp path would be refused as a linked ancestor before any case got to its own point.
 */
const scratch=async(prefix:string)=>realpath(await mkdtemp(join(tmpdir(),prefix)));
const ROOTS=atlasAssetRoots(BRAIN);
const SHARED=ROOTS.filter(r=>r.kind==='shared');
const OWN={client:'Northwind Pilates',directories:['northwind-pilates']};
const terms=(...p:string[])=>assetTerms(...p);

test('the reviewed roots name every excluded root explicitly, so the boundary is inspectable', () => {
 const excluded=ROOTS.filter(r=>r.kind==='excluded').map(r=>r.key).sort();
 assert.deepEqual(excluded,['calls','client-archives']);
 assert.deepEqual(ROOTS.filter(r=>r.kind==='client_scoped').map(r=>r.key),['client-work']);
});

test('shared method assets are retrieved and ranked by lexical match to the task', async () => {
 const found=await searchTaskAssets(SHARED,OWN,terms('Write the coach role SOP','role clarity and escalation for the coach'));
 assert.ok(found.candidates.length>0,'expected shared matches');
 assert.ok(found.candidates.every(c=>c.clientDirectory===null));
 // frameworks.md carries both "role" and "escalation"; it must outrank the lead magnet.
 assert.equal(found.candidates[0].rootKey,'frameworks');
 assert.ok(found.candidates[0].score>found.candidates[found.candidates.length-1].score||found.candidates.length===1);
});

test('identifiers are stable and independent of rank', async () => {
 const a=await searchTaskAssets(SHARED,OWN,terms('coach role escalation'));
 const b=await searchTaskAssets(SHARED,OWN,terms('coach role escalation ladder weekly evidence'));
 const byId=new Map(b.candidates.map(c=>[c.id,c]));
 for(const candidate of a.candidates){
  const other=byId.get(candidate.id);
  if(other)assert.equal(other.contentHash,candidate.contentHash,'same identifier must mean same content hash');
 }
 assert.equal(assetIdentifier('frameworks','frameworks.md'),'asset:frameworks:frameworks.md');
 assert.deepEqual(parseAssetIdentifier('asset:playbooks:a/b.md'),{rootKey:'playbooks',relativePath:'a/b.md'});
});

test('the task client reaches its own released client-work directory', async () => {
 const found=await searchTaskAssets(ROOTS,OWN,terms('Northwind Pilates check-in change','move weekly check-ins to Thursday'));
 const client=found.candidates.filter(c=>c.clientDirectory!==null);
 assert.equal(client.length,1);
 assert.equal(client[0].clientDirectory,'northwind-pilates');
 assert.ok(client[0].id.startsWith('asset:client-work:northwind-pilates/'));
});

test('BOUNDARY: another client\'s work never enters, even when its text matches the task', async () => {
 // "pricing exception" and "handover" are live task terms here, so the only thing keeping
 // Kestrel out is the client boundary itself, not a weak lexical score.
 const found=await searchTaskAssets(ROOTS,OWN,terms('pricing exception coach handover kestrel strength margin package'));
 assert.ok(!found.candidates.some(c=>c.id.includes('kestrel')),'Kestrel must not appear for a Northwind task');
 assert.ok(found.skipped.some(s=>s.reason==='foreign_or_unreleased_client'&&s.path.includes('kestrel')));
 for(const candidate of found.candidates)assert.notEqual(candidate.clientDirectory,'kestrel-strength');
});

test('BOUNDARY: the client-archives root is refused even when its own client is released', async () => {
 const archiveScope={client:'Kestrel Strength',directories:['kestrel-strength']};
 const found=await searchTaskAssets(ROOTS,archiveScope,terms('kestrel strength complete context archive contract value margin'));
 assert.ok(!found.candidates.some(c=>c.rootKey==='client-archives'),'an excluded root can never contribute');
 assert.ok(found.skipped.some(s=>s.reason==='root_excluded_pending_release'&&s.path.includes('client-archives')));
 await assert.rejects(
  readReleasedAsset(ROOTS,{id:'asset:client-archives:kestrel-strength-complete-context-2026-01-01.md',contentHash:'0'.repeat(64),clientDirectory:null},archiveScope),
  /asset_root_excluded/);
});

test('BOUNDARY: an empty client release means no client asset is retrievable at all', async () => {
 const found=await searchTaskAssets(ROOTS,{client:'Northwind Pilates',directories:[]},terms('Northwind Pilates check-in change Thursday'));
 assert.equal(found.candidates.filter(c=>c.clientDirectory!==null).length,0);
});

test('BOUNDARY: a released read cannot be redirected to another client directory', async () => {
 const found=await searchTaskAssets(ROOTS,OWN,terms('Northwind check-in change'));
 const client=found.candidates.find(c=>c.clientDirectory!==null)!;
 await assert.rejects(
  readReleasedAsset(ROOTS,{id:'asset:client-work:kestrel-strength/kestrel-notes.md',contentHash:client.contentHash,clientDirectory:'kestrel-strength'},OWN),
  /asset_client_boundary_refused/);
 // A shared asset claiming a client directory is equally refused.
 await assert.rejects(
  readReleasedAsset(ROOTS,{id:'asset:frameworks:frameworks.md',contentHash:'0'.repeat(64),clientDirectory:'northwind-pilates'},OWN),
  /asset_client_boundary_refused/);
});

test('a source edited after release fails the read instead of substituting new content', async () => {
 const found=await searchTaskAssets(SHARED,OWN,terms('role clarity escalation'));
 const candidate=found.candidates[0];
 const ok=await readReleasedAsset(SHARED,{id:candidate.id,contentHash:candidate.contentHash,clientDirectory:null},OWN);
 assert.equal(ok.contentHash,candidate.contentHash);
 await assert.rejects(
  readReleasedAsset(SHARED,{id:candidate.id,contentHash:createHash('sha256').update('different').digest('hex'),clientDirectory:null},OWN),
  /asset_source_changed/);
});

test('the candidate set is capped at eight and reports truncation', async () => {
 const directory=await scratch('atlas-asset-cap-');
 await mkdir(join(directory,'many'),{recursive:true});
 for(let i=0;i<14;i++)await writeFile(join(directory,'many',`escalation-${i}.md`),`# Escalation note ${i}\n\nEscalation ladder detail for the coach role, item ${i}, with enough text to pass the usable-text floor.`);
 const roots=[{key:'playbooks',path:join(directory,'many'),kind:'shared' as const,label:'fixture'}];
 const found=await withBrain(directory,()=>searchTaskAssets(roots,OWN,terms('escalation ladder coach role')));
 assert.equal(found.candidates.length,ASSET_LIMITS.maxCandidates);
 assert.equal(found.candidates.length,8);
 assert.equal(found.truncated,true);
 // Deterministic ordering: equal scores break by identifier, never by directory order.
 const ids=found.candidates.map(c=>c.id);
 assert.deepEqual([...ids],[...ids].sort((a,b)=>found.candidates.find(c=>c.id===a)!.score===found.candidates.find(c=>c.id===b)!.score?(a<b?-1:1):0));
});

test('a symlink out of the root is refused rather than followed', async () => {
 const directory=await scratch('atlas-asset-link-');
 const outside=join(directory,'outside');await mkdir(outside,{recursive:true});
 await writeFile(join(outside,'secret.md'),'# Secret\n\nEscalation ladder content that must never be reachable through a symlink.');
 const inside=join(directory,'inside');await mkdir(inside,{recursive:true});
 await symlink(join(outside,'secret.md'),join(inside,'linked.md'));
 await writeFile(join(inside,'real.md'),'# Real\n\nEscalation ladder content that is genuinely inside the reviewed root.');
 const roots=[{key:'playbooks',path:inside,kind:'shared' as const,label:'fixture'}];
 const found=await withBrain(directory,()=>searchTaskAssets(roots,OWN,terms('escalation ladder')));
 assert.deepEqual(found.candidates.map(c=>c.relativePath),['real.md']);
 assert.ok(found.skipped.some(s=>s.reason==='symlink_refused'));
});

test('binary and oversize files are skipped, not partially read', async () => {
 const directory=await scratch('atlas-asset-size-');
 await writeFile(join(directory,'huge.md'),'# Escalation\n\n'+'escalation '.repeat(ASSET_LIMITS.maxFileBytes));
 await writeFile(join(directory,'image.png'),Buffer.from([0x89,0x50,0x4e,0x47]));
 await writeFile(join(directory,'fine.md'),'# Escalation ladder\n\nEscalation ladder content within the size bound for the coach role.');
 const roots=[{key:'playbooks',path:directory,kind:'shared' as const,label:'fixture'}];
 const found=await withBrain(directory,()=>searchTaskAssets(roots,OWN,terms('escalation ladder coach')));
 assert.deepEqual(found.candidates.map(c=>c.relativePath),['fine.md']);
 assert.ok(found.skipped.some(s=>s.reason==='over_size_bound'));
});

test('link targets and markup are stripped, so no source can hand the draft a URL', () => {
 const text=assetPlainText('See [the guide](https://example.com/guide) and <b>note</b> this.\n\nRaw https://example.com/raw too.','.md');
 assert.ok(!text.includes('https://'),text);
 assert.ok(text.includes('the guide'));
 assert.ok(!text.includes('<b>'));
 const html=assetPlainText('<script>alert(1)</script><p>Body text here</p>','.html');
 assert.ok(!html.includes('alert'));
 assert.ok(html.includes('Body text here'));
});

test('scoring prefers breadth of matched task terms over one repeated term', () => {
 const narrow=assetScore(['retention','escalation'],'notes.md','Notes','retention '.repeat(20));
 const broad=assetScore(['retention','escalation'],'notes.md','Notes','retention escalation');
 assert.ok(broad.matchedTerms.length>narrow.matchedTerms.length);
 assert.ok(broad.score>narrow.score,`${broad.score} should beat ${narrow.score}`);
});

test('scope and limit arguments are validated rather than coerced', async () => {
 await assert.rejects(searchTaskAssets(SHARED,{client:'',directories:[]},['role']),/asset_client_scope_required/);
 await assert.rejects(searchTaskAssets(SHARED,{client:'X',directories:['../escape']},['role']),/asset_client_directory_invalid/);
 await assert.rejects(searchTaskAssets(SHARED,OWN,['role'],99),/asset_candidate_limit_invalid/);
 assert.throws(()=>parseAssetIdentifier('asset:playbooks:../escape.md'),/asset_identifier_invalid/);
 assert.throws(()=>assetIdentifier('playbooks','../escape.md'),/asset_relative_path_invalid/);
});

test('stopwords and short tokens do not become retrieval terms', () => {
 assert.deepEqual(assetTerms('the and for a client task'),[]);
 assert.deepEqual(assetTerms('Coach role escalation'),['coach','role','escalation']);
});

/*
 * Lane F / review finding R5: the absolute filesystem boundary.
 *
 * Each case is a path that the previous arrangement accepted. The root was taken from the
 * runtime configuration and containment was then measured against that same root, so a
 * configured root anywhere on the disk legitimised itself, an ancestor of a root could be
 * a symlink out of the brain, and a single-file root was not containment-checked at all.
 */
test('R5: a configured brain root that is not the canonical one is refused', () => {
 assert.equal(brainRoot(),BRAIN);
 assert.throws(()=>atlasAssetRoots('/tmp/somewhere-else'),/asset_brain_not_canonical/);
 assert.throws(()=>atlasAssetRoots('relative/path'),/asset_brain_not_canonical/);
 assert.throws(()=>atlasAssetRoots(''),/asset_brain_path_required/);
 // The canonical constant is the production brain, not whatever a fixture injected.
 assert.equal(PRODUCTION_BRAIN_ROOT,'/Users/atlasai/atlas-brain');
});

test('R5: a symlinked ancestor under content/ is refused, not resolved into scope', async () => {
 const directory=await scratch('atlas-asset-ancestor-');
 // The escape: content/ itself is a link out of the brain. lstat of the final directory
 // content/playbooks sees an ordinary directory, and realpath of it then reports the
 // outside location as the root's own real path.
 const outside=join(directory,'outside','playbooks');await mkdir(outside,{recursive:true});
 await writeFile(join(outside,'escalation.md'),'# Escalation ladder\n\nContent outside the brain that must never reach a draft through a linked ancestor.');
 const brain=join(directory,'brain-root');await mkdir(brain,{recursive:true});
 await symlink(join(directory,'outside'),join(brain,'content'));
 const roots=[{key:'playbooks',path:join(brain,'content','playbooks'),kind:'shared' as const,label:'fixture'}];
 const found=await withBrain(brain,()=>searchTaskAssets(roots,OWN,terms('escalation ladder')));
 assert.deepEqual(found.candidates,[]);
 assert.ok(found.skipped.some(s=>s.reason==='asset_symlink_ancestor_refused'),JSON.stringify(found.skipped));
 // And the released read refuses the same path rather than reading it.
 await withBrain(brain,async()=>{
  await assert.rejects(readReleasedAsset(roots,{id:'asset:playbooks:escalation.md',contentHash:'0'.repeat(64),clientDirectory:null},OWN),/asset_symlink_ancestor_refused/);
 });
});

test('R5: a symlinked single-file root is refused instead of taking the early branch', async () => {
 const directory=await scratch('atlas-asset-filelink-');
 const outside=join(directory,'outside');await mkdir(outside,{recursive:true});
 await writeFile(join(outside,'frameworks.md'),'# Frameworks\n\nEscalation ladder content outside the brain reached through a single-file root link.');
 const brain=join(directory,'brain-root');await mkdir(join(brain,'brain'),{recursive:true});
 // Two shapes: the root file is itself a link, and the root file sits under a linked dir.
 await symlink(join(outside,'frameworks.md'),join(brain,'brain','frameworks.md'));
 await symlink(outside,join(brain,'linked'));
 const linkedFile=[{key:'frameworks',path:join(brain,'brain','frameworks.md'),kind:'shared' as const,label:'fixture'}];
 const linkedDir=[{key:'frameworks',path:join(brain,'linked','frameworks.md'),kind:'shared' as const,label:'fixture'}];
 for(const roots of [linkedFile,linkedDir]){
  const found=await withBrain(brain,()=>searchTaskAssets(roots,OWN,terms('escalation ladder')));
  assert.deepEqual(found.candidates,[]);
  assert.ok(found.skipped.some(s=>s.reason==='asset_symlink_ancestor_refused'),JSON.stringify(found.skipped));
  await withBrain(brain,async()=>{
   await assert.rejects(readReleasedAsset(roots,{id:'asset:frameworks:frameworks.md',contentHash:'0'.repeat(64),clientDirectory:null},OWN),/asset_symlink_ancestor_refused/);
  });
 }
});

test('R5: a brandKit path outside the brain is refused', async () => {
 const directory=await scratch('atlas-brand-outside-');
 await writeFile(join(directory,'UNDENIABLE_BRAND_KIT.md'),'## 1. BRAND IDENTITY\n\nSubstituted voice.\n');
 // Any absolute regular file used to be accepted; only the pinned path beneath the brain
 // in force is now permitted, and the production constant is unreachable from config.
 await assert.rejects(readBrandRules(join(directory,'UNDENIABLE_BRAND_KIT.md')),/brand_kit_outside_brain/);
 await assert.rejects(readBrandRules('/etc/hosts'),/brand_kit_outside_brain/);
 await assert.rejects(readBrandRules(resolve(import.meta.dirname,'fixture-brand-kit.md')),/brand_kit_outside_brain/);
 // The pinned path under the injected fixture brain is accepted.
 const rules=await readBrandRules(join(BRAIN,BRAND_KIT_RELATIVE_PATH));
 assert.ok(rules.text.includes('Direct, specific'));
 // A linked kit at the pinned path is refused rather than followed.
 const brain=join(directory,'brain-root');await mkdir(join(brain,'brain'),{recursive:true});
 await symlink(join(directory,'UNDENIABLE_BRAND_KIT.md'),join(brain,BRAND_KIT_RELATIVE_PATH));
 await withBrain(brain,async()=>{
  await assert.rejects(readBrandRules(join(brain,BRAND_KIT_RELATIVE_PATH)),/brand_kit_unavailable/);
 });
});

/*
 * Lane F2 / review finding R5, the two counterexamples Lane R2 left open. The cases above
 * cover static configurations and static links; these two cover the root itself and the
 * replacement race, which are the ones that still permitted a read outside the brain.
 */
test('R5 regression: a linked brain root, a linked ancestor of it, and an untrusted owner are all refused', async () => {
 const directory=await scratch('atlas-asset-rootlink-');
 // Counterexample 1: the brain root itself is a link out. The previous implementation
 // resolved the root and then started its component walk from the resolved location, so
 // every child of the outside directory passed the checks against that location.
 const outside=join(directory,'outside');
 await mkdir(join(outside,'content','playbooks'),{recursive:true});
 await writeFile(join(outside,'content','playbooks','escalation.md'),'# Escalation ladder\n\nContent outside the brain that must never be reachable through a linked brain root.');
 const linkedRoot=join(directory,'linked-brain');
 await symlink(outside,linkedRoot);
 const roots=[{key:'playbooks',path:join(linkedRoot,'content','playbooks'),kind:'shared' as const,label:'fixture'}];
 const found=await withBrain(linkedRoot,()=>searchTaskAssets(roots,OWN,terms('escalation ladder')));
 assert.deepEqual(found.candidates,[]);
 assert.ok(found.skipped.some(s=>s.reason==='asset_brain_root_symlink_refused'),JSON.stringify(found.skipped));
 await withBrain(linkedRoot,async()=>{
  await assert.rejects(readReleasedAsset(roots,{id:'asset:playbooks:escalation.md',contentHash:'0'.repeat(64),clientDirectory:null},OWN),/asset_brain_root_symlink_refused/);
  // The brand kit takes the same trusted root, and it is the one read with no released
  // digest behind it, so its own refusal is asserted rather than assumed.
  await assert.rejects(readBrandRules(join(linkedRoot,BRAND_KIT_RELATIVE_PATH)),/brand_kit_brain_untrusted/);
 });
 // The root is an ordinary directory but an ancestor of it is the link. lstat of the root
 // sees a directory, so only requiring the resolved root to equal the canonical one catches
 // this; using the resolved value as the base does not.
 const realParent=join(directory,'real-parent');
 await mkdir(join(realParent,'brain-root','content'),{recursive:true});
 const linkedParent=join(directory,'linked-parent');
 await symlink(realParent,linkedParent);
 await withBrain(join(linkedParent,'brain-root'),async()=>{
  await assert.rejects(containedPath(join(linkedParent,'brain-root','content')),/asset_brain_not_canonical/);
 });
 // Ownership is part of the trust decision, not only link type: a component another account
 // can rename can redirect everything beneath it. /private/tmp resolves to itself and is a
 // directory, and is still refused because it is not this user's.
 await withBrain('/private/tmp',async()=>{
  await assert.rejects(containedPath(join('/private/tmp','anything.md')),/asset_brain_owner_unexpected/);
 });
 // A brain root reached through a relative or unresolved path is refused outright.
 await withBrain(join(directory,'absent-brain'),async()=>{
  await assert.rejects(containedPath(join(directory,'absent-brain','x.md')),/asset_brain_absent/);
 });
});

test('R5 regression: an ancestor swapped for a symlink after validation and before open refuses the read', async () => {
 const directory=await scratch('atlas-asset-race-');
 const brain=join(directory,'brain-root');
 await mkdir(join(brain,'content','playbooks'),{recursive:true});
 const target=join(brain,'content','playbooks','escalation.md');
 await writeFile(target,'# Escalation ladder\n\nThe genuine in-brain escalation ladder for the coach role.');
 const outside=join(directory,'outside');
 await mkdir(join(outside,'playbooks'),{recursive:true});
 await writeFile(join(outside,'playbooks','escalation.md'),'# Escalation ladder\n\nOUTSIDE-THE-BRAIN content that must never be returned by a redirected read.');
 const content=join(brain,'content'),stashed=join(directory,'content-stashed');
 const swap=async()=>{await rename(content,stashed);await symlink(outside,content)};
 const restore=async()=>{await rm(content,{force:true});await rename(stashed,content)};

 // First prove the fixture is a real escape rather than a theoretical one: with content/
 // swapped, an ordinary read of the same in-brain pathname returns the outside bytes. That
 // is what the leaf open did once an ancestor had been replaced after validation.
 await swap();
 assert.match(await readFile(target,'utf8'),/OUTSIDE-THE-BRAIN/);
 await restore();

 // Now the same swap, performed deterministically at the worst instant: immediately after
 // content/ has been validated and opened, and before the components below it are opened.
 // No sleeps and no racing — the traversal hook yields at exactly that point.
 for(const putBack of [false,true]){
  let swapped=false;
  __setBoundaryTraversalHookForTests(async ({path,index,segments})=>{
   if(path===content&&!swapped){swapped=true;await swap();return}
   // The harder variant: the ancestor is put back after the redirected leaf is open, so
   // the post-open revalidation sees a clean, link-free path. The pinned descriptors are
   // what give it away — the inode it handed us is not the one the clean path yields.
   if(putBack&&swapped&&index===segments.length-1)await restore();
  });
  try{
   const outcome=await withBrain(brain,()=>readContainedFile(target,ASSET_LIMITS.maxFileBytes)).then(r=>r,(e:Error)=>e);
   assert.ok(swapped,'the hook never fired, so the swap was not exercised');
   assert.ok(outcome instanceof Error,'the redirected read returned bytes instead of refusing');
   assert.match(outcome.message,putBack?/asset_ancestor_replaced_refused/:/asset_symlink_ancestor_refused/,`putBack=${putBack}: ${outcome.message}`);
  }finally{
   __setBoundaryTraversalHookForTests(null);
   if(!putBack)await restore();
  }
 }

 // Undisturbed, the same read succeeds and returns the in-brain bytes, so the two refusals
 // above are caused by the swap and not by the fixture being unreadable.
 const ok=await withBrain(brain,()=>readContainedFile(target,ASSET_LIMITS.maxFileBytes));
 assert.match(ok.bytes.toString('utf8'),/genuine in-brain/);
 assert.doesNotMatch(ok.bytes.toString('utf8'),/OUTSIDE-THE-BRAIN/);
 assert.equal(ok.real,target);
 assert.equal(ok.realRoot,brain);
});
