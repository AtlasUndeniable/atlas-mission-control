---
name: atlas-workspace-design-pass
description: Design spec for the Atlas/Undeniable workspace — applies the Manus form factor (chat-first agentic canvas) to the current Codex build. Pairs with `atlas-workspace-design-reference.html`.
type: project
---

# Atlas Workspace — Design Pass

> Source-of-truth design spec. Open `atlas-workspace-design-reference.html` in Chrome alongside this doc.

## The diagnosis

The current build is a CMS with a chat box. Manus is a chat workspace with structure. Same primitives, opposite center of gravity. Until the center of gravity moves, every visual pass on top will read as dashboard.

What Manus actually is: a conversation with an agent that has the agency to do real work, embeds its outputs back into the conversation as live artifacts, and accumulates a corpus of tasks and projects in a sidebar. The chat IS the workspace. The sidebar is your work. Everything else (plugins, scheduled jobs, settings) is secondary chrome.

What the current Atlas is: a workspace overview with status cards, system health metrics, preview tabs, and a composer pinned to the bottom. The composer reads as a feature, not the front door. The agent is a service the dashboard talks to, not the thing you are working with.

## What makes Manus look like Manus (DNA, from the reference screenshot)

1. **The main canvas is a conversation.** Not a header plus cards plus composer. A single vertical chat thread. The agent's reply IS the page.

2. **Artifacts live inside the chat.** A produced doc shows up as an embedded card right where it was created, with the doc rendering inline below it. There is no separate "Artifacts" tab. Artifacts also accumulate in the sidebar task list, surfaced as work-objects, not as a system counter.

3. **The task chip pattern.** At the bottom of an agent reply, a single collapsible chip: `✓ Compile comprehensive competitive intelligence report 4/4 ⌄`. This one component replaces an entire "Agent Runs" page. It encodes what the task was, how many steps, the result, and on-demand step-level expansion.

4. **The sidebar is your work, not the app's features.** Top: a single primary CTA (`+ New task`). A handful of muted secondary items (Agent, Plugins, Scheduled, Library). Then PROJECTS as collapsible folders, then ALL TASKS as a flat list. Each task row is a verb-noun titled by what it produces, with a subtle status icon. The sidebar makes you think about your work, not the system.

5. **Status is iconography, not pills.** A dotted-arc spinner means in-progress. A document icon means a finished artifact. No "ready" / "current" / "not executing" / "queued local" badges anywhere. Visible state is binary: working or done.

6. **The composer is the front door, period.** Wide, central, with inline attachment chips for the agent's plugins/tools, mic, send. Not a sidebar input. Not a hidden command palette. The way you start work is by typing into the composer.

7. **Restraint everywhere.** Near-black background, one or two accents used sparingly. One font family. Generous whitespace. Type weight does the hierarchy work. The product feels expensive because it isn't trying.

## What is wrong with the current Atlas (named, against the screenshots)

1. **The Home page leads with "Workspace pulse" metrics.** Local 22 / Archived 3 / Artifacts 7 / Controls 48, then Source health. This is a sysadmin dashboard. Rhys's first paint should be a composer. Metrics belong behind a Settings cog or removed.

2. **The "Home session" trio (Ask Atlas / Inspect / Results)** turns verbs into nouns. "Ask Atlas" should be a composer, not a card titled `Ask Atlas` with a `current` pill. The cards restate the existence of the composer. Delete them.

3. **"Recent local tasks" is right in spirit, wrong in execution.** The titles are debug strings (`Codex adapter V0 dry run after CLI flag compatibility fix. Return a c…`) and the cards are stamped with internal state (`not executing`, `completed local`, `Created 26 May, 06:38 pm`, `Undeniable OS`, `Settings / Readiness`, `Inspect`). A Rhys-facing task list shows a Rhys-language title, a subtle status icon, the artifact it produced, and a relative time. The debug metadata lives behind a click.

4. **The top-right `Agents preview / Tools preview / Routines preview / Library preview / Mode preview` block.** That is a developer mode-switcher inflicted on the chrome. Production has a small model chevron near the task title and a settings menu. Preview tabs disappear or move behind Settings.

