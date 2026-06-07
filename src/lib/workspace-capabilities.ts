export type AtlasCapabilityStatus = "available" | "limited" | "blocked" | "planned";
export type AtlasCapabilityCategory =
  | "answering"
  | "retrieval"
  | "artifacts"
  | "sessions"
  | "quality"
  | "connectors"
  | "integrations"
  | "persistence"
  | "skills";
export type AtlasCapabilitySafetyLevel = "read_only" | "local_write" | "approval_gated" | "blocked";
export type AtlasCapabilityApprovalRequirement = "none" | "user_confirmation" | "explicit_approval" | "not_supported";

export interface AtlasCapabilityIO {
  name: string;
  description: string;
  required: boolean;
}

export interface AtlasCapabilityBacking {
  tools: string[];
  connectors: string[];
  skills: string[];
}

export interface AtlasCapability {
  id: string;
  name: string;
  category: AtlasCapabilityCategory;
  status: AtlasCapabilityStatus;
  description: string;
  inputs: AtlasCapabilityIO[];
  outputs: AtlasCapabilityIO[];
  safetyLevel: AtlasCapabilitySafetyLevel;
  approvalRequirement: AtlasCapabilityApprovalRequirement;
  backing: AtlasCapabilityBacking;
  knownLimitations: string[];
}

export interface AtlasCapabilityRegistrySummary {
  available: number;
  limited: number;
  blocked: number;
  planned: number;
  readOnly: number;
  localWrite: number;
  approvalGated: number;
}

export interface AtlasCapabilityRegistry {
  generatedAt: string;
  version: 1;
  capabilities: AtlasCapability[];
  summary: AtlasCapabilityRegistrySummary;
}

export interface AtlasCapabilityRegistryOptions {
  now?: () => Date;
}

