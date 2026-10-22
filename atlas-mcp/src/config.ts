/**
 * Atlas MCP Phase A configuration. Read-only tools, loopback only, explicit principals.
 *
 * The loader refuses anything that would widen Phase A: a host other than 127.0.0.1, a
 * relative path, an unknown tool, an unknown scope, or a model other than the reviewed one.
 */
import {readFileSync} from 'node:fs';
import {dirname, isAbsolute, join} from 'node:path';

export const TOOL_NAMES = ['whoami', 'capabilities', 'list_tasks', 'get_task', 'get_draft', 'search_calls', 'ask_call'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type Scope = 'owner' | 'granted';
export type PrincipalConfig = {hostedActor: string; scope: Scope; tools: ToolName[]; label: string};
export type AskCallConfig = {
  model: 'claude-sonnet-5-5'; effort: 'low'; maxOutputTokens: number; maxPromptCharacters: number;
  timeoutMs: number; keyFile: string; budgetFile: string; decisionReference: string;
};
export type McpConfig = {
  host: '127.0.0.1'; port: number; brainCallsDir: string; stateDir: string; tokensFile: string;
  hostedTransportEnvFile: string; principals: Record<string, PrincipalConfig>;
  rateLimits: {toolCallsPerMinute: number; askCallsPerHour: number};
  askCall: AskCallConfig;
  /** The reviewed "never share with Nat/Grok" policy. Default: sensitivity.json next to tokensFile. */
  sensitivityFile: string;
  /** Present only in the exposure server's own config file (Lane X). */
  exposure: ExposureConfig | null;
};

/**
 * Lane X exposure (tunnel origin) settings. Hard ceiling: an exposed principal can never get
 * more than these four task-level tools, whatever its config says. Widening needs a code
 * change and an independent review.
 */
export const EXPOSED_TOOL_CEILING = ['whoami', 'capabilities', 'list_tasks', 'get_task'] as const;
export type ExposedTool = typeof EXPOSED_TOOL_CEILING[number];
export type ExposureConfig = {
  port: number;
  publicHostname: string;
  allowedOrigins: string[];
  principals: Record<string, {tools: ExposedTool[]}>;
  killSwitchFile: string;
  maxBodyBytes: number; maxResponseBytes: number; requestTimeoutMs: number;
  limits: {perMinute: number; perHour: number; perDay: number; maxConcurrent: number; unauthenticatedPerMinute: number};
  tokenMaxAgeDays: number;
  cfAccess: {mode: 'off'} | {mode: 'jwt'; teamDomain: string; aud: string; serviceTokenClientIdSha256: string | null};
  serviceTokenHeaders: {clientIdSha256: string; clientSecretSha256: string} | null;
  decisionReference: string;
};
export type Budget = {
  monthlyMicros: number; monthlyCalls: number; dailyCalls: number;
  inputMicrosPerToken: number; outputMicrosPerToken: number; decisionReference: string;
};

const fail = (what: string): never => { throw Error(`atlas_mcp_config_invalid:${what}`); };
const absolute = (v: unknown, what: string) => (typeof v === 'string' && isAbsolute(v) && !v.includes('\0') ? v : fail(what));
const int = (v: unknown, min: number, max: number, what: string) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fail(what));
const exactKeys = (o: unknown, keys: string[], what: string) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail(what);
  const extra = Object.keys(o as object).filter(k => !keys.includes(k));
  const missing = keys.filter(k => !(k in (o as object)));
  if (extra.length || missing.length) fail(`${what}:keys`);
  return o as Record<string, unknown>;
};

const hex64 = (v: unknown, what: string) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : fail(what));

