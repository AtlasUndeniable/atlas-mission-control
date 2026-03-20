# ATLAS Mission Control — Build Instructions

You are building Mission Control, a real-time dashboard for Rhys Livingstone's
coaching business (Undeniable Mentoring). This runs on the Mac Studio alongside
the ATLAS AI agent system.

## ARCHITECTURE

Single-page dashboard with 13 panels in a responsive CSS grid.
All data comes from localhost bridge services — NO external API calls needed.
The bridges handle all third-party auth internally.

## DESIGN SYSTEM

- **Background**: #0a0e1a (dark navy, NOT pure black)
- **Cards**: Glassmorphism — rgba(15,20,35,0.8) with backdrop-blur-xl, 1px border rgba(255,255,255,0.08)
- **Accent**: Cyan #06b6d4 for primary highlights, borders, active states
- **Secondary**: Purple #a855f7 for agent activity, secondary actions
- **Success**: #22c55e | **Warning**: #f59e0b | **Error**: #ef4444
- **Text**: White #ffffff for primary, #94a3b8 for secondary, #64748b for muted
- **Font**: Inter for UI, JetBrains Mono for data/numbers
- **Cards glow**: Subtle cyan box-shadow on hover (0 0 20px rgba(6,182,212,0.1))
- **Animations**: Pulse for status dots, subtle fade-in for panels loading
- **Aesthetic**: "JARVIS meets Bloomberg terminal" — professional, data-dense, alive

## DASHBOARD LAYOUT

### Row 1: Hero Section
```
┌──────────────────────────────────────┐ ┌───────────────────┐
│           REVENUE HERO               │ │  CONSTELLATION    │
│  $XXX,XXX  MTD    (+X.X%)           │ │  NETWORK VIZ      │
│  Projected: $XXX,XXX                │ │  (SVG status map) │
│  Target: $XXX,XXX                   │ │                   │
└──────────────────────────────────────┘ └───────────────────┘
```

**Revenue Hero** (col-span-3): MTD revenue, projected EOM, vs target, % change.
Show "Connecting..." with subtle pulse until Newie/Zapier wired.

**Constellation Network** (col-span-1): SVG-based network visualization.
- Central node: "ATLAS" with cyan glow
- Orbital nodes: CLAUDE, SLACK, GHL, MONDAY, FIREFLIES, CALENDAR
- Each node has a status dot (green/amber/red) from health checks
- Connection lines pulse with CSS animation when service is healthy
- Implementation: Pure SVG + CSS animations. No canvas/WebGL.
- Health check: Fetch each bridge URL + /health, timeout 3s

### Row 2: KPI Cards (6 across)
```
┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│CALL│ │CLNT│ │ AD$│ │ROAS│ │SLCK│ │CLSE│
└────┘ └────┘ └────┘ └────┘ └────┘ └────┘
```

Each card: Big number + label + change indicator (▲ green / ▼ red + percentage).
- **Calls Booked**: From GHL bridge :4003 (GET /contacts or /pipeline)
- **Active Clients**: From Monday bridge :4004 (count boards)
- **Daily Ad Spend**: "Connecting..." (Meta = Manus handles)
- **ROAS**: "Connecting..." (Meta = Manus handles)
- **Slack Unread**: From Slack bridge :4006
- **Close Rate**: From GHL bridge :4003 pipeline data

### Row 3: Main Panels (4 columns)
```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ META ADS │ │OPERATIONS│ │ REVENUE  │ │  AGENT   │
│(Manus)   │ │(Monday)  │ │  TREND   │ │ ACTIVITY │
│          │ │          │ │ (chart)  │ │          │
│──────────│ │──────────│ │──────────│ │──────────│
│ PIPELINE │ │ COACHING │ │ SYSTEM   │ │ PENDING  │
│ (GHL)    │ │  INTEL   │ │  PERF    │ │APPROVALS │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```

**Column 1:**
- META ADS: Placeholder "Connecting... (Manus)" with pulse. Future: Drive CSV import.
- PIPELINE: GHL pipeline stages. GET :4003/pipeline → show stage names + counts.

**Column 2:**
- OPERATIONS: Monday.com data. GET :4004/boards → aggregate:
  - Count items with "Priority" status = high/critical
  - Count items by status (done, working, stuck)
  - Show: High Priority items, Tasks completed this week, Active workflows
- COACHING INTEL: Fireflies data. GET :4005/transcripts?limit=5 →
  - Calls this week (count by date)
  - Total calls processed (GET :4007/health → processed count)
  - Show last 3 call titles + dates

