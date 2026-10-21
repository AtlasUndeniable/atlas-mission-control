/**
 * Transports and boundaries: token rejection (HTTP and stdio), loopback-only binding,
 * Host/Origin checks, the MCP handshake, read-only tool surface and hosted allowlist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setup} from './fixtures.ts';
import {listen, runStdio} from '../src/server.ts';
import {parseConfig} from '../src/config.ts';
import {hostedClient, HostedRefusal} from '../src/hosted.ts';
import {TOOL_DEFS} from '../src/tools.ts';
import {newToken} from '../src/auth.ts';
import {readRegistry, writeRegistry} from '../src/auth.ts';

async function withServer(fn: (url: string, s: ReturnType<typeof setup>) => Promise<void>) {
  const s = setup();
  const srv = await listen(s);
  const addr = srv.address();
  assert.ok(addr && typeof addr === 'object');
  assert.equal(addr.address, '127.0.0.1', 'must bind loopback only');
  try { await fn(`http://127.0.0.1:${addr.port}/mcp`, s); } finally { await new Promise(r => srv.close(r)); }
}
const rpc = (method: string, params: object = {}, id: number | null = 1) => JSON.stringify({jsonrpc: '2.0', ...(id === null ? {} : {id}), method, params});
const post = (url: string, body: string, headers: Record<string, string> = {}) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body});

test('HTTP: missing, malformed, unknown and revoked tokens are rejected with 401', async () => {
  await withServer(async (url, s) => {
    for (const auth of [undefined, 'Bearer nope', `Bearer ${newToken()}`, `Basic ${s.tokens.rhys}`]) {
      const r = await post(url, rpc('tools/list'), auth ? {authorization: auth} : {});
      assert.equal(r.status, 401, String(auth).slice(0, 12));
    }
    const reg = readRegistry(s.config.tokensFile);
    reg.tokens.find(t => t.principal === 'nat')!.revoked = true;
    writeRegistry(s.config.tokensFile, reg);
    assert.equal((await post(url, rpc('tools/list'), {authorization: `Bearer ${s.tokens.nat}`})).status, 401);
  });
});

test('HTTP: Host and Origin must be loopback (DNS-rebinding guard); only POST /mcp', async () => {
  await withServer(async (url, s) => {
    const auth = {authorization: `Bearer ${s.tokens.rhys}`};
    assert.equal((await post(url, rpc('tools/list'), {...auth, origin: 'https://evil.example'})).status, 403);
    assert.equal((await fetch(url, {headers: auth})).status, 405);
    assert.equal((await post(url.replace('/mcp', '/other'), rpc('tools/list'), auth)).status, 404);
    const {request} = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(url);
      const req = request({host: '127.0.0.1', port: u.port, path: '/mcp', method: 'POST', headers: {...auth, host: 'attacker.example', 'content-type': 'application/json'}}, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end(rpc('tools/list'));
    });
    assert.equal(status, 421);
  });
});

test('HTTP: MCP handshake, tools/list (read-only tools only) and a tool call', async () => {
  await withServer(async (url, s) => {
    const auth = {authorization: `Bearer ${s.tokens.grok_as_nat}`};
    const init = await (await post(url, rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}}), auth)).json();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'atlas-mcp');
    assert.equal((await post(url, rpc('notifications/initialized', {}, null), auth)).status, 202);
    const list = await (await post(url, rpc('tools/list'), auth)).json();
    const names = list.result.tools.map((t: {name: string}) => t.name).sort();
    assert.deepEqual(names, ['ask_call', 'capabilities', 'get_draft', 'get_task', 'list_tasks', 'search_calls', 'whoami']);
    assert.ok(list.result.tools.every((t: {annotations: {readOnlyHint: boolean}}) => t.annotations.readOnlyHint === true));
    const who = await (await post(url, rpc('tools/call', {name: 'whoami', arguments: {}}), auth)).json();
    assert.equal(who.result.structuredContent.principal, 'grok_as_nat');
    assert.equal(who.result.structuredContent.hostedActor, 'nat');
    const bad = await (await post(url, rpc('tools/call', {name: 'create_task', arguments: {}}), auth)).json();
    assert.equal(bad.result.isError, true);
  });
});

test('stdio: token rejected before reading input; accepted token serves tools', async () => {
  const s = setup();
  await assert.rejects(runStdio(s, 'atlas_mcp_' + 'A'.repeat(43), new PassThrough(), new PassThrough()), /token_rejected/);
  const input = new PassThrough(), output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', c => chunks.push(String(c)));
  const done = runStdio(s, s.tokens.rhys, input, output);
  input.write(rpc('initialize', {protocolVersion: '2025-03-26'}) + '\n');
  input.write(rpc('tools/call', {name: 'list_tasks', arguments: {owner: 'rhys'}}, 2) + '\n');
  input.end();
  await done;
  const lines = chunks.join('').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].result.protocolVersion, '2025-03-26');
  assert.equal(lines[1].result.structuredContent.count, 1);
});

test('config refuses any host other than 127.0.0.1 and unknown tools', () => {
  const s = setup();
  const base = {...s.config, rateLimits: s.config.rateLimits, askCall: s.config.askCall};
  for (const host of ['0.0.0.0', 'localhost', '::', '192.168.1.5']) assert.throws(() => parseConfig({...base, host}), /host_must_be_127/);
  assert.throws(() => parseConfig({...base, principals: {xx: {hostedActor: 'nat', scope: 'granted', tools: ['create_task'], label: 'x'}}}), /tools/);
  assert.throws(() => parseConfig({...base, askCall: {...base.askCall, model: 'claude-opus-5'}}), /model/);
});

test('no Phase A tool is a write tool', () => {
  assert.deepEqual(TOOL_DEFS.map(t => t.name).sort(), ['ask_call', 'capabilities', 'get_draft', 'get_task', 'list_tasks', 'search_calls', 'whoami']);
});

test('hosted client: only read actions leave the process; principal binding is checked', async () => {
  const sent: string[] = [];
  const transport = (async (url: unknown, init?: RequestInit) => {
    sent.push(`${String(url).split('/rpc/')[1]}:${JSON.parse(String(init?.body)).action ?? ''}`);
    return new Response(JSON.stringify({actor: 'nat', review: false, triage: true, rhysActor: 'rhys'}), {status: 200});
  }) as typeof fetch;
  const h = hostedClient({url: 'http://127.0.0.1:1', principals: {nat: 'jwt-nat', rhys: 'jwt-rhys'}}, transport);
  await h.capability('nat');
  await assert.rejects(h.capability('rhys'), (e: unknown) => e instanceof HostedRefusal && e.status === 403, 'binding mismatch');
  await assert.rejects(h.documentRead('ghost', 'x'), HostedRefusal);
  // Internal escape hatch check: the rpc allowlist is closed over; write actions cannot be expressed.
  assert.deepEqual(Object.keys(h).sort(), ['capability', 'context', 'documentArtifact', 'documentRead', 'list']);
  assert.deepEqual(sent, ['meeting_capability:', 'meeting_capability:']);
});
