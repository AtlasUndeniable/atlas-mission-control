/**
 * Payment-card redaction for meeting intake (Lane N2, per Lane P's findings).
 *
 * Runs inside normalize(), so a masked transcript is the only form that is hashed, captured,
 * stored, quoted or sent to a model. Fireflies splits a spoken card number into short hyphenated
 * digit groups across several consecutive speaker turns, and speech-to-text mangles the cue words
 * ("car details", "fiery" for expiry, "CBC" for CVC). So detection works across turns:
 *
 *  1. A payment window opens at a turn with a card, expiry or security-code cue (tolerant of the
 *     known mishearings) and stays open across following turns while they keep carrying digits or
 *     cues (bounded). Inside a window every digit run is masked except clearly formatted prices,
 *     clock times and percentages: over-masking near payment cues is preferred.
 *  2. Outside any window: a single run of 13–19 digits that passes Luhn, and any cluster of three
 *     or more consecutive mostly-numeric turns totalling 13+ digits, are masked as card data.
 *  3. Spoken digits ("four one one one …", 4+ in a row) are treated as digit runs.
 *
 * Markers: [REDACTED-CARD], [REDACTED-EXPIRY], [REDACTED-CVC]; adjacent markers of one kind merge.
 * The result carries counts per kind and never any digit.
 */
export type RedactionCounts={card:number;expiry:number;cvc:number};
export type RedactablePassage={speaker:string;text:string;start:number|null;end:number|null};

const CARD_CUE=/\b(?:card|cards|car details|card details|cart details|credit|debit|visa|master ?card|mastercard|amex|american express|long number|number on the front|front of the card|card number|payment details|bank details)\b/i;
const EXPIRY_CUE=/\b(?:expir\w*|expires?|exp(?:\.|iry)? date|exp\b|valid (?:until|till|thru|through|to)|month and (?:the )?year|fiery|expiring|expiration)\b/i;
const CVC_CUE=/\b(?:cvc|cvv|cbc|cdc|cbv|ccv|cvv2|security (?:code|number|digits)|three digits|3 digits|digits on the back|back of the card|on the back)\b/i;
const SPOKEN='(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)';
const SPOKEN_RUN=new RegExp(`\\b${SPOKEN}(?:[\\s,-]+${SPOKEN}){3,}\\b`,'gi');
// Inside a payment window, any run of two or more number words ("twelve twenty eight") is a value.
const NUMWORD='(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const NUMWORD_RUN=new RegExp(`\\b${NUMWORD}(?:[\\s,-]+(?:and\\s+)?${NUMWORD})+\\b`,'gi');
// A digit run: digits joined by single hyphens, spaces, dots, slashes, colons or commas (no letters),
// so a clock time or a thousands-separated price stays one run and can be recognised and protected.
const DIGIT_RUN=/\d(?:\d|[ \-./:,](?=\d))*/g;
const WINDOW_TURNS=10;

const digitsOf=(s:string)=>s.replace(/\D/g,'');
export function luhn(d:string){let sum=0,alt=false;for(let i=d.length-1;i>=0;i--){let n=d.charCodeAt(i)-48;if(alt){n*=2;if(n>9)n-=9}sum+=n;alt=!alt}return d.length>0&&sum%10===0}
/**
 * A clearly formatted price, clock time, percentage or unit count: not masked. R11b-1: every
 * exemption is bounded. A run with card-length digits (12+) is never exempt, whatever its
 * formatting (comma thousands, a currency sign, a following unit); unit and time words must be
 * whole tokens ("am" never matches the start of "amount"); times must have a time's shape; unit
 * counts have at most seven digits.
 */
