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
  | "skills"
  | "maintenance"
  | "guidance";
export type AtlasCapabilitySafetyLevel = "read_only" | "local_write" | "approval_gated" | "blocked";
export type AtlasCapabilityApprovalRequirement = "none" | "user_confirmation" | "explicit_approval" | "not_supported";
export type AtlasSkillCategory = "memory" | "calls" | "artifacts" | "quality" | "operations" | "guidance" | "integrations";
export type AtlasToolBindingKind =
  | "workspace_tool"
  | "workspace_runtime"
  | "local_script"
  | "openclaw_subagent"
  | "artifact_store"
  | "connector_projection"
  | "runtime_workflow";
export type AtlasSubstrateKind =
  | "repo_source"
  | "workspace_tool"
  | "memory_vault"
  | "librarian_report"
  | "openclaw_subagent"
  | "artifact_archive"
  | "runtime_workflow"
  | "connector_projection"
  | "brand_guidance";

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

export interface AtlasSubstrateSource {
  label: string;
  kind: AtlasSubstrateKind;
  summary: string;
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
  sourceRefs: AtlasSubstrateSource[];
  knownLimitations: string[];
}

export interface AtlasSkill {
  id: string;
  name: string;
  category: AtlasSkillCategory;
  status: AtlasCapabilityStatus;
  description: string;
  capabilityIds: string[];
  toolBindingIds: string[];
  safetyPolicyIds: string[];
  sourceRefs: AtlasSubstrateSource[];
  knownLimitations: string[];
}

export interface AtlasToolBinding {
  id: string;
  name: string;
  kind: AtlasToolBindingKind;
  status: AtlasCapabilityStatus;
  description: string;
  executionSurface: string;
  capabilityIds: string[];
  safetyPolicyIds: string[];
  sourceRefs: AtlasSubstrateSource[];
  knownLimitations: string[];
}

export interface AtlasSafetyPolicy {
  id: string;
  name: string;
  safetyLevel: AtlasCapabilitySafetyLevel;
  approvalRequirement: AtlasCapabilityApprovalRequirement;
  description: string;
  enforcedBy: string[];
  prohibited: string[];
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
  skills: AtlasSkill[];
  toolBindings: AtlasToolBinding[];
  safetyPolicies: AtlasSafetyPolicy[];
  discoveredSubstrate: AtlasSubstrateSource[];
  summary: AtlasCapabilityRegistrySummary;
}

export interface AtlasCapabilityRegistryOptions {
  now?: () => Date;
}

const SUBSTRATE = {
  workspaceAgentTools: source("Workspace agent tools", "workspace_tool", "Safe read-only tools for memory search, call summaries, artifact lookup, and reference packets."),
  runtimeContext: source("Workspace runtime context", "repo_source", "Prompt boundary and runtime context assembly for Workspace answers."),
  localSessions: source("Workspace local sessions", "repo_source", "Local event, artifact, task, and run phase persistence for Workspace beta."),
  draftArtifacts: source("Workspace draft artifact flow", "repo_source", "Explicit-intent markdown and supported Ricky package artifact handling."),
  artifactProjection: source("Workspace artifact projection", "repo_source", "Read-only artifact discovery and presentation-safe projection."),
  librarianMemory: source("Layered memory vault", "memory_vault", "Knowledge map, tacit memory notes, and daily memory entries."),
  librarianReports: source("Librarian reports", "librarian_report", "Maintenance, graph diff, daily delta, ingestion, and artifact hygiene reports."),
  librarianSubagent: source("Librarian subagent", "openclaw_subagent", "Nightly, parser, graph, indexer, context-pack, and review queue scripts."),
  auditSubagent: source("Audit subagent", "openclaw_subagent", "Audit generator, QA, run contract, Typeform parser, and PDF renderer workflow."),
  atlasDocumentConverter: source("Atlas document converter", "runtime_workflow", "Existing OpenClaw doc-converter workflow for real Undeniable PDF/DOCX artifacts."),
  strategistSubagent: source("Strategist subagent", "openclaw_subagent", "Classifier, retriever, brief writer, compliance, and strategist voice resource."),
  rickyPackage: source("Ricky package archive", "artifact_archive", "Existing Ricky Calder handover package and source-match dry run evidence."),
  slackRuntime: source("Slack reply runtime", "runtime_workflow", "OpenClaw listener and reply draft workflow, with send paths outside Workspace."),
  connectorRegistry: source("Workspace connector registry", "connector_projection", "Local read-only connector status projection with send and mutation states separated."),
} as const satisfies Record<string, AtlasSubstrateSource>;

