/**
 * GROUNDED RESEARCH ENGINE — the general build capability, slice 1.
 *
 * Turns a build request ("build me a competitor teardown pdf for gym owners")
 * into a CITED research brief under the anti-fabrication contract:
 *
 *   plan       — deterministic sub-queries per section of a deliverable schema
 *   collect    — vault-first (retrieval bridge) then web (brave bridge);
 *                every evidence item gets a content-hash ID, so the same
 *                source found twice dedupes and a fabricated ID cannot exist
 *   coverage   — per-section matched|thin|none computed from EVIDENCE,
 *                deterministically, BEFORE any model sees anything. Web-only
 *                evidence caps at THIN by construction (web default relevance
 *                sits below the matched thresholds): two cold search snippets
 *                can never strip the "directional — verify" hedge.
 *   synthesise — ONE LLM call over a CLOSED WORLD (the evidence pool);
 *                NONE-coverage sections never reach the model
 *   lint       — alias->id resolution; model self-labels are advisory only
 *   gate       — research-gate.mjs, pure + deterministic (citations, numbers,
 *                hygiene, coverage, degraded honesty)
 *   verify     — entailment cross-examination: a SECOND, independent model
 *                pass checks that each claim's cited excerpts actually
 *                SUPPORT it (meaning, units, polarity — the unit-swap/
 *                negation-flip class the deterministic gate cannot see).
 *                Injectable; FAIL-CLOSED: verifier unavailable => no ship.
 *   repair     — bounded loop on gate/verify rejection (drop or re-ground,
 *                never invent); still failing => ok:false. NO CITATION, NO
 *                SHIP; NO SUPPORT, NO SHIP.
 *   render     — internal markdown (citations, handles, coverage banners) and
 *                client markdown (provenance-stripped; no markers, paths,
 *                handles, or internal call participant names). A build that
 *                did not pass exposes NO client render at all.
 *
 * Degraded honesty: a search-backend outage is never laundered into "no data
 * exists". Zero evidence during an outage fails the build (search_unavailable)
 * instead of shipping honest-empty copy; partial outages stamp the brief
 * degraded and force the incomplete-sweep notice into the client render (the
 * gate enforces the notice's literal presence).
 *
 * Everything is injectable (search fns, LLM fn, verifier, clock) so the proof
 * harness drives the whole engine against fixtures — the house pattern proven
 * by the delivery worker. Defaults wrap the live local bridges + Anthropic.
 *
 * This module performs NO Slack I/O, NO file writes, NO delivery. Callers
 * (slice 2/3) own rendering to disk, doc-converter, and the worker handoff.
 */

import { createHash } from "node:crypto";
import {
  coverageForEvidence,
  evaluateGate,
  RESEARCH_BRIEF_SCHEMA_VERSION,
  SEARCH_INCOMPLETE_NOTICE,
} from "./research-gate.mjs";

export const RETRIEVAL_BRIDGE_URL = "http://127.0.0.1:4012";
export const BRAVE_BRIDGE_URL = "http://127.0.0.1:4010";
export const DEFAULT_SYNTHESIS_MODEL = "claude-opus-4-8";
// Brave carries no relevance score. 0.5 is deliberately BELOW the matched
// thresholds (0.55 pair / 0.7 single) so web-only sections cap at THIN.
export const WEB_DEFAULT_RELEVANCE = 0.5;
export const VAULT_ORDER_BOOST = 0.05; // ordering only — never affects coverage

/**
 * The flagship deliverable schema — deliverable-backwards design: these are
 * the sections a competitor teardown must answer to be worth Rhys's name on
 * it. {audience} expands from the request. vaultOnly sections ground
 * exclusively in Rhys's own IP; synthesisOnly sections cite the whole pool.
 */
