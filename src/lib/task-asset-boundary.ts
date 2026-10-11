/**
 * The filesystem boundary for every asset and brand read on the drafting path.
 *
 * One module owns the canonical brain root so there is a single place to review. Four
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
 *     descriptor outside the brain.
 *  4. Every component was opened `O_NOFOLLOW`, its descriptor pinned, and the whole chain was
 *     then re-resolved by pathname and required to land on the pinned inodes. Review finding
 *     R5 (Lane R3) showed that this is still a sequence of separate pathname observations:
 *     an ancestor swapped for a symlink *during* that second walk, after its own level has
 *     passed, makes the later lstats follow the link, see the outside objects the first walk
 *     had already pinned, and agree with them. Repeated pathname checks cannot close that;
 *     Node has no `openat`.
 *
 * What is here now, and exactly what each part proves.
 *
 * A. Exclusive mutation of the chain, VERIFIED rather than assumed (review option 2). The
 *    root, every ancestor of it from `/` down, every component below it and the leaf must be
 *    owned by the running user or by root, must carry no group or other write bit, and must
 *    carry no ACL entry that allows a mutating permission (write, append, delete,
 *    delete_child, add_file, add_subdirectory, writeattr, writeextattr, writesecurity, chown)
 *    to any principal. Ownership and mode bits are read from the pinned descriptors where one
 *    exists and from `lstat` for the ancestors above the root; ACL entries are read from the
 *    macOS listing, `/bin/ls -led`, one bounded process per walk, no shell, fixed argv. The
 *    security argument this establishes is precise: renaming, replacing or linking a chain
 *    component requires write permission on its parent directory, and after this check only
 *    a process running as this user, or as root, holds that permission anywhere on the chain.
 *    A process running as this user already has full control of the runtime (its
 *    configuration, its code, its key files), so an ordering attack by that principal is not
 *    a privilege gain; a process running as any other user cannot mutate the chain at all.
 *    Changing the ownership, mode or ACL of a component is itself a mutation only the owner
 *    or root can perform, so a chain that passes this check at one instant stays exclusively
 *    mutable by trusted principals until a trusted principal changes that.
 *
 * B. Mechanical detection of ANY mutation of the chain during the walk, from the root down,
 *    independent of who performed it. Every directory on the chain, the root included, is
 *    held open from the moment it is opened until the leaf descriptor is returned, and its
 *    change time and modification time are read through that descriptor (`fstat`, never a
 *    pathname) when it is opened and again immediately before the leaf is returned. Renaming,
 *    creating, unlinking or linking an entry in a directory updates that directory's times
 *    in the kernel, and no unprivileged call can set a change time backwards, so equal times
 *    mean that no entry of any pinned directory changed in the window. The induction is: the
 *    root descriptor is the trusted root (its inode matches the pre-walk check); each
 *    component was looked up in its parent while that parent was pinned and unchanged, and
 *    its descriptor's inode equals what the pre-open `lstat` saw; therefore every pinned
 *    descriptor is the object reached by a link-free lookup through pinned, unchanged
 *    in-brain directories, and the leaf is beneath the root. This is what closes R3's
 *    schedule: the swap it performs during the second walk modifies the brain root
 *    directory, and the root's own descriptor reports that before any byte is returned.
 *    Above the root, directories are not pinned this way — a home directory's change time
 *    moves whenever the user's own processes create or remove an entry in it — and that is
 *    where argument A carries the weight: only the running user or root can rename the root
 *    or any ancestor of it.
 *
 * The pathname revalidation from arrangement 4 is kept as a cheap first check; it is no longer
 * the containment proof. Bytes are read from the pinned leaf descriptor only.
 *
 * No network, no write, no shell, no process-global state.
 */
