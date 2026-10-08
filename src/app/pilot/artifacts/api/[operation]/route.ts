import {NextRequest} from 'next/server';
import {pilotCredential,isPilotLogin} from '@/lib/artifact-pilot-auth';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const deny=(status:number,code='backend_unavailable')=>Response.json({status:'unavailable',code},{status,headers:{'Cache-Control':'no-store'}});
 // These four operations authenticate here before reading any body. Next middleware
 // buffers request bodies before dispatch, so its matcher excludes exactly these paths.
 // Never trust caller-supplied x-mc-principal headers on this boundary.
 if(!pilotCredential(process.env))return deny(503);
 if(!isPilotLogin(req.headers.get('authorization'),process.env))return deny(403,'access_refused');
 const {operation}=await params;if(!['list','review','content','approve'].includes(operation))return deny(404);
 const origin=req.headers.get('origin');try{if(!origin||new URL(origin).host!==req.headers.get('host')||new URL(origin).origin!==origin||req.headers.get('sec-fetch-site')==='cross-site')return deny(403,'access_refused')}catch{return deny(403,'access_refused')}
 if(process.env.ATLAS_DANTE_PILOT_REVIEW_ENABLED!=='1')return deny(503,'backend_held');
 try{
  // No caller-controlled upstream URL, identity or filesystem path. Preserve the authenticated login.
  const reader=req.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  let deadline:ReturnType<typeof setTimeout>|undefined,timedOut=false;
  const timeout=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{timedOut=true;reject(Error('body timeout'));void reader?.cancel()},5000)});
  try{if(reader)for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return deny(413)}chunks.push(value)}}finally{clearTimeout(deadline)}
  if(timedOut)return deny(408);
  const body=Buffer.concat(chunks);const upstream=await fetch('http://127.0.0.1:4020/offer/'+operation,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:req.headers.get('authorization')||'',Origin:process.env.ATLAS_DANTE_REVIEW_ORIGIN||''},body,signal:AbortSignal.timeout(6000),cache:'no-store'});
  const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});for(const name of ['content-type','content-disposition','content-security-policy','x-atlas-preview-proof']){const value=upstream.headers.get(name);if(value)headers.set(name,value)}return new Response(upstream.body,{status:upstream.status,headers});
 }catch{return deny(503)}
}
