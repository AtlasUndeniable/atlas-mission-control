import {authorizeMeeting} from '@/lib/meetings/transport';
import {documentRpc,buildTaskDocument} from '@/lib/meetings/document-runtime';
import {WorkspaceRefusal} from '@/lib/workspace-authority';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Authorization','X-Content-Type-Options':'nosniff'};
const uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
function refusal(e:unknown){return Response.json({error:e instanceof WorkspaceRefusal?e.message:'Task working area unavailable. Check status before taking another action.'},{status:e instanceof WorkspaceRefusal?e.status:503,headers});}
export async function GET(request:Request){try{
 const actor=await authorizeMeeting(request),url=new URL(request.url),task=url.searchParams.get('taskId');
 if(!uuid(task))throw new WorkspaceRefusal(400,'A canonical task is required.');
 if(process.env.ATLAS_TASK_DOCUMENTS!=='1')return Response.json({available:false,reason:'Task drafting is held. Actual task, executor, context/output permissions and provider/budget decisions are required.'},{headers});
 const version=url.searchParams.get('version');const result=await documentRpc(actor,version?'artifact':'read',task!,version?{version:Number(version)}:{});
 if(version&&url.searchParams.get('download')==='1')return new Response(result.content,{headers:{...headers,'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="task-review-draft.md"'}});
 return Response.json(result,{headers});
 }catch(e){return refusal(e)}}
export async function POST(request:Request){try{
 const actor=await authorizeMeeting(request);const origin=request.headers.get('origin');
 if(!origin||new URL(origin).host!==request.headers.get('host')||new URL(origin).origin!==origin||request.headers.get('sec-fetch-site')==='cross-site')throw new WorkspaceRefusal(403,'Same-origin action required.');
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new WorkspaceRefusal(415,'JSON required.');
 const raw=await request.text();if(raw.length>8000)throw new WorkspaceRefusal(413,'Task action too large.');const b=JSON.parse(raw);
 if(Object.keys(b).some(k=>!['taskId','action','operationId','revision','version','hash','note'].includes(k))||!uuid(b.taskId)||!uuid(b.operationId)||!['build','cancel','revise','handoff','review'].includes(b.action)||!Number.isInteger(b.revision))throw new WorkspaceRefusal(400,'Invalid task action. Identity and scope are server-derived.');
 const {taskId,action,...payload}=b;
 const result=action==='build'?await buildTaskDocument(actor,taskId,{operationId:b.operationId,revision:b.revision}):await documentRpc(actor,action,taskId,payload);
 return Response.json(result,{headers});
 }catch(e){return refusal(e)}}
