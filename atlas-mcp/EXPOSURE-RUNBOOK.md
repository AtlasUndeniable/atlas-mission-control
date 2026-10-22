# Atlas MCP exposure runbook: Natalie's Grok (grok_as_nat), Lane X

**Status: PREPARED ONLY. Nothing is exposed.** No Cloudflare or Tailscale account was created, no DNS was changed, no tunnel was started, the launchd job is not loaded and no token was minted for exposure. Authority: sprint-20261007 DECISIONS item 19(c) (build), with items 14(b) and 15 for context. **Enabling needs:** an independent review of the exact commit (Lane R16, gpt-6-astra), Dante's enable decision, and the human account steps below. Nothing is sent to Natalie until R16 accepts (item 19(c)).

What Grok gets, once enabled: principal `grok_as_nat` (hosted actor `nat`), tools `whoami`, `capabilities`, `list_tasks` and `get_task` only. It sees task-level fields for clients Rhys has granted to Nat, never call quotes, transcript search, drafts or `ask_call` (no per-client full-call grant exists), and never anything the sensitivity policy (`config/sensitivity.json`) withholds. **Today Nat has no client grants, so Grok will see zero tasks** until Rhys grants clients from Nat's categorized L3 list.

## Architecture

```
Grok (xAI cloud)
  │  HTTPS  POST https://<HOSTNAME>/mcp
  │  headers: CF-Access-Client-Id, CF-Access-Client-Secret   (Cloudflare Access service token)
  │           Authorization: Bearer <grok_as_nat token>        (Atlas)
  ▼
Cloudflare edge: Access application on <HOSTNAME>, policy "Service Auth" = the Grok service token only
  │  (refuses everything else; adds Cf-Access-Jwt-Assertion)
  ▼
cloudflared on the Mac (outbound-only named tunnel; ingress /mcp only; access.required + audTag)
  ▼
atlas-mcp exposure-http on 127.0.0.1:4020 (launchd job ai.atlas.atlas-mcp-exposure)
  kill switch → loopback peer → Host == <HOSTNAME> → no Origin → POST /mcp → size cap
  → Access JWT verify (team JWKS, aud, iss, exp, service-token common_name) → bearer (expiring)
  → rate/concurrency limits → 4-tool ceiling → sensitivity policy → hosted reads as nat
```

Three independent gates: the Cloudflare edge (service token), cloudflared (Access JWT), the origin (Access JWT again plus the Atlas bearer). Separate files from the local Rhys install: `~/.config/atlas/atlas-mcp-exposure/` (config, token registry holding only `grok_as_nat`, sensitivity policy, kill-switch file) and `~/.local/state/atlas-mcp-exposure/` (audit, log). The installed Rhys stdio registration and `~/.config/atlas/atlas-mcp/` are not touched.

## 0. What exists today (read-only checks, 2026-10-22)

