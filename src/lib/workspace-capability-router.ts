import {
  detectWorkspaceDraftArtifactIntent,
  shouldCreateWorkspaceDraftArtifact,
} from "./workspace-draft-artifacts.ts";
import {
  getAtlasCapabilityRegistry,
  type AtlasCapability,
  type AtlasCapabilityApprovalRequirement,
  type AtlasCapabilitySafetyLevel,
  type AtlasCapabilityStatus,
  type AtlasSafetyPolicy,
  type AtlasSkill,
  type AtlasToolBinding,
} from "./workspace-capabilities.ts";

export type WorkspacePromptIntent =
  | "call_memory_analysis"
  | "recent_call_topic_retrieval"
  | "memory_recall"
  | "artifact_lookup"
  | "internal_markdown_draft"
  | "ricky_pdf_package_retrieval"
  | "atlas_document_workflow"
  | "arbitrary_pdf_generation"
  | "slack_send"
  | "monday_mutation"
  | "typeform_mutation"
  | "ads_mutation"
  | "brand_voice_guidance"
  | "connector_status"
  | "general_workspace_answer";

export interface WorkspaceCapabilityPlan {
  intent: WorkspacePromptIntent;
  capabilityId: string;
  capabilityName: string;
  capabilityStatus: AtlasCapabilityStatus;
  skillId: string | null;
  skillName: string | null;
  toolBindingIds: string[];
  toolBindingNames: string[];
  safetyPolicyIds: string[];
  safetyPolicyNames: string[];
  safetyLevel: AtlasCapabilitySafetyLevel;
  approvalRequirement: AtlasCapabilityApprovalRequirement;
  allowed: boolean;
  blockedReason: string | null;
  limitedReason: string | null;
  artifactIntent: {
    shouldCreate: boolean;
    requestedFormat: string | null;
    explicit: boolean;
  };
}

export interface WorkspaceCapabilityRouteInput {
  prompt: string;
  title?: string;
}

export function routeWorkspaceCapability(input: WorkspaceCapabilityRouteInput): WorkspaceCapabilityPlan {
  const prompt = input.prompt.trim();
  const title = input.title?.trim() ?? "";
  const text = `${prompt}\n${title}`.toLowerCase();
  const artifactIntent = detectWorkspaceDraftArtifactIntent({ prompt, taskTitle: title });
  const explicitArtifactIntent = shouldCreateWorkspaceDraftArtifact({ prompt, taskTitle: title });
  const registry = getAtlasCapabilityRegistry();
  const capabilityId = classifyCapabilityId(text, artifactIntent.requestedFormat, explicitArtifactIntent);
  const capability = requireCapability(registry.capabilities, capabilityId);
  const skill = selectSkill(registry.skills, capability.id);
  const toolBindings = selectToolBindings(registry.toolBindings, capability, skill);
  const safetyPolicies = selectSafetyPolicies(registry.safetyPolicies, capability, skill, toolBindings);
  const blockedReason = blockedReasonFor(capability);
  const limitedReason = capability.status === "limited"
    ? capability.knownLimitations[0] ?? `${capability.name} is limited.`
    : null;

  return {
    intent: intentForCapability(capability.id),
    capabilityId: capability.id,
    capabilityName: capability.name,
    capabilityStatus: capability.status,
    skillId: skill?.id ?? null,
    skillName: skill?.name ?? null,
    toolBindingIds: toolBindings.map((binding) => binding.id),
    toolBindingNames: toolBindings.map((binding) => binding.name),
    safetyPolicyIds: safetyPolicies.map((policy) => policy.id),
    safetyPolicyNames: safetyPolicies.map((policy) => policy.name),
    safetyLevel: capability.safetyLevel,
    approvalRequirement: capability.approvalRequirement,
    allowed: capability.status === "available" || capability.status === "limited",
    blockedReason,
    limitedReason,
    artifactIntent: {
      shouldCreate: explicitArtifactIntent,
      requestedFormat: artifactIntent.requestedFormat,
      explicit: explicitArtifactIntent,
    },
  };
}

export function formatCapabilityPlanForPrompt(plan: WorkspaceCapabilityPlan): string[] {
  return [
    `- intent=${plan.intent}`,
    `- selected capability=${plan.capabilityName} (${plan.capabilityId}); status=${plan.capabilityStatus}; safety=${plan.safetyLevel}; approval=${plan.approvalRequirement}`,
    `- selected skill=${plan.skillName ?? "none"}${plan.skillId ? ` (${plan.skillId})` : ""}`,
    `- tool bindings considered=${plan.toolBindingNames.length ? plan.toolBindingNames.join(", ") : "none"}`,
    `- safety policies=${plan.safetyPolicyNames.length ? plan.safetyPolicyNames.join(", ") : "none"}`,
    plan.allowed
      ? `- route status=allowed${plan.limitedReason ? `; limited_reason=${plan.limitedReason}` : ""}`
      : `- route status=blocked; blocked_reason=${plan.blockedReason ?? "Capability is not available."}`,
  ];
}

