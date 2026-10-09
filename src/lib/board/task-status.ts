/**
 * The one task status vocabulary shared by the customer board (Lane D) and the
 * task drafting path (Lane C). Both lanes derive their words from here so the
 * board and the draft panel can never disagree about what a task is doing.
 *
 * Pure: no React, no fetch, no environment access. Safe to import from a server
 * route, a client component or a test.
 *
 * Every status carries one plain-language sentence. A status reason is written
 * for Rhys, Pat and Nat — never a hash, revision, migration or build identifier.
 */
export const BOARD_STATUSES=['proposed','accepted','drafted','in_review','changes_requested','complete','held'] as const;
export type BoardStatus=(typeof BOARD_STATUSES)[number];

export const BOARD_STATUS_LABEL:Record<BoardStatus,string>={
 proposed:'Proposed',
 accepted:'Accepted',
 drafted:'Drafted',
 in_review:'In review',
 changes_requested:'Changes requested',
 complete:'Complete',
 held:'Held',
};

/** Column tone. Amber = a person must act, blue = Atlas-originated, green = genuinely finished. */
export const BOARD_STATUS_TONE:Record<BoardStatus,'review'|'atlas'|'work'|'done'|'held'>={
 proposed:'review',
 accepted:'work',
 drafted:'atlas',
 in_review:'review',
 changes_requested:'review',
 complete:'done',
 held:'held',
};

/** What the drafting path reports for a task. `available:false` means drafting cannot run. */
export type DraftState={
 available:boolean;
 /** Plain-language sentence supplied by the drafting path when it is unavailable. */
 reason?:string;
 status?:string;
 currentVersion?:number;
 versions?:{version:number;hash?:string}[];
 /** What this actor may do: build | revise | handoff | review. */
 rights?:string[];
 /** Optimistic-concurrency token the drafting path requires back on a write. */
 revision?:number;
};

export type StatusInput={
 /** True once the proposal has been accepted and a canonical task exists. */
 hasTask:boolean;
 workStatus?:string|null;
 executor?:string|null;
 /** Proposal-level state from the meeting queue: pending_approval / accepted / declined. */
 itemState?:string|null;
 deferred?:boolean;
 /** The meeting source changed and its correspondence has not been reviewed. */
 sourceChanged?:boolean;
 /** A re-extraction did not reaffirm this obligation. */
 reconciliationRequired?:boolean;
 /** A task-safe correction returned to the executor. */
 sharedCorrection?:string|null;
 /** Null when the board has not read the drafting path for this task. */
 draft?:DraftState|null;
 /** True when Atlas execution/drafting is switched off for this deployment. */
 atlasExecutionInactive?:boolean;
};

export type BoardStatusResult={
 status:BoardStatus;
 label:string;
 tone:(typeof BOARD_STATUS_TONE)[BoardStatus];
 /** One sentence. Always present. */
 reason:string;
 /** Set only when status is 'held'; the same sentence, so a Held strip can list it. */
 heldReason:string|null;
 /** v1, v2 … when the drafting path has produced a version. */
 draftVersion:number|null;
};

/**
 * The drafting and extraction paths may report a hold as a short category
 * token rather than a sentence — a model refusal, for instance, deliberately
 * carries only a category and never the provider's own words. The board must
 * still read as plain language, so known categories are translated and an
 * unrecognised token is wrapped rather than printed raw.
 */
export const HELD_REASON_WORDS:Record<string,string>={
 provider_response_incomplete:'The automatic draft came back incomplete, so nothing was saved. Someone needs to start it again.',
 refusal:'The drafting assistant declined to write this one. A person needs to pick it up.',
 budget_exhausted:'The monthly allowance for automatic drafting is used up.',
 rate_limited:'Drafting is temporarily rate-limited. It can be started again shortly.',
 unauthenticated:'Drafting is not connected to its provider account yet.',
 credit_exhausted:'The drafting account has no credit, so nothing can be drafted until it is topped up.',
 authority_changed:'Who is allowed to do this changed. It needs checking before it can go on.',
 generation_disabled:'Automatic drafting is switched off.',
};
/** True when the drafting path is offering this actor something to do. */
function draftingIsLive(draft:DraftState|null|undefined):boolean{
 return !!draft&&draft.available!==false&&((draft.rights?.length??0)>0||(draft.currentVersion??0)>0);
}

/** A sentence stays a sentence; a bare token becomes one. Never returns ''. */
export function plainHeldReason(raw:string|null|undefined,fallback:string):string{
 const text=raw?.trim();
 if(!text)return fallback;
 const mapped=HELD_REASON_WORDS[text];
 if(mapped)return mapped;
 // A token is a single lower_snake or kebab word with no spaces; anything the
 // product wrote for a person already contains spaces.
 if(!/\s/.test(text))return `${fallback} The reason recorded was “${text.replaceAll(/[_-]/g,' ')}”.`;
 return text;
}

/**
 * Draft states that stop a card dead until a person deals with them. Confirmed
 * against the task-document states by Lane C: a reserved or unresolved
 * generation must never render an enabled Start, because a second press is
 * refused server-side and would look like a button that does nothing.
 */
