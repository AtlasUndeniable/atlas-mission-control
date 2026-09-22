# Synthetic verification only

No files here are deployment overlays. Docker names and loopback ports belong only to this candidate. Never repoint the scripts to hosted infrastructure. They seed synthetic principals/tasks/permissions and contain public test-only credentials. `private*/` is ignored and excluded from transfer.

Prerequisites: Node with TypeScript stripping, current locked MC dependencies, Docker images `public.ecr.aws/supabase/postgres:17.6.1.132` and `public.ecr.aws/supabase/postgrest:v14.12`, and Chrome. Browser helper currently uses the Mac Chrome executable; Windows must adapt that executable path or inspect the supplied screenshots. No production env is required or loaded. Use a fresh clone / unused owned container names for a fresh run.

1. `python3 verification/start-db.py` creates isolated55824/55825 schema-only PostgreSQL/PostgREST, reconstructs captured schema and applies022. `--clean-check` uses separate `-clean` container/55834 and applies migration without fixture grants.
2. `SYNTHETIC_CALL=synthetic-doc-flow node verification/seed.mjs`; `node verification/permissions.mjs`.
3. `./node_modules/.bin/next build --webpack`; `node verification/serve.mjs` in another shell. It constructs a synthetic environment and starts fixture provider55826 and built app55827; wait for Next ready.
4. `SCREENSHOTS=1 node verification/workflow.mjs`; `node verification/additional.mjs`; `node verification/final-guards.mjs`.
5. `node verification/recovery-prepare.mjs`; stop only this serve process; `docker restart atlas-task-docs-20260922 atlas-task-docs-20260922-rest`; restart serve and wait ready; `node verification/recovery-after.mjs`.
6. `node --test verification/exec-*.test.ts`; focused lint paths are in TEST-RESULTS. `python3 verification/catalog-check.py` checks the separately created clean clone. Current captured helper hashes are also in `dependency-helpers.json`.
7. `node verification/held-states.mjs` captures disabled/uncertain fixtures. Stop/restart serve with `--held` to inspect the global missing-decision state. Screenshot arguments: taskUUID actor outputName version(0=no draft) mobile(0/1).

`FIXTURE_SUFFIX=-another-run` gives additional/recovery seed names fresh identities when rerunning in a used database; workflow needs a separately seeded fresh canonical task. Tests deliberately retain versions/journals. Never reset history to make a failing result pass. Development refresh/reset helpers are not required for the fresh reproduction and are not production migration tools.

Stop only the owned app/provider processes and three named `atlas-task-docs-20260922*` containers afterwards. Retain local synthetic journals as evidence; do not touch unrelated Docker/Supabase services. Capture before/after provider counts when checking restart/reconciliation.
