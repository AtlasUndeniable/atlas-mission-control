# Atlas Agent Core V0 Architecture Bridge

Status: architecture bridge only. No runtime behavior changes, external sends, client-system mutations, or production Supabase wiring.

## Target Loop

Atlas Agent Core should own this loop:

1. observe
2. plan
3. decide
4. act
5. reflect
6. compress
7. emit
8. persist

Workspace should invoke this loop first. Slack, OpenClaw, Codex, Mastra, Anthropic Agent SDK, and future connector executors should be adapters around the loop, not the canonical brain.

## Current-State Architecture Map

### Workspace UI

- `/workspace` serves the Manus-style shell through the Workspace demo component.
- The UI consumes `AgentEvent` streams, keeps `visibility: internal` events in Inspector, and hydrates only presentation-safe thread events into chat.
- Current panels cover sessions, library artifacts, and connector status. They are product surfaces over local state, not the agent loop itself.

### Local-Run Route

- `POST /api/workspace-demo/local-run` parses prompt/project/room/session, selects the runtime provider, streams newline-delimited `AgentEvent` JSON, and appends hydratable events into local session storage.
- It currently delegates directly to a runtime adapter. There is no durable core run record, plan object, decision object, critic pass, or budget accounting before the adapter runs.

### AgentEvent Contract

- `src/lib/workspace-demo-events.ts` defines the presentation/internal event contract.
- Events cover message deltas/completions, tool calls/results, artifact creation, task steps/completion, and errors.
- `src/lib/workspace-event-log.ts` maps that contract to the Supabase `events` table and enforces that tool events remain internal.

### Local Sessions/Events

- `src/lib/workspace-local-sessions.ts` persists presentation events under the local Workspace state folder as metadata, `events.jsonl`, and `session.json`.
- Hydration rebuilds chat messages, artifact cards, task steps, task chips, and library entries.
- Internal tool events are intentionally excluded from default presentation hydration.

### Artifact Generation

- `src/lib/workspace-draft-artifacts.ts` detects explicit artifact intent, writes local markdown/PDF sidecars under the controlled Workspace artifact folder, and emits `artifact.created`.
- Supported Ricky PDF output reuses the real Atlas/Rhys archive package. Unsupported PDF paths are hidden or downgraded to internal markdown draft behavior.

### Reference Resolver

- `src/lib/workspace-reference-resolver.ts` reads local Librarian/context/call/project roots and produces compact reference packets with safe handles, source labels, confidence, freshness, guidance, and redacted path summaries.
- `src/lib/workspace-agent-tools.ts` wraps this as read-only tools: `search_memory`, `find_artifact`, `get_reference_packet`, and `summarize_calls`.

### Runtime Adapters

- `src/lib/workspace-runtime-provider.ts` chooses `mock`, `local-codex`, or `mastra`.
- `src/lib/workspace-local-runtime-adapter.ts` and `src/lib/workspace-mastra-runtime-adapter.ts` resolve references/tools, build runtime prompts, stream assistant output, maybe create local artifacts, and emit task events.
- The adapters currently contain much of the implicit loop. They should become executor adapters behind Agent Core.

### OpenClaw / Hermes / Slack Pieces

- OpenClaw remains a local operations/workspace substrate with memory, services, Slack listener/bridge, Fireflies, Monday, call processor, and worker handoff files.
- Mission Control has approval routes that can send Slack when approved, but that is outside this bridge and must not become the canonical Workspace runtime.
- No clear Hermes runtime should be treated as the Workspace brain from this repo audit. Any Hermes/Codex/OpenClaw execution should be modeled as an executor adapter or connector behind Agent Core.

### Supabase Event Spine

- `supabase/migrations/002_workspace_event_spine.sql` defines `workspaces`, `messages`, `events`, `plugins`, and `watchers`.
- `src/lib/workspace-event-log.ts` already maps `AgentEvent` to/from rows and builds replay queries.
- Production Supabase is not wired for Workspace runtime yet; the schema is the durable target, not the current beta persistence.

## Gap Analysis

