/**
 * Bounded read-only retrieval of existing Atlas assets for task-linked drafting.
 *
 * This module only ever produces *candidates*. It grants nothing. A candidate becomes
 * prompt content solely when an explicit release decision names its stable identifier
 * and its content hash still matches, so a changed file can never silently enter a draft.
 * No network, no write, no symlink traversal, no shell, no client inference.
 */
import {createHash} from 'node:crypto';
import {readdir,readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,extname,basename,sep} from 'node:path';

export const ASSET_SCHEME='asset';
/** Hard ceilings. Retrieval is a bounded scan, never an open crawl of the brain. */
export const ASSET_LIMITS={maxCandidates:8,maxScanFiles:4000,maxFileBytes:600_000,maxExcerptCharacters:6000,maxDepth:4,maxTermLength:40,maxTerms:40} as const;
const TEXT_EXTENSIONS=new Set(['.md','.txt','.html']);
/** Common words carry no retrieval signal and would flatten every score toward equal. */
const STOPWORDS=new Set('a an and are as at be by for from has have in into is it its of on or that the their this to was were will with you your we our i he she they them his her not no do does did can could should would about over under after before draft drafts task tasks client clients'.split(' '));

export type AssetRootKind='shared'|'client_scoped'|'excluded';
export type AssetRoot={
 /** Stable short key. It is part of every identifier, so it must never be renamed casually. */
 key:string;
 /** Absolute path to a directory or a single file. */
 path:string;
 kind:AssetRootKind;
 /** Human description of what the root holds; surfaced to reviewers, never to the model. */
 label:string;
};
export type AssetCandidate={
 /** `asset:<rootKey>:<relativePath>` — stable across runs and independent of rank. */
 id:string;
 rootKey:string;
 relativePath:string;
 /** Null for shared Atlas assets; the exact permitted directory for client-scoped ones. */
 clientDirectory:string|null;
 title:string;
 contentHash:string;
 bytes:number;
 score:number;
 /** Why this candidate ranked where it did. Review aid; not sent to the provider. */
 matchedTerms:string[];
};
export type AssetSearchResult={candidates:AssetCandidate[];scanned:number;skipped:{path:string;reason:string}[];truncated:boolean};
export type AssetScope={
 /** Exact canonical client of the task. Never used to guess a directory name. */
 client:string;
 /**
  * Exact permitted client-work directory names for this task's client, from the release
  * decision. Empty means no client-scoped asset is retrievable — the honest default,
  * because a client name does not reliably imply a directory name.
  */
 directories:string[];
};

const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

/**
 * The reviewed asset roots. `excluded` roots are enumerated deliberately rather than
 * omitted: naming them makes the boundary testable and makes a future release decision
 * an explicit edit here rather than an accidental widening somewhere else.
 */
export function atlasAssetRoots(brain:string):AssetRoot[]{
 const r=(p:string)=>resolve(brain,p);
 return [
  {key:'playbooks',path:r('content/playbooks'),kind:'shared',label:'Delivery playbooks'},
  {key:'frameworks',path:r('brain/frameworks.md'),kind:'shared',label:'Undeniable frameworks'},
  {key:'operating-manual',path:r('brain/business-operating-manual.md'),kind:'shared',label:'Business operating manual'},
  {key:'lead-magnets',path:r('brain/lead-magnets'),kind:'shared',label:'Lead magnets'},
  {key:'client-work',path:r('content/client-work'),kind:'client_scoped',label:'Per-client delivery work'},
  // Full-context client dossiers. Out of scope for drafting until separately released.
  {key:'client-archives',path:r('content/client-archives'),kind:'excluded',label:'Full client context archives'},
  // Raw call transcripts stay with the existing meeting/source path and its own permissions.
  {key:'calls',path:r('content/calls'),kind:'excluded',label:'Raw call transcripts'},
 ];
}

export function assetTerms(...parts:(string|null|undefined)[]){
 const seen=new Map<string,number>();
 for(const part of parts){
  for(const raw of String(part||'').toLowerCase().split(/[^a-z0-9]+/)){
   if(raw.length<3||raw.length>ASSET_LIMITS.maxTermLength||STOPWORDS.has(raw))continue;
   seen.set(raw,(seen.get(raw)||0)+1);
   if(seen.size>=ASSET_LIMITS.maxTerms)break;
  }
 }
 return [...seen.keys()];
}

/**
 * Plain-text projection. Markup is removed so source bytes cannot pose as document
 * structure, and link targets are dropped entirely: a draft may never carry a URL, so a
 * retrievable source should not offer one for the model to copy.
 */
