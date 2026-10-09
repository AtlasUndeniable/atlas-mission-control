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