const DISCOVERED_SUBSTRATE: AtlasSubstrateSource[] = [
  SUBSTRATE.workspaceAgentTools,
  SUBSTRATE.runtimeContext,
  SUBSTRATE.localSessions,
  SUBSTRATE.draftArtifacts,
  SUBSTRATE.artifactProjection,
  SUBSTRATE.librarianMemory,
  SUBSTRATE.librarianReports,
  SUBSTRATE.librarianSubagent,
  SUBSTRATE.auditSubagent,
  SUBSTRATE.atlasDocumentConverter,
  SUBSTRATE.strategistSubagent,
  SUBSTRATE.rickyPackage,
  SUBSTRATE.slackRuntime,
  SUBSTRATE.connectorRegistry,
];

const SEEDED_CAPABILITIES: AtlasCapability[] = [
  {
    id: "memory-search-recall",
    name: "Memory search and recall",
    category: "retrieval",
    status: "available",
    description: "Search and summarize safe local memory and Librarian reference signals for Workspace questions.",
    inputs: [requiredInput("Memory query", "A topic, client, workflow, or decision to recall.")],
    outputs: [
      requiredOutput("Memory references", "Safe source labels and short summaries."),
      optionalOutput("Coverage note", "Whether the memory evidence was matched, thin, or absent."),
    ],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["search_memory", "get_reference_packet"], ["Workspace reference resolver"], ["Memory Librarian skill"]),
    sourceRefs: [SUBSTRATE.workspaceAgentTools, SUBSTRATE.librarianMemory, SUBSTRATE.librarianReports],
    knownLimitations: [
      "This is local recall over available reference packets and indexed memory signals, not guaranteed full-vault semantic search.",
      "Atlas must label thin coverage instead of claiming complete recall.",
    ],
  },
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
    backing: backing(["get_reference_packet", "summarize_calls", "search_memory"], ["Workspace reference resolver"], ["Memory Librarian skill", "Call retrieval skill"]),
    sourceRefs: [SUBSTRATE.workspaceAgentTools, SUBSTRATE.runtimeContext, SUBSTRATE.librarianReports],
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
    backing: backing(["summarize_calls", "get_reference_packet"], ["Workspace reference resolver"], ["Call retrieval skill"]),
    sourceRefs: [SUBSTRATE.workspaceAgentTools, SUBSTRATE.librarianReports],
    knownLimitations: [
      "Topic retrieval is not a full transcript search product yet.",
      "Duplicate or generic source titles can appear when upstream call metadata is thin.",
    ],
  },
  {
    id: "librarian-maintenance-reporting",
    name: "Librarian maintenance reporting",
    category: "maintenance",
    status: "limited",
    description: "Expose existing Librarian maintenance, graph diff, ingestion, daily delta, and artifact hygiene signals as read-only Workspace context.",
    inputs: [requiredInput("Maintenance question", "A request about memory health, ingestion, repair plans, or artifact hygiene.")],
    outputs: [requiredOutput("Maintenance summary", "Source-labeled operational summary with no raw local paths.")],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["librarian reports projection"], ["Librarian report archive"], ["Memory Librarian skill"]),
    sourceRefs: [SUBSTRATE.librarianReports, SUBSTRATE.librarianSubagent],
    knownLimitations: [
      "Workspace surfaces report evidence; it does not run Librarian apply bundles from the UI.",
      "Maintenance writes remain outside this registry.",
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
    backing: backing(["find_artifact"], ["Workspace artifact library"], ["Artifact retrieval skill"]),
    sourceRefs: [SUBSTRATE.workspaceAgentTools, SUBSTRATE.artifactProjection],
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
    backing: backing(["workspace draft artifact writer"], ["Workspace local artifact store"], ["Artifact retrieval skill"]),
    sourceRefs: [SUBSTRATE.draftArtifacts, SUBSTRATE.localSessions],
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
    backing: backing(["workspace Ricky PDF resolver"], ["Workspace local artifact store"], ["Artifact retrieval skill"]),
    sourceRefs: [SUBSTRATE.draftArtifacts, SUBSTRATE.rickyPackage],
    knownLimitations: [
      "This is not arbitrary branded PDF generation.",
      "Only the supported Ricky package workflow is wired today.",
    ],
  },
  {
    id: "audit-pdf-renderer-workflow",
    name: "Audit PDF renderer workflow",
    category: "artifacts",
    status: "limited",
    description: "Wrap the existing audit subagent PDF renderer as a known local workflow, while keeping arbitrary Workspace PDF generation blocked.",
    inputs: [requiredInput("Audit markdown", "An audit document that matches the existing audit renderer workflow.")],
    outputs: [requiredOutput("Audit PDF", "A local audit PDF generated by the audit workflow when invoked outside this UI.")],
    safetyLevel: "local_write",
    approvalRequirement: "user_confirmation",
    backing: backing(["audit PDF renderer"], ["Audit subagent"], ["Audit document workflow skill"]),
    sourceRefs: [SUBSTRATE.auditSubagent],
    knownLimitations: [
      "The renderer is a real local workflow, but general Workspace PDF creation is not productized.",
      "Workspace should not promise arbitrary branded PDFs from this capability.",
    ],
  },
  {
    id: "atlas-document-production-workflow",
    name: "Atlas document production workflow",
    category: "artifacts",
    status: "available",
    description: "Render explicit real Atlas/Undeniable document workflow requests to local PDF/DOCX artifacts using the existing converter.",
    inputs: [
      requiredInput("Explicit workflow selection", "A prompt that names the real Atlas/Rhys/Undeniable document workflow or converter."),
      requiredInput("Document body", "Workspace-generated markdown source to render."),
    ],
    outputs: [
      requiredOutput("Real PDF/DOCX artifact", "Local artifact rendered by the existing converter, with markdown kept only as source."),
      optionalOutput("Download links", "Workspace preview/download links for produced PDF and DOCX files."),
    ],
    safetyLevel: "local_write",
    approvalRequirement: "user_confirmation",
    backing: backing(["Atlas document converter"], ["Workspace local artifact store"], ["Artifact retrieval skill", "Document workflow skill"]),
    sourceRefs: [SUBSTRATE.draftArtifacts, SUBSTRATE.atlasDocumentConverter],
    knownLimitations: [
      "Only PDF and DOCX are wired through this converter.",
      "Deck output remains blocked unless a real deck workflow is separately selected.",
      "Local artifact creation does not send or publish files.",
    ],
  },
  {
    id: "brand-voice-guidance-retrieval",
    name: "Brand and voice guidance retrieval",
    category: "guidance",
    status: "limited",
    description: "Retrieve existing Atlas/Rhys strategist and voice guidance for drafting and answer tone.",
    inputs: [requiredInput("Guidance query", "Brand, voice, strategy, or tone question.")],
    outputs: [requiredOutput("Guidance labels", "Short source-labeled guidance with no local paths.")],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["strategist retriever"], ["Strategist resources"], ["Strategist guidance skill"]),
    sourceRefs: [SUBSTRATE.strategistSubagent],
    knownLimitations: [
      "Guidance can shape drafts, but it is not a substitute for approval on external-facing brand decisions.",
      "Only discovered strategist resources are represented here.",
    ],
  },
  {
    id: "slack-draft-reply-workflow",
    name: "Slack draft reply workflow",
    category: "integrations",
    status: "limited",
    description: "Recognize the existing OpenClaw Slack listener and reply drafting workflow while keeping Workspace sends blocked.",
    inputs: [requiredInput("Slack-related context", "A Slack request, reply draft, or reliability question.")],
    outputs: [requiredOutput("Draft or status summary", "Read-only draft/status context; no Workspace send action.")],
    safetyLevel: "read_only",
    approvalRequirement: "none",
    backing: backing(["Slack listener reply runtime"], ["Slack bridge"], ["Slack reply draft skill"]),
    sourceRefs: [SUBSTRATE.slackRuntime],
    knownLimitations: [
      "Workspace does not send Slack messages.",
      "Runtime listener operations remain outside Workspace and require separate operational approval.",
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
    backing: backing(["workspace local sessions"], ["Local JSONL/session store"], ["Workspace continuation skill"]),
    sourceRefs: [SUBSTRATE.localSessions],
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
    backing: backing(["workspace analytical QA critic", "run.phase events"], ["Workspace runtime context"], ["QA critic skill"]),
    sourceRefs: [SUBSTRATE.runtimeContext, SUBSTRATE.localSessions],
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
    backing: backing(["workspace connector registry"], ["Local bridge health endpoints"], ["Connector inspection skill"]),
    sourceRefs: [SUBSTRATE.connectorRegistry],
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
    sourceRefs: [],
    knownLimitations: ["Only the supported Ricky PDF package retrieval and narrow audit renderer workflow are discovered today."],
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
    sourceRefs: [SUBSTRATE.slackRuntime],
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
    sourceRefs: [],
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
    sourceRefs: [SUBSTRATE.auditSubagent],
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
    sourceRefs: [],
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
    sourceRefs: [],
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
    sourceRefs: [],
    knownLimitations: ["No user-managed skill creation UI is connected today."],
  },
];