export function parseExposure(raw: unknown, principals: Record<string, PrincipalConfig>, mainPort: number): ExposureConfig {
  const e = exactKeys(raw, ['port', 'publicHostname', 'allowedOrigins', 'principals', 'killSwitchFile', 'maxBodyBytes', 'maxResponseBytes', 'requestTimeoutMs', 'limits', 'tokenMaxAgeDays', 'cfAccess', 'serviceTokenHeaders', 'decisionReference'], 'exposure');
  const port = int(e.port, 1024, 65535, 'exposure.port');
  if (port === mainPort) fail('exposure.port_must_differ_from_local_port');
  const host = e.publicHostname;
  // A real DNS name with at least one dot; no IP literal, no localhost, no port, no wildcard.
  if (typeof host !== 'string' || host.length > 253 || !/^(?=.*[a-z])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('localhost')) fail('exposure.publicHostname');
  if (!Array.isArray(e.allowedOrigins) || e.allowedOrigins.length > 10 || e.allowedOrigins.some(o => typeof o !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(o))) fail('exposure.allowedOrigins');
  const ep = e.principals;
  if (!ep || typeof ep !== 'object' || Array.isArray(ep) || !Object.keys(ep).length) fail('exposure.principals');
  const outP: Record<string, {tools: ExposedTool[]}> = {};
  for (const [name, v] of Object.entries(ep as object)) {
    const pc = principals[name];
    // Only scoped (granted) principals can ever be exposed; the owner never is.
    if (!pc || pc.scope !== 'granted') fail(`exposure.principal:${name}:must_be_granted_scope`);
    const o = exactKeys(v, ['tools'], `exposure.principal:${name}`);
    if (!Array.isArray(o.tools) || !o.tools.length || o.tools.some(t => !(EXPOSED_TOOL_CEILING as readonly string[]).includes(t) || !pc.tools.includes(t as ToolName))) fail(`exposure.principal:${name}:tools`);
    outP[name] = {tools: [...new Set(o.tools as ExposedTool[])]};
  }
  // The exposure config file may hold ONLY exposable principals: a separate token registry
  // that cannot contain an owner token.
  for (const [name, pc] of Object.entries(principals)) if (pc.scope !== 'granted' || !outP[name]) fail(`exposure.config_principal_not_exposable:${name}`);
  const l = exactKeys(e.limits, ['perMinute', 'perHour', 'perDay', 'maxConcurrent', 'unauthenticatedPerMinute'], 'exposure.limits');
  const cf = e.cfAccess as Record<string, unknown> | null;
  let cfAccess: ExposureConfig['cfAccess'];
  if (cf && typeof cf === 'object' && cf.mode === 'off') { exactKeys(cf, ['mode'], 'exposure.cfAccess'); cfAccess = {mode: 'off'}; }
  else {
    const c = exactKeys(cf, ['mode', 'teamDomain', 'aud', 'serviceTokenClientIdSha256'], 'exposure.cfAccess');
    if (c.mode !== 'jwt') fail('exposure.cfAccess.mode');
    if (typeof c.teamDomain !== 'string' || !/^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/.test(c.teamDomain)) fail('exposure.cfAccess.teamDomain');
    if (typeof c.aud !== 'string' || !/^[0-9a-f]{64}$/.test(c.aud)) fail('exposure.cfAccess.aud');
    cfAccess = {mode: 'jwt', teamDomain: c.teamDomain as string, aud: c.aud as string, serviceTokenClientIdSha256: c.serviceTokenClientIdSha256 === null ? null : hex64(c.serviceTokenClientIdSha256, 'exposure.cfAccess.serviceTokenClientIdSha256')};
  }
  let sth: ExposureConfig['serviceTokenHeaders'] = null;
  if (e.serviceTokenHeaders !== null) {
    const s = exactKeys(e.serviceTokenHeaders, ['clientIdSha256', 'clientSecretSha256'], 'exposure.serviceTokenHeaders');
    sth = {clientIdSha256: hex64(s.clientIdSha256, 'exposure.serviceTokenHeaders.clientIdSha256'), clientSecretSha256: hex64(s.clientSecretSha256, 'exposure.serviceTokenHeaders.clientSecretSha256')};
  }
  if (typeof e.decisionReference !== 'string' || e.decisionReference.trim().length < 8) fail('exposure.decisionReference');
  return {
    port, publicHostname: host as string, allowedOrigins: e.allowedOrigins as string[], principals: outP,
    killSwitchFile: absolute(e.killSwitchFile, 'exposure.killSwitchFile'),
    maxBodyBytes: int(e.maxBodyBytes, 512, 65536, 'exposure.maxBodyBytes'),
    maxResponseBytes: int(e.maxResponseBytes, 1024, 1_048_576, 'exposure.maxResponseBytes'),
    requestTimeoutMs: int(e.requestTimeoutMs, 1000, 60000, 'exposure.requestTimeoutMs'),
    limits: {
      perMinute: int(l.perMinute, 1, 120, 'exposure.limits.perMinute'), perHour: int(l.perHour, 1, 2000, 'exposure.limits.perHour'),
      perDay: int(l.perDay, 1, 10000, 'exposure.limits.perDay'), maxConcurrent: int(l.maxConcurrent, 1, 8, 'exposure.limits.maxConcurrent'),
      unauthenticatedPerMinute: int(l.unauthenticatedPerMinute, 1, 600, 'exposure.limits.unauthenticatedPerMinute'),
    },
    tokenMaxAgeDays: int(e.tokenMaxAgeDays, 1, 90, 'exposure.tokenMaxAgeDays'),
    cfAccess, serviceTokenHeaders: sth, decisionReference: e.decisionReference as string,
  };
}

