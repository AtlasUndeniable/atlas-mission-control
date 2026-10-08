import {workspacePrincipal,WorkspaceRefusal} from '../workspace-authority';
export async function meetingRpc(principal:string,action:string,payload:object={}){
 if(process.env.ATLAS_MEETING_QUEUE!=='1')throw new WorkspaceRefusal(503,'Meeting queue is not enabled.');
 const config=JSON.parse(process.env.ATLAS_MEETING_TRANSPORT||'{}');const token=config.principals?.[principal];
 if(!token||!config.url)throw new WorkspaceRefusal(403,'Named meeting access is not configured.');
 const headers:Record<string,string>={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 // Hosted Supabase authenticates the gateway separately from the scoped RPC role.
 // Never substitute the gateway key for the principal bearer or load a service key implicitly.
 if(typeof config.apiKey==='string'&&config.apiKey)headers.apikey=config.apiKey;
 if(new URL(config.url).hostname.endsWith('.supabase.co')&&!headers.apikey)throw new WorkspaceRefusal(503,'Meeting gateway credential is not configured.');
 const response=await fetch(`${String(config.url).replace(/\/$/,'')}/rpc/${action==='capability'?'meeting_capability':'meeting_queue'}`,{method:'POST',headers,body:JSON.stringify(action==='capability'?{}:{action,payload}),cache:'no-store',signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok)throw new WorkspaceRefusal(data.code==='42501'?403:data.code==='PT409'?409:400,data.message||'Meeting operation refused.');
 if(action==='capability'&&data.actor!==principal)throw new WorkspaceRefusal(403,'Named credential binding mismatch.');return data;
}
export async function authorizeMeeting(request:Request){const principal=workspacePrincipal(request);await meetingRpc(principal,'capability');return principal;}