**Column 3:**
- REVENUE TREND: Recharts line chart. Placeholder data until Newie wired.
  Show "Sample data — connecting revenue source" label.
- SYSTEM PERFORMANCE:
  - Services online: health check each bridge, count green
  - Model: "Sonnet 4.5" (read from gateway)
  - Uptime: process uptime or gateway health
  - Tokens today: if available from gateway logs

**Column 4:**
- AGENT ACTIVITY: Real-time feed.
  - Read /tmp/openclaw/openclaw-*.log (today's log)
  - Parse for agent actions, Slack messages, tool uses
  - Show: timestamp, action description, status dot
  - Auto-scroll, last 15 entries, poll every 5s
- PENDING APPROVALS: Future approval workflow placeholder.
  Show "No pending approvals" with empty state icon.

### Row 4: Atlas Chat Bar (full width)
```
┌──────────────────────────────────────────────────────────┐
│  ATLAS >  Ask ATLAS anything...                      ⏎   │
└──────────────────────────────────────────────────────────┘
```

- Input field with cyan border on focus
- POST to gateway: proxy through Next.js API route to http://127.0.0.1:18789
- Stream or display response below the input
- This is the ONLY feature that costs LLM tokens

## API ROUTES (Next.js App Router)

### GET /api/health
Hit each bridge + /health, return status map:
```json
{
  "gateway": { "status": "online", "latency_ms": 12 },
  "ghl": { "status": "online", "latency_ms": 45 },
  "monday": { "status": "online", "latency_ms": 38 },
  "fireflies": { "status": "online", "latency_ms": 22 },
  "slack": { "status": "online", "latency_ms": 15 },
  "call_processor": { "status": "online", "latency_ms": 8 }
}
```

### GET /api/overview
Aggregate data from all bridges into one payload. Cache 30 seconds.
Returns the full dashboard data structure.

### GET /api/activity
Read today's gateway log, parse last 20 meaningful entries.
Return as array of { timestamp, action, status }.

### POST /api/ask
Proxy to OpenClaw gateway at :18789.
Request: { "question": "string" }
Response: { "answer": "string" }

## BRIDGE API REFERENCE

### GHL Bridge (:4003)
- GET /health — { status: "ok" }
- GET /contacts — contact list
- GET /pipeline — pipeline stages + opportunities

### Monday Bridge (:4004)
- GET /health — { status: "ok" }
- GET /boards — all boards with columns, groups, items
  - Response: { data: { boards: [...] } } ← NOTE: wrapped in data.boards

### Fireflies Bridge (:4005)
- GET /health — { status: "ok" }
- GET /transcripts?limit=N — recent transcripts
  - Response: { data: { transcripts: [...] } } ← NOTE: wrapped in data.transcripts
- GET /transcript/:id — single transcript detail
  - Response: { data: { transcript: {...} } } ← NOTE: wrapped in data.transcript

### Slack Bridge (:4006)
- GET /health — { status: "ok" }
- GET /channels — { total: N, channels: [...] }

### Call Processor (:4007)
- GET /health — { status: "ok", processed: N }

## PLACEHOLDER STRATEGY

Panels without live data show:
- Subtle pulse animation on the card border
- "Connecting..." text with the data source name in muted text below
- Example: "Connecting..." / "Awaiting Newie integration"
- NOT fake data, NOT error states — just "awaiting integration"
- This is honest and still looks professional

## BUILD ORDER

1. Create Next.js app with TypeScript + Tailwind + App Router
2. Global styles: dark theme, glassmorphism classes, fonts
3. Page layout: CSS grid matching the panel layout above
4. Constellation SVG with health check status dots
5. KPI row: 6 cards with live data where available
6. Operations panel (Monday) + Coaching panel (Fireflies)
7. Agent activity feed (gateway log reader)
8. System performance + Pipeline (GHL)
9. Placeholders: Revenue Hero, Meta Ads, Revenue Trend, Approvals
10. Atlas Chat bar with gateway proxy
11. Polish: hover effects, loading states, responsive, animations
12. Commit after each milestone

## RULES

- Bind to 127.0.0.1:3000 ONLY — NEVER 0.0.0.0
- "Connecting..." for panels without live data — NEVER fake numbers
- All bridge API calls are free REST calls — no LLM tokens
- Only Atlas Chat costs tokens (gateway proxy)
- Monday bridge returns data wrapped in { data: { boards: [...] } }
- Fireflies bridge returns data wrapped in { data: { transcripts: [...] } }
- Commit after each major milestone with descriptive messages
- Do not install unnecessary packages — keep dependencies minimal
