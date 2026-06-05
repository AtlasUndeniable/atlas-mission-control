import { access, stat } from "node:fs/promises";

export type WorkspaceConnectorId =
  | "slack"
  | "google-ads"
  | "meta-ads"
  | "fireflies"
  | "monday"
  | "typeform"
  | "google-drive-docs";

export type WorkspaceConnectorStatus =
  | "online"
  | "degraded"
  | "offline"
  | "not_configured"
  | "not_wired"
  | "limited";

export type WorkspaceConnectorCapabilityState =
  | "available"
  | "approval_gated"
  | "not_exposed"
  | "not_wired"
  | "blocked";

export type WorkspaceConnectorSafetyLevel =
  | "read_only"
  | "approval_gated"
  | "blocked";

export interface WorkspaceConnectorCapabilityGroup {
  state: WorkspaceConnectorCapabilityState;
  items: string[];
}

export interface WorkspaceConnectorHealth {
  checked: boolean;
  configured: boolean | null;
  service: string | null;
  latencyMs: number | null;
  summary: string;
}

export interface WorkspaceConnectorRegistryItem {
  id: WorkspaceConnectorId;
  displayName: string;
  status: WorkspaceConnectorStatus;
  safetyLevel: WorkspaceConnectorSafetyLevel;
  capabilities: {
    read: WorkspaceConnectorCapabilityGroup;
    draft: WorkspaceConnectorCapabilityGroup;
    write: WorkspaceConnectorCapabilityGroup;
    send: WorkspaceConnectorCapabilityGroup;
  };
  lastCheck: string;
  blocker: string | null;
  fixHint: string | null;
  health: WorkspaceConnectorHealth;
}

export interface WorkspaceConnectorRegistry {
  generatedAt: string;
  sourceRootsUsed: string[];
  summary: {
    online: number;
    limited: number;
    notConfigured: number;
    notWired: number;
    offline: number;
    approvalGated: number;
  };
  connectors: WorkspaceConnectorRegistryItem[];
}

interface HealthProbeResult {
  ok: boolean;
  configured: boolean | null;
  service: string | null;
  latencyMs: number | null;
  summary: string;
}

export interface WorkspaceConnectorRegistryOptions {
  now?: () => Date;
  healthCheck?: (url: string) => Promise<HealthProbeResult>;
  fileExists?: (path: string) => Promise<boolean>;
  paths?: Partial<typeof DEFAULT_CONNECTOR_PATHS>;
}

const DEFAULT_CONNECTOR_PATHS = {
  googleServiceAccount: "/Users/atlasai/.config/gcloud/service-account.json",
  googleAuthHelper: "/Users/atlasai/.openclaw/workspace/lib/google-auth.mjs",
  typeformParser: "/Users/atlasai/.openclaw/workspace/subagents/audit/typeform-parser.mjs",
} as const;

const LOCAL_HEALTH_ENDPOINTS = {
  slack: "http://127.0.0.1:4006/health",
  monday: "http://127.0.0.1:4004/health",
  fireflies: "http://127.0.0.1:4005/health",
} as const;