| Capability | Current State | Gap |
| --- | --- | --- |
| Durable plan/todo | Task steps exist as presentation events. | Need first-class plan object with step ids, dependencies, owner, and status independent of chat UI. |
| Structured loop outputs | AgentEvents exist; runtime context is mostly prompt text. | Need explicit observe/plan/decide/act/reflect/compress/emit/persist records. |
| Tool schemas | Read-only Workspace tools and connector registry exist. | Need a Core-level dispatch envelope with safety, dry-run, approval, budget, and replay metadata. |
| Critic role | Some truthfulness and safety rules live in prompts/sanitizers. | Need structured critic output before final emit and before artifact/action readiness. |
| Budgets | Timeouts exist in adapters. | Need run budgets for tool calls, turns, wall time, tokens, and cost. |
| Replayable event log | Local presentation events and Supabase event mapping exist. | Need full core event log including internal plan/decision/critic/compression events, with safe presentation projection. |
| Pause/resume/approval | Local sessions resume; approvals exist in separate routes. | Need run status, pause reasons, approval requests, approval grants, and resume semantics in Agent Core. |
| Files-as-state | Local session/artifact/job files exist. | Need normalized state envelope so files are an adapter persistence backend, not bespoke per feature. |
| Memory/skills writeback | Reference reads exist; memory maintenance projections exist. | Need explicit writeback proposal events and approval gates before any memory/skill mutation. |

## Proposed V0 Interface

The tiny code slice is in `src/lib/atlas-agent-core.ts`.

```ts
interface AtlasAgentCore {
  startRun(input): Promise<AtlasAgentCoreRun>;
  resumeRun(runId): Promise<AtlasAgentCoreRun>;
  appendUserMessage(runId, content): Promise<AgentEvent>;
  emitEvent(runId, event): Promise<AgentEvent>;
  dispatchTool(request): Promise<AtlasAgentToolDispatchResult>;
  runCritic(runId): Promise<AtlasAgentCriticResult>;
  persistRun(envelope): Promise<void>;
}
```

V0 constraints:

- `dispatchTool()` accepts only read-only tools or dry-run/approval-scoped requests.
- `emitEvent()` remains the only path to UI-visible output.
- `persistRun()` should support local JSON first and Supabase later through the same envelope.
- Slack/OpenClaw/Monday/Typeform/Google Ads/Meta Ads mutations remain blocked until an approval executor is deliberately wired.

## OpenClaw vs Agent Core Recommendation

OpenClaw should remain the local substrate: memory folders, bridge services, logs, Slack listener, Fireflies/Monday bridges, and local operational workers. It should not be the canonical agent brain.

Atlas Agent Core should become the canonical orchestrator:

- Workspace invokes Agent Core directly.
- Slack later becomes an ingress/egress adapter that creates or resumes Core runs.
- OpenClaw connectors become read/tool/action adapters with explicit safety and approval metadata.
- Supabase becomes durable event/run persistence when the local-only lane is promoted.

## Anthropic Agent SDK Recommendation

Recommendation: use Anthropic Agent SDK as an executor adapter, not the Core loop yet.

Rationale:

- The current Atlas requirement is product-level control: events, approvals, budgets, connector truth, persistence, memory writeback, and Workspace projection.
- Anthropic Agent SDK is valuable because it provides an agent loop, built-in tools, sessions, permissions, MCP, hooks, subagents, cost/usage tracking, and TypeScript/Python SDK surfaces.
- It can connect to MCP servers and constrain allowed tools, which fits future connector execution.
- But if it owns the core loop now, Atlas loses control over the run ledger, approval semantics, UI event projection, and adapter-neutral replay.

Best fit:

1. Agent Core owns observe/plan/decide/reflect/compress/emit/persist.
2. Anthropic Agent SDK is one `executor.adapter.anthropic-agent-sdk`.
3. The adapter receives a Core-approved task/tool envelope and returns structured messages/tool traces that Core converts into AgentEvents.

References checked during this pass:

- Anthropic Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Anthropic Agent SDK MCP configuration: https://code.claude.com/docs/en/agent-sdk/mcp
- MCP overview: https://modelcontextprotocol.io/docs/getting-started/intro

## Next Implementation Tickets

1. Add Core run/event types for `agent.observed`, `agent.plan.created`, `agent.decision.made`, `agent.reflection.created`, `agent.summary.compressed`, and `approval.requested`.
2. Add local JSON-backed Core run store beside current Workspace sessions, without changing UI behavior.
3. Wrap the current local-run route with `startRun()` and `persistRun()` while still delegating to the existing runtime adapter.
4. Move read-only Workspace tool dispatch behind `dispatchTool()` and keep existing tool events internal.
5. Add a critic pass that checks claims, references, artifact intent, connector/action safety, and path redaction before final `message.complete`.
6. Add pause/resume states and approval request envelopes for action readiness, still with all mutations disabled.
7. Add Supabase adapter for the same Core persistence envelope after local validation is green.
8. Add Slack adapter that can create/resume Core runs and only deliver after explicit approval.