const SEEDED_CAPABILITIES: AtlasCapability[] = [
  {
    id: "call-memory-answer",
    name: "Call memory answer",
    category: "answering",
    status: "available",
    description: "Answer analytical questions from resolved Workspace references and safe read-only call or memory signals.",
    inputs: [
      requiredInput("Prompt", "A natural-language analytical question."),
      optionalInput("Workspace references", "Resolved reference packet or read-only tool output when available."),
    ],
    outputs: [
      requiredOutput("Grounded answer", "Answer with checked, found, confidence, and next-action sections."),
      optionalOutput("Source labels", "Visible source type and title labels when evidence exists."),
    ],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["get_reference_packet", "summarize_calls", "search_memory"], ["Workspace reference resolver"], []),
    knownLimitations: [
      "Coverage depends on the local reference packet and tool results available for the run.",
      "Atlas must not claim full corpus coverage when references are thin or absent.",
    ],
  },
  {
    id: "recent-call-topic-retrieval",
    name: "Recent call topic retrieval",
    category: "retrieval",
    status: "limited",
    description: "Retrieve recent call-related source labels and topic signals for analytical Workspace questions.",
    inputs: [requiredInput("Topic prompt", "Call, transcript, topic, client, model, or trend terms.")],
    outputs: [
      requiredOutput("Reference labels", "Call transcript or summary labels with coverage status."),
      optionalOutput("Trend summary", "Local summarizer output when matching call references exist."),
    ],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["summarize_calls", "get_reference_packet"], ["Workspace reference resolver"], []),
    knownLimitations: [
      "Topic retrieval is not a full transcript search product yet.",
      "Duplicate or generic source titles can appear when upstream call metadata is thin.",
    ],
  },
  {
    id: "artifact-library-lookup",
    name: "Artifact library lookup",
    category: "artifacts",
    status: "available",
    description: "Look up safe local Workspace artifacts without mutating external systems.",
    inputs: [requiredInput("Artifact query", "Title, project, type, or recent artifact terms.")],
    outputs: [requiredOutput("Artifact cards", "Safe artifact metadata and previews with local paths hidden.")],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["find_artifact"], ["Workspace artifact library"], []),
    knownLimitations: ["Archived or unsafe placeholder artifacts are hidden from normal views."],
  },
  {
    id: "internal-markdown-draft",
    name: "Internal markdown draft",
    category: "artifacts",
    status: "available",
    description: "Create controlled local markdown drafts only when the prompt explicitly asks to create, draft, save, render, or export a deliverable.",
    inputs: [requiredInput("Explicit draft intent", "A prompt with clear create, draft, save, render, or export language.")],
    outputs: [requiredOutput("Local markdown artifact", "Presentation-safe artifact card and preview.")],
    safetyLevel: "local_write",
    approvalRequirement: "user_confirmation",
    backing: backing(["workspace draft artifact writer"], ["Workspace local artifact store"], []),
    knownLimitations: [
      "Analytical mentions of pdf, playbook, call logs, or knowledge must not create artifacts.",
      "Local artifact creation does not send or publish files.",
    ],
  },
  {
    id: "ricky-pdf-package-retrieval",
    name: "Ricky PDF package retrieval",
    category: "artifacts",
    status: "available",
    description: "Retrieve the supported Ricky Calder PDF package as a local Workspace artifact.",
    inputs: [requiredInput("Ricky PDF request", "A supported Ricky Calder handover/package PDF request.")],
    outputs: [requiredOutput("Ricky PDF artifact", "Existing supported PDF package copied into the local Workspace artifact flow.")],
    safetyLevel: "local_write",
    approvalRequirement: "user_confirmation",
    backing: backing(["workspace Ricky PDF resolver"], ["Workspace local artifact store"], []),
    knownLimitations: [
      "This is not arbitrary branded PDF generation.",
      "Only the supported Ricky package workflow is wired today.",
    ],
  },
  {
    id: "session-persistence-continuation",
    name: "Session persistence and continuation",
    category: "sessions",
    status: "available",
    description: "Persist and hydrate local Workspace sessions, messages, task chips, artifacts, and QA phase events.",
    inputs: [requiredInput("Workspace events", "Presentation-safe AgentEvents for the local session.")],
    outputs: [requiredOutput("Hydrated thread", "Restored messages, run phases, task state, and safe artifact cards.")],
    safetyLevel: "local_write",
    approvalRequirement: "none",
    backing: backing(["workspace local sessions"], ["Local JSONL/session store"], []),
    knownLimitations: ["Shared multi-user Supabase persistence is not wired."],
  },
  {
    id: "qa-critic-check",
    name: "QA critic check",
    category: "quality",
    status: "available",
    description: "Run a lightweight critic on analytical answers before final response.",
    inputs: [requiredInput("Draft answer", "Candidate answer and runtime evidence context.")],
    outputs: [requiredOutput("QA result", "Pass/fail, issues, one revision when possible, and final answer metadata.")],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["workspace analytical QA critic", "run.phase events"], ["Workspace runtime context"], []),
    knownLimitations: ["The critic is deterministic and lightweight; it is not a substitute for human review on high-stakes decisions."],
  },
  {
    id: "connector-status-inspection",
    name: "Connector status inspection",
    category: "connectors",
    status: "available",
    description: "Inspect local connector readiness and clearly separate read, draft, write, and send exposure.",
    inputs: [optionalInput("Refresh request", "User opens or refreshes the Systems panel.")],
    outputs: [requiredOutput("Connector status", "Safe readiness statuses with no secrets or local paths.")],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["workspace connector registry"], ["Local bridge health endpoints"], []),
    knownLimitations: ["Connector readiness does not mean Workspace exposes mutation or send actions."],
  },
  {
    id: "arbitrary-branded-pdf-generation",
    name: "Arbitrary branded PDF generation",
    category: "artifacts",
    status: "blocked",
    description: "Generate arbitrary branded PDFs from any prompt.",
    inputs: [requiredInput("PDF request", "Any unsupported branded PDF generation request.")],
    outputs: [requiredOutput("Blocked response", "Clear limitation instead of a fake PDF artifact.")],
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    backing: backing([], [], []),
    knownLimitations: ["Only the supported Ricky PDF package retrieval is wired today."],
  },
  {
    id: "slack-send",
    name: "Slack send",
    category: "integrations",
    status: "blocked",
    description: "Send messages to Slack from Workspace.",
    inputs: [requiredInput("Slack destination and message", "Channel, user, or thread target plus message body.")],
    outputs: [requiredOutput("No send", "Workspace must not send Slack messages from this capability registry.")],
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    backing: backing([], ["Slack bridge"], []),
    knownLimitations: ["Slack send paths are not exposed from Workspace."],
  },
  {
    id: "monday-mutation",
    name: "Monday mutation",
    category: "integrations",
    status: "blocked",
    description: "Create, update, move, or delete Monday items from Workspace.",
    inputs: [requiredInput("Monday mutation request", "Board/item mutation details.")],
    outputs: [requiredOutput("No mutation", "Workspace can discuss or draft, but not mutate Monday.")],
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    backing: backing([], ["Monday bridge"], []),
    knownLimitations: ["Monday mutation endpoints are not exposed from Workspace."],
  },
  {
    id: "typeform-mutation",
    name: "Typeform mutation",
    category: "integrations",
    status: "blocked",
    description: "Mutate Typeform forms, responses, or configuration from Workspace.",
    inputs: [requiredInput("Typeform mutation request", "Form or response mutation details.")],
    outputs: [requiredOutput("No mutation", "Workspace does not mutate Typeform.")],
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    backing: backing([], ["Typeform parser"], []),
    knownLimitations: ["Only local audit parsing has been detected; no live mutation workflow is exposed."],
  },
  {
    id: "google-meta-ads-mutation",
    name: "Google/Meta ads mutation",
    category: "integrations",
    status: "blocked",
    description: "Create or change Google Ads or Meta Ads campaigns from Workspace.",
    inputs: [requiredInput("Ads mutation request", "Campaign, budget, audience, or creative mutation details.")],
    outputs: [requiredOutput("No mutation", "Workspace does not mutate ad platforms.")],
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    backing: backing([], ["Google Ads", "Meta Ads"], []),
    knownLimitations: ["Read-only diagnostics should be wired and verified before any action workflow is considered."],
  },
  {
    id: "supabase-shared-persistence",
    name: "Supabase shared persistence",
    category: "persistence",
    status: "planned",
    description: "Persist Workspace events and sessions in shared Supabase-backed storage.",
    inputs: [requiredInput("Workspace events", "Event stream and session metadata.")],
    outputs: [requiredOutput("Shared event spine", "Multi-user replay and continuation once wired.")],
    safetyLevel: "blocked",
    approvalRequirement: "explicit_approval",
    backing: backing([], ["Supabase event spine"], []),
    knownLimitations: ["Current Workspace session persistence is local-only."],
  },
  {
    id: "user-created-skills",
    name: "User-created skills",
    category: "skills",
    status: "planned",
    description: "Let users create and manage Atlas skills/tools from the Workspace UI.",
    inputs: [requiredInput("Skill definition", "A user-authored skill, tool contract, or workflow template.")],
    outputs: [requiredOutput("Managed skill", "Versioned user-created capability once productized.")],
    safetyLevel: "approval_gated",
    approvalRequirement: "explicit_approval",
    backing: backing([], [], ["future skill registry"]),
    knownLimitations: ["No user-managed skill creation UI is connected today."],
  },
];

