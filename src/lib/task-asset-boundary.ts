/**
 * The filesystem boundary for every asset and brand read on the drafting path.
 *
 * One module owns the canonical brain root so there is a single place to review. Three
 * arrangements have been refused here in turn, and the history matters because each looked
 * sufficient:
 *
 *  1. The root came from the runtime configuration and containment was measured against the
 *     realpath of *that* root, which is circular: a configured root anywhere on the disk
 *     legitimised itself.
 *  2. The root became a constant and every component below it was lstat-ed, but the root
 *     itself was resolved with `realpath` and the resolved location was then used as the base
 *     for the walk. A symlink *at* the brain root, or above it, therefore still relocated the
 *     whole boundary: children of the outside directory passed every check against it.
 *  3. Containment was decided by a sequence of lstats and the bytes were then taken from a
 *     fresh `open` of the same pathname. `O_NOFOLLOW` protects the final component only, so
 *     an ancestor replaced with a symlink between the last check and the open redirected the
 *     descriptor outside the brain, and `handle.stat()` reported type and size without
 *     saying anything about where the descriptor came from.
 *
 * What is here now. `trustedBrainRoot()` establishes a trusted anchor before any traversal:
 * the root must resolve to *itself*, must not be a link, and every ancestor from `/` down
 * must be a non-link directory owned by root or by the brain's own owner — a component some
 * other account can rename is a component that can redirect everything beneath it.
 * `openBeneathTrustedRoot()` then walks down from an open descriptor on that root, opening
 * one component at a time `O_NOFOLLOW`, holding every handle, and requiring each descriptor
 * to be the object the pre-open `lstat` saw. Because an open descriptor is pinned to its
 * inode, re-resolving the whole chain afterwards and requiring every clean, link-free
 * resolution to land on exactly those pinned inodes is what proves the leaf descriptor is
 * reachable only through in-brain directories. Bytes are then read from that descriptor.
 *
 * No network, no write, no shell, no process-global state.
 */
