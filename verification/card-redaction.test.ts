// Lane N2: card read-out redaction in intake. SYNTHETIC ONLY: the numbers below are the public
// payment-network test PANs (Visa 4111…1111, Mastercard 5555…4444, Amex 3782…0005, Discover
// 6011…1117) and made-up expiry/security values. No real card data appears anywhere.
import test from 'node:test';import assert from 'node:assert/strict';
import {redactCardData,luhn} from '../src/lib/meetings/card-redaction.ts';
import {normalize,normalizeWithRedaction,validateExtraction} from '../src/lib/meetings/intake-core.ts';
import {processMeeting} from '../src/lib/meetings/recurring-intake.ts';

const P=(...texts:string[])=>texts.map((text,i)=>({speaker:i%2?'Client':'Rhys',text,start:i*5,end:i*5+4}));
const VISA='4111111111111111',MC='5555555555554444',AMEX='378282246310005',DISC='6011111111111117';
const leaks=(texts:string[],secrets:string[])=>{const all=texts.join(' ').replace(/\D/g,'');return secrets.filter(s=>all.includes(s))};
test('the synthetic test PANs are Luhn-valid, and a non-card 16-digit run is not',()=>{for(const n of [VISA,MC,AMEX,DISC])assert.ok(luhn(n),n);assert.equal(luhn('1234567890123456'),false)});

test('multi-turn split groups with misheard cues ("car details", "fiery", "CBC") are masked across turns',()=>{
 const r=redactCardData(P("Okay, what are the car details?","So 4111-1111-1111","-1111.","And the fiery date?","08/27","And the CBC on the back?","737","Great, you're all set."),'');
 const t=r.passages.map(p=>p.text);
 assert.deepEqual(leaks(t,['411111111111','1111','0827','737']),[],t.join(' | '));
 assert.equal(t[0],'Okay, what are the car details?');assert.equal(t[7],"Great, you're all set.");
 assert.match(t[1],/\[REDACTED-CARD\]/);assert.match(t[4],/\[REDACTED-EXPIRY\]/);assert.match(t[6],/\[REDACTED-CVC\]/);
 assert.ok(r.counts.card>=1&&r.counts.expiry===1&&r.counts.cvc===1,JSON.stringify(r.counts));
 assert.deepEqual(r.passages.map(p=>[p.speaker,p.start,p.end]),P('','','','','','','','').map(p=>[p.speaker,p.start,p.end]),'speakers and timing are untouched');
});
test('a read-out that starts one turn before its cue, and spoken digits, are masked',()=>{
 const r=redactCardData(P("five five five five, five five five five","five five five five four four four four, that's my Mastercard","expiry is twelve twenty eight and the CVV is one two three"),'');
 const t=r.passages.map(p=>p.text).join(' | ');
 assert.doesNotMatch(t,/\b(?:five|four)\b/i,t);assert.doesNotMatch(t,/one two three/,t);assert.doesNotMatch(t,/twelve twenty eight/,t);
});
test('numeric-only turns with no cue at all are masked as a card when they total 13+ digits over 3+ turns',()=>{
 const r=redactCardData(P("Right.","5555-5555","5555-","4444","Thanks."),'');
 assert.deepEqual(leaks(r.passages.map(p=>p.text),['5555','4444']),[]);assert.equal(r.passages[0].text,'Right.');assert.equal(r.passages[4].text,'Thanks.');
});
test('a single Luhn-valid 13–19 digit run is masked even without a cue',()=>{
 const r=redactCardData(P(`Use 3782 822463 10005 for that one`,`and also ${DISC.replace(/(\d{4})/g,'$1 ').trim()}`),'');
 assert.deepEqual(leaks(r.passages.map(p=>p.text),[AMEX,DISC]),[]);assert.equal(r.counts.card,2);
});
test('prices, clock times, counts and phone numbers outside a payment cue are never masked',()=>{
 const texts=["It's $1,997 or three payments of $697.","Let's speak at 10:30 tomorrow, or 3pm.","We had 12,000 views and 45 clients.","Text me on 0412 345 678.","That's a 30% lift.","Order 1234 5678 9012 3456 shipped."];
 const r=redactCardData(P(...texts),'');
 assert.deepEqual(r.passages.map(p=>p.text),texts);assert.deepEqual(r.counts,{card:0,expiry:0,cvc:0});
});
test('inside a payment window, clearly formatted prices and times survive while every other digit run is masked',()=>{
 const r=redactCardData(P("Can I grab your card number?","Sure, it's 4111 1111 1111 1111 and that's for the $1,997 package at 10:30."),'');
 const t=r.passages[1].text;
 assert.deepEqual(leaks([t],[VISA,'41111111']),[],t);assert.match(t,/\$1,997/);assert.match(t,/10:30/);
});
test('adjacent fragments of one kind merge into a single marker; counts carry no digits',()=>{
 const r=redactCardData(P("Card number?","4111-1111, 1111-1111"),'');
 assert.equal((r.passages[1].text.match(/\[REDACTED-CARD\]/g)??[]).length,1,r.passages[1].text);
 assert.deepEqual(Object.keys(r.counts).sort(),['card','cvc','expiry']);for(const v of Object.values(r.counts))assert.equal(typeof v,'number');
});
test('the provider summary is masked by the same rules',()=>{
 const r=redactCardData(P('hello'),`Take payment: card ${VISA}, exp 01/29, cvc 999`);
 assert.deepEqual(leaks([r.summary],[VISA,'0129','999']),[],r.summary);assert.ok(r.counts.card>=1&&r.counts.expiry>=1&&r.counts.cvc>=1);
});

