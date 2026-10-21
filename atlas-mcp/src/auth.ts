/**
 * Per-caller bearer tokens. Only SHA-256 digests are stored (tokens.json, 0600); the raw
 * token lives in one 0600 file per caller and is never printed. Comparison is constant
 * time over every registered digest. Plus a per-principal sliding-window rate limiter.
 */
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, existsSync, renameSync, lstatSync, openSync, fstatSync, closeSync, constants} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';

export type TokenEntry = {principal: string; sha256: string; created: string; label: string; revoked?: boolean};
export type TokenRegistry = {tokens: TokenEntry[]};

const TOKEN_SHAPE = /^atlas_mcp_[A-Za-z0-9_-]{43}$/;
export const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const newToken = () => 'atlas_mcp_' + randomBytes(32).toString('base64url');

/**
 * Owner-only secret file read, consistent with the provider key reader: no symlink (lstat +
 * O_NOFOLLOW), a regular file owned by this uid with no group/other bits, in a directory
 * owned by this uid that is not group- or world-writable.
 */
export function readOwnerOnlyFile(file: string, what: string): string {
  if (!isAbsolute(file)) throw Error(`${what}_must_be_owner_only`);
  const uid = process.getuid?.();
  const dir = lstatSync(dirname(file));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o022) !== 0) throw Error(`${what}_must_be_owner_only`);
  const l = lstatSync(file);
  if (l.isSymbolicLink() || !l.isFile()) throw Error(`${what}_must_be_owner_only`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) throw Error(`${what}_must_be_owner_only`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function readRegistry(file: string): TokenRegistry {
  if (!existsSync(file)) return {tokens: []};
  const r = JSON.parse(readOwnerOnlyFile(file, 'token_registry')) as TokenRegistry;
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