export function parseConfig(raw: unknown): McpConfig {
  // sensitivityFile and exposure are optional, so the installed Phase A config stays valid.
  const keys = ['host', 'port', 'brainCallsDir', 'stateDir', 'tokensFile', 'hostedTransportEnvFile', 'principals', 'rateLimits', 'askCall'];
  const optional = ['sensitivityFile', 'exposure'].filter(k => raw && typeof raw === 'object' && k in (raw as object));
  const c = exactKeys(raw, [...keys, ...optional], 'root');
  // Phase A rule: never exposed beyond loopback. There is no option to change this.
  if (c.host !== '127.0.0.1') fail('host_must_be_127.0.0.1');
  const principals: Record<string, PrincipalConfig> = {};
  const p = c.principals;
  if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length) fail('principals');
  for (const [name, value] of Object.entries(p as object)) {
    if (!/^[a-z][a-z_]{1,31}$/.test(name)) fail('principal_name');
    const v = exactKeys(value, ['hostedActor', 'scope', 'tools', 'label'], `principal:${name}`);
    if (typeof v.hostedActor !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.hostedActor)) fail(`principal:${name}:hostedActor`);
    if (v.scope !== 'owner' && v.scope !== 'granted') fail(`principal:${name}:scope`);
    if (!Array.isArray(v.tools) || !v.tools.length || v.tools.some(t => !(TOOL_NAMES as readonly string[]).includes(t))) fail(`principal:${name}:tools`);
    if (typeof v.label !== 'string' || v.label.length > 80) fail(`principal:${name}:label`);
    principals[name] = {hostedActor: v.hostedActor as string, scope: v.scope as Scope, tools: [...new Set(v.tools as ToolName[])], label: v.label as string};
  }
  const r = exactKeys(c.rateLimits, ['toolCallsPerMinute', 'askCallsPerHour'], 'rateLimits');
  const a = exactKeys(c.askCall, ['model', 'effort', 'maxOutputTokens', 'maxPromptCharacters', 'timeoutMs', 'keyFile', 'budgetFile', 'decisionReference'], 'askCall');
  if (a.model !== 'claude-sonnet-5-5') fail('askCall.model');
  if (a.effort !== 'low') fail('askCall.effort');
  if (typeof a.decisionReference !== 'string' || !a.decisionReference.trim()) fail('askCall.decisionReference');
  const port = int(c.port, 1024, 65535, 'port');
  const tokensFile = absolute(c.tokensFile, 'tokensFile');
  return {
    host: '127.0.0.1',
    port,
    brainCallsDir: absolute(c.brainCallsDir, 'brainCallsDir'),
    stateDir: absolute(c.stateDir, 'stateDir'),
    tokensFile,
    sensitivityFile: 'sensitivityFile' in c ? absolute(c.sensitivityFile, 'sensitivityFile') : join(dirname(tokensFile), 'sensitivity.json'),
    exposure: 'exposure' in c && c.exposure !== null ? parseExposure(c.exposure, principals, port) : null,
    hostedTransportEnvFile: absolute(c.hostedTransportEnvFile, 'hostedTransportEnvFile'),
    principals,
    rateLimits: {toolCallsPerMinute: int(r.toolCallsPerMinute, 1, 600, 'toolCallsPerMinute'), askCallsPerHour: int(r.askCallsPerHour, 0, 100, 'askCallsPerHour')},
    askCall: {
      model: 'claude-sonnet-5-5', effort: 'low',
      maxOutputTokens: int(a.maxOutputTokens, 256, 8000, 'askCall.maxOutputTokens'),
      maxPromptCharacters: int(a.maxPromptCharacters, 1000, 400000, 'askCall.maxPromptCharacters'),
      timeoutMs: int(a.timeoutMs, 1000, 120000, 'askCall.timeoutMs'),
      keyFile: absolute(a.keyFile, 'askCall.keyFile'),
      budgetFile: absolute(a.budgetFile, 'askCall.budgetFile'),
      decisionReference: a.decisionReference as string,
    },
  };
}

export function parseBudget(raw: unknown): Budget {
  const b = exactKeys(raw, ['monthlyMicros', 'monthlyCalls', 'dailyCalls', 'inputMicrosPerToken', 'outputMicrosPerToken', 'decisionReference'], 'budget');
  if (typeof b.decisionReference !== 'string' || !b.decisionReference.trim()) fail('budget.decisionReference');
  return {
    monthlyMicros: int(b.monthlyMicros, 0, 100_000_000, 'budget.monthlyMicros'),
    monthlyCalls: int(b.monthlyCalls, 0, 10_000, 'budget.monthlyCalls'),
    dailyCalls: int(b.dailyCalls, 0, 1_000, 'budget.dailyCalls'),
    inputMicrosPerToken: int(b.inputMicrosPerToken, 1, 1000, 'budget.inputMicrosPerToken'),
    outputMicrosPerToken: int(b.outputMicrosPerToken, 1, 1000, 'budget.outputMicrosPerToken'),
    decisionReference: b.decisionReference as string,
  };
}

const readJson = (file: string) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fail(`unreadable:${file.split('/').pop()}`); }
};
export const loadConfig = (file: string) => parseConfig(readJson(absolute(file, 'configPath')));
export const loadBudget = (file: string) => parseBudget(readJson(absolute(file, 'budgetPath')));
