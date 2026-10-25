/**
 * Isolated synthetic hosted service for the supervised REMOTE acceptance test (R16 finding 6).
 *
 * It implements the same Hosted interface from a local, owner-only fixture file, for
 * synthetic actors only (hostedActor `synthetic_*`, enforced by the config loader). It never
 * reads Mission Control's transport file, never holds a production JWT and makes no network
 * call, so the acceptance test cannot read or release real business data. The switch to real
 * data is a different config file (production hostedSource, real actor `nat`) and a new
 * token, after its own decision.
 *
 * Fixture shape (config/acceptance-fixture.json):
 *   {"version": "...", "synthetic": true,
 *    "actors": {"synthetic_nat": {"capability": {...}, "meetings": [HostedMeeting...], "contexts": {"<id>": Context}}}}
 */
import {readOwnerOnlyFile} from './auth.ts';
import {HostedRefusal, type Capability, type Context, type Hosted, type HostedMeeting, type Queue} from './hosted.ts';

type Fixture = {version: string; synthetic: true; actors: Record<string, {capability: Capability; meetings: HostedMeeting[]; contexts?: Record<string, Context>}>};

export function loadSyntheticFixture(file: string): Fixture {
  const f = JSON.parse(readOwnerOnlyFile(file, 'synthetic_fixture')) as Fixture;
  if (!f || f.synthetic !== true || typeof f.version !== 'string' || !f.actors || typeof f.actors !== 'object') throw Error('atlas_mcp_synthetic_fixture_invalid');
  for (const [actor, a] of Object.entries(f.actors)) {
    if (!/^synthetic_[a-z0-9_]{1,20}$/.test(actor)) throw Error('atlas_mcp_synthetic_fixture_actor');
    if (!a.capability || a.capability.actor !== actor || !Array.isArray(a.meetings)) throw Error('atlas_mcp_synthetic_fixture_invalid');
  }
  return f;
}

export function syntheticHosted(fixture: Fixture): Hosted {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const actor = (name: string) => {
    const a = fixture.actors[name];
    if (!a) throw new HostedRefusal(403, 'Named hosted access is not configured for this principal.');
    return a;
  };
  const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new HostedRefusal(503, 'Hosted service unavailable.'); };
  return {
    async capability(name, signal) { check(signal); return clone(actor(name).capability); },
    async list(name, signal): Promise<Queue> { check(signal); const a = actor(name); return {capability: clone(a.capability), meetings: clone(a.meetings)}; },
    async context(name, sourceId, signal) {
      check(signal);
      const a = actor(name);
      const m = a.meetings.find(x => x.id === sourceId && x.taskOnly !== true);
      const c = a.contexts?.[sourceId];
      if (!m || !c) throw new HostedRefusal(403, 'Hosted service refused the read.');
      return clone(c);
    },
    async documentRead(name, _taskId, signal) { check(signal); actor(name); return {status: 403, body: {code: '42501'}}; },
    async documentArtifact(name, _taskId, _version, signal) { check(signal); actor(name); return {status: 403, body: {code: '42501'}}; },
  };
}