function protectedRun(text:string,start:number,end:number){
 const before=text.slice(Math.max(0,start-2),start),after=text.slice(end,end+14).toLowerCase(),run=text.slice(start,end),d=digitsOf(run);
 if(d.length>=12)return false;
 if(/[$€£]\s?$/.test(before))return true;
 if(d.length<=7&&/^\s?(?:%|(?:percent|dollars?|bucks|k|grand|aud|usd|views|followers|clients|people|minutes|mins|hours|hrs|days|weeks|months)(?![a-z])|per (?:month|week|year)(?![a-z])|a (?:month|week|year)(?![a-z])|years old(?![a-z]))/.test(after))return true;
 if(/^\d{1,2}:\d{2}$/.test(run))return true;
 if(/^\d{1,2}(?::\d{2})?$/.test(run)&&/^\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/.test(after))return true;
 if(/^\d{1,3}(?:,\d{3})+(?:\.\d{2})?$/.test(run))return true;
 return false;
}
type Span={start:number;end:number;digits:number};
// R11b-1: inside a payment window a turn that is nothing but number words ("one", "two", "seven
// thirty") is a value, even a single word.
const ONLY_NUMWORDS=new RegExp(`^[\\s,.!?-]*(${NUMWORD}(?:[\\s,.-]+(?:and\\s+)?${NUMWORD})*)[\\s,.!?-]*$`,'i');
function runs(text:string,inWindow=false):Span[]{
 const out:Span[]=[];
 if(inWindow){const m=ONLY_NUMWORDS.exec(text);if(m){const s=text.indexOf(m[1]);out.push({start:s,end:s+m[1].length,digits:m[1].split(/[\s,.-]+/).filter(w=>w&&w.toLowerCase()!=='and').length})}}
 for(const m of text.matchAll(DIGIT_RUN)){const s=m.index!,e=s+m[0].length;out.push({start:s,end:e,digits:digitsOf(m[0]).length})}
 for(const m of text.matchAll(inWindow?NUMWORD_RUN:SPOKEN_RUN)){const s=m.index!,e=s+m[0].length;out.push({start:s,end:e,digits:m[0].split(/[\s,-]+/).filter(w=>w.toLowerCase()!=='and').length})}
 // Overlapping matches keep the earliest, longest span.
 return out.sort((a,b)=>a.start-b.start||b.end-a.end).filter((x,i,arr)=>!arr.slice(0,i).some(y=>y.start<=x.start&&y.end>=x.end));
}
const numericHeavy=(text:string)=>{
 const spoken=(text.match(SPOKEN_RUN)??[]).join(' ');
 const d=digitsOf(text).length+spoken.split(/[\s,-]+/).filter(Boolean).length;
 const letters=text.replace(SPOKEN_RUN,'').replace(/[^a-z]/gi,'').length;
 return d>=2&&d>=letters*0.6;
};
/** With no cue earlier in the same turn, the value's shape decides between expiry, card and the window's kind. */
function byShape(raw:string,windowKind:Kind):Kind{
 const t=raw.trim(),d=digitsOf(t);
 const parts=t.split(/[\s/.\-]+/);
 if(/^\d{1,2}\s?[/.\- ]\s?\d{2}(?:\d{2})?$/.test(t)&&Number(parts[0])>=1&&Number(parts[0])<=12)return 'expiry';
 if(d.length>=12)return 'card';
 return windowKind;
}
type Kind=keyof RedactionCounts;
const MARK:Record<Kind,string>={card:'[REDACTED-CARD]',expiry:'[REDACTED-EXPIRY]',cvc:'[REDACTED-CVC]'};
function cueKind(text:string):Kind|null{
 // The cue ending last decides what the following digits are; on a tie the more specific cue
 // (expiry, then security code, checked later) wins, so "back of the card" is a CVC cue.
 let best:{end:number;kind:Kind}|null=null;
 for(const [re,kind] of [[CARD_CUE,'card'],[EXPIRY_CUE,'expiry'],[CVC_CUE,'cvc']] as const){
  const g=new RegExp(re.source,'gi');for(const m of text.matchAll(g)){const end=m.index!+m[0].length;if(!best||end>=best.end)best={end,kind}}
 }
 return best?.kind??null;
}
function maskText(text:string,decide:(span:Span,kindAt:Kind|null)=>Kind|null,counts:RedactionCounts,inWindow=false){
 const spans=runs(text,inWindow);if(!spans.length)return text;
 let out='',pos=0;let lastKind:Kind|null=null;let lastEndOut=-1;
 for(const s of spans){
  if(s.start<pos)continue;
  const cueBefore=cueKind(text.slice(0,s.start));
  const kind=decide(s,cueBefore);
  if(!kind)continue;
  const gap=text.slice(pos,s.start);
  // Merge an adjacent same-kind marker separated only by punctuation/space/filler.
  if(lastKind===kind&&lastEndOut===out.length&&/^[\s,.;:\-–]*(?:and|then|um|uh)?[\s,.;:\-–]*$/i.test(gap)){pos=s.end;continue}
  out+=gap+MARK[kind];counts[kind]++;pos=s.end;lastKind=kind;lastEndOut=out.length;
 }
 return out+text.slice(pos);
}
const notProtected=(text:string)=>(s:Span)=>!protectedRun(text,s.start,s.end);