const SEEDED_SKILLS: AtlasSkill[] = [
  skill("memory-librarian", "Memory Librarian", "memory", "available", "Recall and summarize memory, context packs, and Librarian report evidence.", ["memory-search-recall", "call-memory-answer", "librarian-maintenance-reporting"], ["workspace-search-memory", "workspace-reference-packet", "librarian-report-reader"], ["read-only-retrieval", "path-secret-redaction"], [SUBSTRATE.librarianMemory, SUBSTRATE.librarianReports, SUBSTRATE.librarianSubagent], ["Report application and memory writes are not exposed in Workspace."]),
  skill("call-retrieval", "Call retrieval", "calls", "limited", "Resolve call-related labels and trend summaries for analytical answers.", ["call-memory-answer", "recent-call-topic-retrieval"], ["workspace-summarize-calls", "workspace-reference-packet"], ["read-only-retrieval", "capability-truthfulness"], [SUBSTRATE.workspaceAgentTools, SUBSTRATE.librarianReports], ["Not a full transcript search product yet."]),
  skill("artifact-retrieval", "Artifact retrieval", "artifacts", "available", "Find existing artifacts and produce explicit-intent local drafts.", ["artifact-library-lookup", "internal-markdown-draft", "ricky-pdf-package-retrieval", "atlas-document-production-workflow"], ["workspace-find-artifact", "workspace-draft-artifact-writer", "ricky-package-resolver", "atlas-document-converter"], ["local-artifact-write-gate", "path-secret-redaction"], [SUBSTRATE.artifactProjection, SUBSTRATE.draftArtifacts, SUBSTRATE.rickyPackage, SUBSTRATE.atlasDocumentConverter], ["Artifact creation requires explicit deliverable intent and workflow support."]),
  skill("audit-document-workflow", "Audit document workflow", "artifacts", "limited", "Represent the existing audit renderer and QA flow without claiming general document generation.", ["audit-pdf-renderer-workflow", "typeform-mutation"], ["audit-pdf-renderer"], ["local-artifact-write-gate", "mutation-block"], [SUBSTRATE.auditSubagent], ["Audit generation is not generalized into Workspace yet."]),
  skill("strategist-guidance", "Strategist guidance", "guidance", "limited", "Retrieve strategist voice, compliance, and brief-writing guidance.", ["brand-voice-guidance-retrieval"], ["strategist-retriever"], ["read-only-retrieval", "capability-truthfulness"], [SUBSTRATE.strategistSubagent], ["Guidance retrieval is advisory and source-scoped."]),
  skill("qa-critic", "QA critic", "quality", "available", "Check draft analytical answers for unsupported claims, missing labels, path leaks, and unnecessary follow-up.", ["qa-critic-check"], ["workspace-qa-critic"], ["path-secret-redaction", "capability-truthfulness"], [SUBSTRATE.runtimeContext, SUBSTRATE.localSessions], ["Lightweight deterministic QA, not human review."]),
  skill("slack-reply-draft", "Slack reply draft", "integrations", "limited", "Represent existing Slack listener reply drafting while keeping sends unavailable in Workspace.", ["slack-draft-reply-workflow", "slack-send"], ["slack-listener-reply-runtime"], ["external-send-block", "capability-truthfulness"], [SUBSTRATE.slackRuntime], ["No Slack send action is exposed from Workspace."]),
  skill("connector-inspection", "Connector inspection", "operations", "available", "Inspect connector exposure and show read/draft/write/send boundaries.", ["connector-status-inspection"], ["workspace-connector-registry"], ["read-only-retrieval", "mutation-block"], [SUBSTRATE.connectorRegistry], ["Status is not action authority."]),
];