export function buildBlockedCapabilityAnswer(plan: WorkspaceCapabilityPlan): string {
  return [
    "## What I checked",
    "",
    `- Selected capability: ${plan.capabilityName}.`,
    `- Selected skill: ${plan.skillName ?? "none"}.`,
    `- Safety policy: ${plan.safetyPolicyNames.join(", ") || "Capability truthfulness"}.`,
    `- Tool bindings considered: ${plan.toolBindingNames.join(", ") || "none"}.`,
    "",
    "## What I found",
    "",
    plan.blockedReason ?? `${plan.capabilityName} is not available in Workspace today.`,
    "",
    "## Confidence / coverage",
    "",
    "High. This is a registry-level capability boundary, not a missing-source answer.",
    "",
    "## What I would check next",
    "",
    "- Use an available or limited Workspace capability, or ask for a local draft/retrieval path that does not send, mutate, or fake unsupported PDFs.",
  ].join("\n");
}

export function capabilityPlanMatchesPrompt(plan: WorkspaceCapabilityPlan, prompt: string, title?: string): boolean {
  const expected = routeWorkspaceCapability({ prompt, title });
  return expected.capabilityId === plan.capabilityId;
}

function classifyCapabilityId(text: string, requestedFormat: string | null, explicitArtifactIntent: boolean): string {
  if (/\b(slack|dm|channel|thread)\b/.test(text) && /\b(send|post|reply|message|deliver)\b/.test(text)) return "slack-send";
  if (/\bmonday\b/.test(text) && /\b(create|update|move|delete|change|mutate)\b/.test(text)) return "monday-mutation";
  if (/\btypeform\b/.test(text) && /\b(create|update|delete|change|mutate|edit)\b/.test(text)) return "typeform-mutation";
  if (/\b(google|meta|facebook)\b.{0,40}\bads?\b/.test(text) && /\b(create|update|change|launch|increase|decrease|mutate|budget)\b/.test(text)) return "google-meta-ads-mutation";

  if (requestedFormat === "pdf" && explicitArtifactIntent) {
    if (isRickyPdfRequest(text)) return "ricky-pdf-package-retrieval";
    if (isAtlasDocumentWorkflowRequest(text)) return "atlas-document-production-workflow";
    return "arbitrary-branded-pdf-generation";
  }
  if (requestedFormat === "docx" && explicitArtifactIntent) {
    if (isAtlasDocumentWorkflowRequest(text)) return "atlas-document-production-workflow";
  }

  if (explicitArtifactIntent) return "internal-markdown-draft";
  if (/\b(recent|latest|today|yesterday|this week|last week)\b/.test(text) && /\b(call|calls|transcript|transcripts|call logs?)\b/.test(text)) return "recent-call-topic-retrieval";
  if (/\b(call|calls|transcript|transcripts|call logs?)\b/.test(text) && /\b(model|strategy|strategies|trend|trends|knowledge|memory|playbook|playbooks|clients?|revenue|10k)\b/.test(text)) return "call-memory-answer";
  if (/\b(artifact|library|draft|package|handover|ricky)\b/.test(text) && /\b(find|lookup|show|retrieve|open|where)\b/.test(text)) return "artifact-library-lookup";
  if (/\b(brand|voice|tone|strategist|positioning|copy style)\b/.test(text)) return "brand-voice-guidance-retrieval";
  if (/\b(connector|connection|systems?|status|health)\b/.test(text)) return "connector-status-inspection";
  if (/\b(memory|knowledge|playbooks?|sources?|references?|learned)\b/.test(text)) return "memory-search-recall";
  return "call-memory-answer";
}

function isRickyPdfRequest(text: string): boolean {
  return /\bricky\b|\bcalder\b|\bcoach hire\b/.test(text) && /\b(pay|handover|package|structure|model)\b/.test(text);
}

