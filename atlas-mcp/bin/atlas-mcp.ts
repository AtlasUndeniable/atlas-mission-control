#!/usr/bin/env node
/**
 * Atlas MCP Phase A command line.
 *   node atlas-mcp/bin/atlas-mcp.ts http        [--config FILE]   serve streamable HTTP on 127.0.0.1
 *   node atlas-mcp/bin/atlas-mcp.ts stdio       [--config FILE] --token-file FILE
 *   node atlas-mcp/bin/atlas-mcp.ts index       [--config FILE]   refresh the call index (counts only)
 *   node atlas-mcp/bin/atlas-mcp.ts mint-token  [--config FILE] --principal NAME --out FILE [--label TEXT]
 *   node atlas-mcp/bin/atlas-mcp.ts revoke      [--config FILE] --sha256-prefix HEX
 * Nothing here prints a token, credential or transcript text.
 */
import {existsSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.ts';
import {assemble, listen, readTokenFile, runStdio} from '../src/server.ts';
import {CallIndex} from '../src/call-index.ts';
import {digest, newToken, readRegistry, writeRegistry} from '../src/auth.ts';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i > 0 ? argv[i + 1] : undefined; };
const configFile = opt('config') ?? process.env.ATLAS_MCP_CONFIG ?? join(homedir(), '.config/atlas/atlas-mcp/config.json');
const log = (o: object) => process.stderr.write(JSON.stringify({at: new Date().toISOString(), ...o}) + '\n');

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
    const principal = opt('principal'), out = opt('out');
    if (!principal || !config.principals[principal]) throw Error('unknown principal');
    if (!out || !out.startsWith('/') || existsSync(out)) throw Error('--out must be a new absolute path');
    const token = newToken();
    writeFileSync(out, token + '\n', {mode: 0o600, flag: 'wx'});
    const reg = readRegistry(config.tokensFile);
    reg.tokens.push({principal, sha256: digest(token), created: new Date().toISOString(), label: (opt('label') ?? principal).slice(0, 80)});
    writeRegistry(config.tokensFile, reg);
    console.log(JSON.stringify({principal, tokenFile: out, sha256Prefix: digest(token).slice(0, 12)}));
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
  throw Error('usage: atlas-mcp.ts http|stdio|index|mint-token|revoke');
}

main().catch(e => { log({event: 'fatal', error: e instanceof Error ? e.message.slice(0, 200) : 'error'}); process.exit(1); });