| Item | Finding |
|---|---|
| `undeniablementoring.com` NS | `ns-cloud-d1..d4.googledomains.com` (Google Cloud DNS). **Not on Cloudflare.** |
| Its MX | Google Workspace (`aspmx.l.google.com` …). Moving the zone risks email. |
| Its apex A / `www` | apex `162.159.140.166` (a Cloudflare anycast address, i.e. the website host's own Cloudflare front), `www` CNAME `sites.ludicrous.cloud`. The site host, not Rhys, controls that Cloudflare front. |
| Dante's `fluxgate.pro` | Porkbun NS. Not on Cloudflare, and it is Dante's internal namespace, not the client's. |
| Cloudflare account for Rhys | **Unknown.** Nothing on the Mac indicates one. `cloudflared` is not installed. |
| Tailscale on the Mac | Tailscale.app is installed and running; the node's capabilities include Funnel attributes. Not used by this lane. |

Consequence: a Cloudflare Tunnel public hostname needs a zone **on a Cloudflare account**. Free/Pro plans support only full (NS) setup; partial CNAME setup needs Business, and subdomain zones need Enterprise. Do **not** move `undeniablementoring.com` to Cloudflare for this; it carries Rhys's email and website.

**Recommended:** register a dedicated, low-cost domain owned by Rhys's business directly at Cloudflare Registrar (it is then on Cloudflare automatically), for example `undeniable-atlas.<tld>`, and use `mcp.<that domain>` as `<HOSTNAME>`. A human chooses and pays for the name.

## 1. Human: Cloudflare account and domain (Rhys or Dante with Rhys's approval)

1. Create (or sign in to) a Cloudflare account **owned by Rhys's business**, with 2FA. Record who holds it. (Do not use a personal account of Dante's.)
2. Register the dedicated domain in Cloudflare Registrar, or add an existing Rhys-controlled spare domain with full NS setup.
3. Zero Trust: open Zero Trust, choose a team name (gives `<TEAM>.cloudflareaccess.com`), select the Free plan. Cloudflare may ask for a payment method even on Free (unverified here).
4. Disclosure acknowledgement (R14 exposure requirement 1): Dante and Rhys confirm in DECISIONS that masked task text (titles, clients, owners, due dates, statuses) will transit Cloudflare and reach xAI's Grok. No call quotes or transcripts are exposed by this lane.

## 2. Human: Access application and service token (Cloudflare dashboard)

1. Zero Trust → Access → Service Auth → **Service Tokens** → Create `atlas-grok-nat`, duration 1 year or shorter (shorter is better; 90 days suggested). Copy the Client ID and Client Secret **once** into the owner's password manager. Never paste them into Slack, email, a document or a chat with an assistant.
2. Zero Trust → Access → Applications → Add → **Self-hosted**. Name `Atlas MCP (Grok)`; domain `<HOSTNAME>`; path `mcp`. Session duration: shortest. Turn off the App Launcher tile and identity-provider login (service-token only).
3. Policy: Action **Service Auth**, Include → Service Token → `atlas-grok-nat`. No other policy, no Bypass, no "Everyone".
4. Note the application's **AUD tag** (Overview → Application Audience (AUD) Tag). It is not a secret.
5. Optional edge rate limiting (WAF → Rate limiting rules) on `<HOSTNAME>`: for example 60 requests/min per IP, block 10 min. The origin also limits.

## 3. Mac: stage config, policy and token (owner-only; supervised; after R16 ACCEPT)

```sh
cd <REVIEWED WORKTREE>          # the exact commit R16 accepted; verify `git rev-parse HEAD` and a clean tree
export PATH=/opt/homebrew/bin:$PATH
install -d -m 700 ~/.config/atlas/atlas-mcp-exposure ~/.local/state/atlas-mcp-exposure
install -m 600 atlas-mcp/config/exposure.example.json ~/.config/atlas/atlas-mcp-exposure/config.json
install -m 600 atlas-mcp/config/sensitivity.json     ~/.config/atlas/atlas-mcp-exposure/sensitivity.json
# Start disabled: the kill switch is ON until the acceptance test.
node atlas-mcp/bin/atlas-mcp.ts exposure-kill --config ~/.config/atlas/atlas-mcp-exposure/config.json
```

Edit `~/.config/atlas/atlas-mcp-exposure/config.json`: `exposure.publicHostname` = `<HOSTNAME>` (lowercase, no port); `exposure.cfAccess.teamDomain` = `<TEAM>.cloudflareaccess.com`; `exposure.cfAccess.aud` = the AUD tag; optionally `serviceTokenClientIdSha256` = SHA-256 of the service token Client ID (computed locally with `printf %s '<id>' | shasum -a 256`, typed by the human, never pasted into a chat). Leave `serviceTokenHeaders` null unless step 7 proves Cloudflare forwards those headers to the origin. Then:

