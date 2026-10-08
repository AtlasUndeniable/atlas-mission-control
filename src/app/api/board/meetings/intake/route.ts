import {NextRequest,NextResponse} from 'next/server';
import {authorizeMeeting} from '@/lib/meetings/transport';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Authorization'};
async function rpc(actor:string,name:string,body:object){const c=JSON.parse(process.env.ATLAS_MEETING_TRANSPORT||'{}');const r=await fetch(c.url.replace(/\/$/,'')+'/rpc/'+name,{method:'POST',headers:{Authorization:`Bearer ${c.principals[actor]}`,'Content-Type':'application/json',...(c.apiKey?{apikey:c.apiKey}:{})},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('intake_unavailable');return r.json()}
export async function GET(request:NextRequest){
 try{const actor=await authorizeMeeting(request);
  if(process.env.ATLAS_MEETING_INTAKE_VIEW!=='1')return NextResponse.json({status:'disabled',message:'Recurring intake is disabled. Existing proposals do not establish current meeting coverage.'},{headers});
  const data=await rpc(actor,'meeting_intake_operational_coverage',{});
  if(data.visibility==='reviewer'){const review=await rpc(actor,'meeting_intake_review',{action:'list',payload:{}});data.candidates=review.candidates;data.relations=review.relations;}
  return NextResponse.json(data,{headers});
 }catch{return NextResponse.json({status:'unavailable',message:'Meeting coverage could not be checked. Do not treat this board as current.'},{status:503,headers})}
}
export async function POST(request:NextRequest){
 try{const actor=await authorizeMeeting(request);if(process.env.ATLAS_MEETING_INTAKE_VIEW!=='1')return NextResponse.json({error:'Intake review disabled'},{status:503,headers});
  const origin=request.headers.get('origin');if(!origin||new URL(origin).host!==request.headers.get('host')||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Cross-origin review refused'},{status:403,headers});
  const text=await request.text();if(text.length>12000)throw Error('review_too_large');const body=JSON.parse(text);
  if(body.action!=='decide'||!body.payload||Array.isArray(body.payload))throw Error('invalid_review');
  return NextResponse.json(await rpc(actor,'meeting_intake_review',body),{headers});
 }catch{return NextResponse.json({error:'Review was refused or its outcome is uncertain. Check saved status before retrying; no task completion or send is implied.'},{status:409,headers})}
}