export function assetPlainText(content:string,extension:string){
 const text=extension==='.html'
  ? content.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|#3[0-9];|#[0-9]{2,4});/g,' ')
  : content.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g,'$1').replace(/^\s{0,3}\[[^\]\n]+\]:\s*\S+\s*$/gm,'');
 return text.replace(/\r/g,'').replace(/<[^>\n]{1,200}>/g,' ').replace(/https?:\/\/\S+/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}

/** First heading or filename. Deliberately not model-generated. */
export function assetTitle(text:string,relativePath:string){
 const heading=text.split('\n').find(l=>/^#{1,3} \S/.test(l));
 const title=heading?heading.replace(/^#{1,3} /,'').trim():basename(relativePath,extname(relativePath)).replace(/[-_]+/g,' ');
 return title.slice(0,200);
}

/**
 * Lexical score over the task title, quote and client. Filename and headings weigh more
 * than body text: a file named for the subject is a stronger signal than one that merely
 * mentions it. Scores are integers so ordering is reproducible across platforms.
 */
export function assetScore(terms:string[],relativePath:string,title:string,text:string){
 const name=relativePath.toLowerCase(),head=title.toLowerCase(),body=text.toLowerCase();
 let score=0;const matched:string[]=[];
 for(const term of terms){
  const inName=name.includes(term),inTitle=head.includes(term);
  let occurrences=0,from=0;
  for(;;){const at=body.indexOf(term,from);if(at<0)break;occurrences++;from=at+term.length;if(occurrences>=20)break}
  if(!inName&&!inTitle&&!occurrences)continue;
  matched.push(term);
  // Repetition saturates fast. A source that says one task word twenty times is not a
  // better match than one that covers several facets of the task once each, and without
  // saturation the repeated word wins purely on volume.
  score+=(inName?40:0)+(inTitle?25:0)+(occurrences?8+Math.min(occurrences-1,6)*2:0);
 }
 // Breadth beats repetition: matching several distinct task terms is the better signal.
 return {score:matched.length>1?score+matched.length*15:score,matchedTerms:matched};
}

async function listFiles(root:AssetRoot,budget:{scanned:number},skipped:{path:string;reason:string}[]){
 const files:{absolute:string;relative:string}[]=[];
 const base=await lstat(root.path).catch(()=>null);
 if(!base){skipped.push({path:root.path,reason:'root_absent'});return files}
 if(base.isSymbolicLink()){skipped.push({path:root.path,reason:'root_symlink_refused'});return files}
 if(base.isFile()){files.push({absolute:root.path,relative:basename(root.path)});budget.scanned++;return files}
 const realRoot=await realpath(root.path);
 const walk=async(directory:string,depth:number):Promise<void>=>{
  if(depth>ASSET_LIMITS.maxDepth||budget.scanned>=ASSET_LIMITS.maxScanFiles)return;
  const entries=await readdir(directory,{withFileTypes:true}).catch(()=>null);
  if(!entries){skipped.push({path:directory,reason:'unreadable'});return}
  for(const entry of [...entries].sort((a,b)=>a.name<b.name?-1:1)){
   if(budget.scanned>=ASSET_LIMITS.maxScanFiles)return;
   const absolute=join(directory,entry.name);
   if(entry.name.startsWith('.'))continue;
   // A symlink could leave the reviewed root entirely; refuse rather than resolve it.
   if(entry.isSymbolicLink()){skipped.push({path:absolute,reason:'symlink_refused'});continue}
   if(entry.isDirectory()){await walk(absolute,depth+1);continue}
   if(!entry.isFile())continue;
   budget.scanned++;
   if(!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))continue;
   const real=await realpath(absolute).catch(()=>null);
   if(!real||(real!==realRoot&&!real.startsWith(realRoot+sep))){skipped.push({path:absolute,reason:'outside_root'});continue}
   files.push({absolute,relative:relative(root.path,absolute)});
  }
 };
 await walk(root.path,1);
 return files;
}

/**
 * Rank existing assets for one task. `scope.directories` is the only way client material
 * enters the result, and an excluded root can never contribute regardless of scope.
 */
export async function searchTaskAssets(roots:AssetRoot[],scope:AssetScope,terms:string[],limit:number=ASSET_LIMITS.maxCandidates):Promise<AssetSearchResult>{
 if(!Number.isInteger(limit)||limit<1||limit>ASSET_LIMITS.maxCandidates)throw Error('asset_candidate_limit_invalid');
 if(!scope||typeof scope.client!=='string'||!scope.client.trim()||!Array.isArray(scope.directories))throw Error('asset_client_scope_required');
 if(scope.directories.some(d=>typeof d!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(d)))throw Error('asset_client_directory_invalid');
 const budget={scanned:0};const skipped:{path:string;reason:string}[]=[];const scored:AssetCandidate[]=[];
 for(const root of roots){
  if(root.kind==='excluded'){skipped.push({path:root.path,reason:'root_excluded_pending_release'});continue}
  for(const file of await listFiles(root,budget,skipped)){
   let clientDirectory:string|null=null;
   if(root.kind==='client_scoped'){
    const [first]=file.relative.split(sep);
    // Exact permitted-directory match only. No prefix, fuzzy or client-name inference.
    if(!first||!scope.directories.includes(first)){skipped.push({path:file.absolute,reason:'foreign_or_unreleased_client'});continue}
    clientDirectory=first;
   }
   const stat=await lstat(file.absolute).catch(()=>null);
   if(!stat||!stat.isFile()){skipped.push({path:file.absolute,reason:'unreadable'});continue}
   if(stat.size>ASSET_LIMITS.maxFileBytes){skipped.push({path:file.absolute,reason:'over_size_bound'});continue}
   const bytes=await readFile(file.absolute).catch(()=>null);
   if(!bytes){skipped.push({path:file.absolute,reason:'unreadable'});continue}
   const text=assetPlainText(bytes.toString('utf8'),extname(file.absolute).toLowerCase());
   if(text.length<40){skipped.push({path:file.absolute,reason:'no_usable_text'});continue}
   const title=assetTitle(text,file.relative);
   const {score,matchedTerms}=assetScore(terms,file.relative,title,text);
   if(score<=0)continue;
   scored.push({id:assetIdentifier(root.key,file.relative),rootKey:root.key,relativePath:file.relative,clientDirectory,title,contentHash:hash(bytes),bytes:stat.size,score,matchedTerms});
  }
 }
 // Deterministic: score first, then identifier, so an equal-scoring pair never reorders
 // between runs and change a packet fingerprint for no substantive reason.
 scored.sort((a,b)=>b.score-a.score||(a.id<b.id?-1:1));
 return {candidates:scored.slice(0,limit),scanned:budget.scanned,skipped,truncated:scored.length>limit};
}

export function assetIdentifier(rootKey:string,relativePath:string){
 if(!/^[a-z][a-z0-9-]{0,30}$/.test(rootKey))throw Error('asset_root_key_invalid');
 const normalised=relativePath.split(sep).join('/');
 if(!normalised||normalised.startsWith('/')||normalised.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('asset_relative_path_invalid');
 return `${ASSET_SCHEME}:${rootKey}:${normalised}`;
}

export function parseAssetIdentifier(id:string){
 const match=/^asset:([a-z][a-z0-9-]{0,30}):([^\0]{1,400})$/.exec(id);
 if(!match)throw Error('asset_identifier_invalid');
 const [,rootKey,relativePath]=match;
 if(relativePath.startsWith('/')||relativePath.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('asset_identifier_invalid');
 return {rootKey,relativePath};
}

/**
 * Read one released asset back for prompt use. The release decision fixes the identifier
 * and the content hash; a mismatch means the file moved on after release, so this refuses
 * instead of drafting from content nobody approved.
 */
export async function readReleasedAsset(roots:AssetRoot[],release:{id:string;contentHash:string;clientDirectory:string|null},scope:AssetScope){
 const {rootKey,relativePath}=parseAssetIdentifier(release.id);
 const root=roots.find(r=>r.key===rootKey);
 if(!root)throw Error('asset_root_unknown');
 if(root.kind==='excluded')throw Error('asset_root_excluded');
 if(root.kind==='client_scoped'){
  const [first]=relativePath.split('/');
  if(!first||!scope.directories.includes(first)||release.clientDirectory!==first)throw Error('asset_client_boundary_refused');
 }else if(release.clientDirectory!==null)throw Error('asset_client_boundary_refused');
 const base=await lstat(root.path).catch(()=>null);
 if(!base)throw Error('asset_root_absent');
 const absolute=base.isFile()?root.path:resolve(root.path,relativePath.split('/').join(sep));
 const realRoot=await realpath(root.path);
 const real=await realpath(absolute).catch(()=>null);
 if(!real||(real!==realRoot&&!real.startsWith(realRoot+sep)))throw Error('asset_outside_root');
 const stat=await lstat(absolute);
 if(!stat.isFile()||stat.size>ASSET_LIMITS.maxFileBytes)throw Error('asset_unreadable_or_oversize');
 const bytes=await readFile(absolute);
 if(hash(bytes)!==release.contentHash)throw Error('asset_source_changed');
 const text=assetPlainText(bytes.toString('utf8'),extname(absolute).toLowerCase());
 return {id:release.id,rootKey,relativePath,clientDirectory:release.clientDirectory,title:assetTitle(text,relativePath),contentHash:release.contentHash,text:text.slice(0,ASSET_LIMITS.maxExcerptCharacters),truncated:text.length>ASSET_LIMITS.maxExcerptCharacters};
}
