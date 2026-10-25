/**
 * Origin-side Cloudflare Access checks for the exposure server. MANDATORY (R16): there is no
 * mode that skips them.
 *
 *  - Every request must carry Cloudflare's `Cf-Access-Jwt-Assertion` header, an RS256 JWT
 *    that Access adds after it admits a request. We verify the signature against the team
 *    JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), `aud` (the Access
 *    application AUD tag), `iss`, finite numeric `exp` (required) and `nbf`/`iat` (if present),
 *    with 60 s skew, and that it was issued to the ONE dedicated service token
 *    (`common_name` = its Client ID, compared by SHA-256 digest).
 *  - Keys are trusted only while fresh: a successful JWKS fetch is valid for KEY_MAX_AGE_MS
 *    (1 h, R16 finding 10). After that a refresh must succeed or every token is refused, so a
 *    rotated-out or compromised old key stops working within the hour even if the JWKS
 *    endpoint is unreachable. Unknown kids force a refetch (at most one per 30 s).
 *  - serviceTokenHeaders (optional, off by default): raw `CF-Access-Client-Id/Secret` header
 *    digests. Whether Cloudflare forwards them to the origin is NOT verified.
 * Nothing here logs or returns header values.
 */
import {createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey} from 'node:crypto';

export type CfAccessConfig = {mode: 'jwt'; teamDomain: string; aud: string; serviceTokenClientIdSha256: string};
export type ServiceTokenHeaders = {clientIdSha256: string; clientSecretSha256: string} | null;
export type JwksFetcher = (url: string, signal?: AbortSignal) => Promise<{keys: (JsonWebKey & {kid?: string})[]}>;

export const KEY_MAX_AGE_MS = 60 * 60_000;
const REFRESH_AFTER_MS = 10 * 60_000;
const SKEW_S = 60;

const b64url = (s: string) => Buffer.from(s, 'base64url');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const digestEq = (presented: string, wantHex: string) => {
  if (!/^[0-9a-f]{64}$/.test(wantHex)) return false;
  return timingSafeEqual(sha(presented), Buffer.from(wantHex, 'hex'));
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const defaultJwksFetcher: JwksFetcher = async (url, signal) => {
  const t = AbortSignal.timeout(5000);
  const r = await fetch(url, {redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, t]) : t});
  if (!r.ok) throw Error('jwks_http');
  return await r.json() as {keys: JsonWebKey[]};
};

export class CfAccessVerifier {
  private cfg: CfAccessConfig;
  private fetcher: JwksFetcher;
  private now: () => number;
  private keys = new Map<string, ReturnType<typeof createPublicKey>>();
  private fetchedAt = 0;
  private lastAttempt = -Infinity;
  constructor(cfg: CfAccessConfig, fetcher: JwksFetcher = defaultJwksFetcher, now: () => number = Date.now) {
    this.cfg = cfg; this.fetcher = fetcher; this.now = now;
  }

  private fresh() { return this.keys.size > 0 && this.now() - this.fetchedAt <= KEY_MAX_AGE_MS; }

  private async refresh(signal?: AbortSignal) {
    const t = this.now();
    if (t - this.lastAttempt < (this.fresh() ? 30_000 : 5_000)) return; // bounded attempts
    this.lastAttempt = t;
    const j = await this.fetcher(`https://${this.cfg.teamDomain}/cdn-cgi/access/certs`, signal);
    const next = new Map<string, ReturnType<typeof createPublicKey>>();
    for (const k of Array.isArray(j?.keys) ? j.keys : []) {
      if (typeof k.kid !== 'string' || k.kty !== 'RSA') continue;
      try { next.set(k.kid, createPublicKey({key: k, format: 'jwk'})); } catch { /* skip malformed key */ }
    }
    if (!next.size) throw Error('jwks_empty');
    // Keys removed from the set stop being trusted at once.
    this.keys = next; this.fetchedAt = this.now();
  }

  /** True only for a valid Access JWT for this application and service token. Never throws. */
  async verifyJwt(header: unknown, signal?: AbortSignal): Promise<boolean> {
    const cfg = this.cfg;
    if (typeof header !== 'string' || header.length > 8192) return false;
    const parts = header.split('.');
    if (parts.length !== 3) return false;
    let h: {alg?: unknown; kid?: unknown}, p: {aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown; common_name?: unknown};
    try { h = JSON.parse(b64url(parts[0]).toString('utf8')); p = JSON.parse(b64url(parts[1]).toString('utf8')); } catch { return false; }
    if (!h || !p || typeof h !== 'object' || typeof p !== 'object') return false;
    if (h.alg !== 'RS256' || typeof h.kid !== 'string') return false;
    // Strict claim types (R16 #10): exp required; nbf/iat, when present, must be finite numbers.
    if (!finite(p.exp) || ('nbf' in p && !finite(p.nbf)) || ('iat' in p && !finite(p.iat))) return false;
    try {
      const age = this.now() - this.fetchedAt;
      if (!this.keys.has(h.kid) || age > REFRESH_AFTER_MS) await this.refresh(signal);
    } catch { /* fall through: trust only fresh, known keys */ }
    if (!this.fresh()) return false;
    const key = this.keys.get(h.kid);
    if (!key) return false;
    let ok = false;
    try { ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2])); } catch { ok = false; }
    if (!ok) return false;
    const nowS = Math.floor(this.now() / 1000);
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(cfg.aud)) return false;
    if (p.iss !== `https://${cfg.teamDomain}`) return false;
    if (p.exp + SKEW_S < nowS) return false;
    if (finite(p.nbf) && p.nbf - SKEW_S > nowS) return false;
    if (finite(p.iat) && p.iat - SKEW_S > nowS) return false;
    if (typeof p.common_name !== 'string' || !digestEq(p.common_name, cfg.serviceTokenClientIdSha256)) return false;
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