import {constants as FS} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {open,lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
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
 * Test-only traversal hook, awaited after each component of the first walk has been opened
 * and verified (`phase:'open'`) and after each level of the pathname revalidation has passed
 * (`phase:'revalidate'`). It cannot change a decision — the only thing it can do is yield,
 * which is exactly what a regression test needs in order to replace an ancestor at a chosen
 * instant instead of racing the implementation and hoping. Like the fixture injection it is a
 * direct call from a test module: no configuration field, packet value or environment
 * variable reaches it, and production code never sets it.
 */
export type BoundaryTraversalEvent={phase:'open'|'revalidate';index:number;path:string;segments:readonly string[]};
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

export type TrustedRoot={root:string;dev:bigint;ino:bigint;uid:number;ancestors:readonly string[]};

/** A component of the chain may be owned by root or by the brain's own owner, nobody else. */
function ownerTrusted(uid:number,expected:number){return uid===0||uid===expected}
/** Group and other write bits. A component that another account can write is one it can rename. */
const OTHER_WRITE_BITS=0o022;
function writableByOthers(mode:number){return (mode&OTHER_WRITE_BITS)!==0}

/**
 * Establish the trusted canonical root, from `/` down, before anything below it is touched.
 *
 * Resolution is a *check*, not a relocation: the root must resolve to itself. Resolving the
 * root and then walking from the resolved location is the defect this replaces — it accepted
 * a linked brain root and then measured every child against the outside directory the link
 * pointed at, so children there passed. Every ancestor is lstat-ed as well, because a
 * symlink-free root path says nothing about who is able to replace a directory above it:
 * each must be a non-link directory owned by root or by the brain's owner, with no group or
 * other write bit. The ACL listing for the same chain is taken by the walk, once, together
 * with the components below the root.
 */
export async function trustedBrainRoot():Promise<TrustedRoot>{
 const root=brainRoot();
 if(!isAbsolute(root)||resolve(root)!==root)throw Error('asset_brain_path_required');
 const self=await lstat(root,{bigint:true}).catch(()=>null);
 if(!self)throw Error('asset_brain_absent');
 if(self.isSymbolicLink())throw Error('asset_brain_root_symlink_refused');
 if(!self.isDirectory())throw Error('asset_brain_not_directory');
 // The resolved root must *equal* the canonical root in force. This is what refuses a brain
 // root, or any ancestor of it, that is a link to somewhere else.
 const resolved=await realpath(root).catch(()=>null);
 if(!resolved)throw Error('asset_brain_absent');
 if(resolved!==root)throw Error('asset_brain_not_canonical');
 const expected=Number(self.uid);
 const me=typeof process.getuid==='function'?process.getuid():null;
 if(me!==null&&expected!==me)throw Error('asset_brain_owner_unexpected');
 if(writableByOthers(Number(self.mode)))throw Error('asset_brain_writable_by_others');
 const parts=root.split(sep).filter(Boolean);
 const ancestors:string[]=[sep];
 for(let i=0;i<parts.length-1;i++)ancestors.push(sep+parts.slice(0,i+1).join(sep));
 for(const ancestor of ancestors){
  const st=await lstat(ancestor,{bigint:true}).catch(()=>null);
  if(!st)throw Error('asset_brain_ancestor_absent');
  if(st.isSymbolicLink())throw Error('asset_brain_ancestor_symlink_refused');
  if(!st.isDirectory())throw Error('asset_brain_ancestor_not_directory');
  if(!ownerTrusted(Number(st.uid),expected))throw Error('asset_brain_ancestor_untrusted_owner');
  if(writableByOthers(Number(st.mode)))throw Error('asset_brain_ancestor_writable_by_others');
 }
 return {root,dev:self.dev,ino:self.ino,uid:expected,ancestors};
}

/**
 * ACL permissions that let a principal change a directory's entries, a file's bytes or the
 * object's own security. `write` on a directory is listed by macOS as `add_file`, and
 * `delete_child` is the directory-side form of `delete`; all of them are refused.
 */
const MUTATING_ACL_PERMISSIONS=new Set(['write','append','delete','delete_child','add_file','add_subdirectory','writeattr','writeextattr','writesecurity','chown']);
const ACL_LISTING_TIMEOUT_MS=5000;
const ACL_LISTING_MAX_BYTES=1<<20;

/**
 * Read the macOS ACL listing for every path on the chain in one bounded process, and refuse
 * if any entry allows a mutating permission to any principal.
 *
 * `/bin/ls -led` is the system's own ACL listing: fixed binary, fixed argv, no shell, stdin
 * closed, output bounded, timeout. The listing is read by pathname, so it is part of argument
 * A (who *could* mutate the chain), not of argument B; the change-time check that follows it
 * is what catches a mutation performed while it ran. Every requested path must appear exactly
 * once in the output and must be a directory or a regular file, or the walk refuses.
 */
async function assertNoMutatingAclOnChain(paths:readonly string[]){
 const listing=await new Promise<string>((done,fail)=>{
  const child=execFile('/bin/ls',['-led','--',...paths],{timeout:ACL_LISTING_TIMEOUT_MS,maxBuffer:ACL_LISTING_MAX_BYTES,env:{LC_ALL:'C'} as unknown as NodeJS.ProcessEnv},(error:Error|null,stdout:string|Buffer)=>error?fail(error):done(String(stdout)));
  child.stdin?.end();
 }).catch(()=>null);
 if(listing===null)throw Error('asset_chain_acl_unreadable');
 const byLength=[...paths].sort((a,b)=>b.length-a.length);
 const seen=new Set<string>();
 let current:string|null=null;
 for(const line of listing.split('\n')){
  if(!line.trim())continue;
  const entry=/^\s*\d+:\s+(\S+)\s+(allow|deny)\s+(\S+)\s*$/.exec(line);
  if(entry){
   if(current===null)throw Error('asset_chain_acl_unreadable');
   if(entry[2]==='allow'&&entry[3].split(',').some(p=>MUTATING_ACL_PERMISSIONS.has(p)))throw Error('asset_chain_acl_grants_mutation');
   continue;
  }
  // A symlink is listed as `path -> target`; it is refused, never followed.
  const path=byLength.find(p=>line.endsWith(' '+p)||line.includes(' '+p+' -> '));
  if(!path||seen.has(path))throw Error('asset_chain_acl_unreadable');
  if(line[0]==='l')throw Error('asset_symlink_ancestor_refused');
  if(line[0]!=='d'&&line[0]!=='-')throw Error('asset_unreadable_or_oversize');
  seen.add(path);current=path;
 }
 if(seen.size!==paths.length)throw Error('asset_chain_acl_unreadable');
}

type Pinned={mtimeNs:bigint;ctimeNs:bigint};
type Level={path:string;dev:bigint;ino:bigint;directory:boolean;handle:FileHandle;pinned:Pinned|null};
type Opened={trusted:TrustedRoot;absolute:string;levels:Level[];leaf:FileHandle;leafStat:BigIntStats;release:()=>Promise<void>};

const pin=(st:BigIntStats):Pinned=>({mtimeNs:st.mtimeNs,ctimeNs:st.ctimeNs});

/**
 * Open `target` by walking down from a descriptor on the trusted root, one component at a
 * time, and prove the resulting descriptor is beneath that root. See the module comment for
 * the two arguments, A and B, that this function carries out; in order:
 *
 *  1. Each component is lstat-ed, refused if it is a link, opened `O_NOFOLLOW`, and the
 *     descriptor's `dev`/`ino` must equal what that lstat saw. The descriptor's owner must be
 *     the brain's owner or root and its mode must carry no group or other write bit (A).
 *     Every handle stays open, and every directory's change and modification times are
 *     pinned through its own descriptor the moment it is opened (B).
 *  2. The chain is re-resolved by pathname and every level must still be a non-link with the
 *     pinned `dev`/`ino`. This is the cheap check from the previous arrangement; it refuses
 *     the simple schedules early and proves nothing by itself.
 *  3. The ACL listing for the ancestors, the root, every component and the leaf is read, once,
 *     and refused if any entry allows a mutating permission (A).
 *  4. Every pinned directory's times are read again through its descriptor, before the ACL
 *     listing and once more immediately before the leaf is returned, and must equal the
 *     pinned values (B). Any rename, link, creation or unlink inside any chain directory
 *     during steps 1–3, by any principal, refuses the read here.
 *
 * The caller must `release()`.
 */
async function openBeneathTrustedRoot(target:string):Promise<Opened>{
 const trusted=await trustedBrainRoot();
 const absolute=resolve(target);
 if(absolute!==trusted.root&&!absolute.startsWith(trusted.root+sep))throw Error('asset_outside_brain');
 const segments=relative(trusted.root,absolute).split(sep).filter(Boolean);
 for(const segment of segments){
  if(segment==='.'||segment==='..')throw Error('asset_outside_brain');
  // Control characters would make the ACL listing ambiguous; the brain's owner never needs them.
  if(/[\u0000-\u001f\u007f]/.test(segment))throw Error('asset_path_component_invalid');
 }
 const handles:FileHandle[]=[];
 const release=async()=>{for(const handle of [...handles].reverse())await handle.close().catch(()=>{})};
 try{
  const rootHandle=await open(trusted.root,FS.O_RDONLY|FS.O_DIRECTORY|FS.O_NOFOLLOW).catch(()=>null);
  if(!rootHandle)throw Error('asset_brain_unopenable');
  handles.push(rootHandle);
  const rootStat=await rootHandle.stat({bigint:true});
  if(rootStat.dev!==trusted.dev||rootStat.ino!==trusted.ino)throw Error('asset_brain_root_replaced');
  if(Number(rootStat.uid)!==trusted.uid)throw Error('asset_brain_owner_unexpected');
  if(writableByOthers(Number(rootStat.mode)))throw Error('asset_brain_writable_by_others');
  const levels:Level[]=[{path:trusted.root,dev:rootStat.dev,ino:rootStat.ino,directory:true,handle:rootHandle,pinned:pin(rootStat)}];
  let prefix=trusted.root;
  for(let index=0;index<segments.length;index++){
   prefix=join(prefix,segments[index]);
   const last=index===segments.length-1;
   const before=await lstat(prefix,{bigint:true}).catch(()=>null);
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
   const opened=await handle.stat({bigint:true});
   if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('asset_path_replaced_during_open');
   if(!ownerTrusted(Number(opened.uid),trusted.uid))throw Error('asset_chain_untrusted_owner');
   if(writableByOthers(Number(opened.mode)))throw Error('asset_chain_writable_by_others');
   levels.push({path:prefix,dev:opened.dev,ino:opened.ino,directory:opened.isDirectory(),handle,pinned:opened.isDirectory()?pin(opened):null});
   if(traversalHook)await traversalHook({phase:'open',index,path:prefix,segments});
  }
  for(let index=0;index<levels.length;index++){
   const level=levels[index];
   const after=await lstat(level.path,{bigint:true}).catch(()=>null);
   if(!after)throw Error('asset_path_absent');
   if(after.isSymbolicLink())throw Error('asset_symlink_ancestor_refused');
   if(after.dev!==level.dev||after.ino!==level.ino)throw Error('asset_ancestor_replaced_refused');
   if(after.isDirectory()!==level.directory)throw Error('asset_ancestor_replaced_refused');
   if(traversalHook)await traversalHook({phase:'revalidate',index:index-1,path:level.path,segments});
  }
  // Argument B: no entry of any pinned directory may have changed since it was pinned. This
  // is a descriptor read, not a pathname lookup, so no swap can hide from it. It runs before
  // the ACL listing, so a mutation during steps 1-2 is reported as what it is rather than as
  // an unreadable listing, and again after it, so a mutation during the listing is caught too.
  const unchangedSincePinned=async()=>{
   for(const level of levels){
    if(!level.pinned)continue;
    const now=await level.handle.stat({bigint:true});
    if(now.ctimeNs!==level.pinned.ctimeNs||now.mtimeNs!==level.pinned.mtimeNs)throw Error('asset_chain_mutated_during_walk');
   }
  };
  await unchangedSincePinned();
  await assertNoMutatingAclOnChain([...trusted.ancestors,...levels.map(l=>l.path)]);
  await unchangedSincePinned();
  const leaf=handles[handles.length-1];
  return {trusted,absolute,levels,leaf,leafStat:await leaf.stat({bigint:true}),release};
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
 * What the descriptor proves, exactly: it is the object reached by a link-free lookup through
 * pinned in-brain directories none of which changed while the walk ran, on a chain that only
 * the running user or root can mutate. It does not prove that the file's bytes are unchanged
 * since release — `readReleasedAsset` compares the content hash for that — and it does not
 * prove anything about a brain whose own owner moves content inside it between two reads.
 * What it does close is redirection: the size and the bytes come from that one pinned
 * descriptor, so no change to any name on the path after the walk can substitute a different
 * object, and no change to any name on the path during the walk goes unnoticed.
 */
export async function readContainedFile(target:string,maxBytes:number){
 const opened=await openBeneathTrustedRoot(target);
 try{
  if(!opened.leafStat.isFile())throw Error('asset_unreadable_or_oversize');
  const size=Number(opened.leafStat.size);
  if(size>maxBytes)throw Error('asset_over_size_bound');
  const bytes=await opened.leaf.readFile();
  if(bytes.byteLength>maxBytes)throw Error('asset_over_size_bound');
  return {bytes,size,real:opened.absolute,realRoot:opened.trusted.root,absolute:opened.absolute};
 }finally{await opened.release()}
}
