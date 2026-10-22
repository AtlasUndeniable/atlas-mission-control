/**
 * Origin-side Cloudflare Access checks for the exposure server (optional, configurable).
 *
 *  - mode 'jwt': every request must carry Cloudflare's `Cf-Access-Jwt-Assertion` header, an
 *    RS256 JWT that Access adds after it admits a request. We verify signature (team JWKS
 *    from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, cached), `aud` (the
 *    Access application AUD tag), `iss`, `exp`/`nbf`, and optionally that it was issued to
 *    one specific service token (`common_name` = Client ID, compared by SHA-256 digest).
 *    This proves the request passed Access even if someone reaches the tunnel origin by
 *    another path. Fail closed: a missing header, an unknown key or a JWKS fetch failure is
 *    a refusal.
 *  - serviceTokenHeaders: optionally also require the raw `CF-Access-Client-Id` /
 *    `CF-Access-Client-Secret` headers to reach the origin and match stored SHA-256 digests
 *    (constant-time). Whether Cloudflare forwards these to the origin is NOT verified;
 *    leave this off unless a supervised test shows they arrive.
 * Nothing here logs or returns header values.
 */
import {createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey} from 'node:crypto';

export type CfAccessConfig =
  | {mode: 'off'}
  | {mode: 'jwt'; teamDomain: string; aud: string; serviceTokenClientIdSha256: string | null};
export type ServiceTokenHeaders = {clientIdSha256: string; clientSecretSha256: string} | null;
export type JwksFetcher = (url: string) => Promise<{keys: (JsonWebKey & {kid?: string})[]}>;

const b64url = (s: string) => Buffer.from(s, 'base64url');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const digestEq = (presented: string, wantHex: string) => {
  if (!/^[0-9a-f]{64}$/.test(wantHex)) return false;
  return timingSafeEqual(sha(presented), Buffer.from(wantHex, 'hex'));
};

export const defaultJwksFetcher: JwksFetcher = async url => {
  const r = await fetch(url, {redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000)});
  if (!r.ok) throw Error('jwks_http');
  return await r.json() as {keys: JsonWebKey[]};
};

export class CfAccessVerifier {
  private cfg: CfAccessConfig;
  private fetcher: JwksFetcher;
  private now: () => number;
  private keys = new Map<string, ReturnType<typeof createPublicKey>>();
  private fetchedAt = 0;
  private lastAttempt = 0;
  constructor(cfg: CfAccessConfig, fetcher: JwksFetcher = defaultJwksFetcher, now: () => number = Date.now) {
    this.cfg = cfg; this.fetcher = fetcher; this.now = now;
  }

  private async refresh(force: boolean) {
    if (this.cfg.mode !== 'jwt') return;
    const t = this.now();
    if (!force && this.keys.size && t - this.fetchedAt < 10 * 60_000) return;
    // At most one forced refetch per 30 s with keys cached, one attempt per 5 s without.
    if (t - this.lastAttempt < (this.keys.size ? 30_000 : 5_000)) { if (this.keys.size) return; throw Error('jwks_backoff'); }
    this.lastAttempt = t;
    const j = await this.fetcher(`https://${this.cfg.teamDomain}/cdn-cgi/access/certs`);
    const next = new Map<string, ReturnType<typeof createPublicKey>>();
    for (const k of Array.isArray(j?.keys) ? j.keys : []) {
      if (typeof k.kid !== 'string' || k.kty !== 'RSA') continue;
      try { next.set(k.kid, createPublicKey({key: k, format: 'jwk'})); } catch { /* skip malformed key */ }
    }
    if (!next.size) throw Error('jwks_empty');
    this.keys = next; this.fetchedAt = t;
  }

  /** True only for a valid Access JWT for this application. Never throws. */
  async verifyJwt(header: unknown): Promise<boolean> {
    const cfg = this.cfg;
    if (cfg.mode === 'off') return true;
    if (typeof header !== 'string' || header.length > 8192) return false;
    const parts = header.split('.');
    if (parts.length !== 3) return false;
    let h: {alg?: string; kid?: string; typ?: string}, p: {aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown; common_name?: unknown};
    try { h = JSON.parse(b64url(parts[0]).toString('utf8')); p = JSON.parse(b64url(parts[1]).toString('utf8')); } catch { return false; }
    if (h.alg !== 'RS256' || typeof h.kid !== 'string') return false;
    try {
      if (!this.keys.has(h.kid)) await this.refresh(true); else await this.refresh(false);
    } catch { if (!this.keys.has(h.kid)) return false; }
    const key = this.keys.get(h.kid);
    if (!key) return false;
    let ok = false;
    try { ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2])); } catch { ok = false; }
    if (!ok) return false;
    const nowS = Math.floor(this.now() / 1000), skew = 60;
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(cfg.aud)) return false;
    if (p.iss !== `https://${cfg.teamDomain}`) return false;
    if (typeof p.exp !== 'number' || p.exp + skew < nowS) return false;
    if (typeof p.nbf === 'number' && p.nbf - skew > nowS) return false;
    if (typeof p.iat === 'number' && p.iat - skew > nowS) return false;
    if (cfg.serviceTokenClientIdSha256) {
      if (typeof p.common_name !== 'string' || !digestEq(p.common_name, cfg.serviceTokenClientIdSha256)) return false;
    }
    return true;
  }
}

/** Optional raw service-token header check (digests only, constant time). */
export function serviceTokenHeadersOk(cfg: ServiceTokenHeaders, id: unknown, secret: unknown): boolean {
  if (!cfg) return true;
  if (typeof id !== 'string' || typeof secret !== 'string' || id.length > 512 || secret.length > 512) return false;
  const a = digestEq(id, cfg.clientIdSha256), b = digestEq(secret, cfg.clientSecretSha256);
  return a && b;
}