const SEEDED_TOOL_BINDINGS: AtlasToolBinding[] = [
  toolBinding("workspace-search-memory", "search_memory", "workspace_tool", "available", "Read-only memory/reference search used by analytical Workspace answers.", "Workspace agent tool", ["memory-search-recall", "call-memory-answer"], ["read-only-retrieval", "path-secret-redaction"], [SUBSTRATE.workspaceAgentTools], ["Coverage depends on indexed local references."]),
  toolBinding("workspace-summarize-calls", "summarize_calls", "workspace_tool", "limited", "Read-only call topic summarizer that returns source labels and trends.", "Workspace agent tool", ["recent-call-topic-retrieval", "call-memory-answer"], ["read-only-retrieval", "capability-truthfulness"], [SUBSTRATE.workspaceAgentTools], ["Not a full transcript search engine."]),
  toolBinding("workspace-find-artifact", "find_artifact", "workspace_tool", "available", "Read-only lookup over safe artifact projections.", "Workspace agent tool", ["artifact-library-lookup"], ["read-only-retrieval", "path-secret-redaction"], [SUBSTRATE.workspaceAgentTools, SUBSTRATE.artifactProjection], ["Unsafe archived artifacts stay hidden."]),
  toolBinding("workspace-reference-packet", "get_reference_packet", "workspace_tool", "available", "Resolve source packets for Workspace answers and QA grounding.", "Workspace reference resolver", ["memory-search-recall", "call-memory-answer", "recent-call-topic-retrieval"], ["read-only-retrieval", "path-secret-redaction"], [SUBSTRATE.workspaceAgentTools, SUBSTRATE.runtimeContext], ["Thin or absent packets must be described as thin or absent."]),
  toolBinding("workspace-draft-artifact-writer", "Workspace draft artifact writer", "workspace_runtime", "available", "Creates local markdown and supported Ricky PDF artifacts only after explicit intent.", "Workspace runtime artifact gate", ["internal-markdown-draft", "ricky-pdf-package-retrieval"], ["local-artifact-write-gate", "path-secret-redaction"], [SUBSTRATE.draftArtifacts], ["Unsupported PDFs produce a limitation instead of a fake artifact."]),
  toolBinding("ricky-package-resolver", "Ricky package resolver", "artifact_store", "available", "Copies the supported Ricky handover package into the local Workspace artifact flow.", "Workspace artifact store", ["ricky-pdf-package-retrieval"], ["local-artifact-write-gate"], [SUBSTRATE.rickyPackage, SUBSTRATE.draftArtifacts], ["Only the discovered Ricky package is supported."]),
  toolBinding("atlas-document-converter", "Atlas document converter", "runtime_workflow", "available", "Calls the existing OpenClaw doc-converter script for explicitly selected real PDF/DOCX artifact production.", "OpenClaw doc-converter workflow", ["atlas-document-production-workflow"], ["local-artifact-write-gate", "path-secret-redaction"], [SUBSTRATE.atlasDocumentConverter, SUBSTRATE.draftArtifacts], ["No deck rendering support."]),
  toolBinding("librarian-report-reader", "Librarian report reader", "local_script", "limited", "Represents existing Librarian report and context pack output as read-only evidence.", "Librarian report archive", ["librarian-maintenance-reporting", "memory-search-recall"], ["read-only-retrieval", "path-secret-redaction"], [SUBSTRATE.librarianReports, SUBSTRATE.librarianSubagent], ["Does not apply Librarian bundles from Workspace."]),
  toolBinding("audit-pdf-renderer", "Audit PDF renderer", "openclaw_subagent", "limited", "Known audit workflow renderer for audit markdown to local PDF.", "Audit subagent workflow", ["audit-pdf-renderer-workflow"], ["local-artifact-write-gate", "capability-truthfulness"], [SUBSTRATE.auditSubagent], ["Not generalized to arbitrary branded PDFs."]),
  toolBinding("strategist-retriever", "Strategist retriever", "openclaw_subagent", "limited", "Retrieves strategist voice and brief-writing guidance.", "Strategist subagent workflow", ["brand-voice-guidance-retrieval"], ["read-only-retrieval", "capability-truthfulness"], [SUBSTRATE.strategistSubagent], ["Advisory only; external-facing decisions still need review."]),
  toolBinding("slack-listener-reply-runtime", "Slack listener reply runtime", "runtime_workflow", "limited", "Existing listener and draft/reply workflow represented for status and draft context.", "OpenClaw runtime workflow", ["slack-draft-reply-workflow", "slack-send"], ["external-send-block", "capability-truthfulness"], [SUBSTRATE.slackRuntime], ["Workspace sends remain blocked."]),
  toolBinding("workspace-qa-critic", "Workspace QA critic", "workspace_runtime", "available", "Checks analytical answer drafts and emits persisted QA phase events.", "Workspace runtime QA loop", ["qa-critic-check"], ["path-secret-redaction", "capability-truthfulness"], [SUBSTRATE.runtimeContext, SUBSTRATE.localSessions], ["Lightweight deterministic critic only."]),
  toolBinding("workspace-connector-registry", "Workspace connector registry", "connector_projection", "available", "Displays connector status and separates available reads from blocked sends and mutations.", "Workspace Systems panel", ["connector-status-inspection"], ["read-only-retrieval", "mutation-block", "external-send-block"], [SUBSTRATE.connectorRegistry], ["Readiness is informational unless an action workflow is separately wired."]),
];

