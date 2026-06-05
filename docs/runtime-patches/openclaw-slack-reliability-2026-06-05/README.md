# OpenClaw Slack Reliability Runtime Patch - 2026-06-05

## Why this patch exists

This package snapshots runtime changes currently present outside git under `/Users/atlasai/.openclaw/workspace`.
The changes relate to Slack listener reliability, Slack DM delivery preference handling, timeout/fallback behavior, and listener-side reply handling.

The package exists so the exact live runtime files can be audited, checksummed, and restored if rollback is required.

No Slack messages were sent, no services were restarted, and no live OpenClaw files were modified during this archive capture.

## Files captured

| Live file | Captured file | SHA-256 |
| --- | --- | --- |
| `/Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs` | `lib/slack-listener-reply.mjs` | `6c5850c8f661db3b8eceb03a3cb5a96998c7adaccdc771da6e610faa8c62a7be` |
| `/Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs` | `lib/slack-listener-reply.test.mjs` | `988b95e165221ffabf0026600c5e2e0afdde129f264eab152a60e024b02214ea` |
| `/Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs` | `services/slack-listener/listener.mjs` | `26c976b82802556fbaa9ea6a28182500271ab8c8d196dc9846fd2298650816e3` |

## Backup and pre-change status

A search for matching backup or timestamped copies under `/Users/atlasai/.openclaw/workspace/lib` and `/Users/atlasai/.openclaw/workspace/services/slack-listener` found one backup-like file:

| Candidate backup | Modified time | SHA-256 | Notes |
| --- | --- | --- | --- |
| `/Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs.bak` | `2026-03-18T19:51:56+1100` | `634f3b2cb062027fd27ed54465b0750b9478e4564947d59a016517cb923759b9` | Older backup for `listener.mjs`; it differs materially from the captured live listener and should not be assumed to be the immediate pre-change version for the 2026-06-05 patch. |

No matching backup or timestamped pre-change copy was found for:

- `/Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs`
- `/Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs`

## Verification

Current archive verification:

- Live SHA-256 checksums were captured before copying.
- The copied package files were checksummed after copying.
- The copied package checksums match the live checksums for all three captured files.
- No current Slack sends, service restarts, or live runtime edits were performed.
- No current test suite was run during this archive capture.

Previous-session verification evidence available from Codex memory:

- `node --test lib/slack-listener-reply.test.mjs lib/slack-dm-jobs.test.mjs lib/slack-rhys-dm-artifact.test.mjs` passed `23/23` after the routing patch.
- A stale workspace handoff report showed `STALE_WORKSPACE_HANDOFF needs_workspace id=slackdm-D0AM2R3H6SE-1780281345.847369` with `preferredDelivery=slack_dm` after correction.
- Previous runtime activation restarted only `com.atlas.slack-listener`; gateway and monitor were intentionally not restarted. This archive capture did not repeat that activation.

## Rollback instructions

These instructions are for an approved rollback window only. Do not run them during read-only audit.

1. Record current live checksums:

   ```sh
   sha256sum \
     /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs \
     /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs \
     /Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs
   ```

2. Create a timestamped safety copy of the current live files:

   ```sh
   ts="$(date +%Y%m%d-%H%M%S)"
   cp /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs "/Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs.rollback-${ts}"
   cp /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs "/Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs.rollback-${ts}"
   cp /Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs "/Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs.rollback-${ts}"
   ```

3. Restore this archived patch into the live runtime:

   ```sh
   cp /Users/atlasai/atlas-mission-control/docs/runtime-patches/openclaw-slack-reliability-2026-06-05/lib/slack-listener-reply.mjs /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs
   cp /Users/atlasai/atlas-mission-control/docs/runtime-patches/openclaw-slack-reliability-2026-06-05/lib/slack-listener-reply.test.mjs /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs
   cp /Users/atlasai/atlas-mission-control/docs/runtime-patches/openclaw-slack-reliability-2026-06-05/services/slack-listener/listener.mjs /Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs
   ```

4. Verify restored checksums match this README:

   ```sh
   sha256sum \
     /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.mjs \
     /Users/atlasai/.openclaw/workspace/lib/slack-listener-reply.test.mjs \
     /Users/atlasai/.openclaw/workspace/services/slack-listener/listener.mjs
   ```

5. Run focused no-send validation before any service restart:

   ```sh
   cd /Users/atlasai/.openclaw/workspace
   node --test lib/slack-listener-reply.test.mjs lib/slack-dm-jobs.test.mjs lib/slack-rhys-dm-artifact.test.mjs
   ```

6. Restart only the required listener service if explicitly approved for the rollback window.

## Operational caveats

- `needs_workspace` is only a ledger or handoff state; it does not prove a worker claimed, built, or delivered the requested artifact.
- Listener routing fixes should not be treated as end-to-end Slack fulfilment verification.
- The live Slack listener path can acknowledge a request before downstream work is actually complete.
- Avoid broad service churn. If activation is needed, previous work used the minimal listener-only path.
- Slack sends must remain disabled unless explicitly approved by an operator.