/** Masks card numbers, expiries and security codes across consecutive turns. */
export function redactCardData<P extends RedactablePassage>(passages:P[],summary:string):{passages:P[];summary:string;counts:RedactionCounts}{
 const counts:RedactionCounts={card:0,expiry:0,cvc:0};
 const n=passages.length;
 const windowKind:(Kind|null)[]=new Array(n).fill(null);
 // 1. Payment windows: open at a cue, carried forward over digit- or cue-bearing turns.
 for(let i=0;i<n;i++){
  const k=cueKind(passages[i].text);if(!k)continue;
  // The nearest preceding cue decides the kind, so later windows override earlier ones.
  windowKind[i]=k;
  let quiet=0,cur:Kind=k;
  for(let j=i+1;j<n&&j<=i+WINDOW_TURNS;j++){
   const t=passages[j].text;const has=runs(t,true).length>0;const ck=cueKind(t);
   if(!has&&!ck){if(++quiet>=2)break;continue}
   quiet=0;if(ck)cur=ck;windowKind[j]=cur;
  }
  // A read-out can start one turn before the cue ("4111-1111 … that's the card").
  if(i>0&&numericHeavy(passages[i-1].text))windowKind[i-1]=windowKind[i-1]??k;
 }
 // 2. Numeric-only clusters with no cue at all.
 const cluster=new Array(n).fill(false);
 for(let i=0;i<n;){
  if(!numericHeavy(passages[i].text)){i++;continue}
  let j=i,total=0;while(j<n&&numericHeavy(passages[j].text)){total+=runs(passages[j].text).filter(notProtected(passages[j].text)).reduce((a,s)=>a+s.digits,0);j++}
  if(j-i>=3&&total>=13)for(let x=i;x<j;x++)cluster[x]=true;
  i=j;
 }
 const masked=passages.map((p,i)=>{
  const wk=windowKind[i];
  const text=maskText(p.text,(s,cueBefore)=>{
   if(protectedRun(p.text,s.start,s.end))return null;
   if(wk)return cueBefore??byShape(p.text.slice(s.start,s.end),wk);
   if(cluster[i])return 'card';
   const d=digitsOf(p.text.slice(s.start,s.end));
   if(d.length>=13&&d.length<=19&&luhn(d))return 'card';
   return null;
  },counts,windowKind[i]!==null);
  return text===p.text?p:{...p,text};
 });
 // The provider summary is one text: the whole text is its own window if it has a cue.
 return {passages:masked,summary:redactSingle(summary,counts),counts};
}
/** One free-standing text (summary, title, speaker name): its own window when it carries a cue. */
function redactSingle(text:string,counts:RedactionCounts){
 const sk=cueKind(text);
 return maskText(text,(s,cueBefore)=>{
  if(protectedRun(text,s.start,s.end))return null;
  if(sk)return cueBefore??byShape(text.slice(s.start,s.end),sk);
  const d=digitsOf(text.slice(s.start,s.end));return d.length>=13&&d.length<=19&&luhn(d)?'card':null;
 },counts,sk!==null);
}
/**
 * The contract (R11b-1): transcript turns, the provider summary, the meeting title (in the catalog
 * row and in the captured source) and speaker names are masked. Participant emails, the
 * organizer, ids and timestamps are identifiers, not free text, and are not altered.
 */
export function redactText(text:string):{text:string;counts:RedactionCounts}{
 const counts:RedactionCounts={card:0,expiry:0,cvc:0};return {text:redactSingle(text,counts),counts};
}
