import {NextRequest,NextResponse} from 'next/server';
import {authorizeMeeting,meetingRpc} from '@/lib/meetings/transport';
import {WorkspaceRefusal} from '@/lib/workspace-authority';
import {refusedEditFields,type BoardCapability} from '@/lib/board/presentation';
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
 // Review finding R6: owner, executor, next step and reviewer are not triage rights, so
 // the same server-derived capability the board renders from also refuses the fields here.
 // Hiding a control is a presentation choice; this is the boundary, and it reads the
 // capability from the service on every mutation rather than trusting the browser.
 if(action==='edit'){
  // One `list` supplies both halves from the service: meeting_queue('list') returns
  // public.meeting_capability() alongside the rows this actor may see, so the capability
  // and the task's recorded executor are read together and neither comes from the browser.
  const queue=await meetingRpc(actor,'list',{}) as {capability?:BoardCapability;meetings?:{items?:{id?:string;task?:{executor?:string|null;next_reviewer?:string|null}}[]}[]}|null;
  const id=(payload as {id?:unknown}).id;
  const item=queue?.meetings?.flatMap(m=>m.items??[]).find(x=>x.id===id);
  const refused=refusedEditFields(queue?.capability,payload as Record<string,unknown>,item?.task);
  if(refused.length)throw new WorkspaceRefusal(403,'Who owns this, who does it and who reviews it are set by the person accountable for it. Your change was not saved.');
 }
 return NextResponse.json(await meetingRpc(actor,action,payload),{headers});
 }catch(e){return refusal(e)}}
