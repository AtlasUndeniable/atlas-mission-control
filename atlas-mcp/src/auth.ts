/**
 * Per-caller bearer tokens. Only SHA-256 digests are stored (tokens.json, 0600); the raw
 * token lives in one 0600 file per caller and is never printed. Comparison is constant
 * time over every registered digest. Plus a per-principal sliding-window rate limiter.
 */
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, renameSync, statSync} from 'node:fs';

export type TokenEntry = {principal: string; sha256: string; created: string; label: string; revoked?: boolean};
export type TokenRegistry = {tokens: TokenEntry[]};

const TOKEN_SHAPE = /^atlas_mcp_[A-Za-z0-9_-]{43}$/;
export const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const newToken = () => 'atlas_mcp_' + randomBytes(32).toString('base64url');

export function readRegistry(file: string): TokenRegistry {
  if (!existsSync(file)) return {tokens: []};
  const st = statSync(file);
  if ((st.mode & 0o077) !== 0) throw Error('token_registry_must_be_owner_only');
  const r = JSON.parse(readFileSync(file, 'utf8')) as TokenRegistry;
  if (!r || !Array.isArray(r.tokens)) throw Error('token_registry_invalid');
  return r;
}

export function writeRegistry(file: string, registry: TokenRegistry) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  renameSync(tmp, file);
}

/** Returns the principal for a presented bearer value, or null. Never throws on input. */
export function resolveBearer(registry: TokenRegistry, presented: string | null | undefined, principals: Record<string, unknown>): string | null {
  if (typeof presented !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(presented.trim());
  const token = m ? m[1] : presented.trim();
  if (!TOKEN_SHAPE.test(token)) return null;
  const want = Buffer.from(digest(token), 'hex');
  let found: string | null = null;
  for (const e of registry.tokens) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) continue;
    const match = timingSafeEqual(want, Buffer.from(e.sha256, 'hex'));
    if (match && !e.revoked && Object.hasOwn(principals, e.principal)) found = e.principal;
  }
  return found;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  /** True and recorded when under the limit; false (not recorded) otherwise. */
  take(key: string, limit: number, windowMs: number) {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter(x => t - x < windowMs);
    if (list.length >= limit) { this.hits.set(key, list); return false; }
    list.push(t); this.hits.set(key, list); return true;
  }
}