5. **Left nav is feature surfaces (Home / Audits / Content / Approvals / Agent Runs / Training Grounds / Knowledge).** Manus's left nav is your work. Audits, Content, and Approvals are SKILLS the agent has; surface them as task TYPES inside the task list with type icons, not as nav. Agent Runs, Training Grounds, Knowledge are admin/configuration; they go behind a settings click or fold into Library.

6. **The Audits page is the Home pathology, magnified.** "Local drafts in this lane" plus status pills plus an "Audit intake" composer at the bottom of a stack of cards. The page is about the SYSTEM doing audits. It should be about Rhys doing an audit. Replace with a chat-first canvas for the audit work, sidebar holds past audits as tasks, composer is the way to start a new one.

7. **Voice/copy is admin-panel English.** `Save a local-only draft from the composer.` `Read artifact and memory projections without moving or sending anything.` `0 invalid local job records. External execution remains locked.` This is documentation copy describing system behavior. Product copy should be about the work, in Undeniable voice. Rhys does not care that execution is locked. He cares that the audit is ready.

8. **No conversational thread anywhere on screen.** The whole product is built around drafts, jobs, cards, and status. The actual mechanism of working with an LLM is conversation, and conversation is not visible. That is the structural error. Until a chat thread is the main canvas, nothing else fixes the feel.

## The redesigned Atlas — screen by screen

### Home / new session (empty state)

Single-canvas page. Nothing above the fold but the composer.

- Top bar (44px): brand mark left (`Atlas` plus a small dot), inline model chevron (`Atlas 1.0`), share + more on the right. No nav, no tabs.
- Center stage, vertically centered: a small low-emphasis greeting (`What do you want to do?`). Below it, the composer (~720px wide, centered, ~88px tall): `Message Atlas` placeholder, attachment + tool icons on the left, mic + send on the right.
- Below the composer, a row of starter chips (max five, work-oriented): `Draft an audit for...`, `Brief me on this week's calls`, `Generate a Monday board from a transcript`, `Pull a content plan for next week`, `Write a playbook on...`. Tapping seeds the composer.
- Sidebar (left, 256px, dark): unchanged from active-state spec below.

That is the entire page. No metrics, no cards, no Workspace overview. Empty is on purpose.

### Home / active task (the canonical view) — see reference HTML

A chat thread. Same sidebar, same slim top bar.

- Top bar shows the task title (`Competitive intel: home services agencies`), with the model chevron and share/more. No breadcrumb.
- Main canvas: vertical chat thread, ~720-820px content width, centered with comfortable side margins.
  - User message: right-aligned subtle bubble.
  - Atlas reply: left-aligned, no bubble background, just markdown on the canvas. Embedded artifact card mid-reply or at the end. Task chip at the bottom of the reply: `✓ Compile competitive intelligence report 5/5 ⌄`. Collapsible to show steps.
  - Streaming renders with a soft caret. No `Working… • tool: read • path` leakage.
- Composer: sticky at the bottom of the canvas, slightly shorter than the empty state (~64px). Plugin row collapses into a single `+` affordance if it would crowd.

### Project / task drill-in

Same chat canvas. The page IS the conversation that produced this work. Sidebar highlights the active task. Top bar shows the task title plus a small "open artifact" affordance. The artifact opens in a slide-out right panel (~480px), not a new page. Closes back to the conversation.

### Library

Where finished work consolidates. A clean filterable list of artifacts (docs, audits, content plans, briefs). Each row: artifact title, type icon, source task, relative time. Click opens the artifact in the slide-out. No status pills.

### Settings / Inspector

This is where today's `Local 22 / Archived 3 / Artifacts 7 / Controls 48 / Memory review items 595` block lives. Behind a cog. Inspector view (raw drafts, JSONL records, job intake) is a developer-mode tab here. Useful, just not on the front page.

## Design system

### Palette (placeholders — replace accents with Undeniable brand-kit values)

