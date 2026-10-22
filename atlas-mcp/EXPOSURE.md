# Reaching Atlas MCP from Natalie's Grok: options (NOTHING ENABLED)

Phase A is bound to `127.0.0.1` on Rhys's Mac Studio. Grok runs in xAI's cloud, so it cannot reach the server without some form of exposure. Exposure is a separate decision for Dante and Rhys (DECISIONS item 14(b)). This document lists the options. None of them has been configured, installed or tested.

## What any option must keep

- **Token.** Grok uses its own `grok_as_nat` token. It can be revoked alone, and its scope is Nat's hosted client grants only.
- **Read-only.** Phase A stays read-only. Write tools (Phase B) need their own decision.
- **Second layer.** Something in front of the bearer token must stop the endpoint being an open door. Options are an IP allowlist, mTLS, a Cloudflare Access service token, or OAuth.
- **Loopback.** The server keeps its loopback bind and Host/Origin checks. A tunnel connects to `127.0.0.1:4019` on the Mac; the server never listens publicly.
- **Logging.** Audit stays on; any tunnel's own request logging must not capture bodies.
- **Before any exposure** the R14 exposure-lane requirements apply in full (sprint-20261007/laneR14-review/REVIEW.md, "Exposure review and required future lane"): separate authority and disclosure decisions, verified Grok transport and auth, a minimal per-caller tool allowlist and quote policy, origin Host handling without weakening the loopback checks, edge and origin limits, audit with no bodies, a demonstrated kill switch and rotation, and a supervised synthetic remote acceptance test.
- **Kill switch.** One command must cut access: stop the tunnel and revoke the token.

## Options

| Option | How it works | Pros | Cons and risks |
|---|---|---|---|
| **A. Cloudflare Tunnel + Cloudflare Access** | `cloudflared` on the Mac makes an outbound tunnel to a hostname such as `atlas-mcp.<domain>`. Access requires a service token (`CF-Access-Client-Id/Secret`) as well as the bearer. | No inbound port. Two independent credentials. Cloudflare WAF and rate limiting. Per-request logs. Mission Control's W1c already has Cloudflare Access settings, so the pattern is familiar. | Grok must be able to send two custom headers; confirm with Natalie. Cloudflare sees TLS-terminated traffic, which includes masked transcript excerpts in responses. Needs a domain on Cloudflare and a daemon on the Mac. |
| **B. Tailscale Funnel** | `tailscale funnel 4019` publishes a `*.ts.net` HTTPS URL that routes to the Mac. | Simplest to set up. Tailscale already joins Dante's machines. | Funnel is **public**: the only gate is our bearer token, because Funnel has no client-auth layer. The tailnet hostname is guessable. A tailnet policy change could widen access. Not recommended unless paired with an IP allowlist, and Grok's egress IPs are probably not fixed. |
| **C. Hosted relay** (a small authenticated proxy on a VPS or serverless platform, reaching the Mac over Tailscale or a Cloudflare Tunnel) | Grok calls the relay. The relay checks Grok's credential (whatever OAuth flow Grok is verified to support; client credentials must not be assumed), applies an allowlist of tools and arguments, and forwards to the Mac. | The best control point: OAuth, a per-tool allowlist, response size caps, and the option to strip quotes for Grok. The Mac stays private. | It is another service to build, secure and pay for, and it holds masked call content in transit. It adds latency. More work than A or B. |
| **D. No exposure: Slack door** | Grok posts a structured line into #atlas, and an Atlas Slack bot answers using the same tools. | Nothing on the Mac is reachable from the internet. It reuses the existing Slack connection. | Not MCP. Slower round trip and a poorer tool experience for Grok. This is Phase B work. |
| E. Port forward / public bind | Open a router port or bind to 0.0.0.0. | Nothing to install. | **Rejected.** It exposes the Mac directly. The config loader refuses any host other than 127.0.0.1. |

## Recommendation (for the decision, not acted on)

- Start with **A** (Cloudflare Tunnel + Access service token + `grok_as_nat` bearer) if Grok supports streamable-HTTP MCP with custom headers.
- If Grok supports only an OAuth-based MCP flow, use **C**, after verifying exactly which OAuth flow Grok supports (do not assume client credentials).
- If Grok supports neither, use **D**.
- **B is not acceptable on its own, even for a short demo** (R14): a short duration and later token rotation do not supply the mandatory second layer. B is usable only with the same independent gate as A.

## Questions this depends on (for the 2026-10-22 call)

1. Can Grok call remote MCP servers? Which transport: streamable HTTP or SSE?
2. Grok's MCP authentication: static headers (how many, any names)? OAuth 2.1 / dynamic client registration? Neither?
3. Does Grok have fixed egress IPs that could be allowlisted?
4. Does Grok call tools only when Natalie asks, or can it run them on a schedule? This affects budget and rate limits.
5. Where does Grok store the token, and who at Natalie's end can see it?

## Lane X (2026-10-22): option A prepared, not enabled

DECISIONS item 19(c) gave GO to build option A for `grok_as_nat` only. It is built and tested locally on branch `atlas-mcp-exposure-20261022`; nothing is exposed. See [EXPOSURE-RUNBOOK.md](EXPOSURE-RUNBOOK.md) for the human steps, the acceptance test, the kill switch, rollback and the Funnel trade-offs. Summary of what now exists:

- `exposure-http`: a separate origin listener (own config, own token registry with exposable principals only, own audit), still bound to 127.0.0.1, behind a strict Host check for the tunnel hostname, no Origin, POST `/mcp` only, size/time limits, optional Cloudflare Access JWT and service-token header checks, expiring bearer tokens, per-principal and unauthenticated rate limits and concurrency.
- A hard exposed-tool ceiling in code: `whoami`, `capabilities`, `list_tasks`, `get_task`.
- The sensitivity policy (`config/sensitivity.json`, DECISIONS 19(b)) applies to nat and grok_as_nat on every transport, with posture `task_fields_only` (no quotes, search, drafts or ask_call without a per-client full-call grant; none exist).
- Kill switch (`exposure-kill`, `deploy/kill-switch.sh`), `rotate`, `revoke-principal`, and a launchd plist that is prepared but not loaded.
- Grok's MCP transport and header support remain **unverified**; the runbook lists the unknowns.
