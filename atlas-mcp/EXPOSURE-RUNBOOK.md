# Atlas MCP exposure runbook: Natalie's Grok (grok_as_nat), Lane X / X2

**Status: PREPARED ONLY. Nothing is exposed.** No account was created, no DNS changed, no tunnel started, no launchd job loaded, no exposure token minted. Authority: sprint-20261007 DECISIONS item 19(c) (build) and item 20 (policy list approved as built; L3 clients; task details may transit Cloudflare to Grok/xAI). **Lane R16 rejected the first candidate and R16b the second (X2); X3 is the successor and needs Lane R16c acceptance.** Then, in this order: the classification decision (section 1), Rhys's written confirmation (item 20), Dante's enable decision, a **synthetic** remote acceptance pass (section 7), and only then a separately authorized switch to real data (section 8). Nothing is sent to Natalie before all of that.

What Grok gets once enabled on real data: principal `grok_as_nat` (hosted actor `nat`), tools `whoami`, `capabilities`, `list_tasks`, `get_task` only; task-level fields only (no quotes, search, drafts, `ask_call`; no full-call grants exist); never anything the sensitivity policy withholds; never a record whose classification is unresolved (see section 1).

**Real scope.** The read-only Nat access audit (DECISIONS 25) found 121 active Nat workspace-client grants (all of Rhys's clients) plus a stale task grant; earlier "no grants" statements were wrong. Under DECISIONS 26 those grants and Nat's resolver are being deactivated and the local nat/grok_as_nat tokens revoked, in a separate lane; only Rhys-confirmed level-3 clients are to be re-granted. The real scope is therefore whatever is granted at the time of the real-data switch, observed, not assumed (it may be empty). This lane changes no grant.

## Architecture

```
Grok (xAI cloud)
  │  HTTPS POST https://<HOSTNAME>/mcp
  │  headers: CF-Access-Client-Id, CF-Access-Client-Secret   (Access service token)
  │           Authorization: Bearer <grok_as_nat token>        (Atlas)
  ▼
Cloudflare edge: Access app on <HOSTNAME>/mcp, one Service Auth policy (the Grok token),
                 mandatory rate-limiting rule; adds Cf-Access-Jwt-Assertion
  ▼
cloudflared, user LaunchAgent ai.atlas.cloudflared-atlas-mcp-grok, named tunnel atlas-mcp-grok
  (ingress /mcp only, access.required + audTag; credentials file, no token on the command line)
  ▼
atlas-mcp exposure-http on 127.0.0.1:4020 (user LaunchAgent ai.atlas.atlas-mcp-exposure)
  kill switch → global pre-auth failure limit → loopback → Host == <HOSTNAME> → no Origin
  → POST /mcp → size cap → Access JWT (fresh JWKS, aud, iss, exp, dedicated service token)
  → expiring bearer → limits + held concurrency slot → 4-tool ceiling → CURRENT pinned policy
  → one release decision (classification, exclusions, brain paths from the brain itself)
  → hosted reads as nat under the end-to-end deadline → audit first → capped reply
```

## 0. What exists today (read-only checks)

| Item | Finding |
|---|---|
| `undeniablementoring.com` (2026-10-22 snapshot) | NS Google Cloud DNS; MX Google Workspace; apex A a Cloudflare anycast address (the site host's front; it does not show who controls that account); `www` → `sites.ludicrous.cloud`. Not a zone this lane can use; do not move it. |
| `cloudflared` | **Installed**: `/opt/homebrew/bin/cloudflared` 2026.3.0 (Homebrew, 2026-03-17). (The first receipt's "not installed" was wrong.) |
| Existing tunnel | A **system** daemon `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` (root, since at least 2026-04-21) is running a **remotely-managed** tunnel (`tunnel run --token …`). So some Cloudflare account already exists. Its owner, zone and purpose are unknown here (possibly Mission Control's W1c Access setup). **This lane must not stop, edit or reuse it.** Note for the coordinator: its connector token is visible in the process arguments to every local user, and the plist is world-readable (0644); this lane did not read or record the token. |
| `~/.cloudflared` | Exists, empty (0700). |
| Tailscale | Running; Funnel attributes present (count only). Not used. |

Human decision (step 2): use the existing Cloudflare account only if it is confirmed to be **Rhys's business account** with 2FA and an appropriate zone; otherwise create one. A tunnel public hostname needs a zone on that account (partial CNAME setup needs Business/Enterprise; subdomain zones need Enterprise), so the recommendation stands: a dedicated domain owned by Rhys's business, registered at Cloudflare Registrar, e.g. `mcp.<dedicated domain>` as `<HOSTNAME>`.

## 1. Decision required first: classification (R16 finding 2)

The installed `meeting_queue('list')` does not return any classification; intake classifications live in `intake_scope_bindings`, which Nat's read does not join. X2 therefore **fails closed**: every scoped record whose meeting row has no valid `classification` is withheld (`classificationEnforcement: {"unclassified": "withhold"}`, the default). With today's hosted contract, **Grok would see nothing from production.** Options for Dante:

- **(a) Hosted read projection (recommended):** a reviewed hosted change that adds `classification` to every `meeting_queue('list')` meeting row (full and task-only), taken from the intake binding. Needs its own implementation authority and review (it changes the hosted schema; this lane did not). The MCP then withholds `internal`, `client_financial` and `restricted` automatically.
- **(b) Recorded acceptance:** a DECISIONS entry accepting term/id/path withholding without classification; the exposure config then sets `"classificationEnforcement": {"unclassified": "allow", "decisionReference": "<item>"}`. Residual: lexical screening misses things like "Discuss Sam's promotion", "Pay Sam 900 weekly", "Review the staff roster" (R16 probe).

## 2. Human: Cloudflare account, domain, Access (Rhys or Dante with Rhys's approval)

1. Decide the account (section 0). Business-owned, 2FA, owner recorded.
2. Dedicated domain on that account (full NS setup).
3. Zero Trust team (`<TEAM>.cloudflareaccess.com`), Free plan (may ask for a payment method; unverified).
4. **Two** service tokens: `atlas-grok-acceptance` (synthetic phase, short duration, e.g. 7 days) and later `atlas-grok-nat` (real phase, 90 days or less). Client ID/Secret go straight to the owner's password manager; never into Slack, email, documents or an assistant chat.
5. Self-hosted Access application `Atlas MCP (Grok)` on `<HOSTNAME>`, path `mcp`; App Launcher off; no IdP login; **one** policy: Service Auth, Include → the current phase's service token only. Note the AUD tag (not secret).
6. **Mandatory** edge rate-limiting rule on `<HOSTNAME>` (R14 requirement 5), e.g. 60 requests/min per IP, block 10 min; use what the plan supports and record it.
7. Logging: Access/HTTP logs are metadata; do not enable Logpush with bodies or any Worker that logs bodies. Set retention.

## 3. Mac: stage the SYNTHETIC acceptance origin (supervised; after R16c ACCEPT)

```sh
cd <REVIEWED WORKTREE>          # exact R16c-accepted commit; check `git rev-parse HEAD` and a clean tree
export PATH=/opt/homebrew/bin:$PATH
A=~/.config/atlas/atlas-mcp-exposure-acceptance
install -d -m 700 $A $A/empty-brain ~/.local/state/atlas-mcp-exposure-acceptance
install -m 600 atlas-mcp/config/exposure-acceptance.example.json $A/config.json
install -m 600 atlas-mcp/config/sensitivity.json                 $A/sensitivity.json
install -m 600 atlas-mcp/config/acceptance-fixture.json          $A/acceptance-fixture.json
shasum -a 256 $A/sensitivity.json     # must equal sensitivitySha256 in the config (approved bytes c1611d8a…0d97)
node atlas-mcp/bin/atlas-mcp.ts exposure-kill --config $A/config.json      # start killed
```

Edit `$A/config.json`: `exposure.publicHostname`, `cfAccess.teamDomain`, `cfAccess.aud`, `cfAccess.serviceTokenClientIdSha256` = SHA-256 of the **acceptance** token's Client ID (computed locally: `printf %s '<id>' | shasum -a 256`, typed by the human). Leave `serviceTokenHeaders` null. The synthetic config uses hosted actor `synthetic_nat` and a local fixture: the loader refuses a non-synthetic actor in synthetic mode and a synthetic actor in production mode, and synthetic mode never reads Mission Control's transport file or any production JWT.

```sh
node atlas-mcp/bin/atlas-mcp.ts policy-check    --config $A/config.json   # sha256 + pinned: true
node atlas-mcp/bin/atlas-mcp.ts mint-token      --config $A/config.json --principal grok_as_nat --out $A/grok.token --expires-days 7
node atlas-mcp/bin/atlas-mcp.ts exposure-status --config $A/config.json   # killed, hostedSource synthetic, deployable yes
```

The server refuses to start or resume with placeholders, without the policy pin, with an invalid/insecure policy, or without a writable audit sink.

## 4. Mac: this lane's own tunnel (human-run; outbound only; leaves the existing daemon alone)

```sh
cloudflared tunnel login                     # browser login to the chosen account; writes ~/.cloudflared/cert.pem
cloudflared tunnel create atlas-mcp-grok     # ~/.cloudflared/<TUNNEL_ID>.json (owner-only); never print it
cloudflared tunnel route dns atlas-mcp-grok <HOSTNAME>
cp atlas-mcp/deploy/cloudflared-config.example.yml ~/.cloudflared/atlas-mcp-grok.yml   # NOT config.yml
# edit TUNNEL_ID, HOSTNAME, TEAM (team name only), AUD
chmod 600 ~/.cloudflared/atlas-mcp-grok.yml ~/.cloudflared/*.json ~/.cloudflared/cert.pem
cloudflared tunnel --config ~/.cloudflared/atlas-mcp-grok.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/atlas-mcp-grok.yml ingress rule https://<HOSTNAME>/mcp
```

No quick tunnel (`trycloudflare.com`, including the vendor's generic Grok example), no `httpHostHeader`, no `noTLSVerify`, no token on a command line.

## 5. Mac: prepare both user jobs for the ACCEPTANCE phase (still killed)

Both templates carry placeholders for the worktree, the config and the state directory, so the acceptance phase never writes into production paths (R16b B4):

```sh
W=$PWD; A=~/.config/atlas/atlas-mcp-exposure-acceptance; AS=~/.local/state/atlas-mcp-exposure-acceptance
for f in ai.atlas.atlas-mcp-exposure ai.atlas.cloudflared-atlas-mcp-grok; do
  sed -e "s#WORKTREE#$W#g" -e "s#CONFIG_FILE#$A/config.json#g" -e "s#STATE_DIR#$AS#g" atlas-mcp/deploy/$f.plist > /tmp/$f.plist
  plutil -lint /tmp/$f.plist
  grep -c "atlas-mcp-exposure-acceptance" /tmp/$f.plist        # >= 1: logs (and, for the origin, --config) point at acceptance paths
  ! grep -q "WORKTREE\|CONFIG_FILE\|STATE_DIR\|/atlas-mcp-exposure/" /tmp/$f.plist && echo "no production paths or placeholders left"
done
```

## 6. Start the acceptance window (Dante's explicit go)

The origin starts **killed** (the kill file from section 3 is present) and records which config it runs (`exposure-runtime.json`). `exposure-resume` releases the kill switch only for a live `exposure-http` process started with exactly the config file passed to it; any config change needs a restart first (R16b B2).

```sh
cp /tmp/ai.atlas.atlas-mcp-exposure.plist /tmp/ai.atlas.cloudflared-atlas-mcp-grok.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.atlas.atlas-mcp-exposure.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.atlas.cloudflared-atlas-mcp-grok.plist
lsof -nP -iTCP:4020 -sTCP:LISTEN                                                     # 127.0.0.1:4020 only
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4020/mcp -H "Host: <HOSTNAME>"   # 503 (killed)
node atlas-mcp/bin/atlas-mcp.ts exposure-resume --config $A/config.json --confirm     # prints boundPid = the origin job's pid
```

## 7. Supervised SYNTHETIC remote acceptance: ordered checklist (R14 requirement 8; R16 #6; R16b B4)

Non-production service token `atlas-grok-acceptance`, synthetic hosted actor, synthetic fixture: no real business data can be read or released. Run from outside the Mac's network; secrets typed from the password manager into environment variables, never echoed. **Every Mac command names `--config $A/config.json` (or `ATLAS_MCP_EXPOSURE_CONFIG=$A/config.json`).** Run the phases in order; each phase starts from the state the previous one leaves. Record status codes and counts only.

**Phase A — resumed, below every limit**

| # | Request | Expect |
|---|---|---|
| A1 | Access headers + bearer, `tools/list` | 200; exactly `whoami capabilities list_tasks get_task` |
| A2 | `tools/call whoami` | principal `grok_as_nat`, hosted actor `synthetic_nat`, `sharingPolicy` present |
| A3 | `tools/call list_tasks` | exactly `task-syn-alpha-1`, `req-syn-alpha-2`, `req-syn-taskonly-1` |
| A4 | `get_task` on `task-syn-beta-1`, `task-syn-fin-1`, an unknown id | identical `not_found` |
| A5 | `search_calls`, `ask_call`, `get_draft` | `isError`, `forbidden` |
| A6 | `GET /mcp`; `POST /other` | 405 at origin; 404 from the tunnel ingress |
| A7 | 20 KB body; 2,000-character JSON-RPC id | 413; small `Invalid id.` error |
| A8 | On the Mac: `curl -X POST http://127.0.0.1:4020/mcp` (no public Host) | 421 (`bad_host`) |
| A9 | On the Mac: same with `-H "Host: <HOSTNAME>"`, no Access JWT | 403 (`access_denied`) |
| A10 | No headers at all, from outside | 401 or 403 from Cloudflare Access; no origin audit row |
| A11 | Access headers only (no bearer), then 3 wrong bearers | 401 ×4 (below `bearerFailuresPerMinute` 10) |

**Phase B — limits, then a defined recovery**

| # | Step | Expect |
|---|---|---|
| B1 | After a 70 s pause, 25 valid requests within one minute | 200 ×20, then 429 (`rate_minute`, origin limit 20/min) |
| B2 | 35 wrong bearers within one minute | 401 ×10, then 429 `bearer_rate`, then 429 `unauth_rate` once 30 pre-auth failures accumulate in the minute (no further JWT work); the audit shows one aggregated row per reason per 10 s with `suppressed` counts. Valid requests are also 429 until the window clears |
| B3 | Separately, the configured **edge** rule threshold (e.g. 60/min per IP) | Cloudflare 429 at that threshold; record the rule and provenance |
| B4 | **Wait 70 s** (per-minute, bearer and global pre-auth windows expire), then A1 | 200 again |

**Phase C — kill and bound resume**

| # | Step | Expect |
|---|---|---|
| C1 | Start a slow request (A3), and during it run `exposure-kill --config $A/config.json` | that request and every later one 503 |
| C2 | `exposure-resume --config $A/config.json --confirm` | exit 0, `boundPid` = origin pid; A1 → 200 |
| C3 | Edit `$A/config.json` (e.g. perMinute 19) | next request 503 `config_changed`; `exposure-kill`; `exposure-resume` **refused** (`config_changed_since_server_start`), kill kept |
| C4 | Restore the exact previous bytes (or restart the origin job with the edited config: `launchctl kickstart -k gui/$(id -u)/ai.atlas.atlas-mcp-exposure`), then `exposure-resume` | exit 0; A1 → 200 |
| C5 | Make `$A/sensitivity.json` group-readable for one request, then restore 0600 | that request `not_available`; next one normal |

**Phase D — bearer rotation and in-flight revocation**

| # | Step | Expect |
|---|---|---|
| D1 | `rotate --config $A/config.json --principal grok_as_nat --out $A/grok-2.token --expires-days 7`; old bearer, new bearer | 401 / 200 (update the Grok connector's bearer) |
| D2 | During a slow request, `revoke-principal --config $A/config.json --principal grok_as_nat` | that request 401 (`revoked_in_flight`), later ones 401 |
| D3 | `mint-token --config $A/config.json --principal grok_as_nat --out $A/grok-3.token --expires-days 7` | 200 with the new bearer |

**Phase E — audit**

E1: `$AS/exposure-audit.jsonl` has one schema-bound row per request, with flood reasons aggregated; it contains no token, JWT, body or task text. E2: Cloudflare logs for the hostname hold metadata only.

**Phase F — irrevocable credential step (last)**

F1: revoke the `atlas-grok-acceptance` service token in Cloudflare; A1 → 401/403 at the edge. **To repeat any earlier phase after F1:** create a new acceptance service token, add it to the Access policy, put its Client ID hash in `$A/config.json`, restart the origin job (`launchctl kickstart -k …`; the binding changes), then `exposure-resume`. Never use the production token for synthetic acceptance.

**Phase G — stop, with separate pre-stop and post-stop checks**

| # | Step | Expect |
|---|---|---|
| G1 | `node atlas-mcp/bin/atlas-mcp.ts exposure-kill --config $A/config.json` then A1 | **503** (pre-stop observation) |
| G2 | `sh atlas-mcp/deploy/kill-switch.sh --config $A/config.json --revoke` | exit 0; both user jobs reported stopped and verified; `hostedSource: synthetic` in the status line; the existing system tunnel untouched |
| G3 | A1 from outside | unreachable (Cloudflare tunnel error such as 502/530, or Access 401/403 if F1 done); `lsof -iTCP:4020` empty |

Then remove the two acceptance plists from `~/Library/LaunchAgents`.

## 8. Separate switch to real data (its own authorization)

Only after section 7 passes, the section-1 classification decision is implemented or recorded, Rhys's item-20 confirmation is recorded, Nat's access is re-established under DECISIONS 26 (her 121 grants and resolver are being deactivated and the local nat/grok tokens revoked in a separate lane; only Rhys-confirmed level-3 clients are to be re-granted), and Dante authorizes the switch:

1. Stage `~/.config/atlas/atlas-mcp-exposure/` (config from `config/exposure.example.json`: production `hostedSource`, actor `nat`) and `~/.local/state/atlas-mcp-exposure/`, same pinned policy, the **real** service token's Client ID hash, kill file present; mint a new expiring bearer in **that** registry.
2. Regenerate both plists with `CONFIG_FILE=~/.config/atlas/atlas-mcp-exposure/config.json` and `STATE_DIR=~/.local/state/atlas-mcp-exposure`; bootstrap; Access policy → the real token only; `exposure-resume --config <production config> --confirm`.
3. Re-run phases A (expected `list_tasks` = **the observed authorized scope**: classified, non-withheld tasks of Nat's re-granted clients; possibly empty), B4 recovery as needed, C1–C2, E, and G1 with the **production** config named explicitly.
4. Natalie updates the connector to the real credentials and runs the first prompt below under supervision.

## 9. Natalie's connector

Known from vendor docs (as cited by R16): Grok documents custom MCP connectors with a URL and Streamable HTTP. **Still unverified for her account:** sending three static headers (`Authorization`, `CF-Access-Client-Id`, `CF-Access-Client-Secret`), any OAuth requirement, Origin behaviour, secret custody/retention at xAI, and whether Grok invokes tools autonomously (her 2-hourly Slack scan). Verify in section 7 (phase A) with acceptance credentials. If incompatible, stop: a relay or OAuth front is a new, separately reviewed design; never weaken a gate.

| Field | Value |
|---|---|
| URL | `https://<HOSTNAME>/mcp` |
| Header | `Authorization: Bearer <token for the current phase>` |
| Header | `CF-Access-Client-Id: <current phase service token ID>` |
| Header | `CF-Access-Client-Secret: <current phase service token secret>` |

First prompt (read-only, no spend):

> Using the Atlas connector only: call `whoami` and tell me which principal you are connected as and which tools you can use. Then call `list_tasks` and give me just the task titles, clients and due dates, exactly as returned. If the list is empty, say it is empty. Do not guess or add anything that is not in the tool results.

Expected: synthetic phase as in section 7 A2–A3; real phase the observed authorized scope.

## 10. Kill switch, config/policy changes, rotation, rollback

**Kill switch:** `sh <WORKTREE>/atlas-mcp/deploy/kill-switch.sh --config <phase config> [--revoke]`. The config is **required** (no default), so the acceptance and production registries cannot be confused. It writes the kill file first (503 to everything; results completed after it are dropped), boots out only `ai.atlas.atlas-mcp-exposure` and `ai.atlas.cloudflared-atlas-mcp-grok`, kills only `cloudflared … run atlas-mcp-grok`, verifies each is gone (non-zero exit if not), and prints the status for that config. The existing system cloudflared daemon is outside this lane: the script never stops it and does not suggest stopping it. Then revoke the service token or disable the Access app in Cloudflare.

**After a kill:** `exposure-resume --config <phase config> --confirm` works only while the **same** origin process (the one that recorded `exposure-runtime.json`) is running with byte-identical config, and its own pinned policy validates. If the jobs were stopped, bootstrap them again (they start killed), then resume.

**Config or policy changes (any key, including `sensitivityFile`, `sensitivitySha256`, `classificationEnforcement`, Access values):** a running server answers 503 `config_changed` as soon as its config file changes, and `exposure-resume` refuses. The procedure is kill → edit (after review) → `policy-check` → restart the origin job with the edited config (`launchctl kickstart -k gui/$(id -u)/ai.atlas.atlas-mcp-exposure`) → `exposure-resume`. The policy file itself is still re-read on every scoped call: a deleted, insecure, invalid or not-matching-the-pin policy gives `not_available` immediately.

**Rotation / revocation:** `rotate --config <phase config> --principal grok_as_nat --out <new> --expires-days ≤ tokenMaxAgeDays`; `revoke-principal`; `revoke --sha256-prefix`. A bearer revoked while a request is in flight gets 401 instead of the result. Watch the hosted `nat` JWT expiry (2027-01-18T06:01Z; Lane H alert 2027-01-04).

**Rollback:** kill switch with `--revoke` for each phase config; in Cloudflare revoke both service tokens, delete the Access app, the `<HOSTNAME>` DNS record and tunnel `atlas-mcp-grok`; on the Mac remove the two user plists and this tunnel's credentials/config; keep the audit files; Natalie removes the connector. The local Rhys install and the existing system tunnel are unaffected.

## 11. Alternative: Tailscale Funnel (not accepted on its own)

Unchanged conclusion: Funnel has no independent client-auth gate, so it fails R14 unless paired with a reviewed independent gate (verified fixed Grok egress IPs, or a relay). X2 removed the `cfAccess` "off" mode entirely, so a Funnel variant would need its own reviewed design. Advantage: TLS ends on the Mac; no new account.