export async function getWorkspaceConnectorRegistry(
  options: WorkspaceConnectorRegistryOptions = {},
): Promise<WorkspaceConnectorRegistry> {
  const now = options.now ?? (() => new Date());
  const lastCheck = now().toISOString();
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const fileExists = options.fileExists ?? defaultFileExists;
  const paths = { ...DEFAULT_CONNECTOR_PATHS, ...options.paths };

  const [slackHealth, mondayHealth, firefliesHealth, hasGoogleServiceAccount, hasGoogleAuthHelper, hasTypeformParser] = await Promise.all([
    healthCheck(LOCAL_HEALTH_ENDPOINTS.slack),
    healthCheck(LOCAL_HEALTH_ENDPOINTS.monday),
    healthCheck(LOCAL_HEALTH_ENDPOINTS.fireflies),
    fileExists(paths.googleServiceAccount),
    fileExists(paths.googleAuthHelper),
    fileExists(paths.typeformParser),
  ]);

  const connectors: WorkspaceConnectorRegistryItem[] = [
    healthConnector({
      id: "slack",
      displayName: "Slack",
      health: slackHealth,
      lastCheck,
      read: ["Channels", "channel history", "search", "user lookup"],
      draft: ["Draft response metadata through local approval queues"],
      write: ["Slack bridge has post endpoints, but Workspace does not expose them"],
      send: ["External Slack sends require explicit approval and are disabled here"],
      configuredHint: "Add Slack bot and user tokens to the local bridge environment.",
      offlineHint: "Start or inspect the local Slack bridge on port 4006.",
      safetyLevel: "approval_gated",
    }),
    staticConnector({
      id: "google-ads",
      displayName: "Google Ads",
      status: "not_wired",
      safetyLevel: "blocked",
      lastCheck,
      blocker: "No local Google Ads bridge or Workspace action route was found.",
      fixHint: "Add a read-only Google Ads connector before exposing diagnostics here.",
      read: { state: "not_wired", items: ["No verified local Google Ads read surface"] },
      draft: { state: "not_wired", items: ["No draft workflow connected"] },
      write: { state: "blocked", items: ["Ad mutations are blocked"] },
      send: { state: "blocked", items: ["No production actions from Workspace"] },
    }),
    staticConnector({
      id: "meta-ads",
      displayName: "Meta Ads",
      status: "not_wired",
      safetyLevel: "blocked",
      lastCheck,
      blocker: "Repo references say Meta Ads is awaiting integration; no live bridge was found.",
      fixHint: "Wire a read-only Meta diagnostics connector before any action readiness.",
      read: { state: "not_wired", items: ["No verified local Meta Ads read surface"] },
      draft: { state: "not_wired", items: ["No draft workflow connected"] },
      write: { state: "blocked", items: ["Ad mutations are blocked"] },
      send: { state: "blocked", items: ["No production actions from Workspace"] },
    }),
    healthConnector({
      id: "fireflies",
      displayName: "Fireflies / Calls",
      health: firefliesHealth,
      lastCheck,
      read: ["Recent transcripts", "transcript details"],
      draft: ["Call action item extraction can be drafted locally"],
      write: ["process-latest can hand off to Monday, but Workspace does not expose it"],
      send: ["No external sends from Workspace"],
      configuredHint: "Add a Fireflies API key to the local bridge environment.",
      offlineHint: "Start or inspect the local Fireflies bridge on port 4005.",
      safetyLevel: "approval_gated",
    }),
    healthConnector({
      id: "monday",
      displayName: "Monday",
      health: mondayHealth,
      lastCheck,
      read: ["Boards", "items by board"],
      draft: ["Local task/action mapping can be prepared for review"],
      write: ["Create/update/move endpoints exist on the bridge, but Workspace does not expose them"],
      send: ["No external sends from Workspace"],
      configuredHint: "Add a Monday API token to the local bridge environment.",
      offlineHint: "Start or inspect the local Monday bridge on port 4004.",
      safetyLevel: "approval_gated",
    }),
    typeformConnector({ hasParser: hasTypeformParser, lastCheck }),
    googleDriveConnector({ hasGoogleAuthHelper, hasGoogleServiceAccount, lastCheck }),
  ];

  return {
    generatedAt: lastCheck,
    sourceRootsUsed: [
      "local bridge health endpoints",
      "Google service-account presence",
      "local Workspace connector code audit",
    ],
    summary: summarizeConnectors(connectors),
    connectors,
  };
}

