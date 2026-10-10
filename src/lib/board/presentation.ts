/**
 * Customer-facing wording for the board. Pure: no React, no fetch, no env.
 *
 * Two jobs:
 *  1. Say how fresh a card is in words Rhys, Pat and Nat use.
 *  2. Give the tests a single definition of "engineering identifier" so the
 *     customer view can be checked for leaks instead of eyeballed.
 */

/** Relative time in whole units, past tense. Returns '' for an unusable instant. */
export function relativeTime(instant:string|null|undefined,now:number=Date.now()):string{
 if(!instant)return '';
 const then=Date.parse(instant);
 if(!Number.isFinite(then))return '';
 const seconds=Math.round((now-then)/1000);
 if(seconds<0)return 'just now';
 const units:[Intl.RelativeTimeFormatUnit,number][]=[['second',60],['minute',60],['hour',24],['day',7],['week',4.345],['month',12],['year',Infinity]];
 let value=seconds;
 for(const [unit,size] of units){
  if(value<size||size===Infinity){
   if(unit==='second'&&value<45)return 'just now';
   const whole=Math.max(1,Math.round(value));
   return new Intl.RelativeTimeFormat('en',{numeric:'auto'}).format(-whole,unit);
  }
  value=value/size;
 }
 return '';
}

/**
 * "From your call “Weekly check-in”, 2 hours ago."
 * Uses the meeting's own recorded title and instant. Never invents a
 * counterparty the board cannot see.
 */
export function freshness(meetingTitle:string|null|undefined,instant:string|null|undefined,now:number=Date.now()):string{
 const when=relativeTime(instant,now);
 const title=meetingTitle?.trim();
 if(!title&&!when)return 'Source and timing are not recorded for this item.';
 if(!title)return `Recorded ${when}.`;
 if(!when)return `From your call “${title}”.`;
 return `From your call “${title}”, ${when}.`;
}

/** Whole days until a due date; negative when overdue. Null when there is no due date. */
export function dueIn(due:string|null|undefined,now:number=Date.now()):number|null{
 if(!due)return null;
 const target=Date.parse(due+'T00:00:00Z');
 if(!Number.isFinite(target))return null;
 const today=Date.parse(new Date(now).toISOString().slice(0,10)+'T00:00:00Z');
 return Math.round((target-today)/86400000);
}

export function dueLabel(due:string|null|undefined,now:number=Date.now()):string{
 const days=dueIn(due,now);
 if(days===null)return 'No due date';
 if(days===0)return 'Due today';
 if(days===1)return 'Due tomorrow';
 if(days===-1)return 'Was due yesterday';
 if(days<0)return `Overdue by ${Math.abs(days)} days`;
 if(days<=7)return `Due in ${days} days`;
 return `Due ${new Date(due+'T00:00:00Z').toLocaleDateString('en-AU',{day:'numeric',month:'short',timeZone:'UTC'})}`;
}

/**
 * Engineering identifiers that must not appear in the customer board. The
 * role-visibility test renders the customer view and asserts no match.
 *
 * Deliberately conservative — each pattern targets a shape the product
 * actually emits, so a hit is a real leak rather than ordinary prose.
 */
export const IDENTIFIER_PATTERNS:{name:string;pattern:RegExp}[]=[
 {name:'content hash or commit',pattern:/\b[0-9a-f]{7,}\b/i},
 {name:'uuid',pattern:/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i},
 {name:'migration file',pattern:/\b\d{3}_[a-z][a-z0-9_]*\b/},
 {name:'build identifier',pattern:/(?=[A-Za-z0-9_-]{20,24}\b)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)\b[A-Za-z0-9_-]{20,24}\b/},
 {name:'revision wording',pattern:/\brevisions?\b/i},
 {name:'source revision token',pattern:/\bsource-v\d+\b/i},
];

/** Every identifier-looking fragment in `text`, for test failure messages. */
export function identifierLeaks(text:string):{name:string;match:string}[]{
 const found:{name:string;match:string}[]=[];
 for(const {name,pattern} of IDENTIFIER_PATTERNS){
  const global=new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g');
  for(const m of text.matchAll(global))found.push({name,match:m[0]});
 }
 return found;
}

/** Display name for an actor key. Never invents access; only formats a key. */
export function actorName(key:string|null|undefined):string{
 if(!key)return 'Unassigned';
 const bare=key.replace(/^fixture\./,'');
 if(bare==='atlas')return 'Atlas';
 return bare.charAt(0).toUpperCase()+bare.slice(1);
}

