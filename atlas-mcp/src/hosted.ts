/**
 * Hosted (Supabase PostgREST) access through the EXISTING principal pattern: each hosted
 * actor's own scoped JWT from Mission Control's ATLAS_MEETING_TRANSPORT, read in memory
 * from the env file and never written, logged or returned. There is no service key path.
 *
 * Read-only allowlist: meeting_capability, meeting_queue('list'|'context') and
 * meeting_document('read'|'artifact'). Anything else is refused here, before any request.
 */
import {readFileSync} from 'node:fs';

export type HostedTransport = {url: string; apiKey?: string; principals: Record<string, string>};
export type Capability = {actor: string; triage: boolean; review: boolean; rhysActor: string | null};
export type Evidence = {quote?: string; speaker?: string; start?: number; end?: number; title?: string; kind?: string; provenance?: string};
export type HostedTask = Record<string, unknown> & {id?: string; client?: string; owner?: string; executor?: string | null; next_reviewer?: string | null; work_status?: string; title?: string; due?: string | null};
export type HostedItem = {id: string; title: string; due: string | null; owner: string | null; state: string; deferred?: boolean; evidence?: Evidence; task: HostedTask | null};
// taskOnly: the hosted queue returns limited reviewed task context for meetings the actor
// may NOT read in full (021 meeting_task_grants). Such a row never grants transcript access.
// classification: the REQUIRED contract field for scoped release (R16 finding 2). The current
// installed meeting_queue does not emit it, so scoped callers are withheld everything unless a
// reviewed hosted projection adds it or a recorded decision sets classificationEnforcement=allow.
export type HostedMeeting = {id: string; title: string; instant: string; state: string; items: HostedItem[]; taskOnly?: boolean; clientLabel?: string; classification?: string};
export type Queue = {capability: Capability; meetings: HostedMeeting[]};
export type Passage = {speaker: string; text: string; start: number; end: number};
export type Context = {source: {id: string; title: string; instant: string; summary?: string; passages: Passage[]}};
export type DocumentResult = {status: number; body: Record<string, unknown> | null};

export class HostedRefusal extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const READ_ACTIONS: Record<string, string[]> = {
  meeting_capability: [''],
  meeting_queue: ['list', 'context'],
  meeting_document: ['read', 'artifact'],
};

export function loadTransportFromEnvFile(file: string): HostedTransport {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new HostedRefusal(503, 'Hosted transport configuration is unavailable.'); }
  const line = text.split('\n').find(l => l.startsWith('ATLAS_MEETING_TRANSPORT='));
  if (!line) throw new HostedRefusal(503, 'Hosted transport configuration is unavailable.');
  let v = line.slice('ATLAS_MEETING_TRANSPORT='.length).trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  let cfg: HostedTransport;
  try { cfg = JSON.parse(v); } catch { throw new HostedRefusal(503, 'Hosted transport configuration is invalid.'); }
  if (!cfg || typeof cfg.url !== 'string' || !cfg.principals || typeof cfg.principals !== 'object') throw new HostedRefusal(503, 'Hosted transport configuration is invalid.');
  const u = new URL(cfg.url);
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new HostedRefusal(503, 'Hosted transport must be HTTPS.');
  return cfg;
}

/** Every read takes an optional AbortSignal: the caller's end-to-end deadline (R16 finding 7). */
export type Hosted = {
  capability(actor: string, signal?: AbortSignal): Promise<Capability>;
  list(actor: string, signal?: AbortSignal): Promise<Queue>;
  context(actor: string, sourceId: string, signal?: AbortSignal): Promise<Context>;
  documentRead(actor: string, taskId: string, signal?: AbortSignal): Promise<DocumentResult>;
  documentArtifact(actor: string, taskId: string, version: number, signal?: AbortSignal): Promise<DocumentResult>;
};

export function hostedClient(transport: HostedTransport, request: typeof fetch = fetch, timeoutMs = 15000): Hosted {
  async function rpc(actor: string, fn: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{status: number; data: unknown}> {
    if (signal?.aborted) throw new HostedRefusal(503, 'Hosted service unavailable.');
    const action = typeof body.action === 'string' ? body.action : '';
    if (!READ_ACTIONS[fn]?.includes(action)) throw new HostedRefusal(403, 'Phase A is read-only; this hosted action is not allowed.');
    const token = transport.principals[actor];
    if (typeof token !== 'string' || !token) throw new HostedRefusal(403, 'Named hosted access is not configured for this principal.');
    const headers: Record<string, string> = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
    if (typeof transport.apiKey === 'string' && transport.apiKey) headers.apikey = transport.apiKey;
    if (new URL(transport.url).hostname.endsWith('.supabase.co') && !headers.apikey) throw new HostedRefusal(503, 'Hosted gateway credential is not configured.');
    let response: Response;
    try {
      response = await request(`${transport.url.replace(/\/$/, '')}/rpc/${fn}`, {method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)});
    } catch { throw new HostedRefusal(503, 'Hosted service unavailable.'); }
    let data: unknown = null;
    try { data = await response.json(); } catch { data = null; }
    return {status: response.status, data};
  }
  const ok = (r: {status: number; data: unknown}) => {
    if (r.status >= 200 && r.status < 300) return r.data;
    const code = (r.data as {code?: string} | null)?.code;
    throw new HostedRefusal(code === '42501' || r.status === 401 || r.status === 403 ? 403 : 502, 'Hosted service refused the read.');
  };
  return {
    async capability(actor, signal) {
      const cap = ok(await rpc(actor, 'meeting_capability', {}, signal)) as Capability;
      // Same binding check as Mission Control's meetingRpc: the token must be this actor's.
      if (!cap || cap.actor !== actor) throw new HostedRefusal(403, 'Named credential binding mismatch.');
      return cap;
    },
    async list(actor, signal) {
      const q = ok(await rpc(actor, 'meeting_queue', {action: 'list', payload: {}}, signal)) as Queue;
      if (!q || !Array.isArray(q.meetings) || q.capability?.actor !== actor) throw new HostedRefusal(403, 'Named credential binding mismatch.');
      return q;
    },
    async context(actor, sourceId, signal) {
      return ok(await rpc(actor, 'meeting_queue', {action: 'context', payload: {sourceId}}, signal)) as Context;
    },
    async documentRead(actor, taskId, signal) {
      const r = await rpc(actor, 'meeting_document', {action: 'read', task_id: taskId, payload: {}}, signal);
      return {status: r.status, body: (r.data && typeof r.data === 'object' ? r.data : null) as Record<string, unknown> | null};
    },
    async documentArtifact(actor, taskId, version, signal) {
      const r = await rpc(actor, 'meeting_document', {action: 'artifact', task_id: taskId, payload: {version}}, signal);
      return {status: r.status, body: (r.data && typeof r.data === 'object' ? r.data : null) as Record<string, unknown> | null};
    },
  };
}