| Token | Value | Use |
|---|---|---|
| `--bg-canvas` | `#0a0a0b` | main canvas |
| `--bg-sidebar` | `#111113` | sidebar |
| `--bg-elev-1` | `#15151a` | artifact cards, surfaces |
| `--bg-elev-2` | `#1c1c20` | user message bubble, hover state |
| `--border` | `#1f1f23` | dividers, soft borders |
| `--text-1` | `#fafafa` | primary text |
| `--text-2` | `#a1a1aa` | secondary text |
| `--text-3` | `#71717a` | tertiary, captions |
| `--text-4` | `#52525b` | section headers, counts |
| `--accent` | `#d4a857` | placeholder Undeniable warm; swap with brand kit gold |
| `--success` | `#7fd1a2` | task chip check, completed |

One accent per view. Avoid color explosions.

### Type

- Family: `Inter`, `-apple-system`, `Segoe UI`, system-ui, sans-serif.
- Sizes: 12 (caption), 13 (sidebar item / label), 14 (body / chat), 15 (chat lead), 18 (top-bar task title).
- Weights: 400 body, 500 UI medium, 600 display.
- Line height: 1.55 body, 1.35 UI chrome.

### Spacing & density

- Base unit 4px.
- Sidebar item vertical padding 8px.
- Chat turn rhythm 24-32px.
- Canvas side margins ~80px at desktop, content max-width 820px.

### Motion

- Streaming caret: blinking 2px bar.
- Hover transitions: 120ms ease-out.
- Task chip expand: 180ms easeInOut.
- No bouncy easings, no big motion. Restraint.

### Iconography

- Single icon set (Lucide or Phosphor, light weight). Reference HTML uses inline SVG paths in the Lucide style.
- Status icons: dotted-arc spinner (in-progress), check (done), folder (project), document (artifact), clock (scheduled).
- No emojis in UI chrome. Emojis are fine inside agent replies if the agent chose them.

## Components

### Sidebar (256px)

1. Brand mark `Atlas` plus small dot, optional `for Undeniable` subtitle in tertiary text.
2. Primary button `+ New task`. Subtle dark fill, accent plus glyph. Full width.
3. Compact secondary nav: `Tasks · Library · Plugins · Scheduled`. Text-only, tertiary.
4. `PROJECTS` section header (caption, upper, tertiary). Collapsible folder rows with task counts right-aligned in muted text.
5. `ALL TASKS` section header. Flat list of recent tasks. Each row: status icon + title (truncated). Hover: subtle background lift. Active: background tint plus accent left-bar.
6. Bottom-pinned: avatar + name + chevron. Opens user/settings menu.

### Composer

Heights: 88px empty, 64px active. Width: matches canvas content (max 820px), centered.

- Background `--bg-elev-1`, 1px border `--border`, 12px radius.
- Placeholder `Message Atlas` (tertiary text).
- Inside the composer, left to right: `+` attachment, 2-4 plugin/tool icons (16-18px with tooltip), input, mic, send. Send turns to enter-arrow on non-empty input.
- Multi-line: expands to ~6 lines, then scrolls inside.

### Chat message (user)

Right-aligned. Max 70% canvas width. `--bg-elev-2` pill, 12px radius, 12/16 padding. No avatar.

### Chat message (agent)

Left-aligned. No bubble. Markdown directly on the canvas. While streaming, a 2px accent left-bar runs the height of the message; removes on completion.

Inside the agent message: standard markdown (h2/h3, bullets, bold, inline code, code blocks with `#0e0e10` background), an inline artifact card where the agent produced a doc, a task chip at the end if the reply represents a completed task.

### Artifact card (inline in chat)

- `--bg-elev-1` background, 1px border, 10px radius, 14px padding.
- Left: type icon (document / spreadsheet / playbook / audit).
- Center: title (label, primary), subtitle `Atlas · 2 min ago · 14 pages` (tertiary).
- Right: `Open ↗` link or expand chevron.
- For hero artifacts, expand inline below the card with a max-height and an "Open full" affordance.

### Task chip (end of agent reply)

Pill at the bottom of the agent message.

- `--bg-elev-1` background, 1px border, full radius.
- Layout: `[status icon] [task title] [N/N] [chevron]`.
- Example: `✓ Compile competitive intelligence report  5/5  ⌄`.
- Click expands a steps panel below the chip. Each step row: status icon, title, optional output preview. Re-collapse with the chevron.

