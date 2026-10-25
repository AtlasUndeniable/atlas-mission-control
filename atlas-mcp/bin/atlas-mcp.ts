#!/usr/bin/env node
/**
 * Atlas MCP Phase A command line.
 *   node atlas-mcp/bin/atlas-mcp.ts http        [--config FILE]   serve streamable HTTP on 127.0.0.1 (local)
 *   node atlas-mcp/bin/atlas-mcp.ts stdio       [--config FILE] --token-file FILE
 *   node atlas-mcp/bin/atlas-mcp.ts index       [--config FILE]   refresh the call index (counts only)
 *   node atlas-mcp/bin/atlas-mcp.ts mint-token  [--config FILE] --principal NAME --out FILE [--label TEXT] [--expires-days N]
 *   node atlas-mcp/bin/atlas-mcp.ts revoke      [--config FILE] --sha256-prefix HEX
 *   node atlas-mcp/bin/atlas-mcp.ts policy-check [--config FILE]  validate the sensitivity policy (counts only)
 * Lane X exposure (its OWN config file; prepared, not enabled):
 *   node atlas-mcp/bin/atlas-mcp.ts exposure-http    --config FILE   tunnel origin on 127.0.0.1:<exposure.port>
 *   node atlas-mcp/bin/atlas-mcp.ts exposure-kill    --config FILE [--revoke-tokens]   refuse ALL external requests now
 *   node atlas-mcp/bin/atlas-mcp.ts exposure-resume  --config FILE --confirm
 *   node atlas-mcp/bin/atlas-mcp.ts exposure-status  --config FILE
 *   node atlas-mcp/bin/atlas-mcp.ts rotate           --config FILE --principal NAME --out FILE --expires-days N
 *   node atlas-mcp/bin/atlas-mcp.ts revoke-principal --config FILE --principal NAME
 * Nothing here prints a token, credential or transcript text.
 */