export function getAtlasCapabilityRegistry(options: AtlasCapabilityRegistryOptions = {}): AtlasCapabilityRegistry {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const capabilities = SEEDED_CAPABILITIES.map(cloneCapability);
  validateAtlasCapabilityRegistry(capabilities);
  return {
    generatedAt,
    version: 1,
    capabilities,
    summary: summarizeCapabilities(capabilities),
  };
}

export function validateAtlasCapabilityRegistry(capabilities: readonly AtlasCapability[]): void {
  const ids = new Set<string>();
  for (const capability of capabilities) {
    assertSafeCapabilityText(capability.id, "id");
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(capability.id)) throw new Error(`Invalid capability id: ${capability.id}`);
    if (ids.has(capability.id)) throw new Error(`Duplicate capability id: ${capability.id}`);
    ids.add(capability.id);
    assertSafeCapabilityText(capability.name, `${capability.id}.name`);
    assertSafeCapabilityText(capability.description, `${capability.id}.description`);
    for (const item of [...capability.inputs, ...capability.outputs]) {
      assertSafeCapabilityText(item.name, `${capability.id}.io.name`);
      assertSafeCapabilityText(item.description, `${capability.id}.io.description`);
    }
    for (const value of [
      ...capability.backing.tools,
      ...capability.backing.connectors,
      ...capability.backing.skills,
      ...capability.knownLimitations,
    ]) {
      assertSafeCapabilityText(value, `${capability.id}.detail`);
    }
    if ((capability.status === "blocked" || capability.status === "planned") && capability.safetyLevel !== "blocked" && capability.approvalRequirement !== "explicit_approval") {
      throw new Error(`${capability.id} cannot be ${capability.status} without blocked or explicit-approval safety.`);
    }
    if (capability.status === "blocked" && capability.approvalRequirement !== "not_supported") {
      throw new Error(`${capability.id} blocked capabilities must be marked not supported.`);
    }
  }
}

