/**
 * Atlas MCP Phase A configuration. Read-only tools, loopback only, explicit principals.
 *
 * The loader refuses anything that would widen Phase A: a host other than 127.0.0.1, a
 * relative path, an unknown tool, an unknown scope, or a model other than the reviewed one.
 */
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

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

export function parseConfig(raw: unknown): McpConfig {
  const c = exactKeys(raw, ['host', 'port', 'brainCallsDir', 'stateDir', 'tokensFile', 'hostedTransportEnvFile', 'principals', 'rateLimits', 'askCall'], 'root');
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
  return {
    host: '127.0.0.1',
    port: int(c.port, 1024, 65535, 'port'),
    brainCallsDir: absolute(c.brainCallsDir, 'brainCallsDir'),
    stateDir: absolute(c.stateDir, 'stateDir'),
    tokensFile: absolute(c.tokensFile, 'tokensFile'),
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
