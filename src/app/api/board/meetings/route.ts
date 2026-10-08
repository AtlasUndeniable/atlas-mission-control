import {NextRequest,NextResponse} from 'next/server';
import {authorizeMeeting,meetingRpc} from '@/lib/meetings/transport';
import {WorkspaceRefusal} from '@/lib/workspace-authority';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Authorization'};
function refusal(error:unknown){return NextResponse.json({error:error instanceof WorkspaceRefusal?error.message:'Meeting service unavailable'},{status:error instanceof WorkspaceRefusal?error.status:503,headers});}
export async function GET(request:NextRequest){try{const actor=await authorizeMeeting(request);const id=request.nextUrl.searchParams.get('sourceId');return NextResponse.json(await meetingRpc(actor,id?'context':'list',id?{sourceId:id,...(request.nextUrl.searchParams.get('itemId')?{id:request.nextUrl.searchParams.get('itemId')}:{})}:{}),{headers})}catch(e){return refusal(e)}}
export async function POST(request:NextRequest){try{
 const actor=await authorizeMeeting(request);
 // Next normalizes loopback nextUrl to localhost. Browser Origin must match the
 // actual Host; forwarded-host is deliberately not trusted as an alternate.
 const origin=request.headers.get('origin');
 if(origin){let allowed=false;try{const parsed=new URL(origin);allowed=['http:','https:'].includes(parsed.protocol)&&parsed.origin===origin&&parsed.host===request.headers.get('host')}catch{}
  if(!allowed||request.headers.get('sec-fetch-site')==='cross-site')throw new WorkspaceRefusal(403,'Cross-origin action refused.');}

 const text=await request.text();if(text.length>64000)throw new WorkspaceRefusal(413,'Review request is too large.');
 const {action,payload}=JSON.parse(text);if(!['edit','accept','defer','dismiss','complete','review','request_changes','retain_original','source_review'].includes(action)||!payload||typeof payload!=='object'||Array.isArray(payload))throw new WorkspaceRefusal(400,'Invalid review operation.');
 return NextResponse.json(await meetingRpc(actor,action,payload),{headers});
 }catch(e){return refusal(e)}}
