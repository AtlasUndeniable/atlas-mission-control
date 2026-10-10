/**
 * The filesystem boundary for every asset and brand read on the drafting path.
 *
 * One module owns the canonical brain root so there is a single place to review. The
 * previous arrangement took the root from the runtime configuration and then checked
 * containment against the realpath of *that* root, which is circular: a configured root
 * anywhere on the disk legitimised itself. Three further gaps went with it — an ancestor
 * of a root could be a symlink out of the brain while an lstat of the final directory saw
 * an ordinary directory, a single-file root took an early branch with no containment check
 * at all, and separate lstat/realpath/readFile calls on the same name left a replacement
 * race between the check and the read.
 *
 * So: the root is a constant here, every ancestor of every resolved path is checked, and
 * bytes are read from the descriptor that was validated rather than from the name again.
 * No network, no write, no shell.
 */
import {constants as FS} from 'node:fs';
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

/**
 * Verify that `target` lies beneath the brain root with no symlinked ancestor, and return
 * the resolved pair.
 *
 * Checking only the leaf, or only the final directory of a root, is not enough: with
 * `atlas-brain/content` a symlink to somewhere else, `lstat('content/playbooks')` sees an
 * ordinary directory and `realpath('content/playbooks')` then reports a path that is
 * genuinely outside the brain as the root's own real location. Every component from the
 * brain root down is therefore lstat-ed and refused if it is a link.
 */
export async function containedPath(target:string){
 const root=brainRoot();
 const realRoot=await realpath(root).catch(()=>null);
 if(!realRoot)throw Error('asset_brain_absent');
 const absolute=resolve(target);
 if(absolute!==root&&!absolute.startsWith(root+sep))throw Error('asset_outside_brain');
 let walked=realRoot;
 for(const segment of relative(root,absolute).split(sep)){
  if(!segment)continue;
  if(segment==='.'||segment==='..')throw Error('asset_outside_brain');
  walked=join(walked,segment);
  const st=await lstat(walked).catch(()=>null);
  if(!st)throw Error('asset_path_absent');
  if(st.isSymbolicLink())throw Error('asset_symlink_ancestor_refused');
 }
 // The walk already refuses every link on the way down; this re-reads the kernel's own
 // answer so a path that became reachable some other way still has to be inside.
 const real=await realpath(absolute).catch(()=>null);
 if(!real||(real!==realRoot&&!real.startsWith(realRoot+sep)))throw Error('asset_outside_brain');
 return {real,realRoot,absolute};
}

/**
 * Read a contained file from a descriptor opened O_NOFOLLOW, and report the size from that
 * same descriptor. The containment decision and the bytes come from one open file rather
 * than from three separate resolutions of a name that can change between them.
 */
export async function readContainedFile(target:string,maxBytes:number){
 const contained=await containedPath(target);
 const handle=await open(target,FS.O_RDONLY|FS.O_NOFOLLOW).catch(()=>null);
 if(!handle)throw Error('asset_unreadable_or_oversize');
 try{
  const st=await handle.stat();
  if(!st.isFile())throw Error('asset_unreadable_or_oversize');
  if(st.size>maxBytes)throw Error('asset_over_size_bound');
  return {bytes:await handle.readFile(),size:st.size,...contained};
 }finally{await handle.close().catch(()=>{});}
}