const raw=(sentences:{speaker_name:string;text:string}[])=>({id:'synthetic-card-call',title:'Synthetic',date:Date.parse('2026-10-20T00:00:00Z'),is_live:false,
 sentences:sentences.map((s,i)=>({...s,start_time:i,end_time:i+0.5})),summary:{action_items:'Send the onboarding pack'}});
const CALL=raw([{speaker_name:'Rhys',text:'Great, what are the car details?'},{speaker_name:'Client',text:'4111-1111-1111'},{speaker_name:'Client',text:'-1111'},{speaker_name:'Rhys',text:'Expiry and the CBC?'},{speaker_name:'Client',text:'08/27, 737'},{speaker_name:'Rhys',text:'I will send the onboarding pack tonight.'}]);
test('normalize() masks before hashing: the stored revision is over masked text, and counts are returned',()=>{
 const {source,redaction}=normalizeWithRedaction(CALL);
 assert.deepEqual(leaks(source.passages.map(p=>p.text),['41111111','0827','737']),[]);
 assert.deepEqual(normalize(CALL),source,'normalize is the masked form');
 assert.ok(redaction.card>=1&&redaction.expiry>=1&&redaction.cvc>=1);
 assert.equal(source.passages[5].text,'I will send the onboarding pack tonight.');
});
test('a model quote can only be masked text: a quote containing the card digits is rejected',()=>{
 const {source}=normalizeWithRedaction(CALL);
 const receipt=(quote:string,speaker:string,i:number)=>({reviewedAll:true,coverage:{sourceRevision:source.revision,passageCount:source.passages.length,completeTranscript:true},
  items:[{key:'x',title:'t',kind:'promise',quote,speaker,start:source.passages[i].start,end:source.passages[i].end,provenance:'transcript',suggestedResponsibility:null,due:null,dueQuote:null,uncertainty:'none really',sourceRevision:source.revision}]});
 assert.throws(()=>validateExtraction(source,receipt('4111-1111-1111','Client',1)));
 assert.equal(validateExtraction(source,receipt('I will send the onboarding pack tonight.','Rhys',5)).length,1);
});
test('processMeeting captures only the masked source and sends the masked-span counts (no digits) with it',async()=>{
 const calls:{action:string;payload:Record<string,unknown>}[]=[];
 const rpc=async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});if(action==='eligible')return {allowed:true,revision:null,authority:'synthetic'};if(action==='capture')return {held:true};return {}};
 const catalog={page:async()=>[],source:async()=>CALL};
 await processMeeting(catalog as never,rpc,{configurationHash:'x',invoke:async()=>({})},{id:CALL.id,title:'Synthetic',instant:new Date(CALL.date).toISOString(),live:false},{timeoutMs:1000});
 const cap=calls.find(c=>c.action==='capture')!;
 assert.ok(cap,'capture called');
 assert.deepEqual(leaks([JSON.stringify(cap.payload.source)],['41111111','0827','737']),[]);
 const red=cap.payload.redaction as Record<string,number>;
 assert.deepEqual(Object.keys(red).sort(),['card','cvc','expiry']);assert.ok(red.card>=1);
 assert.doesNotMatch(JSON.stringify(red),/4111|0827|737/);
});

