# Atlas Workspace Rhys Controlled Beta Script

Status: controlled local beta script for the current `/workspace` state.

Audience:

- Rhys: run the beta flow and send feedback.
- Dante/operator: preflight the local server/runtime and recover cleanly if the local Workspace state gets messy.

Current scope:

- `/workspace` serves the live Atlas Workspace shell.
- Local Workspace sessions persist to JSON.
- PDF artifact generation, preview, download, and the local Artifact Library are available.
- This is local-only. It is not Slack-connected, not OpenClaw-delivered, not Supabase-backed, and not full long-term memory.

## Rhys Test Script

### 1. Open Workspace

Open:

`http://127.0.0.1:3031/workspace?project=undeniable-os&room=workspace-demo`

Expected:

- Atlas Workspace loads.
- The left sidebar shows projects and saved local sessions if any exist.
- The top bar shows `Atlas 1.0`.
- No local file paths are visible in the chat, cards, preview, or Library.

### 2. Prompt One: PDF Artifact

Click `+ New task`, then send:

```text
Please update the Ricky Calder pay structure handover doc and return it as a PDF.
```

Expected:

- A user prompt appears in the thread.
- Atlas responds.
- A task chip appears.
- A card appears that says `PDF draft saved`.
- The card action says `Preview / Download PDF` or `Open / Download PDF`.

Open the artifact card:

- Click the PDF artifact card.
- In the preview panel, click `Open PDF` to open it in a new tab.
- Click `Download PDF` to download it locally.
- Close the preview panel.

Pass criteria:

- PDF preview/open/download works.
- The card is not a markdown-only artifact.
- No local paths such as `/Users/atlasai` or `.openclaw` appear.
- Nothing is sent to Slack or any external system.

### 3. Prompt Two: Thin Reference Honesty

Click `+ New task`, then send:

```text
What are the top 5 trends from recent calls?
```

Expected:

- Atlas answers in chat.
- If call coverage is limited, Atlas says references are limited or provisional.
- It should not pretend to have full recall of all calls.
- It should not create an artifact unless you explicitly ask for a file/export/PDF.

Pass criteria:

- Answer is useful but honest about reference coverage.
- No fake full-memory claim.
- No unexpected artifact card.

### 4. Prompt Three: Non-Artifact Thinking

Click `+ New task`, then send:

```text
Give me 10 content ideas for next week.
```

Expected:

- Atlas responds directly in the thread.
- It should not create a PDF, markdown draft, or file unless you ask it to save/export.

Pass criteria:

- Useful content ideas.
- No invented memory claim.
- No artifact card unless the prompt clearly asks for an artifact.

### 5. Test Library And Persistence

Open the `Library` tab.

Expected:

- Recent local artifacts for the selected project appear.
- Each artifact shows title, type, requested format, created time, and source task/session.
- PDF cards make preview/download behavior obvious.
- Markdown cards make preview/markdown download behavior obvious.

Open a PDF from Library:

- Click a PDF card.
- Confirm the same preview panel opens.
- Confirm `Open PDF` and `Download PDF` work.
- Close the preview.

Switch projects:

- Click another project such as `Ricky coach hire`.
- Confirm history/artifacts are scoped to that project. It is OK if it shows an empty local state.
- Click back to `Undeniable OS`.
- Confirm prior sessions and Library artifacts return.

Refresh the browser:

- Reload `/workspace`.
- Open `Library` again.
- Confirm local artifacts and sessions are still visible.

### 6. Feedback To Send Dante

Send Dante:

- Which prompts you tried.
- Whether PDF preview/open/download worked.
- Whether the Library made it easy to find the PDF again.
- Any place the UI felt blank, stale, confusing, or too technical.
- Any answer that sounded overconfident or claimed memory/reference coverage it did not visibly have.
- Any local path, raw JSON, command detail, or internal tool detail that appeared in the normal chat UI.
- Whether switching projects and refreshing preserved the right local history.

