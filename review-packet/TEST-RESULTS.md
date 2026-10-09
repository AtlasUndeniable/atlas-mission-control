# Implementer verification

All generation, actors, sources and business transitions below are local synthetic fixtures. No hosted data rows were copied. No live provider call, Rhys/Nat device use, real task usefulness or customer acceptance is established.

| Verification | Result / evidence |
|---|---|
| Permission/classification/source checks | 26 passed, `evidence/permissions.json`: explicit grants, revocation, client/actor/source/item changes, Nat full-source/financial denial, required reviewer, curated freshness/classification/use/display, direct-write/private-function/runtime refusal |
| Built HTTP workflow | 26 passed, `workflow.json`, `workflow-release.log`: accepted canonical task, v1, exact bytes, reviewer substantive correction, preserved v2, duplicate calls, handoff/review and truthful internal completion |
| Recovery | 17 passed, `recovery.json`: lost provider response; cancellation/late response; exact prompt hash; retained response before simulated lost acknowledgment; actual local PostgreSQL/PostgREST/app/provider restart; reconciliation without another provider invocation; revoke/regrant invalidation |
| Additional invocation checks | 11 passed, `additional.json`: parallel callers make one dispatch, invalid response held privately, response replacement refusal, permission fence during invocation, same task on repeat acceptance |
| Auth and final guards | 14 passed, `final-guards.json`: built board/exec access matrix, spoofed principal/cross-origin/authority-field refusal, no implicit authority, revoked prior draft cannot feed a new correction, stale revision refusal |
| Held states | 2 passed, `held-states.json`: disabled task and expired reservation; screenshot uncertain state uses an advanced local reservation deadline, not an actual provider dispatch |
| Default activation hold | 3 passed, `default-held.json`: visible missing-decision message, explicit503 build hold, no invocation |
| Existing executive logic | 37 Node tests passed, `executive-regression.tap`: installed metrics/ranges/request gate/view state. Tests copied from accepted E1 and run against this candidate's unchanged current modules |
| Build and focused lint | `next build --webpack` and focused ESLint passed; TypeScript included in build. `build-release-webpack.log`, `lint-release.log` |
| Browser | 13 synthetic desktop/mobile screenshots with no observed runtime exceptions or panel overflow; screenshot JSON records exact fixture/state. Desktop v2 and mobile v2 were visually inspected, as were the final held/recovery states |

The authoritative final local build is recorded in the outer receipt. Default Turbopack refused the out-of-root node_modules symlink; explicit webpack succeeds. Earlier development build/log files remain historical evidence, not additional passing results. No verification shim enters product code. Production-like auth/service behavior was exercised against the built local candidate using constructed synthetic environment only; actual executive data/provider integrations were not configured there.

## Migration compatibility

`verification/start-db.py --clean-check` restores a captured schema-only baseline and applies exact021 **only to a disposable local clone**, checks current captures, then applies candidate022 from scratch. This is reconstruction for tests, not production migration guidance.

15 current meeting function definitions matched exact MD5s; three additional dependency helpers matched. 22 captured table definitions matched columns, effective owner ACLs, RLS and preexisting triggers. Seven constraint formatting differences across four tables are PostgreSQL associative-AND parenthesization differences, manually inspected; their exact before/after strings are retained in `catalog-differences.json`. They are not silently called byte-identical. `migration-catalog.json` records the final migration SHA256, clean install, no seeded documents/new RPC grants and repeat refusal. New authority fences are the deliberate extra triggers. Refresh the hosted catalog before any future installation; no hosted schema was changed during these tests.

## Visual evidence

01 ready;02 v1;03 substantive correction with v1 retained;04 v2 desktop;05 v2 mobile;06 exact-v2 reviewer handoff;07 accepted internal work;08 rejected response;09 cancellation;10 authority changed;11 disabled task;12 uncertain reservation;13 first-use decisions held. Each screenshot is clearly synthetic; generated documents carry an injected-response label. These are working-panel checks, not live approval/delivery acceptance.

## Direct preservation checks

`preservation.json`: all132 installed source hashes, all38 preservation paths and all six installed UX hashes unchanged; installed build `v6ZtYwepyahA5KetEuE_2`;25 dirty entries retained. Pilot held, private4020 absent/unloaded, worker loaded at30 seconds with no pilot override, MC/public-probe listener PIDs unchanged. Old UX and frozen pilot checkouts remain clean at their accepted commits. These checks are local; Eve was not freshly remotely inspected.

## Not tested / remaining gates

Real human commitment/permissions/usefulness, actual private provider/API behavior and spend, hosted rollout/locks/RLS gateway deployment, canonical Atlas-executor integration, real Nat device, external delivery and audience acceptance, production-scale locking/throughput and simultaneous administrative revoke/grant contention. Recorded-response acknowledgment loss is simulated by stopping before publication; the provider-response-loss case actually closes the local fixture socket. No test establishes a business decision. Windows independent candidate review is still pending.
