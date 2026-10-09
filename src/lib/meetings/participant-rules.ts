/** Offline identity reuse only. Attendance is never a source/sharing grant. */
export type ClientIdentity={client:string;emails:string[];active:boolean;verified:boolean;reference:string};
export type ParticipantRule={id:string;organizer:string;client:string;allowedDomains:string[];clientDomains:string[];matchKind:'participant';clientEmails:string[];allowedEmails:string[];classification:'client_financial'|'client_confidential'|'internal';reviewer:string;decisionReference:string;excluded:false};
const email=(s:string)=>s.trim().toLowerCase();
export function participantRules(identities:ClientIdentity[],scope:{organizer:string;reviewer:string;classification:ParticipantRule['classification'];decisionReference:string;permittedClients:string[];permittedStaffEmails:string[]}){
 if(!scope.organizer||!scope.reviewer||scope.decisionReference.length<9)throw Error('Explicit standing scope/reviewer decision required');
 const valid=(s:string)=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
 const owner=email(scope.organizer),staff=[...new Set(scope.permittedStaffEmails.map(email))];
 if(!valid(owner)||!staff.every(valid)||!staff.includes(owner))throw Error('Explicit organizer/staff identities required');
 const conflicts=new Map<string,Set<string>>(),held:{client:string;reason:string}[]=[],candidates=identities.map(i=>({...i,emails:[...new Set(i.emails.map(email))].sort()}));
 // Even an unverified conflicting association prevents blind reuse of that email.
 for(const i of candidates.filter(i=>i.active))for(const e of i.emails){const clients=conflicts.get(e)||new Set<string>();clients.add(i.client);conflicts.set(e,clients)}
 const rules:ParticipantRule[]=[];
 for(const client of [...new Set(candidates.map(i=>i.client))].sort()){
  const rows=candidates.filter(i=>i.client===client&&i.active);
  if(!rows.length)continue;
  if(!scope.permittedClients.includes(client)){held.push({client,reason:'Client outside explicit permitted scope'});continue}
  const accepted:ClientIdentity[]=[];
  for(const row of rows){
   if(!row.verified||row.reference.length<3){held.push({client,reason:'Unverified identity association'});continue}
   const emails=row.emails.filter(e=>valid(e)&&!staff.includes(e)&&(conflicts.get(e)?.size||0)===1);
   if(emails.length!==row.emails.length||!emails.length)held.push({client,reason:'Conflicting or incomplete identity alias held'});
   if(emails.length)accepted.push({...row,emails});
  }
  const emails=[...new Set(accepted.flatMap(i=>i.emails))].sort();if(!emails.length)continue;
  rules.push({id:'identity-'+client,organizer:owner,client,allowedDomains:[],clientDomains:[],matchKind:'participant',clientEmails:emails,allowedEmails:[...new Set([...staff,...emails])].sort(),classification:scope.classification,reviewer:scope.reviewer,decisionReference:scope.decisionReference+'; identities: '+accepted.map(i=>i.reference).sort().join(', '),excluded:false});
 }
 return {rules,held};
}