async function defaultHealthCheck(url: string): Promise<HealthProbeResult> {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    const latencyMs = Date.now() - startedAt;
    const body = await response.json().catch(() => ({})) as {
      status?: unknown;
      service?: unknown;
      configured?: unknown;
      mcp?: unknown;
    };
    const configured = typeof body.configured === "boolean" ? body.configured : null;
    const service = typeof body.service === "string" ? body.service : null;
    const ok = response.ok && body.status === "ok";
    return {
      ok,
      configured,
      service,
      latencyMs,
      summary: ok ? "Local health check passed." : "Local health check returned an unexpected status.",
    };
  } catch {
    return {
      ok: false,
      configured: null,
      service: null,
      latencyMs: null,
      summary: "Local health check did not respond.",
    };
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function healthConnector({
  id,
  displayName,
  health,
  lastCheck,
  read,
  draft,
  write,
  send,
  configuredHint,
  offlineHint,
  safetyLevel,
}: {
  id: WorkspaceConnectorId;
  displayName: string;
  health: HealthProbeResult;
  lastCheck: string;
  read: string[];
  draft: string[];
  write: string[];
  send: string[];
  configuredHint: string;
  offlineHint: string;
  safetyLevel: WorkspaceConnectorSafetyLevel;
}): WorkspaceConnectorRegistryItem {
  const status = statusFromHealth(health);
  return {
    id,
    displayName,
    status,
    safetyLevel,
    capabilities: {
      read: { state: status === "online" ? "available" : "not_exposed", items: read },
      draft: { state: "approval_gated", items: draft },
      write: { state: "approval_gated", items: write },
      send: { state: "approval_gated", items: send },
    },
    lastCheck,
    blocker: status === "online" ? null : health.configured === false ? "Local bridge is running but not configured." : "Local bridge is not available.",
    fixHint: status === "online" ? null : health.configured === false ? configuredHint : offlineHint,
    health: {
      checked: true,
      configured: health.configured,
      service: health.service,
      latencyMs: health.latencyMs,
      summary: health.summary,
    },
  };
}

function statusFromHealth(health: HealthProbeResult): WorkspaceConnectorStatus {
  if (health.ok && health.configured !== false) return "online";
  if (health.ok && health.configured === false) return "not_configured";
  if (health.latencyMs !== null) return "degraded";
  return "offline";
}

function staticConnector({
  id,
  displayName,
  status,
  safetyLevel,
  lastCheck,
  blocker,
  fixHint,
  read,
  draft,
  write,
  send,
}: {
  id: WorkspaceConnectorId;
  displayName: string;
  status: WorkspaceConnectorStatus;
  safetyLevel: WorkspaceConnectorSafetyLevel;
  lastCheck: string;
  blocker: string | null;
  fixHint: string | null;
  read: WorkspaceConnectorCapabilityGroup;
  draft: WorkspaceConnectorCapabilityGroup;
  write: WorkspaceConnectorCapabilityGroup;
  send: WorkspaceConnectorCapabilityGroup;
}): WorkspaceConnectorRegistryItem {
  return {
    id,
    displayName,
    status,
    safetyLevel,
    capabilities: { read, draft, write, send },
    lastCheck,
    blocker,
    fixHint,
    health: {
      checked: false,
      configured: null,
      service: null,
      latencyMs: null,
      summary: "No safe local health check is registered.",
    },
  };
}

function typeformConnector({
  hasParser,
  lastCheck,
}: {
  hasParser: boolean;
  lastCheck: string;
}): WorkspaceConnectorRegistryItem {
  return staticConnector({
    id: "typeform",
    displayName: "Typeform",
    status: hasParser ? "limited" : "not_wired",
    safetyLevel: "blocked",
    lastCheck,
    blocker: hasParser
      ? "Only local audit parsing code was found; no live Workspace Typeform connector is exposed."
      : "No live Workspace Typeform connector was found.",
    fixHint: "Expose a read-only Typeform diagnostics route before any ingestion or write workflow.",
    read: {
      state: hasParser ? "not_exposed" : "not_wired",
      items: hasParser ? ["Local executive-audit payload parser present"] : ["No verified Typeform read surface"],
    },
    draft: { state: "not_wired", items: ["No Workspace draft workflow connected"] },
    write: { state: "blocked", items: ["Typeform mutations are blocked"] },
    send: { state: "blocked", items: ["No external sends from Workspace"] },
  });
}

function googleDriveConnector({
  hasGoogleAuthHelper,
  hasGoogleServiceAccount,
  lastCheck,
}: {
  hasGoogleAuthHelper: boolean;
  hasGoogleServiceAccount: boolean;
  lastCheck: string;
}): WorkspaceConnectorRegistryItem {
  const status: WorkspaceConnectorStatus = hasGoogleAuthHelper && hasGoogleServiceAccount ? "limited" : "not_configured";
  return {
    id: "google-drive-docs",
    displayName: "Google Drive / Docs",
    status,
    safetyLevel: "read_only",
    capabilities: {
      read: {
        state: status === "limited" ? "available" : "not_exposed",
        items: ["Drive readonly ingestion helper", "Calendar readonly scope", "Docs/Drive source discovery"],
      },
      draft: { state: "not_exposed", items: ["Workspace document drafts are local artifacts only"] },
      write: { state: "blocked", items: ["Google Drive/Docs writes are not exposed"] },
      send: { state: "blocked", items: ["No file sends from Workspace"] },
    },
    lastCheck,
    blocker: status === "limited" ? null : "Google read-only helper or service-account config is missing.",
    fixHint: status === "limited" ? null : "Verify local Google service-account config before enabling diagnostics.",
    health: {
      checked: true,
      configured: hasGoogleAuthHelper && hasGoogleServiceAccount,
      service: "local-google-readonly-helper",
      latencyMs: null,
      summary: status === "limited"
        ? "Local read-only Google helper and service-account config are present."
        : "Local read-only Google helper is not fully configured.",
    },
  };
}

function summarizeConnectors(connectors: WorkspaceConnectorRegistryItem[]): WorkspaceConnectorRegistry["summary"] {
  return connectors.reduce<WorkspaceConnectorRegistry["summary"]>((summary, connector) => {
    if (connector.status === "online") summary.online += 1;
    if (connector.status === "limited") summary.limited += 1;
    if (connector.status === "not_configured") summary.notConfigured += 1;
    if (connector.status === "not_wired") summary.notWired += 1;
    if (connector.status === "offline" || connector.status === "degraded") summary.offline += 1;
    if (connector.safetyLevel === "approval_gated") summary.approvalGated += 1;
    return summary;
  }, {
    online: 0,
    limited: 0,
    notConfigured: 0,
    notWired: 0,
    offline: 0,
    approvalGated: 0,
  });
}
