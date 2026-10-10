/**
 * Undeniable brand rules for the drafting system prompt.
 *
 * The rules are read from the brand kit rather than restated here, so the document voice
 * follows the same file Rhys edits. Only the sections that govern written documents are
 * extracted; the typography, colour, logo and landing-page sections do not apply to a
 * structured text document and are deliberately left out of the prompt budget.
 */
import {createHash} from 'node:crypto';
import {assertPermittedBrandKit,readContainedFile} from './task-asset-boundary.ts';

export const BRAND_KIT_SECTIONS=['1. BRAND IDENTITY','11. WRITING STYLE GUIDE','12. FORMATTING DO AND DO NOT'] as const;
export const BRAND_RULES_LIMITS={maxFileBytes:200_000,maxCharacters:6000} as const;
export type BrandRules={kitHash:string;sections:string[];text:string;hash:string};

/** Extract one `## <heading>` section, stopping at the next heading of the same level. */
export function brandSection(kit:string,heading:string){
 const lines=kit.split('\n');
 const start=lines.findIndex(l=>l.trimEnd()==='## '+heading);
 if(start<0)throw Error('brand_section_absent');
 let end=lines.length;
 for(let i=start+1;i<lines.length;i++)if(/^## /.test(lines[i])){end=i;break}
 return lines.slice(start,end).join('\n').replace(/\n---\s*$/,'').trimEnd();
}

/**
 * Build the bounded brand rule block. The kit's own content hash is recorded so a draft
 * can be traced to the exact brand rules in force when it was generated.
 */
export function brandRules(kit:string,sections:readonly string[]=BRAND_KIT_SECTIONS):BrandRules{
 const parts=sections.map(h=>brandSection(kit,h));
 const text=parts.join('\n\n');
 if(text.length>BRAND_RULES_LIMITS.maxCharacters)throw Error('brand_rules_over_budget');
 return {kitHash:createHash('sha256').update(kit).digest('hex'),sections:[...sections],text,hash:createHash('sha256').update(text).digest('hex')};
}

/**
 * Read the brand kit from the one permitted path beneath the brain root. No search,
 * default or fallback copy, and no configured absolute path of its own: checking only the
 * final component let the kit be any absolute regular file on the disk, so the reader now
 * goes through the same containment and O_NOFOLLOW descriptor as every asset read.
 */
export async function readBrandRules(file:string,sections:readonly string[]=BRAND_KIT_SECTIONS){
 const kit=assertPermittedBrandKit(file);
 const read=await readContainedFile(kit,BRAND_RULES_LIMITS.maxFileBytes).catch((e:Error)=>{
  throw Error(e.message==='asset_over_size_bound'?'brand_kit_oversize':'brand_kit_unavailable');
 });
 return brandRules(read.bytes.toString('utf8'),sections);
}

/**
 * The voice and formatting instruction actually sent as the system prompt. The explicit
 * rules above the kit extract are the document-shape constraints the kit does not state,
 * because the kit was written for client-facing audit PDFs rather than internal drafts.
 */
export function brandSystemPrompt(rules:BrandRules){
 return [
  'You draft internal Undeniable Mentoring documents for Rhys Livingstone to review. Apply the brand rules below to voice and formatting.',
  'Document rules that override anything inferred from the brand kit:',
  '- Output is a single structured document. Plain text only: no HTML, markup, links, file paths or images.',
  '- Every factual claim must quote a supplied source and name that source identifier. If no source supports a claim, put it in open questions instead of asserting it.',
  '- Mark every new step, role, date and decision as a proposal for review. You are not authorising, assigning, scheduling or sending anything.',
  '- Write the document itself, not a description of how you would write it.',
  '',
  'Undeniable brand rules, extracted from UNDENIABLE_BRAND_KIT.md sections '+rules.sections.join(', ')+':',
  rules.text,
 ].join('\n');
}