// ---- Lane N3 (R11b-1): explicit payment context beats the price/time exemptions --------------
import {redactText} from '../src/lib/meetings/card-redaction.ts';
import {catalogTitle} from '../src/lib/meetings/fireflies.ts';
import {extractionAdapter} from '../src/lib/meetings/recurring-intake.ts';
test('R11b-1 repro: a card cue then the test PAN in comma-thousands format is masked',()=>{
 const r=redactCardData(P("What's the card number?","4,111,111,111,111,111"),'');
 assert.deepEqual(leaks(r.passages.map(p=>p.text),[VISA]),[]);assert.equal(r.counts.card,1);
});
test('R11b-1 repro: "am" is a whole token only; a PAN followed by "amount" is masked',()=>{
 const r=redactCardData(P("Card number please.","4111 1111 1111 1111 amount is fine"),'');
 assert.deepEqual(leaks(r.passages.map(p=>p.text),[VISA]),[]);assert.match(r.passages[1].text,/amount is fine$/);
});
test('R11b-1 repro: single spoken-number turns after a security-code cue are masked',()=>{
 const r=redactCardData(P("Security code on the back?","one","two","three","Thanks."),'');
 assert.deepEqual(r.passages.slice(1,4).map(p=>p.text),['[REDACTED-CVC]','[REDACTED-CVC]','[REDACTED-CVC]']);assert.equal(r.counts.cvc,3);assert.equal(r.passages[4].text,'Thanks.');
});
test('R11b-1: card-length runs are never exempt, even outside a cue, when Luhn-valid in comma or currency format',()=>{
 for(const t of ['ref $4111111111111111 thanks','total 4,111,111,111,111,111 dollars']){const r=redactText(t);assert.deepEqual(leaks([r.text],[VISA]),[],r.text);assert.equal(r.counts.card,1)}
});
test('R11b-1: bounded exemptions still protect real prices, times and unit counts inside a payment window',()=>{
 const r=redactCardData(P("Card details?","It's $1,997 now, call me at 10am or 3:30, we have 45 clients and 1,200 views."),'');
 assert.equal(r.passages[1].text,"It's $1,997 now, call me at 10am or 3:30, we have 45 clients and 1,200 views.");
});
test('R11b-1 contract: title and speaker names are masked; catalog titles are masked before storage',()=>{
 assert.equal(catalogTitle(`Payment call, card ${VISA}`),'Payment call, card [REDACTED-CARD]');
 assert.equal(catalogTitle('Weekly coaching call'),'Weekly coaching call');
 const {source,redaction}=normalizeWithRedaction({...CALL,title:`Sign-up, visa ${VISA}`,sentences:[{speaker_name:`Caller ${MC}`,text:'Hello there',start_time:0,end_time:1}]});
 assert.deepEqual(leaks([source.title,source.passages[0].speaker],[VISA,MC]),[]);assert.ok(redaction.card>=2);
});
const PAYMENT_CALL=raw([{speaker_name:'Rhys',text:'Great, what are the car details?'},{speaker_name:'Client',text:'4,111,111,111,111,111'},{speaker_name:'Rhys',text:'And the security code on the back?'},
 {speaker_name:'Client',text:'seven'},{speaker_name:'Client',text:'three seven'},{speaker_name:'Rhys',text:'I will send the onboarding pack tonight.'}]);
(PAYMENT_CALL.summary as {action_items:string}).action_items=`Take payment: card ${MC}, exp 01/29, cvc 999. Send the onboarding pack.`;
test('processMeeting: neither the captured source nor the synthetic extractor input carries card values (transcript and summary)',async()=>{
 const calls:{action:string;payload:Record<string,unknown>}[]=[];let modelInput='';
 const rpc=async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});
  if(action==='eligible')return {allowed:true,revision:null,authority:'synthetic'};
  if(action==='reserve')return {dispatch:true,attempt:'00000000-0000-4000-8000-000000000001'};
  return {}};
 const extractor=extractionAdapter({mode:'synthetic',model:'synthetic-model',maxCharacters:100000},async(input)=>{modelInput=JSON.stringify(input);return {reviewedAll:false}});
 await processMeeting({page:async()=>[],source:async()=>PAYMENT_CALL} as never,rpc,extractor,{id:PAYMENT_CALL.id,title:'Synthetic',instant:new Date(PAYMENT_CALL.date).toISOString(),live:false},{timeoutMs:2000});
 const cap=JSON.stringify(calls.find(c=>c.action==='capture')!.payload.source);
 assert.ok(modelInput.length>0,'the synthetic extractor was invoked');
 for(const text of [cap,modelInput]){
  assert.deepEqual(leaks([text],[VISA,MC,'0129','999']),[]);
  assert.doesNotMatch(text,/"seven"|three seven/);
  assert.match(text,/onboarding pack/);
 }
 const red=calls.find(c=>c.action==='capture')!.payload.redaction as Record<string,number>;
 assert.ok(red.card>=2&&red.expiry>=1&&red.cvc>=3,JSON.stringify(red));
 for(const v of Object.values(red))assert.equal(Number.isInteger(v),true,'counts are JSON integers');
});