import {constants as FS} from 'node:fs';
import type {Stats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {open,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';

/** The production brain. Content outside it is not retrievable by any configuration. */
export const PRODUCTION_BRAIN_ROOT='/Users/atlasai/atlas-brain';
/** The permitted brand kit, relative to the brain root. Not a configurable search path. */
export const BRAND_KIT_RELATIVE_PATH='brain/UNDENIABLE_BRAND_KIT.md';

type Injection={brainRoot:string;brandKit:string};
let injected:Injection|null=null;

/**
 * Test-only injection of a synthetic fixture brain.
 *
 * Deliberately a direct function call from a test module, never a configuration field,
 * packet value or environment variable: the reviewed `ATLAS_TASK_DOCUMENT_CONFIG` has no
 * way to reach it, so a production configuration cannot move the boundary. A fixture that
 * wants synthetic content imports this and says so; production code never calls it.
 *
 * An injected root is held to the same trust rules as the production constant, so a fixture
 * must be a real, self-resolving directory the test user owns. That is deliberate: a test
 * that could skip the root checks would not be exercising the boundary.
 */
export function __injectAssetBoundaryForTests(value:{brainRoot:string;brandKit?:string}|null){
 if(value===null){injected=null;return}
 if(!isAbsolute(value.brainRoot))throw Error('asset_brain_path_required');
 const brainRoot=resolve(value.brainRoot);
 const brandKit=value.brandKit?resolve(value.brandKit):join(brainRoot,BRAND_KIT_RELATIVE_PATH);
 if(!isAbsolute(brandKit))throw Error('brand_kit_path_required');
 injected={brainRoot,brandKit};
}

/**
 * Test-only traversal hook, awaited after each component of a walk has been opened and
 * verified. It cannot change a decision — the only thing it can do is yield, which is
 * exactly what a regression test needs in order to replace an ancestor at a chosen instant
 * instead of racing the implementation and hoping. Like the fixture injection it is a direct
 * call from a test module: no configuration field, packet value or environment variable
 * reaches it, and production code never sets it.
 */
export type BoundaryTraversalEvent={index:number;path:string;segments:readonly string[]};
let traversalHook:((event:BoundaryTraversalEvent)=>void|Promise<void>)|null=null;
export function __setBoundaryTraversalHookForTests(hook:typeof traversalHook){traversalHook=hook}

/**
 * The second, narrower injection: a fixture root for the *built* app, which runs in its own
 * process and cannot be reached by a direct function call.
 *
 * It is honoured only while live generation is switched off. The live Claude adapter
 * requires `ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION === 'reviewed'`, so the two are
 * mutually exclusive by construction: no dispatch that can reach the provider can also be
 * reading content from outside the canonical brain. It is a separate variable from
 * ATLAS_TASK_DOCUMENT_CONFIG for the same reason — the reviewed, hash-bound configuration
 * must not carry a field that moves the boundary.
 */
function envFixtureRoot(){
 const root=process.env.ATLAS_ASSET_BRAIN_TEST_ROOT;
 if(!root||!isAbsolute(root))return null;
 if(process.env.ATLAS_TASK_DOCUMENT_ALLOW_LIVE_GENERATION==='reviewed')return null;
 return resolve(root);
}

/** The brain root in force. The constant unless a test module injected a fixture root. */
export function brainRoot(){return injected?.brainRoot??envFixtureRoot()??PRODUCTION_BRAIN_ROOT}
/** The brand kit in force. Pinned beneath the brain root unless a fixture overrode it. */
export function brandKitPath(){return injected?.brandKit??join(brainRoot(),BRAND_KIT_RELATIVE_PATH)}

/**
 * Assert that a configured brain root is the canonical one. The configuration field is
 * kept — it must keep matching, and a mismatch is a loud refusal rather than a silent
 * relocation — but it selects nothing.
 */
export function assertCanonicalBrain(configured:unknown){
 if(typeof configured!=='string'||!configured.trim())throw Error('asset_brain_path_required');
 if(resolve(configured)!==brainRoot())throw Error('asset_brain_not_canonical');
 return brainRoot();
}

/** Assert that a configured brand kit path is the permitted one beneath the brain. */
export function assertPermittedBrandKit(configured:unknown){
 // A relative path keeps its own refusal: it is a configuration mistake rather than an
 // attempt to read outside the brain, and the two are worth telling apart.
 if(typeof configured!=='string'||!configured.trim()||!isAbsolute(configured))throw Error('brand_kit_path_required');
 if(resolve(configured)!==brandKitPath())throw Error('brand_kit_outside_brain');
 return brandKitPath();
}

export type TrustedRoot={root:string;dev:number;ino:number;uid:number};

/** A component above the brain may be owned by root or by the brain's own owner, nobody else. */
function ownerTrusted(uid:number,expected:number){return uid===0||uid===expected}

/**
 * Establish the trusted canonical root, from `/` down, before anything below it is touched.
 *
 * Resolution is a *check*, not a relocation: the root must resolve to itself. Resolving the
 * root and then walking from the resolved location is the defect this replaces — it accepted
 * a linked brain root and then measured every child against the outside directory the link
 * pointed at, so children there passed. Every ancestor is lstat-ed as well, because a
 * symlink-free root path says nothing about who is able to replace a directory above it.
 */
export async function trustedBrainRoot():Promise<TrustedRoot>{
 const root=brainRoot();
 if(!isAbsolute(root)||resolve(root)!==root)throw Error('asset_brain_path_required');
 const self=await lstat(root).catch(()=>null);
 if(!self)throw Error('asset_brain_absent');
 if(self.isSymbolicLink())throw Error('asset_brain_root_symlink_refused');
 if(!self.isDirectory())throw Error('asset_brain_not_directory');
 // The resolved root must *equal* the canonical root in force. This is what refuses a brain
 // root, or any ancestor of it, that is a link to somewhere else.
 const resolved=await realpath(root).catch(()=>null);
 if(!resolved)throw Error('asset_brain_absent');
 if(resolved!==root)throw Error('asset_brain_not_canonical');
 const expected=self.uid;
 const me=typeof process.getuid==='function'?process.getuid():null;
 if(me!==null&&expected!==me)throw Error('asset_brain_owner_unexpected');
 const parts=root.split(sep).filter(Boolean);
 const ancestors:string[]=[sep];
 for(let i=0;i<parts.length-1;i++)ancestors.push(sep+parts.slice(0,i+1).join(sep));
 for(const ancestor of ancestors){
  const st=await lstat(ancestor).catch(()=>null);
  if(!st)throw Error('asset_brain_ancestor_absent');
  if(st.isSymbolicLink())throw Error('asset_brain_ancestor_symlink_refused');
  if(!st.isDirectory())throw Error('asset_brain_ancestor_not_directory');
  if(!ownerTrusted(st.uid,expected))throw Error('asset_brain_ancestor_untrusted_owner');
 }
 return {root,dev:self.dev,ino:self.ino,uid:expected};
}

type Level={path:string;dev:number;ino:number;directory:boolean};
type Opened={trusted:TrustedRoot;absolute:string;levels:Level[];leaf:FileHandle;leafStat:Stats;release:()=>Promise<void>};

/**
 * Open `target` by walking down from a descriptor on the trusted root, one component at a
 * time, and prove the resulting descriptor is beneath that root.
 *
 * Node has no `openat`, so the proof is built from inode identity rather than from a dirfd:
 *
 *  - Each component is lstat-ed, refused if it is a link, then opened `O_NOFOLLOW`, and the
 *    descriptor's `dev`/`ino` must equal what that lstat saw. That closes the per-component
 *    window between judging a name safe and opening it.
 *  - Every handle stays open for the whole walk. A descriptor is bound to its inode for life,
 *    so the chain of handles is a chain of pinned objects that cannot be re-pointed.
 *  - The whole chain is then re-resolved from the trusted root and every level must still be
 *    a non-link whose `dev`/`ino` equals the pinned value. An ancestor swapped for a symlink
 *    mid-walk is caught either as a link that is still there, or — if it has been put back —
 *    as a level whose pinned inode is no longer the one the clean path yields, since the
 *    outside directory it handed us cannot also be the in-brain one. Directory hard links do
 *    not exist, so no third possibility reconciles the two.
 *
 * The caller must `release()`.
 */
async function openBeneathTrustedRoot(target:string):Promise<Opened>{
 const trusted=await trustedBrainRoot();
 const absolute=resolve(target);
 if(absolute!==trusted.root&&!absolute.startsWith(trusted.root+sep))throw Error('asset_outside_brain');
 const segments=relative(trusted.root,absolute).split(sep).filter(Boolean);
 for(const segment of segments)if(segment==='.'||segment==='..')throw Error('asset_outside_brain');
 const handles:FileHandle[]=[];
 const release=async()=>{for(const handle of [...handles].reverse())await handle.close().catch(()=>{})};
 try{
  const rootHandle=await open(trusted.root,FS.O_RDONLY|FS.O_DIRECTORY|FS.O_NOFOLLOW).catch(()=>null);
  if(!rootHandle)throw Error('asset_brain_unopenable');
  handles.push(rootHandle);
  const rootStat=await rootHandle.stat();
  if(rootStat.dev!==trusted.dev||rootStat.ino!==trusted.ino)throw Error('asset_brain_root_replaced');
  const levels:Level[]=[{path:trusted.root,dev:rootStat.dev,ino:rootStat.ino,directory:true}];
  let prefix=trusted.root;
  for(let index=0;index<segments.length;index++){
   prefix=join(prefix,segments[index]);
   const last=index===segments.length-1;
   const before=await lstat(prefix).catch(()=>null);
   if(!before)throw Error('asset_path_absent');
   if(before.isSymbolicLink())throw Error('asset_symlink_ancestor_refused');
   if(!before.isDirectory()&&!last)throw Error('asset_path_not_directory');
   // Anything that is neither a directory nor a regular file is refused before it is
   // opened, so no fifo or device on the path can block the open itself.
   if(!before.isDirectory()&&!before.isFile())throw Error('asset_unreadable_or_oversize');
   const flags=FS.O_RDONLY|FS.O_NOFOLLOW|(before.isDirectory()?FS.O_DIRECTORY:0);
   const handle=await open(prefix,flags).catch((e:NodeJS.ErrnoException)=>e);
   if(handle instanceof Error)throw Error(handle.code==='ELOOP'?'asset_symlink_ancestor_refused':handle.code==='ENOTDIR'?'asset_path_not_directory':'asset_unreadable_or_oversize');
   handles.push(handle);
   const opened=await handle.stat();
   if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('asset_path_replaced_during_open');
   levels.push({path:prefix,dev:opened.dev,ino:opened.ino,directory:opened.isDirectory()});
   if(traversalHook)await traversalHook({index,path:prefix,segments});
  }
  for(const level of levels){
   const after=await lstat(level.path).catch(()=>null);
   if(!after)throw Error('asset_path_absent');
   if(after.isSymbolicLink())throw Error('asset_symlink_ancestor_refused');
   if(after.dev!==level.dev||after.ino!==level.ino)throw Error('asset_ancestor_replaced_refused');
   if(after.isDirectory()!==level.directory)throw Error('asset_ancestor_replaced_refused');
  }
  const leaf=handles[handles.length-1];
  return {trusted,absolute,levels,leaf,leafStat:await leaf.stat(),release};
 }catch(e){await release();throw e}
}

/**
 * Verify that `target` lies beneath the trusted brain root, reachable only through in-brain
 * non-link directories, and return the resolved pair.
 *
 * `real` is the target's own absolute path: the walk proves no component is a link, so the
 * canonical path and the given path are the same string, and `realpath` is not consulted for
 * the answer. Callers that compare `real` against `realRoot` keep their meaning.
 */
export async function containedPath(target:string){
 const opened=await openBeneathTrustedRoot(target);
 try{return {real:opened.absolute,realRoot:opened.trusted.root,absolute:opened.absolute}}
 finally{await opened.release()}
}

/**
 * Read a contained file from the descriptor the containment walk opened and proved.
 *
 * What the descriptor proves, exactly: it is the object that a link-free resolution from the
 * trusted canonical root arrived at, verified both before it was opened and again after the
 * whole chain was open and pinned. It does not prove that the file's bytes are unchanged
 * since release — `readReleasedAsset` compares the content hash for that — and it does not
 * prove anything about a brain whose own owner moves content inside it. What it does close
 * is redirection: the size and the bytes come from that one pinned descriptor, so no change
 * to any name on the path after the walk can substitute a different object.
 */
export async function readContainedFile(target:string,maxBytes:number){
 const opened=await openBeneathTrustedRoot(target);
 try{
  if(!opened.leafStat.isFile())throw Error('asset_unreadable_or_oversize');
  if(opened.leafStat.size>maxBytes)throw Error('asset_over_size_bound');
  const bytes=await opened.leaf.readFile();
  if(bytes.byteLength>maxBytes)throw Error('asset_over_size_bound');
  return {bytes,size:opened.leafStat.size,real:opened.absolute,realRoot:opened.trusted.root,absolute:opened.absolute};
 }finally{await opened.release()}
}