/**
 * Who may change what on a task, derived from the server's own capability payload.
 *
 * Review finding R6: the board read `capability.triage` — which is `can_triage` returned
 * verbatim by `public.meeting_capability()` — as permission to change owner, executor,
 * reviewer, next step and due date. `can_triage` is the triage right: whether this actor
 * may turn a call commitment into a task at all. It is not an ownership right, and the
 * captured hosted capability has Nat, a builder, at `triage:true`, so a visible valid task
 * of hers would have exposed enabled owner and executor controls.
 *
 * The permission source used instead is already in the same payload and is equally
 * server-derived: `rhysActor` is `app_private.meeting_reviewers.rhys_actor`, the recorded
 * accountable principal. The delegation RPC uses exactly that value as its own authority
 * anchor — on any request with an active task grant it refuses a reviewer that is not
 * `r.rhys_actor` (`required_reviewer_change_denied`) — so deriving ownership management
 * from it matches the mutation boundary rather than guessing alongside it.
 *
 * Executor scheduling is retained deliberately and separately: the person doing the work
 * may move its due date and report on it. That is a scheduling right, not an ownership
 * right, so it is named here rather than folded into triage.
 */
export type BoardCapability={actor:string;triage:boolean;review:boolean;rhysActor:string|null};
export type TaskControlSubject={executor?:string|null;next_reviewer?:string|null}|null|undefined;
export type TaskControls={
 /** Owner, next step and who is doing it. The accountable principal only. */
 manageOwnership:boolean;
 /** Who reviews it. Needs ownership, and `can_review` to displace an existing reviewer. */
 setReviewer:boolean;
 /** Due date. The accountable principal, or the person actually doing this task. */
 schedule:boolean;
 /** Why a control is absent, for the card's own wording. '' when nothing is withheld. */
 withheldReason:string;
};
export function taskControls(capability:BoardCapability|null|undefined,task:TaskControlSubject):TaskControls{
 const accountable=!!capability?.actor&&!!capability.rhysActor&&capability.actor===capability.rhysActor;
 const doingIt=!!capability?.actor&&!!task?.executor&&task.executor===capability.actor;
 // `can_triage` is still a precondition for writing anything, because the RPC refuses the
 // edit action outright without it (`triage_denied`). It is no longer sufficient for any
 // control, which is the correction: triage gates whether this actor may change a card at
 // all; the rights below decide which fields.
 const mayWrite=!!capability?.triage;
 // An existing required reviewer may only be displaced by someone who can review.
 const setReviewer=mayWrite&&accountable&&(!!capability?.review||!task?.next_reviewer);
 return {
  manageOwnership:mayWrite&&accountable,
  setReviewer,
  schedule:mayWrite&&(accountable||doingIt),
  withheldReason:!mayWrite?'':accountable?'':doingIt
   ? 'You can change the timing of this and report your work. Who owns it, who does it and who reviews it are set by the person accountable for it.'
   : 'Who owns this, who does it and who reviews it are set by the person accountable for it.',
 };
}

/**
 * The payload fields each control writes. The route refuses any of these from an actor
 * without the matching right, so the UI and the mutation boundary cannot drift apart.
 */
export const OWNERSHIP_FIELDS=['owner','executor','title'] as const;
export const REVIEWER_FIELDS=['reviewer'] as const;
export const SCHEDULE_FIELDS=['due'] as const;

/** Fields in `payload` this capability may not write. Empty means the edit is permitted. */
export function refusedEditFields(capability:BoardCapability|null|undefined,payload:Record<string,unknown>,task:TaskControlSubject){
 const controls=taskControls(capability,task);
 const refused:string[]=[];
 for(const field of OWNERSHIP_FIELDS)if(field in payload&&!controls.manageOwnership)refused.push(field);
 for(const field of REVIEWER_FIELDS)if(field in payload&&!controls.setReviewer)refused.push(field);
 for(const field of SCHEDULE_FIELDS)if(field in payload&&!controls.schedule)refused.push(field);
 return refused;
}

/**
 * Customer-safe rendering of a canonical review-history note.
 *
 * Review finding R7: the customer "Where this came from" history printed
 * `history[].input.note` verbatim, and canonical document completion and review write a
 * SHA256 into exactly those notes (migration 028). The notes themselves are immutable and
 * stay that way; this is a presentation layer over them.
 *
 * Every fragment the identifier detector above recognises is replaced by a visible marker
 * rather than deleted, so a reader can tell that something technical was withheld instead
 * of silently losing a clause. The raw note is kept on /board/engineering only.
 */
export const IDENTIFIER_PLACEHOLDER='[engineering detail]';
export function customerSafeNote(note:string|null|undefined):string{
 if(!note)return '';
 let text=String(note);
 for(const {pattern} of IDENTIFIER_PATTERNS){
  const global=new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g');
  text=text.replace(global,IDENTIFIER_PLACEHOLDER);
 }
 const marker=IDENTIFIER_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 // Collapse runs of adjacent markers and the punctuation stranded between them, so a
 // "SHA256 <hash>" pair does not read as two separate withholdings.
 return text
  .replace(new RegExp(`${marker}(?:[\\s;,·—-]*${marker})+`,'g'),IDENTIFIER_PLACEHOLDER)
  .replace(/[ \t]{2,}/g,' ')
  .trim();
}
