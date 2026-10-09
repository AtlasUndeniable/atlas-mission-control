import {execFileSync} from 'node:child_process';import {createHmac} from 'node:crypto';
const CONTAINER=process.env.ATLAS_FIXTURE_CONTAINER||'atlas-task-docs-20260922';const REST=process.env.ATLAS_FIXTURE_REST_PORT||'55825';
export const sql=(s,user='postgres')=>execFileSync('docker',['exec','-i',CONTAINER,'psql','-X','-U',user,'-d','docs','-v','ON_ERROR_STOP=1','-At','-q'],{input:s,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
export const lit=s=>"'"+s.replaceAll("'","''")+"'";
export const jlit=x=>lit(JSON.stringify(x))+'::jsonb';
export const token=role=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),b=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');return a+'.'+b+'.'+createHmac('sha256','task-document-synthetic-only-2026-0000000001').update(a+'.'+b).digest('base64url')};
export const roles={nat:'atlas_meeting_nat_web',rhys:'atlas_meeting_rhys_web',outsider:'docs_outsider',runtime:'docs_runtime',ingest:'atlas_meeting_astra_20260911_ingest'};
export async function rpc(actor,name,body){const r=await fetch('http://127.0.0.1:'+REST+'/rpc/'+name,{method:'POST',headers:{Authorization:'Bearer '+token(roles[actor]),'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}}