## Clear Caveats For Rhys

- This is a local beta, not production persistence.
- Supabase persistence is not wired yet.
- Slack/OpenClaw/Monday/Typeform delivery is not connected from this screen.
- The Workspace can create local artifacts only under the controlled local state folder.
- Reference coverage is still partial. Atlas should say when references are limited.
- Do not treat generated PDFs as externally delivered. They are local drafts until manually shared.

## Internal Operator Checklist

### Server And Runtime Preflight

- Canonical repo: `/Users/atlasai/atlas-mission-control`
- Expected route: `/workspace`
- Expected local URL: `http://127.0.0.1:3031/workspace`
- Confirm route:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3031/workspace"
```

- Confirm local sessions API:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3031/api/workspace-demo/sessions?project=undeniable-os&room=workspace-demo"
```

- If the running server is stale or down, restart only the local mission-control dev server.
- Do not restart Slack, OpenClaw, Monday, Typeform, Supabase, or external delivery services.

Runtime expectations:

- Live Mastra/Anthropic may be available when local env is configured.
- Mock/local fallback paths must continue to work.
- Model/runtime selection remains controlled server-side for this alpha.

### State Folders To Verify

Local sessions:

`/Users/atlasai/.openclaw/workspace/state/workspace-demo-sessions/`

Expected per-session files:

- `metadata.json`
- `events.jsonl`
- `session.json`

Local artifacts:

`/Users/atlasai/.openclaw/workspace/state/workspace-demo-artifacts/`

Expected artifact files:

- `*.metadata.json`
- `*.md` source drafts
- `*.pdf` when PDF was explicitly requested

Safety rules:

- Local paths may exist in metadata sidecars and Inspector-only/internal state.
- Local paths must not appear in normal chat, cards, Library, or preview UI.
- Internal tool events must not hydrate into the presentation thread.

### Known Limitations

- Supabase is still blocked on local tooling and not wired.
- Sessions are local JSON, not shared durable cloud state.
- Artifact Library indexes artifacts from persisted Workspace session events, not arbitrary filesystem browsing.
- Only document-style local markdown/PDF artifacts are supported.
- PDF export is local only and does not send files externally.
- Library/project counts are local to this browser/project/session state.
- Call/reference coverage may be thin.

### Rollback And Recovery

If the UI looks stale:

1. Hard refresh `/workspace`.
2. Restart only the local mission-control dev server if the route is serving an old build.
3. Reopen `http://127.0.0.1:3031/workspace?project=undeniable-os&room=workspace-demo`.

If one local session is confusing:

1. Click `+ New task`.
2. Run a fresh prompt.
3. Keep old sessions in place unless Dante explicitly approves deleting local state.

If local artifacts are messy:

1. Do not delete artifact folders during Rhys testing without approval.
2. Use the Library and session timestamps to identify the latest artifact.
3. Confirm the artifact opens via `/api/workspace-demo/artifacts/[id]` behavior, not by exposing local paths.

Rollback code behavior:

- Revert only the latest Workspace-specific commit if a regression is clearly tied to it.
- Do not touch unrelated dirty files in the worktree.
- Do not push rollback commits without explicit approval.

## Operator Verification Commands

Suggested checks before Rhys tests:

```bash
node --test tests/workspace-local-sessions.test.ts tests/workspace-draft-artifacts.test.ts tests/workspace-local-runtime-adapter.test.ts
npx eslint src/app/workspace-demo/WorkspaceDemoApp.tsx src/lib/workspace-local-sessions.ts tests/workspace-local-sessions.test.ts
npx tsc --noEmit --pretty false
npm run build
```

Browser smoke:

- Open `/workspace`.
- Generate the Ricky PDF.
- Open the PDF from the chat card.
- Open the same PDF from Library.
- Switch project and back.
- Refresh and confirm sessions/artifacts persist.
- Check desktop and mobile widths for horizontal overflow.