const SEEDED_SAFETY_POLICIES: AtlasSafetyPolicy[] = [
  {
    id: "read-only-retrieval",
    name: "Read-only retrieval",
    safetyLevel: "read_only",
    approvalRequirement: "none",
    description: "Retrieval can inspect local safe projections and summarized references without external calls or mutations.",
    enforcedBy: ["Workspace agent tools", "Workspace runtime context", "Capabilities panel"],
    prohibited: ["External sends", "Live mutations", "Unlabeled full-corpus claims"],
  },
  {
    id: "local-artifact-write-gate",
    name: "Local artifact write gate",
    safetyLevel: "local_write",
    approvalRequirement: "user_confirmation",
    description: "Local artifacts require explicit create, draft, render, save, or export intent before a Workspace artifact is created.",
    enforcedBy: ["Workspace draft artifact flow", "Workspace local sessions"],
    prohibited: ["Artifacts from analytical mentions", "Fake unsupported PDFs", "External publication"],
  },
  {
    id: "external-send-block",
    name: "External send block",
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    description: "Workspace does not send Slack, OpenClaw, email, or other external messages from this registry.",
    enforcedBy: ["Capability registry", "Runtime boundaries", "Systems panel"],
    prohibited: ["Slack sends", "OpenClaw sends", "External delivery claims"],
  },
  {
    id: "mutation-block",
    name: "Mutation block",
    safetyLevel: "blocked",
    approvalRequirement: "not_supported",
    description: "Workspace does not mutate Monday, Typeform, Google Ads, Meta Ads, or live shared persistence from this registry.",
    enforcedBy: ["Capability registry", "Connector status projection"],
    prohibited: ["Monday mutations", "Typeform mutations", "Ads mutations", "Shared persistence writes"],
  },
  {
    id: "path-secret-redaction",
    name: "Path and secret redaction",
    safetyLevel: "read_only",
    approvalRequirement: "none",
    description: "UI and agent answers expose source labels and safe summaries, never raw local paths, provider diagnostics, or secret-like keys.",
    enforcedBy: ["Registry validation", "Workspace runtime context", "Artifact preview APIs"],
    prohibited: ["Raw local paths", "Environment key names", "Provider stderr"],
  },
  {
    id: "capability-truthfulness",
    name: "Capability truthfulness",
    safetyLevel: "read_only",
    approvalRequirement: "none",
    description: "Available, limited, blocked, and planned statuses must be shown honestly and blocked/planned capabilities cannot be offered as actions.",
    enforcedBy: ["Registry validation", "QA critic", "Capabilities panel"],
    prohibited: ["Presenting blocked capabilities as available", "Claiming unverified tools", "Asking to dig when safe retrieval already ran"],
  },
];

