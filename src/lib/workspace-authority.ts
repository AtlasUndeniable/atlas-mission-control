/** Server-only transport: no caller-selected actor, audience, client or token. */
export type WorkspaceActor = { actor: string; workspaceId: string; role: 'super_admin'|'admin'|'builder'; financial: boolean };
export class WorkspaceRefusal extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status=status; }
}
function transport(principal: string) {
  const config = JSON.parse(process.env.ATLAS_STAFF_TRANSPORT || '{}');
  const token = config.principals?.[principal];
  if (!token || !config.url) throw new WorkspaceRefusal(403, 'Workspace access is not configured for this login.');
  return { url: String(config.url).replace(/\/$/, ''), token: String(token) };
}
export async function workspaceRpc(principal: string, name: 'workspace_capability'|'workspace_action'|'task_card', body: object = {}) {
  const {url,token}=transport(principal);
  const response=await fetch(`${url}/rpc/${name}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(!response.ok) throw new WorkspaceRefusal(data.code==='42501'?403:data.code==='PT409'?409:400, data.message || 'Workspace operation refused.');
  return data;
}
export async function workspaceActor(principal: string): Promise<WorkspaceActor> {
  const actor = await workspaceRpc(principal,'workspace_capability');
  if(actor.actor!==principal)throw new WorkspaceRefusal(403,'Workspace credential binding mismatch.');
  return actor;
}
export function workspacePrincipal(request: Request): string {
  if(request.headers.get('x-mc-principal-kind')!=='named') throw new WorkspaceRefusal(403,'Named login required.');
  const principal=request.headers.get('x-mc-principal');
  if(!principal) throw new WorkspaceRefusal(403,'Named login required.');
  return principal;
}