export const COMPETITOR_TEARDOWN_SCHEMA = {
  key: "competitor-teardown",
  title: "Competitor Teardown",
  match: /\bcompetitor\s+(teardown|analysis|breakdown|intel(?:ligence)?|landscape)\b/i,
  sections: [
    { id: "executive-summary", title: "Executive Summary", synthesisOnly: true },
    { id: "competitor-set", title: "The Competitor Set", queries: ["{audience} competitors market landscape", "top fitness franchises {audience} compete"] },
    { id: "offers-pricing", title: "Offers & Pricing", queries: ["{audience} membership pricing models", "gym membership price comparison franchise"] },
    { id: "positioning-marketing", title: "Positioning & Marketing", queries: ["{audience} marketing positioning differentiation", "gym lead generation offers advertising"] },
    { id: "local-vs-franchise", title: "Local vs Franchise Dynamics", queries: ["independent gym vs franchise competition", "{audience} local competition franchise expansion"] },
    { id: "retention-economics", title: "Retention & Unit Economics", queries: ["gym member retention churn benchmarks", "{audience} lifetime value unit economics"] },
    { id: "undeniable-angle", title: "The Undeniable Angle", vaultOnly: true, queries: ["competitor positioning playbook pricing strategy", "{audience} offer differentiation retention playbook"] },
    { id: "recommendations", title: "Recommendations", synthesisOnly: true },
  ],
};

const STOPWORDS = new Set([
  "build", "make", "create", "generate", "give", "me", "a", "an", "the", "for",
  "pdf", "doc", "document", "deck", "please", "of", "on", "and", "to", "with",
]);