export function getAtlasCapabilityRegistry(options: AtlasCapabilityRegistryOptions = {}): AtlasCapabilityRegistry {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const capabilities = SEEDED_CAPABILITIES.map(cloneCapability);
  const skills = SEEDED_SKILLS.map(cloneSkill);
  const toolBindings = SEEDED_TOOL_BINDINGS.map(cloneToolBinding);
  const safetyPolicies = SEEDED_SAFETY_POLICIES.map(cloneSafetyPolicy);
  const discoveredSubstrate = DISCOVERED_SUBSTRATE.map(cloneSource);
  validateAtlasRegistry({ capabilities, skills, toolBindings, safetyPolicies, discoveredSubstrate });
  return {
    generatedAt,
    version: 1,
    capabilities,
    skills,
    toolBindings,
    safetyPolicies,
    discoveredSubstrate,
    summary: summarizeCapabilities(capabilities),
  };
}

export function validateAtlasRegistry(input: {
  capabilities: readonly AtlasCapability[];
  skills: readonly AtlasSkill[];
  toolBindings: readonly AtlasToolBinding[];
  safetyPolicies: readonly AtlasSafetyPolicy[];
  discoveredSubstrate?: readonly AtlasSubstrateSource[];
}): void {
  validateAtlasCapabilityRegistry(input.capabilities);
  validateAtlasSkills(input.skills, input.capabilities, input.toolBindings, input.safetyPolicies);
  validateAtlasToolBindings(input.toolBindings, input.capabilities, input.safetyPolicies);
  validateAtlasSafetyPolicies(input.safetyPolicies);
  for (const sourceRef of input.discoveredSubstrate ?? []) validateSource(sourceRef, "discoveredSubstrate");
}