```sh
C=~/.config/atlas/atlas-mcp-exposure/config.json
node atlas-mcp/bin/atlas-mcp.ts policy-check --config $C            # counts only; must show nat + grok_as_nat task_fields_only
node atlas-mcp/bin/atlas-mcp.ts mint-token --config $C --principal grok_as_nat \
     --out ~/.config/atlas/atlas-mcp-exposure/grok_as_nat.token --expires-days 30 --label "Grok for Natalie"
node atlas-mcp/bin/atlas-mcp.ts exposure-status --config $C          # killed: true, one active token (prefix + expiry only)
```

This is a **new** `grok_as_nat` token in the exposure registry. The older Phase A `grok_as_nat` token (`e8cdc8b3d1cb…`, local registry) is not valid here and should be revoked in the local registry when exposure is enabled.

Rhys's sensitivity review: the policy is a proposal. Rhys (via Dante) confirms or edits topics, adds client labels/task ids/call ids he excludes, and records any per-client full-call grants (there are none). Re-run `policy-check` after any edit; the exposure server refuses to start with an invalid policy, and scoped callers get nothing if it becomes invalid later.

## 4. Mac: cloudflared and the tunnel (human-run; outbound only)

```sh
brew install cloudflared                    # installation is a separate authorization (CLAUDE.md); a human runs it
cloudflared tunnel login                    # browser login to Rhys's Cloudflare account; writes ~/.cloudflared/cert.pem
cloudflared tunnel create atlas-mcp-grok    # writes ~/.cloudflared/<TUNNEL_ID>.json (owner-only); never print it
cloudflared tunnel route dns atlas-mcp-grok <HOSTNAME>
cp atlas-mcp/deploy/cloudflared-config.example.yml ~/.cloudflared/config.yml
# edit: TUNNEL_ID, HOSTNAME, TEAM (team name only, without .cloudflareaccess.com), AUD
chmod 600 ~/.cloudflared/config.yml ~/.cloudflared/*.json ~/.cloudflared/cert.pem
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://<HOSTNAME>/mcp     # must match the 127.0.0.1:4020 rule
```

Run it as a **user** LaunchAgent (no sudo) only at step 6. Never use a quick tunnel (`trycloudflare.com`). Do not set `httpHostHeader`, `noTLSVerify` or any bypass. The ingress serves `/mcp` only; everything else returns 404 at the tunnel.

## 5. Origin smoke on the Mac (still killed, then local only)

```sh
cp atlas-mcp/deploy/ai.atlas.atlas-mcp-exposure.plist /tmp/ && sed -i '' "s#WORKTREE#$PWD#g" /tmp/ai.atlas.atlas-mcp-exposure.plist
plutil -lint /tmp/ai.atlas.atlas-mcp-exposure.plist
node atlas-mcp/bin/atlas-mcp.ts exposure-http --config $C &      # foreground test run
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4020/mcp -H "Host: <HOSTNAME>"   # expect 503 (killed)
kill %1
```

## 6. Enable (Dante's explicit go after R16 ACCEPT)

```sh
cp /tmp/ai.atlas.atlas-mcp-exposure.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.atlas.atlas-mcp-exposure.plist
lsof -nP -iTCP:4020 -sTCP:LISTEN            # must show 127.0.0.1:4020 only
cloudflared service install                  # or a user LaunchAgent running `cloudflared tunnel run atlas-mcp-grok`
node atlas-mcp/bin/atlas-mcp.ts exposure-resume --config $C --confirm   # only for the acceptance test window
```

## 7. Supervised synthetic remote acceptance (R14 requirement 8), before Natalie gets anything

Run from a machine **outside** the Mac's network, with the human holding the secrets (they are typed from the password manager into environment variables, never echoed). Expected results:

| # | Request | Expect |
|---|---|---|
| 1 | `POST https://<HOSTNAME>/mcp` with no headers | 403 from Cloudflare Access (no origin audit row) |
| 2 | Access headers only, no bearer | 401 at origin (`unauthorized` row) |
| 3 | Access headers + wrong bearer | 401 |
| 4 | Access headers + bearer, `tools/list` | 200, exactly `whoami capabilities list_tasks get_task` |
| 5 | `tools/call whoami` | principal `grok_as_nat`, hosted actor `nat`, `sharingPolicy` present |
| 6 | `tools/call list_tasks` | 0 tasks today (no grants) |
| 7 | `tools/call search_calls` / `ask_call` / `get_draft` | `isError`, `forbidden` |
| 8 | `GET /mcp`, `POST /other` | 405 / 404 (tunnel 404 for other paths) |
| 9 | 20 KB body | 413 |
| 10 | 25 quick requests | 429 after the per-minute limit |
| 11 | `exposure-kill` on the Mac, repeat #4 | 503 immediately |
| 12 | Revoke the service token in Cloudflare, repeat #4 | 403 at the edge |
| 13 | `rotate`, old bearer | 401; new bearer 200 |
| 14 | Direct origin bypass attempt (`curl http://127.0.0.1:4020/mcp` from another local user, or with `Host: <HOSTNAME>` and no JWT) | 403 (`access_denied`) |
| 15 | Inspect `~/.local/state/atlas-mcp-exposure/exposure-audit.jsonl` | one schema-bound row per request; no token, JWT, body or task text |

Also confirm Cloudflare's own logs for the hostname hold no request bodies (Access and HTTP request logs carry metadata only; do not enable Logpush with bodies or any Worker that logs them).

Record results (status codes and counts only) in the lane receipt. Only after this passes, and Dante says so, does Natalie receive anything.

## 8. Natalie adds the connector in Grok

**Unknowns, to be verified in a supervised session with Natalie** (nothing here was tested against Grok):
- whether Grok Pro's connectors tab accepts a **custom remote MCP server URL** at all, or only listed partners;
- which transport it speaks (streamable HTTP `POST` with JSON responses is what this server supports; SSE `GET` streams are refused with 405);
- whether it can send **custom static headers**, and **how many** (this design needs three: `Authorization`, `CF-Access-Client-Id`, `CF-Access-Client-Secret`);
- whether it only supports OAuth (then this design does not fit: see "If Grok cannot send headers" below);
- the MCP protocol version it negotiates (server supports 2025-06-18, 2025-03-26, 2024-11-05);
- whether Grok calls tools only on Natalie's prompt or autonomously (for example her 2-hourly Slack scan), which sets the rate limits;
- where xAI stores the connector secrets, who at Natalie's end can see them, and whether xAI retains tool results;
- Grok's egress IPs (only relevant to the Funnel fallback).

If supported, Natalie enters (Dante or Rhys gives her the secrets through a one-time secret link or in person, never in Slack/email):