function isAtlasDocumentWorkflowRequest(text: string): boolean {
  return (
    /\b(?:use|select|run|invoke|wrap|route to|via)\b.{0,90}\b(?:real|actual|production|proper|existing|source-of-truth)\b.{0,90}\b(?:atlas|rhys|undeniable)\b.{0,90}\b(?:document|doc|pdf|docx|converter|workflow)\b/.test(text) ||
    /\b(?:real|actual|production|proper|existing|source-of-truth)\b.{0,90}\b(?:atlas|rhys|undeniable)\b.{0,90}\b(?:document|doc|pdf|docx|converter|workflow)\b/.test(text) ||
    /\b(?:atlas|rhys|undeniable)\b.{0,90}\b(?:doc-converter|document converter|document workflow|pdf workflow|docx workflow)\b/.test(text)
  );
}

function intentForCapability(capabilityId: string): WorkspacePromptIntent {
  switch (capabilityId) {
    case "recent-call-topic-retrieval":
      return "recent_call_topic_retrieval";
    case "memory-search-recall":
      return "memory_recall";
    case "artifact-library-lookup":
      return "artifact_lookup";
    case "internal-markdown-draft":
      return "internal_markdown_draft";
    case "ricky-pdf-package-retrieval":
      return "ricky_pdf_package_retrieval";
    case "atlas-document-production-workflow":
      return "atlas_document_workflow";
    case "arbitrary-branded-pdf-generation":
      return "arbitrary_pdf_generation";
    case "slack-send":
      return "slack_send";
    case "monday-mutation":
      return "monday_mutation";
    case "typeform-mutation":
      return "typeform_mutation";
    case "google-meta-ads-mutation":
      return "ads_mutation";
    case "brand-voice-guidance-retrieval":
      return "brand_voice_guidance";
    case "connector-status-inspection":
      return "connector_status";
    case "call-memory-answer":
      return "call_memory_analysis";
    default:
      return "general_workspace_answer";
  }
}

function requireCapability(capabilities: readonly AtlasCapability[], id: string): AtlasCapability {
  const capability = capabilities.find((candidate) => candidate.id === id);
  if (!capability) throw new Error(`Missing Atlas capability: ${id}`);
  return capability;
}

function selectSkill(skills: readonly AtlasSkill[], capabilityId: string): AtlasSkill | null {
  return skills.find((skill) =>
    skill.capabilityIds.includes(capabilityId) &&
    (skill.status === "available" || skill.status === "limited")
  ) ?? null;
}

function selectToolBindings(
  toolBindings: readonly AtlasToolBinding[],
  capability: AtlasCapability,
  skill: AtlasSkill | null,
): AtlasToolBinding[] {
  const ids = new Set<string>(skill?.toolBindingIds ?? []);
  for (const binding of toolBindings) {
    if (binding.capabilityIds.includes(capability.id)) ids.add(binding.id);
  }
  return [...ids]
    .map((id) => toolBindings.find((binding) => binding.id === id))
    .filter((binding): binding is AtlasToolBinding => Boolean(binding));
}

function selectSafetyPolicies(
  safetyPolicies: readonly AtlasSafetyPolicy[],
  capability: AtlasCapability,
  skill: AtlasSkill | null,
  toolBindings: readonly AtlasToolBinding[],
): AtlasSafetyPolicy[] {
  const ids = new Set<string>([
    ...(skill?.safetyPolicyIds ?? []),
    ...toolBindings.flatMap((binding) => binding.safetyPolicyIds),
  ]);
  if (capability.status === "blocked") ids.add("capability-truthfulness");
  if (capability.safetyLevel === "blocked") ids.add("mutation-block");
  if (capability.id === "slack-send") ids.add("external-send-block");
  if (capability.id === "arbitrary-branded-pdf-generation") ids.add("local-artifact-write-gate");
  return [...ids]
    .map((id) => safetyPolicies.find((policy) => policy.id === id))
    .filter((policy): policy is AtlasSafetyPolicy => Boolean(policy));
}

function blockedReasonFor(capability: AtlasCapability): string | null {
  if (capability.status !== "blocked") return null;
  if (capability.id === "slack-send") return "Slack send is blocked in Workspace. Atlas can draft or summarize, but it must not send Slack messages.";
  if (capability.id === "arbitrary-branded-pdf-generation") return "Arbitrary branded PDF generation is blocked. Workspace can retrieve the supported Ricky PDF package, but it must not create fake unsupported PDFs.";
  if (capability.id === "monday-mutation") return "Monday mutation is blocked in Workspace. Atlas can discuss or draft changes, but it must not mutate Monday.";
  if (capability.id === "typeform-mutation") return "Typeform mutation is blocked in Workspace. Atlas can inspect supported local audit parsing paths, but it must not mutate Typeform.";
  if (capability.id === "google-meta-ads-mutation") return "Google/Meta ads mutation is blocked in Workspace. Atlas must not create or change ad campaigns.";
  return `${capability.name} is blocked in Workspace.`;
}