export function validateAtlasCapabilityRegistry(capabilities: readonly AtlasCapability[]): void {
  const ids = new Set<string>();
  for (const capability of capabilities) {
    assertSafeId(capability.id, "capability id");
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
    for (const sourceRef of capability.sourceRefs) validateSource(sourceRef, `${capability.id}.sourceRefs`);
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

export function registryPromptSummary(registry: AtlasCapabilityRegistry = getAtlasCapabilityRegistry()): string[] {
  return [
    ...capabilityPromptSummary(registry.capabilities),
    "Discovered Atlas skills:",
    ...registry.skills.map((skillItem) => `- ${skillItem.name}: ${skillItem.status}; capabilities=${skillItem.capabilityIds.join(",")}`),
    "Tool binding truthfulness:",
    ...registry.toolBindings.map((binding) => `- ${binding.name}: ${binding.status}; ${binding.executionSurface}`),
    "Safety policies:",
    ...registry.safetyPolicies.map((policy) => `- ${policy.name}: ${policy.safetyLevel}; ${policy.description}`),
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

function validateAtlasSkills(
  skills: readonly AtlasSkill[],
  capabilities: readonly AtlasCapability[],
  toolBindings: readonly AtlasToolBinding[],
  safetyPolicies: readonly AtlasSafetyPolicy[],
): void {
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  const toolBindingIds = new Set(toolBindings.map((binding) => binding.id));
  const safetyPolicyIds = new Set(safetyPolicies.map((policy) => policy.id));
  const ids = new Set<string>();
  for (const skillItem of skills) {
    assertSafeId(skillItem.id, "skill id");
    if (ids.has(skillItem.id)) throw new Error(`Duplicate skill id: ${skillItem.id}`);
    ids.add(skillItem.id);
    for (const value of [skillItem.name, skillItem.description, ...skillItem.knownLimitations]) assertSafeCapabilityText(value, `${skillItem.id}.detail`);
    for (const id of skillItem.capabilityIds) if (!capabilityIds.has(id)) throw new Error(`${skillItem.id} references unknown capability ${id}`);
    for (const id of skillItem.toolBindingIds) if (!toolBindingIds.has(id)) throw new Error(`${skillItem.id} references unknown tool binding ${id}`);
    for (const id of skillItem.safetyPolicyIds) if (!safetyPolicyIds.has(id)) throw new Error(`${skillItem.id} references unknown safety policy ${id}`);
    for (const sourceRef of skillItem.sourceRefs) validateSource(sourceRef, `${skillItem.id}.sourceRefs`);
  }
}

function validateAtlasToolBindings(
  toolBindings: readonly AtlasToolBinding[],
  capabilities: readonly AtlasCapability[],
  safetyPolicies: readonly AtlasSafetyPolicy[],
): void {
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  const safetyPolicyIds = new Set(safetyPolicies.map((policy) => policy.id));
  const ids = new Set<string>();
  for (const binding of toolBindings) {
    assertSafeId(binding.id, "tool binding id");
    if (ids.has(binding.id)) throw new Error(`Duplicate tool binding id: ${binding.id}`);
    ids.add(binding.id);
    for (const value of [binding.name, binding.description, binding.executionSurface, ...binding.knownLimitations]) assertSafeCapabilityText(value, `${binding.id}.detail`);
    for (const id of binding.capabilityIds) if (!capabilityIds.has(id)) throw new Error(`${binding.id} references unknown capability ${id}`);
    for (const id of binding.safetyPolicyIds) if (!safetyPolicyIds.has(id)) throw new Error(`${binding.id} references unknown safety policy ${id}`);
    for (const sourceRef of binding.sourceRefs) validateSource(sourceRef, `${binding.id}.sourceRefs`);
  }
}

function validateAtlasSafetyPolicies(safetyPolicies: readonly AtlasSafetyPolicy[]): void {
  const ids = new Set<string>();
  for (const policy of safetyPolicies) {
    assertSafeId(policy.id, "safety policy id");
    if (ids.has(policy.id)) throw new Error(`Duplicate safety policy id: ${policy.id}`);
    ids.add(policy.id);
    for (const value of [policy.name, policy.description, ...policy.enforcedBy, ...policy.prohibited]) {
      assertSafeCapabilityText(value, `${policy.id}.detail`);
    }
  }
}

function skill(
  id: string,
  name: string,
  category: AtlasSkillCategory,
  status: AtlasCapabilityStatus,
  description: string,
  capabilityIds: string[],
  toolBindingIds: string[],
  safetyPolicyIds: string[],
  sourceRefs: AtlasSubstrateSource[],
  knownLimitations: string[],
): AtlasSkill {
  return { id, name, category, status, description, capabilityIds, toolBindingIds, safetyPolicyIds, sourceRefs, knownLimitations };
}

function toolBinding(
  id: string,
  name: string,
  kind: AtlasToolBindingKind,
  status: AtlasCapabilityStatus,
  description: string,
  executionSurface: string,
  capabilityIds: string[],
  safetyPolicyIds: string[],
  sourceRefs: AtlasSubstrateSource[],
  knownLimitations: string[],
): AtlasToolBinding {
  return { id, name, kind, status, description, executionSurface, capabilityIds, safetyPolicyIds, sourceRefs, knownLimitations };
}

function source(label: string, kind: AtlasSubstrateKind, summary: string): AtlasSubstrateSource {
  return { label, kind, summary };
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
    sourceRefs: capability.sourceRefs.map(cloneSource),
    knownLimitations: [...capability.knownLimitations],
  };
}

function cloneSkill(skillItem: AtlasSkill): AtlasSkill {
  return {
    ...skillItem,
    capabilityIds: [...skillItem.capabilityIds],
    toolBindingIds: [...skillItem.toolBindingIds],
    safetyPolicyIds: [...skillItem.safetyPolicyIds],
    sourceRefs: skillItem.sourceRefs.map(cloneSource),
    knownLimitations: [...skillItem.knownLimitations],
  };
}

function cloneToolBinding(binding: AtlasToolBinding): AtlasToolBinding {
  return {
    ...binding,
    capabilityIds: [...binding.capabilityIds],
    safetyPolicyIds: [...binding.safetyPolicyIds],
    sourceRefs: binding.sourceRefs.map(cloneSource),
    knownLimitations: [...binding.knownLimitations],
  };
}

function cloneSafetyPolicy(policy: AtlasSafetyPolicy): AtlasSafetyPolicy {
  return {
    ...policy,
    enforcedBy: [...policy.enforcedBy],
    prohibited: [...policy.prohibited],
  };
}

function cloneSource(sourceRef: AtlasSubstrateSource): AtlasSubstrateSource {
  return { ...sourceRef };
}

function validateSource(sourceRef: AtlasSubstrateSource, path: string): void {
  assertSafeCapabilityText(sourceRef.label, `${path}.label`);
  assertSafeCapabilityText(sourceRef.summary, `${path}.summary`);
}

function assertSafeId(value: string, path: string): void {
  assertSafeCapabilityText(value, path);
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(value)) throw new Error(`Invalid ${path}: ${value}`);
}

function assertSafeCapabilityText(value: string, path: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Capability ${path} must be non-empty text.`);
  if (/(?:\/Users\/|\/private\/|\/tmp\/|\.openclaw\/|OPENAI_API_KEY|ANTHROPIC_API_KEY|SLACK_|MONDAY_|TYPEFORM_)/i.test(value)) {
    throw new Error(`Capability ${path} contains unsafe local or secret-looking text.`);
  }
}