| Field | Value |
|---|---|
| Name | Atlas (Rhys's tasks) |
| URL | `https://<HOSTNAME>/mcp` |
| Header | `Authorization: Bearer <grok_as_nat token>` |
| Header | `CF-Access-Client-Id: <service token Client ID>` |
| Header | `CF-Access-Client-Secret: <service token Client Secret>` |

**First test prompt for Natalie** (read-only, no spend, works with zero grants):

> Using the Atlas connector only: call `whoami` and tell me which principal you are connected as and which tools you can use. Then call `list_tasks` and give me just the task titles, clients and due dates, exactly as returned. If the list is empty, say it is empty. Do not guess or add anything that is not in the tool results.

Expected: principal `grok_as_nat`, the four tools, and an empty task list until Rhys grants clients.

**If Grok cannot send custom headers:** do not weaken the gates. Options for a later decision: (a) Cloudflare Access with an OAuth-capable front (for example Cloudflare's MCP server portal / Access for SaaS, unverified) once Grok's exact OAuth flow is known; (b) the hosted relay (EXPOSURE.md option C); (c) the Slack door (option D). Each needs its own review.

## 9. Kill switch and rollback

**Kill switch (one command, refuses every external request immediately, including in-flight responses):**

```sh
sh <WORKTREE>/atlas-mcp/deploy/kill-switch.sh            # add --revoke to also revoke every exposed token
```

It writes the kill file (the origin answers 503 to everything from that moment), boots out the origin launchd job and the user cloudflared agent, kills `cloudflared tunnel` processes, prints status, and reminds the human to revoke the service token / disable the Access application in Cloudflare. A system-level cloudflared daemon needs `sudo launchctl bootout system/com.cloudflare.cloudflared` (printed, not run). Equivalent single step without the script: `node atlas-mcp/bin/atlas-mcp.ts exposure-kill --config $C`.

In-flight behaviour: the exposed tools make no model calls and no writes; a request already reading the hosted queue finishes its read, but its result is dropped (503) if the kill file exists when it completes.

**Rotation:** `node atlas-mcp/bin/atlas-mcp.ts rotate --config $C --principal grok_as_nat --out <new file> --expires-days 30` (new token valid at once, all previous ones revoked in the same write; Natalie updates the header). Tokens must expire within `tokenMaxAgeDays` (30). Rotate the Cloudflare service token in the dashboard on its own schedule. Watch the hosted `nat` JWT expiry (2027-01-18T06:01Z; Lane H alert 2027-01-04).

**Revocation:** `revoke-principal --principal grok_as_nat` (all tokens) or `revoke --sha256-prefix <hex>` (one).

**Full rollback:**
1. `kill-switch.sh --revoke`.
2. Cloudflare: revoke the `atlas-grok-nat` service token; delete the Access application; `cloudflared tunnel route dns` record → delete the DNS record for `<HOSTNAME>`; `cloudflared tunnel delete atlas-mcp-grok`.
3. Mac: `rm ~/Library/LaunchAgents/ai.atlas.atlas-mcp-exposure.plist`; `cloudflared service uninstall` if installed as a service; remove `~/.cloudflared/` credentials for this tunnel.
4. Keep `~/.local/state/atlas-mcp-exposure/` audit files as evidence. The local Rhys install is unaffected throughout.
5. Natalie removes the connector in Grok.

## 10. Alternative: Tailscale Funnel (not recommended on its own)

How: `tailscale funnel --bg --https=443 http://127.0.0.1:4020` publishes `https://<mac>.<tailnet>.ts.net/` to the internet; set `exposure.publicHostname` to that name and `cfAccess.mode` to `off`.

| | Cloudflare Tunnel + Access | Tailscale Funnel |
|---|---|---|
| Accounts | New Cloudflare account + a domain on it | Existing tailnet (Funnel attributes appear present on the Mac) |
| Independent second gate | Yes: Access service token at the edge, JWT re-checked by cloudflared and origin | **No.** Funnel has no client authentication; the only gates are our origin checks and bearer |
| Hostname | Custom, on Rhys's domain | `*.ts.net`, reveals the tailnet name; guessable |
| Edge rate limiting / WAF | Yes | No |
| Who terminates TLS | Cloudflare (sees masked task text) | The Mac (Tailscale relays encrypted traffic) |
| Policy blast radius | Per-application Access policy | A tailnet ACL/attr change can widen or remove Funnel |
| Grok header needs | 3 headers | 1 header (bearer), or 2 with `serviceTokenHeaders` as a second shared secret |

R14 rejected a bare Funnel (no second layer, even for a short demo). Funnel is acceptable only with an independent second gate reviewed by R16, for example an IP allowlist of verified, fixed Grok egress addresses (unknown) or a relay in front. Using `serviceTokenHeaders` as an extra static header with Funnel adds a second secret, not an independent gate; it does not meet R14 by itself. The Funnel advantage is TLS ending on the Mac (no third party sees task text) and no new account.