export const HELD_DRAFT_STATES:Record<string,string>={
 building:'A draft is already being made. Wait for it to finish rather than starting another.',
 uncertain:'A draft was started and we never found out how it ended. Someone needs to check before it is tried again.',
 rejected:'The draft that came back was not usable. It has been kept, and nothing was sent.',
 cancelled:'The draft was cancelled part-way. The attempt has been kept.',
 authority_changed:'Who may see or approve this changed while the draft was open. It needs checking before it is approved or changed.',
};

function heldBecause(i:StatusInput):string|null{
 if(i.sourceChanged)return 'The call this came from was updated. Someone needs to confirm it still means the same thing.';
 if(i.reconciliationRequired)return 'The latest version of the call did not repeat this. Confirm whether it is still needed.';
 if(i.hasTask&&i.workStatus!=='completed'&&i.draft?.available!==false&&i.draft?.status&&HELD_DRAFT_STATES[i.draft.status])
  return HELD_DRAFT_STATES[i.draft.status];
 // Atlas being the executor is only a hold while the drafting path offers
 // nothing. Once drafting is switched on for Atlas tasks it reports a right or
 // a version, and the card goes back to ordinary flow rather than staying held.
 if(i.hasTask&&i.executor==='atlas'&&i.workStatus!=='completed'&&!draftingIsLive(i.draft))
  return 'Atlas is set to do this, but Atlas is not switched on to do work yet.';
 // Drafting being unavailable is deliberately NOT a hold. A person can still
 // do the work by hand, and a task that simply never used drafting must not be
 // mislabelled as blocked. It disables Start and states the reason instead —
 // see draftingBlock below.
 return null;
}

/**
 * Why Start cannot be used, in the customer's words, or null when it can.
 * Separate from status on purpose: an unavailable draft stops the automatic
 * route, not the work.
 */
export function draftingBlock(draft:DraftState|null|undefined):string|null{
 if(!draft)return null;
 if(draft.available===false)return plainHeldReason(draft.reason,'Drafting is not available for this task yet.');
 return null;
}

export function deriveBoardStatus(input:StatusInput):BoardStatusResult{
 const draftVersion=input.draft?.currentVersion&&input.draft.currentVersion>0?input.draft.currentVersion:null;
 const held=heldBecause(input);
 let status:BoardStatus;
 let reason:string;
 if(held){status='held';reason=held;}
 else if(input.workStatus==='completed'){status='complete';reason='Finished and reviewed. Nothing is waiting on anyone.';}
 else if(input.draft?.status==='needs_revision'||(input.hasTask&&input.sharedCorrection)){
  status='changes_requested';
  // A person's note may not be punctuated; the card must still read as a sentence.
  const asked=input.sharedCorrection?.trim();
  reason=asked?`Changes asked for: ${/[.!?]$/.test(asked)?asked:asked+'.'}`:'Changes were asked for. The next version has not been made yet.';
 }
 else if(input.workStatus==='needs_review'||input.draft?.status==='in_review'){status='in_review';reason='The work is done and is sitting with a reviewer.';}
 else if(draftVersion){status='drafted';reason=`A draft (v${draftVersion}) is ready to read and approve or send back.`;}
 else if(input.hasTask){status='accepted';reason='Agreed and assigned. The work has not been started.';}
 else {status='proposed';reason='Came out of a call. Nobody has agreed to it yet.';}
 // A deferred or dismissed proposal is still Proposed; its reason says why it is parked.
 if(status==='proposed'&&input.deferred)reason='Parked for now. It will keep showing under Deferred until it is accepted or dismissed.';
 if(status==='proposed'&&input.itemState==='declined')reason='Decided against. Kept so the decision is not lost.';
 return {status,label:BOARD_STATUS_LABEL[status],tone:BOARD_STATUS_TONE[status],reason,heldReason:status==='held'?reason:null,draftVersion};
}

export type NextActionInput={
 owner?:string|null;
 executor?:string|null;
 reviewer?:string|null;
 /** The signed-in actor key, so the sentence can say "you". */
 viewer?:string|null;
 /** Formats an actor key for display. Injected so this file stays pure. */
 name:(key:string|null|undefined)=>string;
 heldReason?:string|null;
};

/**
 * One sentence naming who does the next thing. Distinct from the status
 * reason, which explains why the card sits where it does.
 */
export function nextAction(status:BoardStatus,i:NextActionInput):string{
 const who=(key:string|null|undefined,fallback:string)=>!key?fallback:key===i.viewer?'You':i.name(key);
 const owner=who(i.owner,'Whoever owns this');
 const executor=who(i.executor,'Nobody yet');
 const reviewer=who(i.reviewer,owner);
 switch(status){
  case 'proposed':return `${owner} to accept this or decide against it.`;
  case 'accepted':return i.executor?`${executor} to start the work.`:'Choose who does this, then start it.';
  case 'drafted':return `${reviewer} to read the draft and either approve it or ask for changes.`;
  case 'in_review':return `${reviewer} to check the work and approve it.`;
  case 'changes_requested':return `${executor} to make the changes and send it back.`;
  case 'complete':return 'Nothing. This one is finished.';
  case 'held':return i.heldReason?.trim()||'Nothing can move until the hold above is cleared.';
 }
}