export function capabilityPromptSummary(capabilities: readonly AtlasCapability[] = getAtlasCapabilityRegistry().capabilities): string[] {
  const visible = capabilities
    .filter((capability) => capability.status === "available" || capability.status === "limited")
    .map((capability) => `- ${capability.name}: ${capability.status}; safety=${capability.safetyLevel}; ${capability.description}`);
  const blocked = capabilities
    .filter((capability) => capability.status === "blocked" || capability.status === "planned")
    .map((capability) => `- ${capability.name}: ${capability.status}; do not present as available.`);
  return [
    "Available or limited Atlas capabilities:",
    ...visible,
    "Blocked or planned capabilities:",
    ...blocked,
  ];
}

function summarizeCapabilities(capabilities: readonly AtlasCapability[]): AtlasCapabilityRegistrySummary {
  return capabilities.reduce<AtlasCapabilityRegistrySummary>((summary, capability) => {
    summary[capability.status] += 1;
    if (capability.safetyLevel === "read_only") summary.readOnly += 1;
    if (capability.safetyLevel === "local_write") summary.localWrite += 1;
    if (capability.safetyLevel === "approval_gated") summary.approvalGated += 1;
    return summary;
  }, {
    available: 0,
    limited: 0,
    blocked: 0,
    planned: 0,
    readOnly: 0,
    localWrite: 0,
    approvalGated: 0,
  });
}

function requiredInput(name: string, description: string): AtlasCapabilityIO {
  return { name, description, required: true };
}

function optionalInput(name: string, description: string): AtlasCapabilityIO {
  return { name, description, required: false };
}

function requiredOutput(name: string, description: string): AtlasCapabilityIO {
  return { name, description, required: true };
}

function optionalOutput(name: string, description: string): AtlasCapabilityIO {
  return { name, description, required: false };
}

function backing(tools: string[], connectors: string[], skills: string[]): AtlasCapabilityBacking {
  return { tools, connectors, skills };
}

function cloneCapability(capability: AtlasCapability): AtlasCapability {
  return {
    ...capability,
    inputs: capability.inputs.map((input) => ({ ...input })),
    outputs: capability.outputs.map((output) => ({ ...output })),
    backing: {
      tools: [...capability.backing.tools],
      connectors: [...capability.backing.connectors],
      skills: [...capability.backing.skills],
    },
    knownLimitations: [...capability.knownLimitations],
  };
}

function assertSafeCapabilityText(value: string, path: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Capability ${path} must be non-empty text.`);
  if (/(?:\/Users\/|\/private\/|\/tmp\/|\.openclaw\/|OPENAI_API_KEY|ANTHROPIC_API_KEY|SLACK_|MONDAY_|TYPEFORM_)/i.test(value)) {
    throw new Error(`Capability ${path} contains unsafe local or secret-looking text.`);
  }
}
