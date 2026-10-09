/**
 * Turns the meeting-intake coverage payload into the small strip above the
 * board. Its whole purpose is that an empty board is never mistaken for a
 * healthy one, so it must say "switched off" and "held" at least as loudly as
 * it says a count. Pure: no React, no fetch, no env.
 */
export type IntakePayload={
 status?:string;
 message?:string;
 visibility?:string;
 lastSuccessfulScan?:string;
 lastProcessedAt?:string;
 operatingEnabled?:boolean;
 sourceWorkPending?:number;
 stages?:{scopeHeld:number;captured:number;extracted:number;heldOrFailed:number;awaitingReview:number};
 sourceChecks?:{title:string;state:string;reason:string;nextReadAt?:string;checkedAt:string}[];
};

export type IntakeHold={
 /** Call title. Only shown to actors permitted to see source titles. */
 title:string;
 /** One plain-language sentence. Always the reason the system actually gave. */
 reason:string;
};

export type IntakeSummary={
 /** 'off' | 'unknown' | 'reporting' — drives the strip's tone. */
 mode:'off'|'unknown'|'reporting';
 /** The one line that must never be optimistic when it should not be. */
 headline:string;
 /** Shown under the headline. Explains what an empty board does and does not mean. */
 caveat:string;
 counts:{processed:number;pending:number;held:number;awaitingReview:number}|null;
 /** The window the counts describe, in words. '' when the payload does not say. */
 period:string;
 holds:IntakeHold[];
};

const HOLD_STATE_WORDS:Record<string,string>={
 scope_held:'outside the agreed scope',
 permission_denied:'we do not have permission to read it',
 source_unavailable:'the recording was not available',
 temporary_read_failure:'reading it failed and it will be retried',
 extraction_failed:'we could not turn it into tasks',
 provider_response_incomplete:'the summary came back incomplete',
 budget_exhausted:'the monthly allowance for processing calls is used up',
 awaiting_review:'it is waiting for someone to review it',
};

function sameDay(a:number,b:number){return new Date(a).toISOString().slice(0,10)===new Date(b).toISOString().slice(0,10)}

/** "today", "yesterday", or the actual date. Never claims "today" without evidence. */
export function periodWords(lastSuccessfulScan:string|undefined,now:number=Date.now()):string{
 if(!lastSuccessfulScan)return '';
 const at=Date.parse(lastSuccessfulScan);
 if(!Number.isFinite(at))return '';
 if(sameDay(at,now))return 'today';
 if(sameDay(at,now-86400000))return 'yesterday';
 return `on ${new Date(at).toLocaleDateString('en-AU',{day:'numeric',month:'short'})}`;
}

export function summariseIntake(payload:IntakePayload|null,now:number=Date.now()):IntakeSummary{
 if(!payload||payload.status==='unavailable'||payload.status==='checking'){
  return {
   mode:'unknown',
   headline:payload?.status==='checking'?'Checking whether calls are being processed…':'We cannot tell whether calls are being processed.',
   caveat:'Until this says otherwise, an empty board does not mean there is nothing to do.',
   counts:null,period:'',holds:[],
  };
 }
 if(payload.status==='disabled'||payload.operatingEnabled===false){
  return {
   mode:'off',
   headline:'Calls are not being turned into tasks right now.',
   caveat:payload.message?.trim()||'Processing is switched off. An empty board does not mean there is nothing to do.',
   counts:null,period:'',holds:[],
  };
 }
 const s=payload.stages;
 const counts=s?{
  processed:s.extracted,
  pending:Math.max(0,s.captured-s.extracted)+(payload.sourceWorkPending??0),
  held:s.heldOrFailed+s.scopeHeld,
  awaitingReview:s.awaitingReview,
 }:null;
 const period=periodWords(payload.lastSuccessfulScan,now);
 const holds=(payload.sourceChecks??[])
  .filter(c=>c.state!=='ok'&&c.state!=='processed')
  .map(c=>({
   title:c.title,
   reason:[HOLD_STATE_WORDS[c.state]?`Held because ${HOLD_STATE_WORDS[c.state]}.`:`Held: ${c.state.replaceAll('_',' ')}.`,c.reason?.trim()].filter(Boolean).join(' '),
  }));
 const headline=counts
  ? `${counts.processed} ${counts.processed===1?'call':'calls'} turned into tasks${period?` ${period}`:''}, ${counts.pending} still to do, ${counts.held} held.`
  : payload.message?.trim()||'Call processing is running.';
 return {
  mode:'reporting',
  headline,
  caveat:counts&&counts.held>0
   ? 'Held calls have not produced tasks. The board is not complete until they are dealt with.'
   : 'This covers calls only. It does not confirm that older tasks are still needed.',
  counts,period,holds,
 };
}