/** Deterministic topic/audience terms from the request text. */
export function extractRequestTerms(request = "") {
  const tokens = String(request).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .filter((t) => !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/** Deterministic sub-query expansion for one section. */
export function planSectionQueries(section, request) {
  const terms = extractRequestTerms(request);
  const audience = terms.slice(0, 4).join(" ") || "business owners";
  return (section.queries || []).map((q) => q
    .replaceAll("{audience}", audience)
    .replaceAll("{topic}", terms.join(" ") || "the requested topic"));
}

/** Content-hash evidence id: dedupes across queries; unforgeable by a model. */
export function evidenceIdFor({ provenance, url, handle, excerpt }) {
  const normalized = String(excerpt || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `ev_${createHash("sha256").update(`${provenance}|${url || handle || ""}|${normalized}`).digest("hex").slice(0, 10)}`;
}

// ── Default live adapters (never exercised by the harness) ──────────────────

export function makeDefaultRetrieveVault({ fetchImpl = fetch, baseUrl = RETRIEVAL_BRIDGE_URL, timeoutMs = 35_000 } = {}) {
  return async (query, topK = 5) => {
    try {
      const resp = await fetchImpl(`${baseUrl}/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: topK }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return { chunks: [], degraded: true, error: `retrieval bridge HTTP ${resp.status}` };
      const data = await resp.json();
      // OR-semantics: ANY backend error means the sweep was incomplete (the
      // v1 AND-check let a half-dead bridge masquerade as an empty vault).
      const degraded = Boolean(data?.error || data.meta?.rag_error || data.meta?.graph_error);
      return { chunks: Array.isArray(data.chunks) ? data.chunks : [], degraded };
    } catch (err) {
      return { chunks: [], degraded: true, error: String(err?.message || err) };
    }
  };
}

export function makeDefaultSearchWeb({ fetchImpl = fetch, baseUrl = BRAVE_BRIDGE_URL, timeoutMs = 15_000 } = {}) {
  return async (query, count = 5) => {
    const call = async () => {
      const resp = await fetchImpl(`${baseUrl}/search?q=${encodeURIComponent(query)}&count=${count}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return { error: `brave bridge HTTP ${resp.status}` };
      return resp.json();
    };
    try {
      let data = await call();
      if (data?.error === "rate_limited") {
        await new Promise((r) => setTimeout(r, 1_500));
        data = await call();
      }
      return { results: Array.isArray(data.results) ? data.results : [], degraded: Boolean(data?.error) };
    } catch (err) {
      return { results: [], degraded: true, error: String(err?.message || err) };
    }
  };
}

export function makeDefaultLlm({ fetchImpl = fetch, apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_SYNTHESIS_MODEL, timeoutMs = 180_000 } = {}) {
  return async ({ system, prompt, maxTokens = 8_000 }) => {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is unavailable");
    const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error("empty synthesis response");
    return text;
  };
}

// ── Entailment verification (the semantic teeth the pure gate cannot have) ──

const ENTAILMENT_SYSTEM = [
  "You are an adversarial fact-checker. For each claim you receive the EXACT source excerpts it cites.",
  "Decide whether the excerpts FULLY SUPPORT the claim: same facts, same numbers WITH THE SAME UNITS AND PERIODS, same polarity (a source saying X never supports 'not X'), same entities. A source that merely mentions a topic does NOT support an assertion about it.",
  "Default to unsupported when uncertain. Output STRICT JSON only:",
  '{"verdicts":[{"id":"c1","supported":true|false,"reason":"short"}]}',
].join("\n");

export function makeDefaultEntailmentVerifier({ llm } = {}) {
  return async ({ claims }) => {
    if (!claims.length) return { verdicts: [] };
    const body = claims.map((c) => [
      `CLAIM id=${c.id}: ${c.text}`,
      ...c.excerpts.map((x, i) => `  EXCERPT ${i + 1}: ${x}`),
    ].join("\n")).join("\n\n");
    const raw = await llm({ system: ENTAILMENT_SYSTEM, prompt: body, maxTokens: 2_000 });
    const parsed = parseJsonObject(raw);
    if (!Array.isArray(parsed.verdicts)) throw new Error("entailment verifier returned no verdicts[]");
    return { verdicts: parsed.verdicts };
  };
}

// ── Collection ───────────────────────────────────────────────────────────────

async function collectEvidence({ schema, request, retrieveVault, searchWeb, vaultTopK, webCount, maxQueries, log }) {
  const pool = new Map();
  const sectionAllocation = new Map();
  const degraded = { vault: false, web: false };
  let queriesRun = 0;

  const add = (sectionId, item) => {
    const id = evidenceIdFor(item);
    if (!pool.has(id)) pool.set(id, { ...item, id });
    if (!sectionAllocation.has(sectionId)) sectionAllocation.set(sectionId, new Set());
    sectionAllocation.get(sectionId).add(id);
  };

  for (const section of schema.sections) {
    if (section.synthesisOnly) continue;
    for (const query of planSectionQueries(section, request)) {
      if (queriesRun >= maxQueries) {
        log(`query budget reached (${maxQueries}) — remaining sections rely on collected pool`);
        break;
      }
      queriesRun += 1;
      const vault = await retrieveVault(query, vaultTopK);
      if (vault.degraded) degraded.vault = true;
      for (const chunk of vault.chunks || []) {
        add(section.id, {
          provenance: "vault",
          handle: chunk.source,
          url: null,
          title: chunk.title || chunk.source,
          excerpt: String(chunk.content || "").slice(0, 1500),
          relevance: Number(chunk.relevance ?? 0),
          category: chunk.category || "vault",
          query,
        });
      }
      if (!section.vaultOnly) {
        const web = await searchWeb(query, webCount);
        if (web.degraded) degraded.web = true;
        for (const result of web.results || []) {
          add(section.id, {
            provenance: "web",
            handle: null,
            url: result.url,
            title: result.title || result.url,
            excerpt: String(result.description || "").slice(0, 1500),
            relevance: WEB_DEFAULT_RELEVANCE,
            category: "web",
            age: result.age || null,
            query,
          });
        }
      }
    }
  }

  const evidence = [...pool.values()].sort((a, b) => {
    const aScore = a.relevance + (a.provenance === "vault" ? VAULT_ORDER_BOOST : 0);
    const bScore = b.relevance + (b.provenance === "vault" ? VAULT_ORDER_BOOST : 0);
    return bScore - aScore || a.id.localeCompare(b.id);
  });
  const alias = new Map(evidence.map((e, i) => [`E${i + 1}`, e.id]));
  return { evidence, alias, sectionAllocation, degraded, queriesRun };
}

// ── Synthesis prompt ─────────────────────────────────────────────────────────

const SYNTHESIS_SYSTEM = [
  "You are Atlas's grounded research synthesiser. You write research briefs whose every factual claim is grounded in a CLOSED WORLD of evidence supplied in the prompt.",
  "HARD RULES:",
  "1. You may only assert facts that appear in the supplied evidence excerpts. Your own knowledge may shape structure, phrasing, and analysis framing — NEVER facts, numbers, names, or statistics.",
  "2. EVERY claim — analytical or factual — must cite the evidence aliases (E1, E2...) that support it. A claim with no citation will be rejected by a deterministic gate. Copy numbers VERBATIM from excerpts, keeping their units and periods.",
  "3. A separate fact-checker will verify each claim against its cited excerpts: same meaning, same units, same polarity. Do not stretch a citation beyond what its excerpt literally says.",
  "4. Claim text is plain prose: no URLs, no markdown links, no [source] markers, no code fences, no HTML.",
  "5. Never name coaching clients or internal call participants. Refer to internal evidence as 'owner calls' or 'the house playbook'.",
  "6. gapNote is meta-commentary about what is missing — it must contain no statistics, no named companies, no specifics.",
  "7. If the evidence cannot support a useful claim for a section, return fewer claims and an honest gapNote. NEVER pad. NEVER invent.",
  "8. Output STRICT JSON only — no prose around it.",
].join("\n");

function synthesisPrompt({ request, schema, evidence, alias, sectionsForLlm, repairNote }) {
  const aliasLines = [...alias.entries()].map(([a, id]) => {
    const e = evidence.find((x) => x.id === id);
    return `${a} [${e.provenance}${e.age ? `, ${e.age}` : ""}] ${e.title}\n   ${e.excerpt.slice(0, 700)}`;
  });
  const sectionLines = sectionsForLlm.map((s) => `- id:"${s.id}" title:"${s.title}"${s.synthesisOnly ? " (synthesise from the whole pool)" : ""} coverage:${s.coverage}`);
  return [
    `REQUEST: ${request}`,
    `DELIVERABLE: ${schema.title}`,
    "",
    "SECTIONS TO WRITE (use exactly these ids):",
    ...sectionLines,
    "",
    "EVIDENCE POOL (the closed world — cite by alias):",
    ...aliasLines,
    "",
    repairNote ? `REPAIR INSTRUCTIONS:\n${repairNote}\n` : "",
    'OUTPUT JSON SHAPE: {"sections":[{"id":"...","claims":[{"text":"one clear sentence","kind":"material"|"soft","evidence":["E1"]}],"gapNote":"string or null"}]}',
    "Write 2-5 claims per matched section, 1-3 for thin sections (hedged, citing what exists). Claims must be self-contained sentences.",
  ].filter(Boolean).join("\n");
}

/** Robust strict-JSON extraction: fenced block, whole text, anchored object. */
export function parseJsonObject(raw) {
  const text = String(raw);
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(text.trim());
  const anchored = text.indexOf('{"');
  if (anchored !== -1) candidates.push(text.slice(anchored, text.lastIndexOf("}") + 1));
  const first = text.indexOf("{");
  if (first !== -1) candidates.push(text.slice(first, text.lastIndexOf("}") + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* try next */ }
  }
  throw new Error("output contained no parseable JSON object");
}

function parseSynthesisJson(raw) {
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed.sections)) throw new Error("synthesis JSON missing sections[]");
  return parsed;
}

// ── Renders (pure; markdown is a projection of the brief, never the truth) ──

export function renderInternalMarkdown(brief) {
  const byId = new Map(brief.evidence.map((e) => [e.id, e]));
  const aliasOf = new Map(brief.evidence.map((e, i) => [e.id, `E${i + 1}`]));
  const lines = [`# ${brief.title}`, "", `_Internal cited brief — generated ${brief.createdAt}. Coverage: ${brief.coverageSummary.matched} matched / ${brief.coverageSummary.thin} thin / ${brief.coverageSummary.none} none._`, ""];
  if (brief.degraded?.vault || brief.degraded?.web) {
    lines.push(`> **SEARCH DEGRADED** — ${brief.degraded.vault ? "vault retrieval" : ""}${brief.degraded.vault && brief.degraded.web ? " and " : ""}${brief.degraded.web ? "web search" : ""} errored during collection. Coverage reflects an INCOMPLETE sweep, not the world.`, "");
  }
  for (const section of brief.sections) {
    lines.push(`## ${section.title}`);
    if (section.coverage === "none") {
      lines.push("", `> **Coverage: NONE** — no grounded evidence found in the vault or web search for this section. Nothing has been fabricated to fill it. Open questions: ${section.gapNote || "see queries in the brief JSON."}`, "");
      continue;
    }
    if (section.coverage === "thin") {
      lines.push("", "> **Coverage: THIN** — limited grounding; treat the claims below as directional and verify before client use.", "");
    }
    for (const claim of brief.claims.filter((c) => c.sectionId === section.id)) {
      const markers = (claim.evidenceIds || []).map((id) => aliasOf.get(id)).filter(Boolean);
      lines.push(`- ${claim.text}${markers.length ? ` [${markers.join(",")}]` : ""}`);
    }
    if (section.gapNote) lines.push("", `> Gap: ${section.gapNote}`);
    lines.push("");
  }
  lines.push("## Sources", "");
  for (const [id, alias] of aliasOf) {
    const e = byId.get(id);
    lines.push(`- **${alias}** — ${e.provenance === "web" ? `${e.title} (${e.url})` : `${e.title} (vault: ${e.handle})`}`);
  }
  return lines.join("\n");
}

export function renderClientMarkdown(brief) {
  const lines = [`# ${brief.title}`, ""];
  if (brief.degraded?.vault || brief.degraded?.web) {
    lines.push(`_${SEARCH_INCOMPLETE_NOTICE}_`, "");
  }
  const webSources = brief.evidence.filter((e) => e.provenance === "web");
  const vaultCount = brief.evidence.length - webSources.length;
  for (const section of brief.sections) {
    lines.push(`## ${section.title}`);
    if (section.coverage === "none") {
      lines.push("", "_Limited public data was available for this section; rather than estimate, we flag it as an open question for direct research._", "");
      continue;
    }
    if (section.coverage === "thin") {
      lines.push("", "_Note: public data on this section is limited — figures below are directional._", "");
    }
    for (const claim of brief.claims.filter((c) => c.sectionId === section.id)) {
      lines.push(`- ${claim.text}`);
    }
    lines.push("");
  }
  lines.push("## Sources", "");
  for (const e of webSources) lines.push(`- ${e.title} — ${e.url}`);
  if (vaultCount > 0) lines.push(`- Undeniable internal knowledge base (${vaultCount} reference${vaultCount === 1 ? "" : "s"})`);
  return lines.join("\n");
}

// ── The engine ───────────────────────────────────────────────────────────────

export async function runGroundedResearch({
  request,
  schema = COMPETITOR_TEARDOWN_SCHEMA,
  retrieveVault = makeDefaultRetrieveVault(),
  searchWeb = makeDefaultSearchWeb(),
  llm = makeDefaultLlm(),
  verifyClaims = null, // default built from llm below; injectable for fixtures
  vaultTopK = 5,
  webCount = 5,
  maxQueries = 12,
  maxRepairRounds = 2,
  now = () => new Date(),
  log = () => {},
} = {}) {
  const budget = { vaultAndWebQueries: 0, llmCalls: 0 };
  const verifier = verifyClaims || makeDefaultEntailmentVerifier({ llm });

  // Schemas are operator-authored code, but duplicate section ids would
  // render the same claims under multiple headings — dedupe defensively.
  const uniqueSections = [];
  const seenSectionIds = new Set();
  for (const s of schema.sections) {
    if (seenSectionIds.has(s.id)) continue;
    seenSectionIds.add(s.id);
    uniqueSections.push(s);
  }
  const dedupedSchema = { ...schema, sections: uniqueSections };

  // 1-2. plan + collect
  const { evidence, alias, sectionAllocation, degraded, queriesRun } =
    await collectEvidence({ schema: dedupedSchema, request, retrieveVault, searchWeb, vaultTopK, webCount, maxQueries, log });
  budget.vaultAndWebQueries = queriesRun;

  // 3. deterministic per-section PRE-synthesis coverage. synthesisOnly
  // sections are provisionally allocated the whole pool for prompting, but
  // their FINAL coverage is recomputed after synthesis from what their
  // claims actually cite — one strong pool item must never launder an
  // executive summary built on weak citations into "matched" (round-2
  // adversarial finding).
  const idToEvidence = new Map(evidence.map((e) => [e.id, e]));
  // gapNote is DETERMINISTIC, derived from coverage — model-supplied gap
  // notes were a verifier-free fabrication channel (both review rounds) and
  // are discarded entirely.
  const gapNoteFor = (coverage) => {
    if (coverage === "thin") return "Grounding for this section is limited - treat as directional and verify before client use.";
    if (coverage === "none") return "No grounded evidence was found for this section in the vault or web sweep.";
    return null;
  };
  const sectionBase = uniqueSections.map((s) => {
    const allocatedIds = s.synthesisOnly
      ? evidence.map((e) => e.id)
      : [...(sectionAllocation.get(s.id) || [])];
    const coverage = coverageForEvidence(allocatedIds.map((id) => idToEvidence.get(id)));
    return {
      id: s.id,
      title: s.title,
      coverage,
      honestGap: coverage !== "matched" ? true : undefined,
      allocatedEvidenceIds: allocatedIds,
      gapNote: gapNoteFor(coverage),
      synthesisOnly: Boolean(s.synthesisOnly),
    };
  });
  // `sections` is rebuilt FRESH each synthesis round (no state bleeding
  // between rounds — a rejected round's artefacts must not survive it).
  let sections = sectionBase.map((s) => ({ ...s }));

  const claims = [];
  const buildBrief = () => ({
    schemaVersion: RESEARCH_BRIEF_SCHEMA_VERSION,
    briefId: `brief_${createHash("sha256").update(`${schema.key}|${request}`).digest("hex").slice(0, 10)}`,
    title: schema.title,
    request,
    audience: extractRequestTerms(request).slice(0, 4).join(" "),
    createdAt: now().toISOString(),
    degraded,
    evidence,
    sections: sections.map(({ synthesisOnly, ...s }) => s),
    claims,
    coverageSummary: {
      matched: sections.filter((s) => s.coverage === "matched").length,
      thin: sections.filter((s) => s.coverage === "thin").length,
      none: sections.filter((s) => s.coverage === "none").length,
    },
  });

  // DEGRADED + EMPTY => the search infrastructure failed; saying "nothing
  // exists" would be a lie. Fail the build honestly instead (v1 hole).
  if (evidence.length === 0 && (degraded.vault || degraded.web)) {
    log("search unavailable: zero evidence AND degraded backends — refusing to claim the world is empty");
    return { ok: false, status: "search_unavailable", honestEmpty: false, brief: null, internalMarkdown: "", clientMarkdown: "", gate: { verdict: "reject", checks: [{ id: "not_evaluated", ok: false, offenders: [{ id: "search", reason: "search backends unavailable; brief never built" }] }], rejectedClaimIds: [] }, coverageSummary: null, budget };
  }

  const sectionsForLlm = sections.filter((s) => s.coverage !== "none");

  if (sectionsForLlm.length === 0 || evidence.length === 0) {
    // Honest-empty path (healthy search, genuinely nothing): zero model calls.
    sections.forEach((s) => { s.coverage = "none"; s.honestGap = true; });
    const brief = buildBrief();
    const clientMarkdown = renderClientMarkdown(brief);
    const internalMarkdown = renderInternalMarkdown(brief);
    const gate = evaluateGate({ brief, clientMarkdown });
    brief.gate = gate;
    log("honest-empty brief: no grounding available, no synthesis attempted");
    return { ok: gate.verdict === "pass", status: gate.verdict === "pass" ? "completed_with_gaps" : "gate_rejected", honestEmpty: true, brief, internalMarkdown, clientMarkdown, gate, coverageSummary: brief.coverageSummary, budget };
  }

  // 4-7. synthesis -> lint -> gate -> entailment verify -> bounded repair
  let repairNote = null;
  let lastBrief = null;
  let lastInternal = "";
  let lastGate = {
    verdict: "reject",
    checks: [{ id: "not_evaluated", ok: false, offenders: [{ id: "synthesis", reason: "no parseable synthesis output was ever produced" }] }],
    rejectedClaimIds: [],
  };
  let lastStatus = "synthesis_unparseable";

  for (let round = 0; round <= maxRepairRounds; round += 1) {
    budget.llmCalls += 1;
    let raw;
    try {
      raw = await llm({
        system: SYNTHESIS_SYSTEM,
        prompt: synthesisPrompt({ request, schema, evidence, alias, sectionsForLlm, repairNote }),
      });
    } catch (err) {
      // FAIL-CLOSED: a dead model (network, auth, timeout) ends the build
      // honestly — it must never crash the caller or strand half-built state.
      log(`synthesis model unavailable: ${err.message} — failing closed`);
      return { ok: false, status: "synthesis_unavailable", honestEmpty: false, brief: lastBrief, internalMarkdown: lastInternal, clientMarkdown: "", gate: lastGate, coverageSummary: lastBrief?.coverageSummary || null, budget };
    }
    let parsed;
    try {
      parsed = parseSynthesisJson(raw);
    } catch (err) {
      repairNote = `Your previous output was not parseable JSON (${err.message}). Re-emit the full strict-JSON object.`;
      log(`synthesis round ${round}: unparseable output — retrying`);
      continue;
    }

    // 5. lint: alias -> canonical id; markers stripped from text (re-added at
    // render from the resolved FKs so prose and citations cannot drift).
    // Sections are rebuilt fresh — nothing from a rejected round survives,
    // and model-supplied gapNotes are DISCARDED (deterministic notes only).
    sections = sectionBase.map((s) => ({ ...s }));
    claims.length = 0;
    let claimSeq = 0;
    for (const section of parsed.sections || []) {
      const target = sections.find((s) => s.id === section.id);
      if (!target) continue;
      if (target.coverage === "none" && !target.synthesisOnly) continue;
      for (const rawClaim of section.claims || []) {
        claimSeq += 1;
        const text = String(rawClaim.text || "").replace(/\s*\[E[0-9, ]+\]\s*/g, " ").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const evidenceIds = [...new Set((rawClaim.evidence || []).map((a) => alias.get(String(a).trim()) || String(a).trim()))];
        claims.push({
          id: `c${claimSeq}`,
          sectionId: section.id,
          text,
          kind: rawClaim.kind === "soft" ? "soft" : "material",
          evidenceIds,
        });
      }
    }

    // synthesisOnly coverage is recomputed from what the claims ACTUALLY
    // cite — the whole-pool prompting allocation must never set the shipped
    // confidence level (one strong pool item is not a matched exec summary).
    for (const target of sections) {
      if (!target.synthesisOnly) continue;
      const cited = [...new Set(claims.filter((c) => c.sectionId === target.id).flatMap((c) => c.evidenceIds))];
      target.allocatedEvidenceIds = cited;
      target.coverage = coverageForEvidence(cited.map((id) => idToEvidence.get(id)).filter(Boolean));
      target.honestGap = target.coverage !== "matched" ? true : undefined;
      target.gapNote = gapNoteFor(target.coverage);
      if (target.coverage === "none") {
        // no usable citations => the section carries no claims at all
        for (let i = claims.length - 1; i >= 0; i -= 1) {
          if (claims[i].sectionId === target.id) claims.splice(i, 1);
        }
      }
    }

    // 6. deterministic gate
    const brief = buildBrief();
    const internalMarkdown = renderInternalMarkdown(brief);
    const clientMarkdown = renderClientMarkdown(brief);
    const gate = evaluateGate({ brief, clientMarkdown });
    brief.gate = gate;
    lastBrief = brief; lastInternal = internalMarkdown; lastGate = gate;

    if (gate.verdict !== "pass") {
      lastStatus = "insufficient_grounding";
      const offenders = gate.checks.flatMap((c) => c.ok ? [] : c.offenders.map((o) => `- ${c.id}: ${o.id}: ${o.reason}`));
      const offenderClaims = new Set(gate.rejectedClaimIds);
      // Render-level offenders (e.g. a person name leaking into the client
      // render) reject without naming a claim id — map each leaked name back
      // to the claims that carry it so the repair round has a real target
      // (live smoke finding: the model otherwise loops without converging).
      const nameRepairLines = [];
      for (const check of gate.checks) {
        if (check.ok) continue;
        for (const o of check.offenders) {
          const nameMatch = /participant name "([^"]+)"/.exec(o.reason || "");
          if (!nameMatch) continue;
          const name = nameMatch[1];
          const carriers = brief.claims.filter((c) => new RegExp(`\\b${name}\\b`).test(c.text));
          carriers.forEach((c) => offenderClaims.add(c.id));
          nameRepairLines.push(`The name "${name}" must not appear anywhere. Rewrite ${carriers.length ? `claim(s) ${carriers.map((c) => c.id).join(", ")}` : "any text containing it"} to refer to "an owner" or "a studio" instead.`);
        }
      }
      repairNote = [
        "The deterministic grounding gate REJECTED your previous output. Offenders:",
        ...offenders.slice(0, 30),
        ...nameRepairLines.slice(0, 10),
        "For each offending claim: either (a) REMOVE it, (b) re-cite pool evidence whose excerpt LITERALLY contains its facts and numbers, or (c) rewrite it without the ungrounded specifics.",
        "Do not add new ungrounded claims. Re-emit the FULL JSON.",
        `Offending claim texts: ${brief.claims.filter((c) => offenderClaims.has(c.id)).map((c) => `${c.id}: "${c.text.slice(0, 140)}"`).join(" | ") || "(structural offenders only)"}`,
      ].join("\n");
      log(`gate REJECT on round ${round}: ${offenderClaims.size} claim(s), ${offenders.length} offender(s)`);
      continue;
    }

    // 7. entailment verification — semantic support, fail-closed.
    if (claims.length > 0) {
      let verdictLists;
      try {
        budget.llmCalls += 1;
        const verification = await verifier({
          claims: claims.map((c) => ({
            id: c.id,
            text: c.text,
            excerpts: c.evidenceIds.map((id) => idToEvidence.get(id)?.excerpt).filter(Boolean),
          })),
        });
        verdictLists = new Map();
        for (const v of verification.verdicts || []) {
          if (!v || typeof v.id !== "string") continue;
          if (!verdictLists.has(v.id)) verdictLists.set(v.id, []);
          verdictLists.get(v.id).push(v);
        }
      } catch (err) {
        log(`entailment verifier unavailable: ${err.message} — failing closed`);
        return { ok: false, status: "verification_unavailable", honestEmpty: false, brief, internalMarkdown, clientMarkdown: "", gate, coverageSummary: brief.coverageSummary, budget };
      }
      // FAIL-CLOSED reduction: a claim is supported only when at least one
      // verdict exists for it and EVERY verdict for it is strictly
      // supported === true. Duplicate ids carrying a conflicting false, a
      // missing verdict, or a stringy "true" all count as UNSUPPORTED
      // (round-2 finding: Map last-write-wins let a duplicate verdict flip
      // a refuted claim back to shipped).
      const isSupported = (id) => {
        const list = verdictLists.get(id) || [];
        return list.length > 0 && list.every((v) => v.supported === true);
      };
      const firstReason = (id) => (verdictLists.get(id) || []).find((v) => v.supported !== true)?.reason
        || (verdictLists.has(id) ? "conflicting or malformed verdicts" : "no verdict returned");
      const unsupported = claims.filter((c) => !isSupported(c.id));
      brief.verification = {
        method: "llm-cross-examination",
        checked: claims.length,
        unsupportedClaimIds: unsupported.map((c) => c.id),
      };
      if (unsupported.length) {
        lastStatus = "insufficient_grounding";
        repairNote = [
          "An independent fact-checker found these claims are NOT fully supported by their cited excerpts (wrong unit/period, flipped polarity, or the excerpt only mentions the topic):",
          ...unsupported.slice(0, 20).map((c) => `- ${c.id}: "${c.text.slice(0, 160)}" — ${firstReason(c.id)}`),
          "REMOVE each one or rewrite it to say exactly what its cited excerpt says. Re-emit the FULL JSON.",
        ].join("\n");
        log(`entailment REJECT on round ${round}: ${unsupported.length} unsupported claim(s)`);
        continue;
      }
    }

    log(`gate + entailment PASS on round ${round} (claims=${claims.length}, evidence=${evidence.length})`);
    return { ok: true, status: "completed", honestEmpty: claims.length === 0, brief, internalMarkdown, clientMarkdown, gate, coverageSummary: brief.coverageSummary, budget };
  }

  // Fail-closed: a rejected build exposes NO client-facing render — only the
  // internal brief survives, for operator debugging. Nothing shippable exists
  // unless gate AND verification passed.
  return { ok: false, status: lastStatus, honestEmpty: false, brief: lastBrief, internalMarkdown: lastInternal, clientMarkdown: "", gate: lastGate, coverageSummary: lastBrief?.coverageSummary || null, budget };
}