import {existsSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.ts';
import {assemble, listen, readTokenFile, runStdio} from '../src/server.ts';
import {CallIndex} from '../src/call-index.ts';
import {mintEntry, readRegistry, revokePrincipal, writeRegistry} from '../src/auth.ts';
import {PolicySource} from '../src/sensitivity.ts';
import {assertDeployable, checkAuditSink, clearRuntimeBinding, engageKill, exposureProcessAlive, fileSha256, killed, listenExposure, releaseKill, requireExposure, verifyResumeBinding, writeRuntimeBinding} from '../src/exposure.ts';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
const flag = (name: string) => argv.includes(`--${name}`);
const configFile = opt('config') ?? process.env.ATLAS_MCP_CONFIG ?? join(homedir(), '.config/atlas/atlas-mcp/config.json');
const log = (o: object) => process.stderr.write(JSON.stringify({at: new Date().toISOString(), ...o}) + '\n');
const days = (v: string | undefined, required: boolean) => {
  if (v === undefined) { if (required) throw Error('--expires-days required'); return undefined; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw Error('--expires-days must be 1..365');
  return n;
};
const newOut = (out: string | undefined) => { if (!out || !out.startsWith('/') || existsSync(out)) throw Error('--out must be a new absolute path'); return out; };

async function main() {
  process.umask(0o077); // every file this process creates is owner-only
  const config = loadConfig(configFile);
  if (cmd === 'index') {
    const idx = new CallIndex(join(config.stateDir, 'calls-index.sqlite'), config.brainCallsDir);
    const t = Date.now();
    const r = idx.refresh();
    console.log(JSON.stringify({...r, calls: idx.count(), ms: Date.now() - t}));
    return;
  }
  if (cmd === 'mint-token') {
    const principal = opt('principal'), out = newOut(opt('out'));
    if (!principal || !config.principals[principal]) throw Error('unknown principal');
    const expiresDays = days(opt('expires-days'), !!config.exposure);
    if (config.exposure && expiresDays! > config.exposure.tokenMaxAgeDays) throw Error('--expires-days exceeds exposure.tokenMaxAgeDays');
    const {token, entry} = mintEntry(principal, opt('label') ?? principal, expiresDays);
    writeFileSync(out, token + '\n', {mode: 0o600, flag: 'wx'});
    const reg = readRegistry(config.tokensFile);
    reg.tokens.push(entry);
    writeRegistry(config.tokensFile, reg);
    console.log(JSON.stringify({principal, tokenFile: out, sha256Prefix: entry.sha256.slice(0, 12), expires: entry.expires ?? null}));
    return;
  }
  if (cmd === 'rotate') {
    // New token first, then every other active token of the principal is revoked in the same write.
    const principal = opt('principal'), out = newOut(opt('out'));
    if (!principal || !config.principals[principal]) throw Error('unknown principal');
    const expiresDays = days(opt('expires-days'), true)!;
    if (config.exposure && expiresDays > config.exposure.tokenMaxAgeDays) throw Error('--expires-days exceeds exposure.tokenMaxAgeDays');
    const {token, entry} = mintEntry(principal, opt('label') ?? `${principal} (rotated)`, expiresDays);
    writeFileSync(out, token + '\n', {mode: 0o600, flag: 'wx'});
    const reg = readRegistry(config.tokensFile);
    reg.tokens.push(entry);
    const revoked = revokePrincipal(reg, principal, entry.sha256);
    writeRegistry(config.tokensFile, reg);
    console.log(JSON.stringify({principal, tokenFile: out, sha256Prefix: entry.sha256.slice(0, 12), expires: entry.expires, revokedPrevious: revoked}));
    return;
  }
  if (cmd === 'revoke') {
    const prefix = opt('sha256-prefix');
    if (!prefix || !/^[0-9a-f]{8,64}$/.test(prefix)) throw Error('--sha256-prefix required');
    const reg = readRegistry(config.tokensFile);
    const hits = reg.tokens.filter(t => t.sha256.startsWith(prefix));
    if (hits.length !== 1) throw Error('prefix must match exactly one token');
    hits[0].revoked = true;
    writeRegistry(config.tokensFile, reg);
    console.log(JSON.stringify({revoked: prefix, principal: hits[0].principal}));
    return;
  }
  if (cmd === 'revoke-principal') {
    const principal = opt('principal');
    if (!principal || !config.principals[principal]) throw Error('unknown principal');
    const reg = readRegistry(config.tokensFile);
    const n = revokePrincipal(reg, principal);
    writeRegistry(config.tokensFile, reg);
    console.log(JSON.stringify({principal, revoked: n}));
    return;
  }
  if (cmd === 'policy-check') {
    // The same validation the server applies on every scoped call (owner-only file, strict
    // schema, optional SHA-256 pin). Counts and the content hash only.
    const st = PolicySource.file(config.sensitivityFile, config.sensitivitySha256).current();
    if (!st) throw Error('sensitivity policy invalid, insecure, missing or not matching sensitivitySha256: scoped callers are refused');
    const p = st.policy.spec;
    console.log(JSON.stringify({sha256: st.sha256, pinned: !!config.sensitivitySha256, version: p.version, topics: p.topics.length, terms: p.topics.reduce((n, t) => n + t.terms.length, 0), patterns: p.patterns.length,
      classifications: p.classifications, unclassified: config.classificationEnforcement.unclassified, excluded: Object.fromEntries(Object.entries(p.excluded).map(([k, v]) => [k, v.length])),
      principals: Object.fromEntries(Object.entries(p.principals).map(([k, v]) => [k, {posture: v.posture, fullCallClients: v.fullCallClients.length}]))}));
    return;
  }
  if (cmd === 'exposure-kill') {
    const e = requireExposure(config);
    engageKill(e, 'exposure-kill');
    let revoked = 0;
    if (flag('revoke-tokens')) {
      const reg = readRegistry(config.tokensFile);
      for (const p of Object.keys(e.principals)) revoked += revokePrincipal(reg, p);
      writeRegistry(config.tokensFile, reg);
    }
    console.log(JSON.stringify({killed: true, revokedTokens: revoked}));
    return;
  }
  if (cmd === 'exposure-resume') {
    const e = requireExposure(config);
    if (!flag('confirm')) throw Error('--confirm required');
    // No stale-policy resume (R16b B2): the kill switch is released only for a LIVE
    // exposure-http process bound to exactly this config file (same bytes), whose own policy
    // path and pin validate now. A changed config needs a restart with it first.
    assertDeployable(config);
    const binding = verifyResumeBinding(config, configFile, exposureProcessAlive);
    checkAuditSink(join(config.stateDir, 'exposure-audit.jsonl'));
    releaseKill(e);
    console.log(JSON.stringify({killed: killed(e), boundPid: binding.pid, configSha256: binding.configSha256, sensitivitySha256: binding.sensitivitySha256}));
    return;
  }
  if (cmd === 'exposure-status') {
    const e = requireExposure(config);
    const reg = readRegistry(config.tokensFile);
    const now = Date.now();
    const active = reg.tokens.filter(t => !t.revoked && (t.expires === undefined || Date.parse(t.expires) > now));
    const st = PolicySource.file(config.sensitivityFile, config.sensitivitySha256).current();
    let deployable = 'yes';
    try { assertDeployable(config); } catch (err) { deployable = err instanceof Error ? err.message.replace(/^atlas_mcp_exposure_not_deployable:/, 'no: ') : 'no'; }
    console.log(JSON.stringify({killed: killed(e), hostedSource: config.hostedSource.mode, publicHostname: e.publicHostname, port: e.port, cfAccess: e.cfAccess.mode, serviceTokenHeaders: !!e.serviceTokenHeaders,
      policy: st ? {sha256: st.sha256, version: st.policy.spec.version, pinned: !!config.sensitivitySha256} : 'INVALID (scoped callers refused)', unclassified: config.classificationEnforcement.unclassified, deployable,
      principals: Object.fromEntries(Object.entries(e.principals).map(([k, v]) => [k, {hostedActor: config.principals[k].hostedActor, tools: v.tools, activeTokens: active.filter(t => t.principal === k).map(t => ({sha256Prefix: t.sha256.slice(0, 12), expires: t.expires ?? null}))}]))}));
    return;
  }
  if (cmd === 'exposure-http') {
    assertDeployable(config); // no placeholders, pinned policy, dedicated Access identity
    if (!PolicySource.file(config.sensitivityFile, config.sensitivitySha256).current()) throw Error('sensitivity policy invalid or not matching the pin: not starting');
    // No index refresh: sensitivity decisions read the brain directory directly (BrainFiles).
    const configSha256 = fileSha256(configFile);
    const a = assemble({config, refreshIndex: false});
    // Serves only this config (503 config_changed if the file changes) and records the binding
    // that exposure-resume must match.
    const srv = await listenExposure(a, {configFile, configSha256});
    writeRuntimeBinding(config, configFile, configSha256);
    log({event: 'exposure_listening', host: '127.0.0.1', port: config.exposure!.port, hostedSource: config.hostedSource.mode, killed: killed(config.exposure!), configSha256});
    const stop = () => { srv.close(); clearRuntimeBinding(config); log({event: 'exposure_stopped'}); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (cmd === 'http') {
    const a = assemble({config});
    const srv = await listen(a);
    log({event: 'listening', host: '127.0.0.1', port: config.port, calls: a.index.count()});
    const stop = () => { srv.close(); log({event: 'stopped'}); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (cmd === 'stdio') {
    const file = opt('token-file') ?? process.env.ATLAS_MCP_TOKEN_FILE;
    if (!file) throw Error('--token-file required');
    const a = assemble({config});
    await runStdio(a, readTokenFile(file));
    return;
  }
  throw Error('usage: atlas-mcp.ts http|stdio|index|mint-token|revoke|policy-check|exposure-http|exposure-kill|exposure-resume|exposure-status|rotate|revoke-principal');
}

main().catch(e => { log({event: 'fatal', error: e instanceof Error ? e.message.slice(0, 200) : 'error'}); process.exit(1); });
