import {NextRequest,NextResponse} from 'next/server';
import {authorizeMeeting} from '@/lib/meetings/transport';
import {listPayload,parseMappingList,validMappingRequest} from '@/lib/board/client-mapping';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Authorization'};
// Off unless the install turns it on. The hosted RPC decides who may list and resolve.
const enabled=()=>process.env.ATLAS_CLIENT_MAPPING_VIEW==='1';
async function rpc(actor:string,body:object){const c=JSON.parse(process.env.ATLAS_MEETING_TRANSPORT||'{}');const r=await fetch(c.url.replace(/\/$/,'')+'/rpc/meeting_client_mapping',{method:'POST',headers:{Authorization:`Bearer ${c.principals[actor]}`,'Content-Type':'application/json',...(c.apiKey?{apikey:c.apiKey}:{})},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('client_mapping_unavailable');return r.json()}
export async function GET(request:NextRequest){
 try{const actor=await authorizeMeeting(request);
  if(!enabled())return NextResponse.json({status:'disabled',items:[],clients:[]},{headers});
  return NextResponse.json({status:'ok',...parseMappingList(await rpc(actor,{action:'list',payload:listPayload(request.nextUrl.searchParams)}))},{headers});
 }catch{return NextResponse.json({status:'unavailable',items:[],clients:[]},{status:503,headers})}
}
export async function POST(request:NextRequest){
 try{const actor=await authorizeMeeting(request);if(!enabled())return NextResponse.json({error:'Client mapping is switched off'},{status:503,headers});
  const origin=request.headers.get('origin');if(!origin||new URL(origin).host!==request.headers.get('host')||request.headers.get('sec-fetch-site')==='cross-site')return NextResponse.json({error:'Cross-origin request refused'},{status:403,headers});
  const text=await request.text();if(text.length>4000)throw Error('too_large');
  const body=validMappingRequest(JSON.parse(text));if(!body)throw Error('invalid');
  return NextResponse.json(await rpc(actor,body),{headers});
 }catch{return NextResponse.json({error:'That choice was not saved. Someone may have changed this call already; check again before retrying.'},{status:409,headers})}
}