### Top bar (44px)

- Left: task title (15px medium). On Home empty, `New session` or blank.
- 8px to the right: model chevron `Atlas 1.0 ▾`.
- Right: share, more (3-dot). On agent-running state, a small stop button appears.

## Voice & copy

Hard rules from `atlas-client/CLAUDE.md`:

- No em-dashes. (Codex tends to write them; lint or strip.)
- No AI jargon: leverage, optimize, transform, streamline, utilize, delve, realm, landscape, solutions, robust, comprehensive.
- No self-help tone. No `Let's dive into…` or `I'm here to help.`
- Short, direct, concrete.

Specific rewrites against current copy:

| Current | Replacement |
|---|---|
| `Workspace overview and saved project context.` | remove — Home is the composer |
| `Save a local-only draft from the composer.` | remove — the composer is self-evident |
| `Read artifact and memory projections without moving or sending anything.` | remove — debug copy |
| `Codex adapter V0 dry run after CLI flag compatibility fix. Return a c…` | replace with the actual Rhys-facing task title (e.g. `Q2 audit for Jess Sidoti`) |
| `not executing`, `completed local`, `queued local`, `current`, `ready`, `Local only` | remove all pills, use status icons |
| Empty state hero | `What do you want to do?` |
| Composer placeholder | `Message Atlas` |
| Agent finish-line | `Done. I pulled the competitive intel on the seven agencies you flagged. Here is what stands out:` |
| Failure copy | `That run hit a snag. I can retry, or step through it with you.` (not `Atlas timed out on that one. Wait thirty seconds and re-ask.`) |

## What gets cut entirely

- Home `Workspace pulse` metrics column.
- Home `Ask Atlas / Inspect / Results` trio.
- Top-right `Agents preview / Tools preview / Routines preview / Library preview / Mode preview` tabs.
- All `not executing` / `completed local` / `queued local` / `current` / `ready` / `Local only` pills.
- Visible `Created … pm` stamps in card chrome (move to hover-only tooltip).
- `Memory ready / 3 context packs / 595 review items` sysadmin block on the Audits page.
- `Audit intake` header chrome (`Local drafts in this lane / Not executing / queued local`) — replaced by a chat thread.
- All visible internal file paths in chrome.

## Rebuild order (priority)

1. **Move to a chat-thread canvas as the Home page.** Single change with the biggest visual delta. Replace the current Home with: sidebar (existing structure reskinned), slim top bar, empty-state composer centered, starter chips. Land this and the product reads Manus immediately, even before anything else changes.
2. **Kill the status pills and the top-right preview-tab block.** Visual noise, trivial to remove.
3. **Rebuild the sidebar** as Projects + All tasks with status icons and Rhys-language task titles. Audits / Content / Approvals become task TYPES (icons), not nav items.
4. **Build the agent-reply pattern:** markdown body + embedded artifact card + task chip at the end. This is the workhorse component; invest here.
5. **Build the artifact side panel** (slide from right on click of an artifact card).
6. **Rewrite all copy** per the voice rules and the table above.
7. **Move developer/inspector surfaces** (Local job records, Memory review items, Routines preview, etc.) behind a Settings cog. Keep them, just not on the front page.
8. **Apply Undeniable brand accents** from the brand kit. Replace placeholder amber, set brand serif (if any) for display, lock the palette.

## Open calls

- **Brand source.** Pull color + type from the Undeniable brand kit (currently in the OpenClaw workspace as `UNDENIABLE_BRAND_KIT.md`). Confirm logo / wordmark treatment for the brand mark in the sidebar.
- **Plugin surface in the composer.** Decide the actual visible set (Gmail, Drive, Slack, Fireflies, Monday, GHL, Brave, Newie) and the icon order.
- **Multi-user.** The design assumes single user at a time per workspace. If the team needs concurrent sessions, the sidebar grows a `Members` surface and tasks gain an assignee chip. Out of scope for v1.

Reference HTML: `atlas-workspace-design-reference.html` (same directory). Open in Chrome to see the target.
